import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, runStatus, type World } from './helpers.js';

let w: World;
let server: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  server = buildServer(w.app);
});
afterAll(async () => {
  await server.close();
  await w.db.end();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('personal credential vault', () => {
  it('members only ever see their own credential names, never secrets', async () => {
    await w.app.vault.put(w.alice.id, 'gitlab', 'glpat-alice-secret');
    await w.app.vault.put(w.bob.id, 'jira', 'bob:secret');
    const aliceView = await server.inject({ method: 'GET', url: '/api/me/credentials', headers: auth(w.tokens.alice) });
    expect(aliceView.json().map((c: { service: string }) => c.service)).toEqual(['gitlab']);
    expect(aliceView.body).not.toContain('glpat-alice-secret');
    const bobView = await server.inject({ method: 'GET', url: '/api/me/credentials', headers: auth(w.tokens.bob) });
    expect(bobView.json().map((c: { service: string }) => c.service)).toEqual(['jira']);
  });

  it('a ciphertext copied into another member\'s row cannot be decrypted', async () => {
    await w.db.query(
      `INSERT INTO credentials (member_id, service, secret_enc)
       SELECT $2, 'gitlab', secret_enc FROM credentials WHERE member_id = $1 AND service = 'gitlab'
       ON CONFLICT (member_id, service) DO UPDATE SET secret_enc = EXCLUDED.secret_enc`,
      [w.alice.id, w.bob.id],
    );
    await expect(w.app.vault.reveal(w.bob.id, 'gitlab')).rejects.toThrow();
    await w.app.vault.remove(w.bob.id, 'gitlab');
  });

  it('a run uses only the credentials of the member it runs as', async () => {
    const version = await approvedReleaseFlow(w);
    await giveAllCredentials(w, w.bob);
    // alice has gitlab only: the jira step pauses for her; bob's jira credential is never used.
    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('paused');
    expect(run.steps[0]).toMatchObject({ id: 'tickets', status: 'failed', errorType: 'missing_credential' });
    expect(w.fake.calls.filter((c) => c.url.includes('atlassian'))).toEqual([]);
  });
});

describe('delegation', () => {
  it('a teammate approves and runs one action with their own account; both names are recorded', async () => {
    const version = await approvedReleaseFlow(w);
    // Carol-equivalent: alice has jira + slack but no GitLab access. Bob has GitLab.
    await w.app.vault.remove(w.alice.id, 'gitlab');
    await w.app.vault.put(w.alice.id, 'jira', 'alice@example.com:jira');
    await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice');
    w.fake.calls.length = 0;

    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    let run = await runStatus(w, runId, w.alice);
    expect(run.steps[1]).toMatchObject({ id: 'mrs', status: 'failed', errorType: 'missing_credential' });

    // Alice asks Bob through the API.
    const req = await server.inject({
      method: 'POST',
      url: `/api/runs/${runId}/steps/mrs/delegate`,
      headers: auth(w.tokens.alice),
      payload: { delegateId: w.bob.id },
    });
    expect(req.statusCode).toBe(201);
    const { delegationId } = req.json();

    // Bob sees exactly what he is asked to run; alice cannot approve for him.
    const details = await server.inject({ method: 'GET', url: `/api/delegations/${delegationId}`, headers: auth(w.tokens.bob) });
    expect(details.json()).toMatchObject({
      module: 'gitlab@1.0.0',
      action: { name: 'list_merge_requests', effect: 'read' },
      inputs: [{ project: 'acme/app', label: 'ready' }],
      requesterId: w.alice.id,
    });
    const aliceDetails = await server.inject({ method: 'GET', url: `/api/delegations/${delegationId}`, headers: auth(w.tokens.alice) });
    expect(aliceDetails.json().inputs).toBeUndefined();
    const selfApprove = await server.inject({
      method: 'POST',
      url: `/api/delegations/${delegationId}/decision`,
      headers: auth(w.tokens.alice),
      payload: { decision: 'approved' },
    });
    expect(selfApprove.statusCode).toBe(403);

    const approve = await server.inject({
      method: 'POST',
      url: `/api/delegations/${delegationId}/decision`,
      headers: auth(w.tokens.bob),
      payload: { decision: 'approved' },
    });
    expect(approve.statusCode).toBe(202);
    await w.app.worker.drain();

    run = await runStatus(w, runId, w.alice);
    expect(run.steps[1]).toMatchObject({ id: 'mrs', status: 'succeeded', executedBy: w.bob.id });
    // Bob, who ran that one step for Alice, sees its output and nothing else of her run.
    const asBob = await w.app.engine.runView(runId, w.bob);
    expect(asBob.steps[1]!.output).toBeDefined();
    expect(asBob.steps.filter((st) => st.id !== 'mrs').every((st) => st.output === undefined)).toBe(true);
    expect(asBob.inputs).toBeUndefined();
    expect(w.fake.calls.find((c) => c.url.includes('gitlab.com'))!.auth).toBe('glpat-bob');
    expect(w.fake.calls.find((c) => c.url.includes('atlassian'))!.auth).toBe(`Basic ${Buffer.from('alice@example.com:jira').toString('base64')}`);

    const events = (
      await w.db.query(`SELECT action, actor_id, related_id FROM audit_events WHERE subject_id = $1 ORDER BY id`, [delegationId])
    ).rows;
    expect(events).toEqual([
      { action: 'delegation.requested', actor_id: w.alice.id, related_id: w.bob.id },
      { action: 'delegation.approved', actor_id: w.bob.id, related_id: w.alice.id },
      { action: 'delegation.executed', actor_id: w.bob.id, related_id: w.alice.id },
    ]);
  });

  it('a delegated request cannot change after it was made', async () => {
    const version = await approvedReleaseFlow(w);
    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const delegationId = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.bob.id);
    // Tamper: swap the stored request for a different (validly encrypted) one.
    const tampered = w.app.cipher.encryptJson({ forEach: false, items: [{ project: 'acme/secret-repo' }] }, `delegation:${delegationId}:inputs`);
    await w.db.query(`UPDATE delegations SET inputs_enc = $2 WHERE id = $1`, [delegationId, tampered]);
    await w.app.engine.decideDelegation(delegationId, w.bob, 'approved');
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.steps[1]).toMatchObject({ status: 'failed', errorType: 'delegation_tampered' });
    expect(w.fake.calls.some((c) => c.url.includes('secret-repo'))).toBe(false);
  });

  it('a rejected delegation pauses the run so the member can ask someone else', async () => {
    const version = await approvedReleaseFlow(w);
    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const id = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.bob.id);
    await w.app.engine.decideDelegation(id, w.bob, 'rejected');
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('paused');
    expect(run.steps[1]).toMatchObject({ status: 'failed', errorType: 'delegation_rejected' });
    await expect(w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.admin.id)).resolves.toBeTypeOf('string');
  });

  it('an expired delegation cannot be approved', async () => {
    const version = await approvedReleaseFlow(w);
    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const id = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.bob.id);
    await w.db.query(`UPDATE delegations SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    await expect(w.app.engine.decideDelegation(id, w.bob, 'approved')).rejects.toMatchObject({ code: 'delegation_expired' });
    expect((await w.db.query(`SELECT status FROM delegations WHERE id = $1`, [id])).rows[0].status).toBe('expired');
    expect((await runStatus(w, runId, w.alice)).steps[1]).toMatchObject({ errorType: 'delegation_expired' });
  });

  it('only the run\'s own member can ask for delegation, and not to themselves', async () => {
    const version = await approvedReleaseFlow(w);
    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    await expect(w.app.engine.requestDelegation(runId, 'mrs', w.bob, w.bob.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.alice.id)).rejects.toMatchObject({ code: 'cannot_delegate_to_self' });
  });
});

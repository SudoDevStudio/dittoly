import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { sanitize } from '../src/core/log.js';
import { setRetention } from '../src/core/retention.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, logLines, makeWorld, runStatus, type World } from './helpers.js';

const PII = ['jane.doe@example.com', 'Jane Doe', '+1-555-0100', 'acme/top-secret-project'];
const SECRETS = ['glpat-alice', 'xoxb-alice', 'alice@example.com:jira-token-alice'];

let w: World;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  await giveAllCredentials(w, w.bob);
});
afterAll(async () => w.db.end());

async function everythingPersistedOrLogged(): Promise<string> {
  const tables = ['audit_events', 'notifications', 'jobs', 'webhook_deliveries', 'gate_decisions'];
  const dumps = await Promise.all(tables.map((t) => w.db.query(`SELECT * FROM ${t}`).then((r) => JSON.stringify(r.rows))));
  return [...dumps, ...logLines].join('\n');
}

describe('no personal data or secrets in logs or records', () => {
  it('a full run with personal data leaves none in logs, audit, notifications or jobs; kept results are encrypted, shown only to the runner, and deleted when their time is up', async () => {
    const version = await approvedReleaseFlow(w);
    const inputs = { release: 'Jane Doe +1-555-0100', jql: 'reporter = "jane.doe@example.com"', project: 'acme/top-secret-project', channel: 'C1' };
    const server = buildServer(w.app);
    const started = await server.inject({
      method: 'POST',
      url: `/api/flow-versions/${version.id}/runs`,
      headers: { authorization: `Bearer ${w.tokens.alice}` },
      payload: { inputs },
    });
    const { runId } = started.json();
    await w.app.worker.drain();

    // While the run waits, in-progress data exists, but only encrypted.
    const raw = JSON.stringify((await w.db.query(`SELECT * FROM runs WHERE id = $1`, [runId])).rows) +
      JSON.stringify((await w.db.query(`SELECT * FROM run_steps WHERE run_id = $1`, [runId])).rows);
    for (const p of PII) expect(raw).not.toContain(p);
    expect((await w.db.query(`SELECT inputs_enc FROM runs WHERE id = $1`, [runId])).rows[0].inputs_enc).toMatch(/^v1:/);

    await w.app.engine.decideGate(runId, 'signoff', w.approver, 'approved');
    await w.app.worker.drain();
    await server.close();

    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('succeeded');

    const all = await everythingPersistedOrLogged();
    for (const s of [...PII, ...SECRETS]) expect(all, s).not.toContain(s);

    const leftovers = async () =>
      Number(
        (
          await w.db.query(
            `SELECT (SELECT count(*) FROM runs WHERE id = $1 AND inputs_enc IS NOT NULL) +
                    (SELECT count(*) FROM run_steps WHERE run_id = $1 AND (output_enc IS NOT NULL OR progress_enc IS NOT NULL)) +
                    (SELECT count(*) FROM delegations WHERE run_id = $1 AND inputs_enc IS NOT NULL) AS n`,
            [runId],
          )
        ).rows[0].n,
      );
    // Results are kept (encrypted, checked above) for the retention period: 7 days on a shared server.
    const kept = (await w.db.query(`SELECT data_expires_at FROM runs WHERE id = $1`, [runId])).rows[0].data_expires_at as Date;
    expect(Math.round((kept.getTime() - Date.now()) / 86_400_000)).toBe(7);
    expect(await leftovers()).toBeGreaterThan(0);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM run_steps WHERE run_id = $1 AND progress_enc IS NOT NULL`, [runId])).rows[0].n).toBe(0);
    // Only the member who ran it sees them; an approver sees statuses only.
    expect((await w.app.engine.runView(runId, w.alice)).steps.some((st) => st.output !== undefined)).toBe(true);
    const asApprover = await w.app.engine.runView(runId, w.approver);
    expect(asApprover.steps.every((st) => st.output === undefined) && asApprover.inputs === undefined).toBe(true);
    // Then maintenance deletes them.
    await w.app.maintenance(new Date(Date.now() + 8 * 86_400_000));
    expect(await leftovers()).toBe(0);
    expect((await w.app.engine.runView(runId, w.alice)).dataExpiresAt).toBeNull();
  });

  it('with a retention of 0 days nothing is kept after a run ends, and shortening the period applies to kept results', async () => {
    const version = await approvedReleaseFlow(w);
    const finished = await w.app.engine.startRun(version.id, w.alice.id, { release: 'x', jql: 'j', project: 'p', channel: 'c' });
    await w.app.worker.drain();
    const status = (await runStatus(w, finished, w.alice)).status;
    if (!['succeeded', 'failed', 'cancelled'].includes(status)) await w.app.engine.cancel(finished, w.alice);
    expect((await w.db.query(`SELECT inputs_enc FROM runs WHERE id = $1`, [finished])).rows[0].inputs_enc).toMatch(/^v1:/);
    await expect(setRetention(w.db, w.alice, 0, 'shared')).rejects.toMatchObject({ code: 'admin_only' });
    await setRetention(w.db, w.admin, 0, 'shared');
    expect((await w.db.query(`SELECT inputs_enc FROM runs WHERE id = $1`, [finished])).rows[0].inputs_enc).toBeNull();
  });

  it('failures record error types only, never response bodies or messages', async () => {
    const version = await approvedReleaseFlow(w);
    w.fake.failNext['GET example.atlassian.net'] = [400];
    const runId = await w.app.engine.startRun(version.id, w.alice.id, {
      release: 'x',
      jql: 'assignee = "jane.doe@example.com"',
      project: 'p',
      channel: 'c',
    });
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.steps[0]!.errorType).toBe('http_400');
    const all = await everythingPersistedOrLogged();
    expect(all).not.toContain('jane.doe@example.com');
    // Cancelling ends the run; with retention set to 0 by the test above, its data is deleted at once.
    await w.app.engine.cancel(runId, w.alice);
    expect((await w.db.query(`SELECT inputs_enc FROM runs WHERE id = $1`, [runId])).rows[0].inputs_enc).toBeNull();
  });

  it('the logger drops any field that is not allow-listed or does not look like an identifier', () => {
    expect(
      sanitize({
        runId: 'b3a1c0de-0000-4000-8000-000000000000',
        email: 'jane.doe@example.com',
        memberId: 'jane.doe@example.com',
        errorType: 'Jane Doe said no',
        status: 'paused',
        payload: { name: 'Jane' },
      }),
    ).toEqual({ runId: 'b3a1c0de-0000-4000-8000-000000000000', status: 'paused' });
  });
});

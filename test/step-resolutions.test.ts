import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, makeWorld, runStatus, type World } from './helpers.js';

/**
 * Getting past a failed step without retrying it: skip it, or continue with a result typed in. A step that only
 * reads is the run member's call; one that changes data waits for an approver. Audited, and later steps go on.
 */

let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
  // Alice can post to Slack but has no Jira or GitLab access: their steps fail with missing_credential.
  await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice');
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

async function flow(name: string, steps: unknown[]): Promise<string> {
  const v = await w.app.flows.create(name, { inputs: { type: 'object', properties: {} }, moduleSettings: { jira: { site: 'example.atlassian.net' } }, steps }, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  return v.id;
}
const search = { id: 'look', title: 'Find the tickets', type: 'action', module: 'jira@1.1.0', action: 'search_issues', input: { jql: 'project = REL' } };
const post = (text: string) => ({ id: 'tell', title: 'Tell the team', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text } });
const resolve = (runId: string, stepId: string, body: unknown, token = w.tokens.alice) =>
  api.inject({ method: 'POST', url: `/api/runs/${runId}/steps/${stepId}/resolve`, headers: auth(token), payload: body as object });
async function paused(versionId: string) {
  const runId = await w.app.engine.startRun(versionId, w.alice.id, {});
  await w.app.worker.drain();
  expect((await runStatus(w, runId, w.alice)).status).toBe('paused');
  return runId;
}

describe('getting past a failed read step', () => {
  it('"What to do" offers it, naming the later steps that use the result', async () => {
    const runId = await paused(await flow('Offer', [search, post('Found {{ steps.look.output.issues }}')]));
    const n = (await runStatus(w, runId, w.alice)).nextSteps!;
    expect(n.fixes.find((f) => f.kind === 'result')).toMatchObject({ label: 'Type in its result and continue' });
    expect(n.fixes.find((f) => f.kind === 'skip')).toMatchObject({ label: 'Skip this step', detail: 'Later steps use its result: Tell the team.' });
  });

  it('skipping it lets the run go on; the skip is audited and the outcome says a person skipped it', async () => {
    const runId = await paused(await flow('Skip read', [search, post('Release notes are out')]));
    expect((await resolve(runId, 'look', { kind: 'skip' })).json()).toEqual({ applied: true });
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.status).toBe('succeeded');
    expect(r.steps.map((s) => [s.id, s.status])).toEqual([['look', 'skipped'], ['tell', 'succeeded']]);
    expect(r.steps[0]!.resolution).toMatchObject({ kind: 'skip', status: 'applied', requestedBy: 'alice', decidedBy: 'alice' });
    expect(r.outcome.reason).toBe('Skipped by a person after failing: Find the tickets.');
    const events = (await w.db.query(`SELECT action, actor_id FROM audit_events WHERE subject_id = $1`, [`${runId}:look`])).rows;
    expect(events).toContainEqual({ action: 'run.step_skipped', actor_id: w.alice.id });
  });

  it('a typed-in result must have the shape the next steps expect; then they use it', async () => {
    const runId = await paused(await flow('Give read', [search, post('First: {{ steps.look.output.issues[0].key }}')]));
    const bad = await resolve(runId, 'look', { kind: 'result', output: { tickets: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'result_invalid' });
    const ok = await resolve(runId, 'look', { kind: 'result', output: { issues: [{ key: 'REL-7', summary: 'Ship it', status: 'Done' }] } });
    expect(ok.json()).toEqual({ applied: true });
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.status).toBe('succeeded');
    expect(r.steps[0]).toMatchObject({ status: 'succeeded', output: { issues: [{ key: 'REL-7' }] }, resolution: { kind: 'result', status: 'applied' } });
  });

  it('only the run\'s member may do it, and only on a failed step of a paused run', async () => {
    const runId = await paused(await flow('Who', [search, post('x')]));
    expect((await resolve(runId, 'look', { kind: 'skip' }, w.tokens.bob)).statusCode).toBe(403);
    expect((await resolve(runId, 'tell', { kind: 'skip' })).json()).toMatchObject({ error: 'step_not_failed' });
  });
});

describe('getting past a failed step that changes data', () => {
  const merge = { id: 'merge', title: 'Merge it', type: 'action', module: 'gitlab@1.0.0', action: 'merge_merge_request', input: { project: 'acme/app', iid: 7 } };

  it('waits for an approver, who may let it through; the member cannot decide their own', async () => {
    const runId = await paused(await flow('Skip write', [merge, post('Merged')]));
    expect((await runStatus(w, runId, w.alice)).nextSteps!.fixes.find((f) => f.kind === 'skip')!.label).toBe('Ask an approver to skip this step');
    expect((await resolve(runId, 'merge', { kind: 'skip' })).json()).toEqual({ applied: false });
    const waiting = await runStatus(w, runId, w.alice);
    expect(waiting).toMatchObject({ status: 'waiting', waitReason: 'step_resolution', steps: [{ resolution: { kind: 'skip', status: 'pending' } }, {}] });
    expect(waiting.outcome.reason).toContain('an approver to agree to skip');
    const told = (await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE member_id = $1 AND kind = 'approval_needed' AND run_id = $2`, [w.approver.id, runId])).rows[0].n;
    expect(told).toBe(1);

    const decide = (token: string, decision: string) => api.inject({ method: 'POST', url: `/api/runs/${runId}/steps/merge/resolution`, headers: auth(token), payload: { decision } });
    expect((await decide(w.tokens.alice, 'approved')).statusCode).toBe(403);
    expect((await decide(w.tokens.approver, 'approved')).statusCode).toBe(202);
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.status).toBe('succeeded');
    expect(r.steps[0]!.resolution).toMatchObject({ status: 'applied', requestedBy: 'alice', decidedBy: 'approver' });
  });

  it('a rejected request leaves the run paused at the step, as before; the proposed result is shown to the approver', async () => {
    const runId = await paused(await flow('Give write', [merge, post('Merged')]));
    expect((await resolve(runId, 'merge', { kind: 'result', output: { iid: 7, state: 'merged' } })).json()).toEqual({ applied: false });
    expect((await runStatus(w, runId, w.approver)).steps[0]!.proposed).toEqual({ iid: 7, state: 'merged' });
    await api.inject({ method: 'POST', url: `/api/runs/${runId}/steps/merge/resolution`, headers: auth(w.tokens.approver), payload: { decision: 'rejected' } });
    const r = await runStatus(w, runId, w.alice);
    expect(r).toMatchObject({ status: 'paused', waitReason: 'missing_credential', steps: [{ status: 'failed', resolution: { status: 'rejected' } }, { status: 'pending' }] });
    expect(r.steps[0]!.proposed).toBeUndefined();
    expect(r.nextSteps!.errorType).toBe('missing_credential');
  });
});

describe('what a stopped step shows', () => {
  it('a draft of its result in the shape later steps expect, with its fields', async () => {
    const runId = await paused(await flow('Draft result', [search, post('Found {{ steps.look.output.issues }}')]));
    const n = (await runStatus(w, runId, w.alice)).nextSteps!;
    expect(n.result).toMatchObject({ example: { issues: [] } });
    expect(n.result!.fields.join(' ')).toContain('issues (array');
    // The draft itself is accepted as it is.
    expect((await resolve(runId, 'look', { kind: 'result', output: n.result!.example })).json()).toEqual({ applied: true });
  });

  it('what it called before it failed (method, host, path, status, and for a refused call what was sent), and the AI can be asked to fix the module', async () => {
    await w.app.vault.put(w.alice.id, 'jira', 'alice@example.com:token');
    w.fake.failNext['GET example.atlassian.net'] = [422, 422, 422, 422];
    // The app's own short reason is kept (never the rest of its body).
    w.fake.failBody = { message: 'Validation Failed', errors: [{ message: 'The listed users cannot be searched' }], documentation_url: 'https://docs.example.com/x', secret: 'never shown' };
    const runId = await paused(await flow('Calls', [search, post('x')]));
    delete w.fake.failNext['GET example.atlassian.net'];
    w.fake.failBody = {};
    const r = await runStatus(w, runId, w.alice);
    // …and, for a refused call, what was sent (the query; never a header).
    const line = 'GET example.atlassian.net/rest/api/3/search/jql → 422: Validation Failed — The listed users cannot be searched · sent query: jql=project = REL&fields=summary,status&maxResults=50';
    expect(r.steps[0]!.calls).toEqual([line]);
    // The run says what it is doing as it goes: the step, each call, how it ended.
    const said = (r.commentary as { stepId: string | null; text: string }[]).map((l) => l.text);
    expect(said[0]).toMatch(/^Now on step ".+": jira search_issues$/);
    expect(said).toContain(`Calling ${line}`);
    expect(said.some((t) => /failed: http 422$/.test(t))).toBe(true);
    expect(JSON.stringify(r.commentary)).not.toContain('never shown');
    expect(r.nextSteps!.calls).toEqual(r.steps[0]!.calls);
    // Alice drafted the Jira module here, so she may have the AI fix it from this failure.
    const fix = r.nextSteps!.fixes.find((f) => f.kind === 'ai_fix')!;
    expect(fix.label).toBe('Have the AI fix jira');
    expect(fix.feedback).toContain('the action "search_issues" failed with "http 422"');
    expect(fix.feedback).toContain(line);
    // Another member cannot open the run at all, so never sees what it called.
    await expect(runStatus(w, runId, w.bob)).rejects.toThrow('forbidden');
    await w.app.vault.remove(w.alice.id, 'jira');
  });
});

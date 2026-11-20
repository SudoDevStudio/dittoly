import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { putTeamCredential, setCredentialMode } from '../src/core/team-credentials.js';
import { defaultTeamFor } from '../src/core/teams.js';
import { approveExampleModules, makeWorld, runStatus, type World } from './helpers.js';

/**
 * Plan item 09b: approving a new version of a Flow shows which pages of the apps following it break, and needs the
 * approver to accept that (audited). An app may pin a version instead: it keeps its pages, and once a newer version is
 * approved it still reads, but its steps that change data stop (pinned_version_retired) until its pin moves.
 */
let w: World;
let api: ReturnType<typeof buildServer>;
let teamId: string;
let flowId: string;
let v1: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  api.inject({ method, url: `/api${url}`, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });

const def = (input: string) => ({
  inputs: { type: 'object', properties: { [input]: { type: 'string' } }, required: [input] },
  steps: [
    { id: 'look', type: 'table', table: 'notes', op: 'get', key: `{{ inputs.${input} }}` },
    { id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-ops', text: `{{ inputs.${input} }}` } },
  ],
});

async function app(name: string, flows: { flowId: string; versionId?: string }[]) {
  const res = await call(w.tokens.alice, 'POST', '/apps/layout', { name, flows });
  expect(res.statusCode, res.body).toBe(200);
  const layout = res.json();
  // A form page that shows the input and the post step's result: renaming the input breaks it.
  const plan = { ...layout.plan, pages: layout.plan.pages.map((p: { kind: string }) => (p.kind === 'form' ? { ...p, fields: ['text'], result: { source: { step: 'post' }, display: 'auto' } } : p)) };
  const created = await call(w.tokens.alice, 'POST', '/apps', { name, spec: { flows, plan } });
  expect(created.statusCode, created.body).toBe(201);
  const { appId, versionId } = created.json();
  expect((await call(w.tokens.approver, 'POST', `/app-versions/${versionId}/decision`, { decision: 'approved' })).statusCode).toBe(204);
  return appId as string;
}

beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
  teamId = await defaultTeamFor(w.db, w.alice.id);
  await w.app.tables.create(w.admin, { teamId, name: 'notes', keyColumn: 'key', columns: [{ name: 'body', type: 'text' }] });
  await setCredentialMode(w.db, w.admin, teamId, 'slack', 'slack', 'team');
  await putTeamCredential(w.db, w.app.cipher, w.admin, teamId, 'slack', 'xoxb-team');
  const v = await w.app.flows.create('Notify ops', def('text'), w.alice, undefined, teamId);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  [flowId, v1] = [v.flowId, v.id];
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('apps and new Flow versions', () => {
  let following: string;
  let pinned: string;

  it('an app follows its Flow or pins an approved version of it; a pending or rejected one cannot be pinned', async () => {
    following = await app('Following desk', [{ flowId }]);
    pinned = await app('Pinned desk', [{ flowId, versionId: v1 }]);
    // Editing a Flow ends its approved version's approval (as before): v1 is superseded while v2 waits.
    const v2 = await w.app.flows.update(flowId, def('text'), w.alice);
    const lres = await call(w.tokens.alice, 'POST', '/apps/layout', { name: 'x', flows: [{ flowId, versionId: v1 }] });
    expect(lres.statusCode, lres.body).toBe(200);
    const bad = await call(w.tokens.alice, 'POST', '/apps', { name: 'x', spec: { flows: [{ flowId, versionId: v2.id }], plan: lres.json().plan } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toContain('the pinned version is not one that was approved');
    await w.app.flows.decide(v2.id, w.approver, 'rejected');
  });

  it('the review lists the pages a new version breaks; approving needs the approver to accept them, and is audited', async () => {
    const v2 = await w.app.flows.update(flowId, def('message'), w.alice);
    const review = (await call(w.tokens.approver, 'GET', `/flow-versions/${v2.id}/review`)).json();
    const byName = Object.fromEntries((review.appImpact as { name: string; problems: string[]; pinned: boolean }[]).map((a) => [a.name, a]));
    expect(byName['Following desk']).toMatchObject({ pinned: false, problems: [expect.stringContaining('unknown input text')] });
    expect(byName['Pinned desk']).toMatchObject({ pinned: true, problems: [] });

    const refused = await call(w.tokens.approver, 'POST', `/flow-versions/${v2.id}/decision`, { decision: 'approved' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('app_pages_would_break');
    expect(refused.body).toContain('Following desk');
    const ok = await call(w.tokens.approver, 'POST', `/flow-versions/${v2.id}/decision`, { decision: 'approved', acceptAppBreaks: true });
    expect(ok.statusCode, ok.body).toBe(200);
    const audited = (await w.db.query(`SELECT related_id FROM audit_events WHERE action = 'flow.app_breaks_accepted' AND subject_id = $1`, [v2.id])).rows;
    expect(audited).toEqual([{ related_id: '1' }]);
    // The following app now says its page no longer fits.
    expect((await call(w.tokens.alice, 'GET', `/apps/${following}`)).json().problems.join(' ')).toContain('unknown input text');
  });

  it('the pinned app keeps its pages; its replaced version still reads, and its steps that change data stop until the pin moves', async () => {
    const detail = (await call(w.tokens.alice, 'GET', `/apps/${pinned}`)).json();
    expect(detail.flows).toEqual([expect.objectContaining({ pinned: true, retired: true, version: 1, current: 3 })]);
    expect(detail.problems.join(' ')).toContain('pinned to v1, which v3 replaced');

    const started = await call(w.tokens.alice, 'POST', `/apps/${pinned}/v/live/api/flows/notify-ops/runs`, { inputs: { text: 'hi' } });
    expect(started.statusCode, started.body).toBe(201);
    await w.app.worker.drain();
    const r = await runStatus(w, started.json().runId, w.alice);
    expect(r.steps.map((s) => [s.id, s.status, s.errorType])).toEqual([['look', 'succeeded', null], ['post', 'failed', 'pinned_version_retired']]);
    expect(w.fake.messages.filter((m) => m.channel === 'C-ops')).toEqual([]);
    expect(r.outcome.reason).toContain("move the App's pin");
    // Nothing else may start the replaced version.
    await expect(w.app.engine.startRun(v1, w.alice.id, { text: 'x' })).rejects.toMatchObject({ code: 'flow_version_not_approved' });
  });
});

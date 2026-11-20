import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, giveAllCredentials, makeWorld, type World } from './helpers.js';

/** Deleting a Flow (a Super Flow too) or a module archives it: it never runs again, its history stays, an admin restores it. */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const notify = {
  inputs: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-ops', text: '{{ inputs.text }}' } }],
};
async function approved(name: string, def: unknown) {
  const v = await w.app.flows.create(name, def, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  return v;
}
const del = (url: string, token: string) => api.inject({ method: 'DELETE', url: `/api${url}`, headers: auth(token) });
const restore = (url: string, token: string) => api.inject({ method: 'POST', url: `/api${url}/restore`, headers: auth(token) });
const names = async (token: string, query = '') => ((await api.inject({ method: 'GET', url: `/api/flows${query}`, headers: auth(token) })).json() as { name: string }[]).map((f) => f.name);

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('deleting Flows and Super Flows', () => {
  it('refuses while a Super Flow runs it, then deletes the Super Flow and the Flow; neither runs, an admin restores', async () => {
    const child = await approved('Notify ops', notify);
    const parent = await approved('Release train', { inputs: notify.inputs, steps: [{ id: 'notify', type: 'flow', runs: [{ id: 'a', flow: child.flowId, version: 1, input: { text: '{{ inputs.text }}' } }] }] });

    // The Flows and Super Flows pages each get their own list from the server.
    expect(await names(w.tokens.alice, '?kind=super')).toEqual(['Release train']);
    expect(await names(w.tokens.alice, '?kind=flow')).toEqual(['Notify ops']);
    expect((await api.inject({ method: 'GET', url: '/api/flows?kind=other', headers: auth(w.tokens.alice) })).statusCode).toBe(400);
    // Only its owner or an admin.
    expect((await del(`/flows/${child.flowId}`, w.tokens.bob)).statusCode).toBe(403);
    const used = await del(`/flows/${child.flowId}`, w.tokens.alice);
    expect(used.statusCode).toBe(409);
    expect(used.json()).toMatchObject({ error: 'flow_in_use' });
    expect(used.json().detail).toContain('"Release train"');

    expect((await del(`/flows/${parent.flowId}`, w.tokens.alice)).statusCode).toBe(204);
    expect((await del(`/flows/${child.flowId}`, w.tokens.alice)).statusCode).toBe(204);
    expect(await names(w.tokens.alice)).not.toContain('Notify ops');
    // Nothing starts it: a run, a change, an approval.
    await expect(w.app.engine.startRun(child.id, w.alice.id, { text: 'x' })).rejects.toMatchObject({ code: 'flow_archived' });
    await expect(w.app.flows.update(child.flowId, notify, w.alice)).rejects.toMatchObject({ code: 'flow_archived' });
    // Its history stays: versions and the audit trail.
    expect((await w.app.flows.versions(child.flowId)).map((v) => v.status)).toEqual(['approved']);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'flow.archived' AND subject_id = $1`, [child.flowId])).rowCount).toBe(1);

    // Admins see deleted Flows and restore them; members cannot.
    expect(await names(w.tokens.admin, '?archived=true')).toEqual(expect.arrayContaining(['Notify ops', 'Release train']));
    expect(await names(w.tokens.alice, '?archived=true')).toEqual([]);
    expect((await restore(`/flows/${child.flowId}`, w.tokens.alice)).statusCode).toBe(403);
    expect((await restore(`/flows/${child.flowId}`, w.tokens.admin)).statusCode).toBe(204);
    expect(await names(w.tokens.alice)).toContain('Notify ops');
    expect(await w.app.engine.startRun(child.id, w.alice.id, { text: 'back' })).toEqual(expect.any(String));
    await w.app.worker.drain();
  });

  it('refuses while a run of it is still active', async () => {
    const gated = await approved('Needs a sign-off', { inputs: notify.inputs, steps: [{ id: 'ok', type: 'approval' }, ...notify.steps] });
    const runId = await w.app.engine.startRun(gated.id, w.alice.id, { text: 'x' });
    await w.app.worker.drain();
    const busy = await del(`/flows/${gated.flowId}`, w.tokens.alice);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().detail).toContain('1 run still active');
    await w.app.engine.cancel(runId, w.alice);
    expect((await del(`/flows/${gated.flowId}`, w.tokens.alice)).statusCode).toBe(204);
  });
});

describe('deleting modules', () => {
  it('admins only; refused while a Flow uses it; then gone from the catalog, no new versions, restorable', async () => {
    expect((await del('/modules/by-name/slack', w.tokens.alice)).statusCode).toBe(403);
    const used = await del('/modules/by-name/slack', w.tokens.admin);
    expect(used.statusCode).toBe(409);
    expect(used.json()).toMatchObject({ error: 'module_in_use' });
    expect(used.json().detail).toContain('"Notify ops"');

    // Jira is used by no Flow here.
    expect((await del('/modules/by-name/jira', w.tokens.admin)).statusCode).toBe(204);
    expect((await w.app.flowChat.catalog()).some((a) => a.module.startsWith('jira@'))).toBe(false);
    const listed = (await w.app.modules.list()).filter((m) => m.name === 'jira');
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((m) => m.archived)).toBe(true);
    const jira = listed[0]!;
    await expect(w.app.modules.createDraft({ manifest: { ...jira.manifest, version: '9.9.9' }, code: 'export const actions = {};', tests: [], origin: 'seed' }, w.alice)).rejects.toMatchObject({ code: 'module_archived' });

    expect((await restore('/modules/by-name/jira', w.tokens.admin)).statusCode).toBe(204);
    expect((await w.app.flowChat.catalog()).some((a) => a.module.startsWith('jira@'))).toBe(true);
  });
});

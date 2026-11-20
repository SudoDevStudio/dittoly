import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { defaultTeamFor } from '../src/core/teams.js';
import type { FlowDefinition } from '../src/flows/definition.js';
import { parseManifest } from '../src/modules/manifest.js';
import { approveExampleModules, giveAllCredentials, makeWorld, runStatus, type World } from './helpers.js';

/** Undo: writes a module declares a reversal for can be reversed, by their person, after an approver signs off. */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (url: string, who: string, payload: object) => api.inject({ method: 'POST', url, headers: auth(who), payload });
const get = (url: string, who: string) => api.inject({ method: 'GET', url, headers: auth(who) });
const announce = {
  inputs: { type: 'object', properties: { channels: { type: 'array', items: { type: 'string' } } }, required: ['channels'] },
  steps: [{ id: 'announce', type: 'action', module: 'slack@1.0.0', action: 'post_message', forEach: '{{ inputs.channels }}', input: { channel: '{{ item }}', text: 'Release 2.4 is out' } }],
} as unknown as FlowDefinition;

async function announced(): Promise<string> {
  const runId = await w.app.engine.startRun(versionId, w.alice.id, { channels: ['C1', 'C2'] });
  await w.app.worker.drain();
  expect(await runStatus(w, runId, w.alice)).toMatchObject({ status: 'succeeded' });
  return runId;
}
let versionId = '';

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  api = buildServer(w.app);
  await giveAllCredentials(w, w.alice);
  const v = await w.app.flows.create('Announce', announce, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  versionId = v.id;
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('declaring undo in a module', () => {
  const base = (undo: unknown, effect = 'write') => ({
    name: 'notes', version: '1.0.0', title: 'Notes', description: 'Notes.', hosts: ['notes.example.com'], credentials: [],
    actions: [
      { name: 'create_note', title: 'Create', description: 'Creates a note.', effect, credentials: [], input: { type: 'object', properties: { text: { type: 'string' } } }, output: { type: 'object' }, undo },
      { name: 'delete_note', title: 'Delete', description: 'Deletes a note.', effect: 'write', credentials: [], input: { type: 'object', properties: { id: { type: 'string' } } }, output: { type: 'object' } },
      { name: 'get_note', title: 'Get', description: 'Reads a note.', effect: 'read', credentials: [], input: { type: 'object', properties: { id: { type: 'string' } } }, output: { type: 'object' } },
    ],
  });
  const issues = (m: unknown) => {
    const r = parseManifest(m);
    return r.ok ? [] : r.issues.join('\n');
  };

  it('names another write action of the module and fills only its inputs, from {{ input }} and {{ output }}', () => {
    expect(issues(base({ action: 'delete_note', input: { id: '{{ output.id }}' } }))).toEqual([]);
    expect(issues(base({ action: 'delete_note', input: { id: '{{ output.id }}' } }, 'read'))).toContain('only write actions can be undone');
    expect(issues(base({ action: 'nope', input: {} }))).toContain('no action nope');
    expect(issues(base({ action: 'create_note', input: {} }))).toContain('cannot undo itself');
    expect(issues(base({ action: 'get_note', input: { id: '{{ output.id }}' } }))).toContain('get_note must be a write action');
    expect(issues(base({ action: 'delete_note', input: { key: '{{ output.id }}' } }))).toContain('delete_note has no input key');
    expect(issues(base({ action: 'delete_note', input: { id: '{{ inputs.secret }}' } }))).toContain('use only {{ input.<field> }} and {{ output.<field> }}');
  });

  it('the reviewer sees whether each write can be undone', async () => {
    const ids = (await w.db.query<{ id: string; name: string }>(`SELECT id, name FROM module_versions`)).rows;
    const summary = async (name: string) => ((await get(`/api/modules/${ids.find((m) => m.name === name)!.id}/review`, w.tokens.admin)).json() as { summary: string }).summary;
    expect(await summary('slack')).toContain('It can be undone with delete_message (channel = {{ input.channel }}, ts = {{ output.ts }}).');
    expect(await summary('gitlab')).toContain('It cannot be undone by Dittoly.');
  });
});

describe('reversing a run', () => {
  it('keeps what reverses each write; its person asks with a reason, an approver signs off, and it runs newest first', async () => {
    const runId = await announced();
    const view = (await get(`/api/runs/${runId}/undo`, w.tokens.alice)).json();
    expect(view).toMatchObject({ windowDays: 7, writes: [{ stepId: 'announce', item: 1, undoAction: 'delete_message', status: 'ready' }, { item: 0, status: 'ready' }], reversals: [] });
    // Stored encrypted: the plain value never appears (quoted, since "C1" can turn up by chance inside base64).
    const stored = (await w.db.query<{ input_enc: string }>(`SELECT input_enc FROM undo_records WHERE run_id = $1`, [runId])).rows.map((r) => r.input_enc);
    for (const v of stored) expect(v.startsWith('v1:') && !v.includes('"C1"') && !v.includes('channel')).toBe(true);

    expect((await post('/api/reversals', w.tokens.bob, { runId, reason: 'Posted by mistake, please undo.' })).statusCode).toBe(403);
    expect((await post('/api/reversals', w.tokens.alice, { runId, reason: 'oops' })).json()).toMatchObject({ error: 'invalid_request' });
    const r = await post('/api/reversals', w.tokens.alice, { runId, reason: 'Posted the announcement a day early.' });
    expect(r.statusCode).toBe(201);
    const reversal = r.json() as { id: string; status: string };
    expect(reversal.status).toBe('pending');
    expect((await post('/api/reversals', w.tokens.alice, { runId, reason: 'Posted the announcement a day early.' })).json()).toMatchObject({ error: 'reversal_already_requested' });

    const inbox = (await get('/api/approvals', w.tokens.approver)).json() as { kind: string; id: string; title: string }[];
    expect(inbox.find((a) => a.kind === 'reversal' && a.id === reversal.id)?.title).toBe('Reverse 2 changes of Announce');
    expect((await post(`/api/reversals/${reversal.id}/decision`, w.tokens.alice, { decision: 'approved' })).json()).toMatchObject({ error: 'approver_only' });
    w.fake.deleted.length = 0;
    expect((await post(`/api/reversals/${reversal.id}/decision`, w.tokens.approver, { decision: 'approved' })).json()).toMatchObject({ status: 'running' });
    await w.app.worker.drain();
    expect(w.fake.deleted.map((d) => d.channel)).toEqual(['C2', 'C1']);
    expect((await get(`/api/reversals/${reversal.id}`, w.tokens.alice)).json()).toMatchObject({ status: 'done', writes: [{ status: 'reversed' }, { status: 'reversed' }] });
    expect((await w.db.query(`SELECT count(*)::int AS n FROM undo_records WHERE run_id = $1 AND input_enc IS NOT NULL`, [runId])).rows[0].n).toBe(0);
    expect((await w.db.query(`SELECT 1 FROM notifications WHERE member_id = $1 AND kind = 'reversal_finished'`, [w.alice.id])).rowCount).toBe(1);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'undo.reversed' AND actor_id = $1`, [w.alice.id])).rows[0].n).toBe(2);
    expect((await post('/api/reversals', w.tokens.alice, { runId, reason: 'Posted the announcement a day early.' })).json()).toMatchObject({ error: 'nothing_to_reverse' });
  });

  it('only the chosen writes; a rejected request reverses nothing; past the window nothing can be reversed', async () => {
    const runId = await announced();
    const writes = ((await get(`/api/runs/${runId}/undo`, w.tokens.alice)).json() as { writes: { id: string; item: number }[] }).writes;
    const one = writes.find((x) => x.item === 0)!.id;
    const asked = (await post('/api/reversals', w.tokens.alice, { runId, reason: 'Only the first channel was wrong.', undoIds: [one] })).json() as { id: string; writes: unknown[] };
    expect(asked.writes).toHaveLength(1);
    w.fake.deleted.length = 0;
    expect((await post(`/api/reversals/${asked.id}/decision`, w.tokens.approver, { decision: 'rejected' })).json()).toMatchObject({ status: 'rejected' });
    await w.app.worker.drain();
    expect(w.fake.deleted).toHaveLength(0);

    await w.db.query(`UPDATE undo_records SET expires_at = now() - interval '1 second' WHERE run_id = $1`, [runId]);
    expect((await post('/api/reversals', w.tokens.alice, { runId, reason: 'Too late to undo this now.' })).json()).toMatchObject({ error: 'nothing_to_reverse' });
    expect((await w.db.query(`SELECT status, input_enc FROM undo_records WHERE run_id = $1`, [runId])).rows).toEqual([
      { status: 'expired', input_enc: null },
      { status: 'expired', input_enc: null },
    ]);
  });

  it('admins set how long writes can be reversed', async () => {
    expect((await api.inject({ method: 'PUT', url: '/api/undo-window', headers: auth(w.tokens.alice), payload: { days: 30 } })).json()).toMatchObject({ error: 'admin_only' });
    expect((await api.inject({ method: 'PUT', url: '/api/undo-window', headers: auth(w.tokens.admin), payload: { days: 0 } })).json()).toMatchObject({ error: 'invalid_undo_window' });
    expect((await api.inject({ method: 'PUT', url: '/api/undo-window', headers: auth(w.tokens.admin), payload: { days: 30 } })).json()).toEqual({ days: 30 });
    const runId = await announced();
    const days = (await w.db.query<{ d: number }>(`SELECT round(extract(epoch FROM expires_at - created_at) / 86400)::int AS d FROM undo_records WHERE run_id = $1 LIMIT 1`, [runId])).rows[0]!.d;
    expect(days).toBe(30);
    await api.inject({ method: 'PUT', url: '/api/undo-window', headers: auth(w.tokens.admin), payload: { days: 7 } });
  });
});

describe('reversing an agent call', () => {
  it('a gateway write made by an agent is reversed the same way', async () => {
    const teamId = await defaultTeamFor(w.db, w.alice.id);
    const slack = (await w.db.query(`SELECT id FROM module_versions WHERE name = 'slack'`)).rows[0].id;
    await post('/api/gateway-tools', w.tokens.admin, { moduleVersionId: slack, action: 'post_message', teamId });
    const a = (await post('/api/agents', w.tokens.alice, { name: 'Poster', scopes: { tools: { 'action:slack/post_message': 'run' } } })).json() as { id: string; token: string };
    const r = await api.inject({
      method: 'POST', url: '/mcp', headers: { ...auth(a.token), 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'app_slack_post_message', arguments: { channel: 'C9', text: 'hello' } } },
    });
    expect(r.json().result.isError).toBeUndefined();
    const call = ((await get(`/api/agents/${a.id}/calls`, w.tokens.alice)).json() as { id: string; undo: string }[])[0]!;
    expect(call.undo).toBe('ready');
    const rev = (await post('/api/reversals', w.tokens.alice, { agentCallId: call.id, reason: 'The agent posted to the wrong channel.' })).json() as { id: string };
    w.fake.deleted.length = 0;
    await post(`/api/reversals/${rev.id}/decision`, w.tokens.approver, { decision: 'approved' });
    await w.app.worker.drain();
    expect(w.fake.deleted).toEqual([{ channel: 'C9', ts: '1700000000.000100' }]);
    expect(((await get(`/api/agents/${a.id}/calls`, w.tokens.alice)).json() as { undo: string }[])[0]!.undo).toBe('reversed');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { setFlowMcp } from '../src/mcp/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, type World } from './helpers.js';

/** AI agents as identities: each MCP token uses only the tools its person picked, until it expires, and every call is recorded. */
let w: World;
let api: ReturnType<typeof buildServer>;
let flowId = '';
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let nextId = 1;
const rpc = async (token: string, method: string, params: unknown = {}) => {
  const r = await api.inject({ method: 'POST', url: '/mcp', headers: { ...auth(token), 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: nextId++, method, params } });
  return { status: r.statusCode, body: r.json() as { result?: any; error?: { code: number; message: string } } };
};
const names = async (token: string) => ((await rpc(token, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name);
const text = (r: { body: { result?: any } }) => JSON.parse(r.body.result.content[0].text);
const agent = async (who: string, body: object) => {
  const r = await api.inject({ method: 'POST', url: '/api/agents', headers: auth(who), payload: body });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; token: string };
};

beforeAll(async () => {
  w = await makeWorld({}, { mcpWaitMs: 0 });
  await approveExampleModules(w);
  api = buildServer(w.app);
  await giveAllCredentials(w, w.alice);
  flowId = (await approvedReleaseFlow(w)).flowId;
  await setFlowMcp(w.db, w.alice, flowId, true);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('what an agent may use', () => {
  it('a new agent gets nothing until its person picks tools; what it tries outside them is recorded', async () => {
    const a = await agent(w.tokens.alice, { name: 'Empty', scopes: { tools: {} } });
    expect(await names(a.token)).toEqual(['get_run', 'get_call']);
    const all = (await api.inject({ method: 'GET', url: '/api/me/mcp-tools', headers: auth(w.tokens.alice) })).json() as { name: string; key: string }[];
    const tool = all.find((t) => t.key === `flow:${flowId}`)!;
    expect((await rpc(a.token, 'tools/call', { name: tool.name, arguments: releaseInputs })).body.error?.code).toBe(-32602);
    expect((await rpc(a.token, 'tools/call', { name: 'save_as_flow', arguments: {} })).body.error?.code).toBe(-32602);
    const calls = (await api.inject({ method: 'GET', url: `/api/agents/${a.id}/calls`, headers: auth(w.tokens.alice) })).json();
    expect(calls).toMatchObject([
      { tool: 'save_as_flow', status: 'denied' },
      { tool: `flow:${flowId}`, title: 'Release coordination', status: 'denied' },
    ]);
    // A Flow that does not exist cannot be given.
    const bad = await api.inject({ method: 'POST', url: '/api/agents', headers: auth(w.tokens.alice), payload: { name: 'x', scopes: { tools: { 'flow:00000000-0000-0000-0000-000000000000': 'run' } } } });
    expect(bad.json()).toMatchObject({ error: 'unknown_tool' });
  });

  it('"run" uses the tool directly, as its person, and the call is recorded with its run', async () => {
    const a = await agent(w.tokens.alice, { name: 'Runner', scopes: { tools: { [`flow:${flowId}`]: 'run' } } });
    const name = (await names(a.token)).find((n) => n.startsWith('run_release'))!;
    const started = text(await rpc(a.token, 'tools/call', { name, arguments: releaseInputs }));
    expect(started).toMatchObject({ status: 'running' });
    expect((await w.db.query(`SELECT mcp_token_id FROM runs WHERE id = $1`, [started.runId])).rows[0].mcp_token_id).toBe(a.id);
    const calls = (await api.inject({ method: 'GET', url: `/api/agents/${a.id}/calls`, headers: auth(w.tokens.alice) })).json();
    expect(calls).toMatchObject([{ tool: `flow:${flowId}`, status: 'done', runId: started.runId }]);
  });

  it('"ask" waits for its person: they see what it would send and confirm or reject it; nobody else can', async () => {
    const a = await agent(w.tokens.alice, { name: 'Asker', scopes: { tools: { [`flow:${flowId}`]: 'ask' } } });
    const name = (await names(a.token)).find((n) => n.startsWith('run_release'))!;
    const asked = text(await rpc(a.token, 'tools/call', { name, arguments: releaseInputs }));
    expect(asked).toMatchObject({ status: 'awaiting_confirmation', callId: expect.any(String) });
    expect((await w.db.query(`SELECT count(*)::int AS n FROM runs WHERE mcp_token_id = $1`, [a.id])).rows[0].n).toBe(0);
    expect((await w.db.query(`SELECT 1 FROM notifications WHERE member_id = $1 AND kind = 'agent_confirmation_needed'`, [w.alice.id])).rowCount).toBeGreaterThan(0);
    const waiting = (await api.inject({ method: 'GET', url: '/api/agent-calls', headers: auth(w.tokens.alice) })).json();
    expect(waiting).toMatchObject([{ id: asked.callId, agent: { name: 'Asker' }, title: 'Release coordination', args: releaseInputs }]);
    // Stored encrypted.
    expect(JSON.stringify((await w.db.query(`SELECT args_enc FROM agent_calls WHERE id = $1`, [asked.callId])).rows[0])).not.toContain(String(Object.values(releaseInputs)[0]));
    expect(text(await rpc(a.token, 'tools/call', { name: 'get_call', arguments: { callId: asked.callId } }))).toMatchObject({ status: 'awaiting_confirmation' });

    const decide = (who: string, id: string, decision: string) => api.inject({ method: 'POST', url: `/api/agent-calls/${id}/decision`, headers: auth(who), payload: { decision } });
    expect((await decide(w.tokens.bob, asked.callId, 'confirmed')).statusCode).toBe(404);
    const done = (await decide(w.tokens.alice, asked.callId, 'confirmed')).json();
    expect(done).toMatchObject({ status: 'done', runId: expect.any(String) });
    expect((await w.db.query(`SELECT run_as, mcp_token_id FROM runs WHERE id = $1`, [done.runId])).rows[0]).toMatchObject({ run_as: w.alice.id, mcp_token_id: a.id });
    expect(text(await rpc(a.token, 'tools/call', { name: 'get_call', arguments: { callId: asked.callId } }))).toMatchObject({ status: 'done', runId: done.runId });
    expect((await decide(w.tokens.alice, asked.callId, 'confirmed')).json()).toMatchObject({ error: 'agent_call_not_waiting' });
    expect((await w.db.query(`SELECT args_enc FROM agent_calls WHERE id = $1`, [asked.callId])).rows[0].args_enc).toBeNull();

    const second = text(await rpc(a.token, 'tools/call', { name, arguments: releaseInputs }));
    expect((await decide(w.tokens.alice, second.callId, 'rejected')).json()).toMatchObject({ status: 'rejected', runId: null });

    // Nobody decides within a day: it lapses.
    const third = text(await rpc(a.token, 'tools/call', { name, arguments: releaseInputs }));
    await w.db.query(`UPDATE agent_calls SET created_at = now() - interval '25 hours' WHERE id = $1`, [third.callId]);
    expect(text(await rpc(a.token, 'tools/call', { name: 'get_call', arguments: { callId: third.callId } }))).toMatchObject({ status: 'expired' });
    expect((await w.db.query(`SELECT count(*)::int AS n FROM runs WHERE mcp_token_id = $1`, [a.id])).rows[0].n).toBe(1);
  });

  it('its person changes what it may use; it stops working when it expires', async () => {
    const a = await agent(w.tokens.alice, { name: 'Short', scopes: { tools: {} }, expiresInDays: 1 });
    expect((await api.inject({ method: 'PUT', url: `/api/agents/${a.id}`, headers: auth(w.tokens.alice), payload: { scopes: { tools: { [`flow:${flowId}`]: 'run' }, drafting: true } } })).statusCode).toBe(204);
    expect(await names(a.token)).toEqual(expect.arrayContaining(['get_flow_guide', 'save_as_flow', expect.stringMatching(/^run_release/)]));
    await w.db.query(`UPDATE mcp_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [a.id]);
    expect((await rpc(a.token, 'ping')).status).toBe(401);
    const mine = (await api.inject({ method: 'GET', url: '/api/agents', headers: auth(w.tokens.alice) })).json() as { id: string; state: string }[];
    expect(mine.find((x) => x.id === a.id)?.state).toBe('expired');
  });
});

describe('admins and older tokens', () => {
  it('admins see every agent and revoke any; they cannot widen someone else\'s', async () => {
    const b = await agent(w.tokens.bob, { name: "Bob's agent", scopes: { tools: { [`flow:${flowId}`]: 'ask' } } });
    expect((await api.inject({ method: 'GET', url: '/api/agents?all=1', headers: auth(w.tokens.bob) })).json()).toMatchObject({ error: 'admin_only' });
    const all = (await api.inject({ method: 'GET', url: '/api/agents?all=1', headers: auth(w.tokens.admin) })).json() as { id: string; owner: { handle: string } }[];
    expect(all.find((x) => x.id === b.id)?.owner.handle).toBe('bob');
    expect((await api.inject({ method: 'PUT', url: `/api/agents/${b.id}`, headers: auth(w.tokens.admin), payload: { expiresInDays: 365 } })).statusCode).toBe(404);
    expect((await api.inject({ method: 'DELETE', url: `/api/agents/${b.id}`, headers: auth(w.tokens.admin) })).statusCode).toBe(204);
    expect((await rpc(b.token, 'ping')).status).toBe(401);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'mcp.token_revoked' AND related_id = $1 AND actor_id = $2`, [b.id, w.admin.id])).rowCount).toBe(1);
  });

  it('a token made before agent scopes keeps everything its person can use until restricted', async () => {
    const legacy = await agent(w.tokens.alice, { name: 'Old', scopes: { tools: {} } });
    await w.db.query(`UPDATE mcp_tokens SET scopes = NULL, expires_at = NULL WHERE id = $1`, [legacy.id]);
    expect(await names(legacy.token)).toEqual(expect.arrayContaining(['get_flow_guide', expect.stringMatching(/^run_release/)]));
    const mine = (await api.inject({ method: 'GET', url: '/api/agents', headers: auth(w.tokens.alice) })).json() as { id: string; scopes: unknown }[];
    expect(mine.find((x) => x.id === legacy.id)?.scopes).toBeNull();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { setFlowMcp } from '../src/mcp/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseFlow, releaseInputs, type World } from './helpers.js';
import { OLD_MCP_TOKEN_PREFIX } from '../src/core/old-prefixes.js';
import { sha256Hex } from '../src/core/crypto.js';

/** Dittoly as an MCP server: approved Flows the owner switched on become tools, run as the token's person. */
let w: World;
let api: ReturnType<typeof buildServer>;
let token = '';
let flowId = '';
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let nextId = 1;
const rpc = async (method: string, params: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await api.inject({ method: 'POST', url: '/mcp', headers: { ...auth(token), 'content-type': 'application/json', ...headers }, payload: { jsonrpc: '2.0', id: nextId++, method, params } });
  return { status: r.statusCode, body: r.json() as { result?: any; error?: { code: number; message: string } } };
};

beforeAll(async () => {
  w = await makeWorld({}, { mcpWaitMs: 0 });
  await approveExampleModules(w);
  api = buildServer(w.app);
  await giveAllCredentials(w, w.alice);
  flowId = (await approvedReleaseFlow(w)).flowId;
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('MCP tokens', () => {
  it('a person makes a named token that only works on /mcp, and sees it listed without the secret', async () => {
    const r = await api.inject({ method: 'POST', url: '/api/me/mcp-tokens', headers: auth(w.tokens.alice), payload: { name: 'Claude on my laptop', scopes: { tools: { [`flow:${flowId}`]: 'run' }, drafting: true } } });
    expect(r.statusCode).toBe(201);
    token = r.json().token;
    expect(token).toMatch(/^dty_mcp_/);
    const list = (await api.inject({ method: 'GET', url: '/api/me/mcp-tokens', headers: auth(w.tokens.alice) })).json();
    expect(list).toMatchObject([{ name: 'Claude on my laptop' }]);
    expect(JSON.stringify(list)).not.toContain(token);
    // A token issued under the earlier prefix (src/core/old-prefixes.ts) still works.
    const old = `${OLD_MCP_TOKEN_PREFIX}${token.slice('dty_mcp_'.length)}`;
    await w.db.query(`UPDATE mcp_tokens SET token_hash = $2 WHERE token_hash = $1`, [sha256Hex(token), sha256Hex(old)]);
    expect((await api.inject({ method: 'POST', url: '/mcp', headers: auth(old), payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode).toBe(200);
    await w.db.query(`UPDATE mcp_tokens SET token_hash = $1 WHERE token_hash = $2`, [sha256Hex(token), sha256Hex(old)]);
    // Not an API token: the rest of Dittoly refuses it.
    expect((await api.inject({ method: 'GET', url: '/api/flows', headers: auth(token) })).statusCode).toBe(401);
    // And an API token is not an MCP token.
    expect((await api.inject({ method: 'POST', url: '/mcp', headers: auth(w.tokens.alice), payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode).toBe(401);
  });
});

describe('the MCP protocol', () => {
  it('answers initialize with a version it speaks, and newer clients\' server/discover like an earlier server would', async () => {
    let r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dittoly' } });
    r = await rpc('initialize', { protocolVersion: '2099-01-01' });
    expect(r.body.result.protocolVersion).toBe('2025-11-25');
    r = await rpc('server/discover');
    expect(r.body.error?.code).toBe(-32601);
    expect((await rpc('ping')).body.result).toEqual({});
  });

  it('acknowledges notifications without a body, refuses other sites, GET and unknown protocol versions', async () => {
    const n = await api.inject({ method: 'POST', url: '/mcp', headers: auth(token), payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(n.statusCode).toBe(202);
    expect(n.body).toBe('');
    expect((await api.inject({ method: 'POST', url: '/mcp', headers: { ...auth(token), origin: 'https://evil.example' }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode).toBe(403);
    expect((await api.inject({ method: 'GET', url: '/mcp', headers: auth(token) })).statusCode).toBe(405);
    expect((await rpc('ping', {}, { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400);
    expect((await rpc('ping', {}, { 'mcp-protocol-version': '2025-11-25' })).status).toBe(200);
  });
});

describe('Flows as tools', () => {
  it('offers only Flows their owner switched on; only the owner (or a team or org admin) can switch', async () => {
    let tools = (await rpc('tools/list')).body.result.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(['get_run', 'get_call', 'get_flow_guide', 'save_as_flow']);
    expect((await api.inject({ method: 'PUT', url: `/api/flows/${flowId}/mcp`, headers: auth(w.tokens.bob), payload: { enabled: true } })).json()).toMatchObject({ error: 'owner_only' });
    expect((await api.inject({ method: 'PUT', url: `/api/flows/${flowId}/mcp`, headers: auth(w.tokens.alice), payload: { enabled: true } })).statusCode).toBe(204);
    tools = (await rpc('tools/list')).body.result.tools;
    const t = tools.find((x) => x.name.startsWith('run_release_coordination_')) as any;
    expect(t).toBeTruthy();
    expect(t.description).toContain('changes data');
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(t.inputSchema.properties).toHaveProperty('release');
    const list = (await api.inject({ method: 'GET', url: '/api/flows', headers: auth(w.tokens.alice) })).json();
    expect(list.find((f: { id: string }) => f.id === flowId).mcpEnabled).toBe(true);
  });

  it('runs the Flow as the token\'s person, waits for a human sign-off, and reports through get_run', async () => {
    const name = ((await rpc('tools/list')).body.result.tools as { name: string }[]).find((x) => x.name.startsWith('run_release'))!.name;
    const r = await rpc('tools/call', { name, arguments: releaseInputs });
    const started = JSON.parse(r.body.result.content[0].text);
    expect(started).toMatchObject({ flow: 'Release coordination', status: 'running' });
    const row = (await w.db.query(`SELECT run_as, mcp_token_id FROM runs WHERE id = $1`, [started.runId])).rows[0];
    expect(row.run_as).toBe(w.alice.id);
    expect(row.mcp_token_id).not.toBeNull();
    await w.app.worker.drain();
    const later = JSON.parse((await rpc('tools/call', { name: 'get_run', arguments: { runId: started.runId } })).body.result.content[0].text);
    expect(later).toMatchObject({ status: 'waiting', note: expect.stringContaining('sign off') });
    const report = (await api.inject({ method: 'GET', url: '/api/admin/audit-report', headers: auth(w.tokens.admin) })).json() as { rows: { detail: string }[] };
    expect(report.rows.some((x) => x.detail.includes(`run ${started.runId}`) && x.detail.includes('via AI assistant (MCP)'))).toBe(true);
  });

  it('tells the assistant what is wrong with its inputs, and refuses unknown tools', async () => {
    const name = ((await rpc('tools/list')).body.result.tools as { name: string }[]).find((x) => x.name.startsWith('run_release'))!.name;
    const bad = await rpc('tools/call', { name, arguments: {} });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toContain('invalid_inputs');
    expect((await rpc('tools/call', { name: 'run_nothing_000000', arguments: {} })).body.error?.code).toBe(-32602);
  });

  it('someone outside the Flow\'s team does not see it; a revoked token stops working', async () => {
    const team = (await api.inject({ method: 'POST', url: '/api/teams', headers: auth(w.tokens.admin), payload: { name: 'Elsewhere' } })).json() as { id: string };
    const f = await releaseFlow();
    const v = await w.app.flows.create('Elsewhere release', f.definition, w.admin, undefined, team.id);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    await setFlowMcp(w.db, w.admin, v.flowId, true);
    const bobTok = (await api.inject({ method: 'POST', url: '/api/me/mcp-tokens', headers: auth(w.tokens.bob), payload: { name: 'bob', scopes: { tools: { [`flow:${v.flowId}`]: 'run' } } } })).json();
    const names = async (t: string) => ((await api.inject({ method: 'POST', url: '/mcp', headers: auth(t), payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json().result.tools as { name: string }[]).map((x) => x.name);
    expect((await names(bobTok.token)).some((n) => n.startsWith('run_elsewhere_release'))).toBe(false);
    await api.inject({ method: 'DELETE', url: `/api/me/mcp-tokens/${bobTok.id}`, headers: auth(w.tokens.bob) });
    expect((await api.inject({ method: 'POST', url: '/mcp', headers: auth(bobTok.token), payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode).toBe(401);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { defaultTeamFor } from '../src/core/teams.js';
import { approveExampleModules, giveAllCredentials, makeWorld, type World } from './helpers.js';

/** The MCP gateway: admins offer approved module actions to agents as tools, pinned to what was approved. */
let w: World;
let api: ReturnType<typeof buildServer>;
let teamId = '';
const ids: Record<string, string> = {};
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let nextId = 1;
const rpc = async (token: string, method: string, params: unknown = {}) =>
  (await api.inject({ method: 'POST', url: '/mcp', headers: { ...auth(token), 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: nextId++, method, params } })).json() as { result?: any; error?: { code: number } };
const call = async (token: string, name: string, args: unknown) => {
  const r = (await rpc(token, 'tools/call', { name, arguments: args })).result;
  return { isError: !!r.isError, text: r.content[0].text as string };
};
const offer = (body: object, who = w.tokens.admin) => api.inject({ method: 'POST', url: '/api/gateway-tools', headers: auth(who), payload: body });
const agent = async (tools: Record<string, string>) =>
  (await api.inject({ method: 'POST', url: '/api/agents', headers: auth(w.tokens.alice), payload: { name: 'Gateway agent', scopes: { tools } } })).json() as { id: string; token: string };

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  api = buildServer(w.app);
  await giveAllCredentials(w, w.alice);
  teamId = await defaultTeamFor(w.db, w.alice.id);
  for (const r of (await w.db.query<{ id: string; name: string }>(`SELECT id, name FROM module_versions WHERE status = 'approved'`)).rows) ids[r.name] = r.id;
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('offering module actions', () => {
  it('only admins offer, only actions of approved modules, and each needs picking by the agent\'s person', async () => {
    expect((await offer({ moduleVersionId: ids.jira, action: 'search_issues', teamId, settings: { site: 'example.atlassian.net' } }, w.tokens.alice)).json()).toMatchObject({ error: 'admin_only' });
    expect((await offer({ moduleVersionId: ids.jira, action: 'no_such', teamId, settings: { site: 'example.atlassian.net' } })).json()).toMatchObject({ error: 'unknown_action' });
    expect((await offer({ moduleVersionId: ids.jira, action: 'search_issues', teamId, settings: { site: 'example.atlassian.net' } })).json()).toMatchObject({ key: 'action:jira/search_issues', name: 'app_jira_search_issues', changesData: false, status: 'active' });
    expect((await offer({ moduleVersionId: ids.slack, action: 'post_message', teamId })).json()).toMatchObject({ key: 'action:slack/post_message', changesData: true });

    const picker = (await api.inject({ method: 'GET', url: '/api/me/mcp-tools', headers: auth(w.tokens.alice) })).json() as { key: string; kind: string }[];
    expect(picker.filter((t) => t.kind === 'action').map((t) => t.key)).toEqual(['action:jira/search_issues', 'action:slack/post_message']);
    const none = await agent({});
    expect(((await rpc(none.token, 'tools/list')).result.tools as { name: string }[]).map((t) => t.name)).not.toContain('app_jira_search_issues');
    // Tokens made before scopes do not get them either.
    await w.db.query(`UPDATE mcp_tokens SET scopes = NULL WHERE id = $1`, [none.id]);
    expect(((await rpc(none.token, 'tools/list')).result.tools as { name: string }[]).map((t) => t.name)).not.toContain('app_jira_search_issues');
    expect((await api.inject({ method: 'POST', url: '/api/agents', headers: auth(w.tokens.alice), payload: { name: 'x', scopes: { tools: { 'action:jira/create_issue': 'run' } } } })).json()).toMatchObject({ error: 'unknown_tool' });
  });
});

describe('calling them', () => {
  it('a read runs as the person, through the broker, and is recorded and audited', async () => {
    const a = await agent({ 'action:jira/search_issues': 'run' });
    const tools = (await rpc(a.token, 'tools/list')).result.tools as { name: string; description: string; annotations: { readOnlyHint: boolean } }[];
    const t = tools.find((x) => x.name === 'app_jira_search_issues')!;
    expect(t.description).toContain('It only reads data.');
    expect(t.annotations.readOnlyHint).toBe(true);
    const r = await call(a.token, 'app_jira_search_issues', { jql: 'project = OPS' });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toHaveProperty('issues');
    const bad = await call(a.token, 'app_jira_search_issues', {});
    expect(bad.isError).toBe(true);
    const calls = (await api.inject({ method: 'GET', url: `/api/agents/${a.id}/calls`, headers: auth(w.tokens.alice) })).json();
    expect(calls).toMatchObject([{ tool: 'action:jira/search_issues', status: 'failed' }, { tool: 'action:jira/search_issues', status: 'done' }]);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'gateway.tool_called' AND actor_id = $1 AND outcome = 'ok'`, [w.alice.id])).rowCount).toBe(1);
  });

  it('a write with "ask me first" waits for the person, then posts', async () => {
    const a = await agent({ 'action:slack/post_message': 'ask' });
    w.fake.messages.length = 0;
    const asked = JSON.parse((await call(a.token, 'app_slack_post_message', { channel: 'C1', text: 'Deploy done' })).text);
    expect(asked).toMatchObject({ status: 'awaiting_confirmation' });
    expect(w.fake.messages).toHaveLength(0);
    const done = (await api.inject({ method: 'POST', url: `/api/agent-calls/${asked.callId}/decision`, headers: auth(w.tokens.alice), payload: { decision: 'confirmed' } })).json();
    expect(done).toMatchObject({ status: 'done', error: null });
    expect(w.fake.messages.map((m) => m.text)).toEqual(['Deploy done']);
  });

  it('someone outside the team it is offered to cannot use it', async () => {
    const team = (await api.inject({ method: 'POST', url: '/api/teams', headers: auth(w.tokens.admin), payload: { name: 'Elsewhere' } })).json() as { id: string };
    await offer({ moduleVersionId: ids.jira, action: 'search_issues', teamId: team.id, settings: { site: 'example.atlassian.net' } });
    const picker = (await api.inject({ method: 'GET', url: '/api/me/mcp-tools', headers: auth(w.tokens.alice) })).json() as { key: string }[];
    expect(picker.map((t) => t.key)).not.toContain('action:jira/search_issues');
    await offer({ moduleVersionId: ids.jira, action: 'search_issues', teamId, settings: { site: 'example.atlassian.net' } });
  });

  it('a tool that no longer matches what was approved is blocked until offered again, and a waiting call does not run', async () => {
    const a = await agent({ 'action:slack/post_message': 'ask' });
    const asked = JSON.parse((await call(a.token, 'app_slack_post_message', { channel: 'C1', text: 'later' })).text);
    // The pinned record no longer matches the module (as if the row were changed behind Dittoly's back).
    await w.db.query(`UPDATE gateway_tools SET pin_sha256 = 'x' WHERE module_name = 'slack'`);
    expect(((await rpc(a.token, 'tools/list')).result.tools as { name: string }[]).map((t) => t.name)).not.toContain('app_slack_post_message');
    const list = (await api.inject({ method: 'GET', url: '/api/gateway-tools', headers: auth(w.tokens.admin) })).json() as { key: string; status: string; changedReason: string }[];
    expect(list.find((t) => t.key === 'action:slack/post_message')).toMatchObject({ status: 'changed', changedReason: 'pin_mismatch' });
    w.fake.messages.length = 0;
    const r = (await api.inject({ method: 'POST', url: `/api/agent-calls/${asked.callId}/decision`, headers: auth(w.tokens.alice), payload: { decision: 'confirmed' } })).json();
    expect(r).toMatchObject({ status: 'failed', error: 'tool_no_longer_given' });
    expect(w.fake.messages).toHaveLength(0);
    // Offered again: pinned afresh.
    expect((await offer({ moduleVersionId: ids.slack, action: 'post_message', teamId })).json()).toMatchObject({ status: 'active' });
    const id = (await w.db.query(`SELECT id FROM gateway_tools WHERE module_name = 'slack'`)).rows[0].id;
    expect((await api.inject({ method: 'DELETE', url: `/api/gateway-tools/${id}`, headers: auth(w.tokens.admin) })).statusCode).toBe(204);
    expect(((await rpc(a.token, 'tools/list')).result.tools as { name: string }[]).map((t) => t.name)).not.toContain('app_slack_post_message');
  });
});

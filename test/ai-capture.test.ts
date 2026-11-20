import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/** AI work into Flows: an assistant saves a task it did as a draft Flow (and modules) over MCP; people approve it. */
let w: World;
let api: ReturnType<typeof buildServer>;
let token = '';
let nextId = 1;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const rpc = async (method: string, params: unknown = {}) => {
  const r = await api.inject({ method: 'POST', url: '/mcp', headers: { ...auth(token), 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: nextId++, method, params } });
  return r.json() as { result?: { content: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { message: string } };
};
const call = async (name: string, args: unknown) => {
  const r = (await rpc('tools/call', { name, arguments: args })).result!;
  const text = r.content[0]!.text;
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // the guide is plain text
  }
  return { isError: r.isError === true, text, data };
};

const slackDir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
const newModule = (version = '1.0.0', code = readFileSync(path.join(slackDir, 'module.mjs'), 'utf8')) => ({
  manifest: { ...JSON.parse(readFileSync(path.join(slackDir, 'manifest.json'), 'utf8')), name: 'teamchat', title: 'Team chat', version },
  code,
  tests: JSON.parse(readFileSync(path.join(slackDir, 'tests.json'), 'utf8')),
});

// The task the assistant did: look up the open bugs of a project in Jira.
const definition = {
  description: 'Lists the open bugs of a Jira project.',
  inputs: { type: 'object', properties: { project: { type: 'string', description: 'Jira project key', examples: ['OPS'] } }, required: ['project'] },
  form: { fields: [{ name: 'project', label: 'Project', widget: 'text' }] },
  moduleSettings: { jira: { site: 'example.atlassian.net' } },
  steps: [{ id: 'bugs', type: 'action', module: 'jira@1.1.0', action: 'search_issues', input: { jql: 'project = {{ inputs.project }} AND type = Bug AND status != Done' } }],
};
const test = (summary: unknown = 'Login fails') => ({
  name: 'What Jira answered',
  case: { inputs: { project: 'OPS' }, answers: { bugs: { output: { issues: [{ key: 'OPS-1', summary, status: 'Open' }] } } }, expect: { status: 'succeeded' } },
});
const flowCount = async () => (await w.db.query(`SELECT count(*)::int AS n FROM flows`)).rows[0].n as number;

beforeAll(async () => {
  w = await makeWorld({}, { mcpWaitMs: 0 });
  await approveExampleModules(w);
  api = buildServer(w.app);
  token = (await api.inject({ method: 'POST', url: '/api/me/mcp-tokens', headers: auth(w.tokens.alice), payload: { name: 'Claude on my laptop', scopes: { tools: {}, drafting: true } } })).json().token;
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('the guide', () => {
  it('is offered next to the Flow tools, with the rules and what the person can build from', async () => {
    const names = (await rpc('tools/list')).result!.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_flow_guide', 'save_as_flow', 'get_run']));
    const init = await rpc('initialize', { protocolVersion: '2025-11-25' });
    expect(JSON.stringify(init)).toContain('save_as_flow');
    const g = await call('get_flow_guide', {});
    expect(g.isError).toBe(false);
    expect(g.text).toContain('# Saving a task you did as a Flow');
    expect(g.text).toContain('"type": "action"');
    expect(g.text).toContain('"module":"jira@1.1.0","moduleTitle":"Jira Cloud","action":"search_issues"');
    expect(g.text).not.toContain('# Module rules');
    expect((await call('get_flow_guide', { newModules: true })).text).toContain('# Module rules');
  });
});

describe('saving a task as a Flow', () => {
  it('a draft with problems is not saved; the assistant gets the problems', async () => {
    const before = await flowCount();
    let r = await call('save_as_flow', { name: 'Open bugs', explanation: 'x', definition: { ...definition, steps: [{ ...definition.steps[0], action: 'search_everything' }] } });
    expect(r).toMatchObject({ isError: true, data: { saved: false } });
    expect(r.data.problems.join(' ')).toContain('jira@1.1.0 has no action search_everything');
    // Its test must pass too: an answer that does not fit what the action promises.
    r = await call('save_as_flow', { name: 'Open bugs', explanation: 'x', definition, tests: [test(42)] });
    expect(r.data.saved).toBe(false);
    expect(r.data.problems.join(' ')).toContain('test "What Jira answered"');
    r = await call('save_as_flow', { name: 'Open bugs', explanation: 'x', definition, secret: 'no' });
    expect(r.data.problems.join(' ')).toContain('Unrecognized key');
    expect(await flowCount()).toBe(before);
  });

  it('a valid draft is saved for approval, with its test, who drafted it and what the task cost', async () => {
    const r = await call('save_as_flow', {
      name: 'Open bugs', explanation: 'Reads the open bugs of a Jira project. It changes nothing.', definition, tests: [test()],
      aiUsage: { inputTokens: 42_000, outputTokens: 3_100, provider: 'anthropic', model: 'claude-test' }, assistant: 'Claude Code',
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ saved: true, flow: { name: 'Open bugs', version: 1, status: 'pending' }, modules: [], tests: { total: 1, passed: 1 } });
    expect(r.data.flow.url).toMatch(/\/flows\/[0-9a-f-]{36}$/);
    const flowId = r.data.flow.id;
    const flow = (await w.db.query(`SELECT created_by, ai_baseline_input_tokens, ai_baseline_output_tokens, ai_baseline_model, ai_baseline_source FROM flows WHERE id = $1`, [flowId])).rows[0];
    expect(flow).toMatchObject({ created_by: w.alice.id, ai_baseline_input_tokens: 42_000, ai_baseline_output_tokens: 3_100, ai_baseline_model: 'claude-test', ai_baseline_source: 'assistant' });
    // The approver sees who drafted it and why, and is told it waits.
    const versionId = (await w.app.flows.versions(flowId))[0]!.id;
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: auth(w.tokens.approver) })).json();
    expect(review.generation.assistant).toEqual({ name: 'Claude Code', token: 'Claude on my laptop', explanation: 'Reads the open bugs of a Jira project. It changes nothing.' });
    const told = (await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'flow_approval_needed' AND flow_version_id = $1`, [versionId])).rows[0].n;
    expect(told).toBeGreaterThan(0);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'mcp.flow_saved' AND subject_id = $1`, [versionId])).rowCount).toBe(1);
    // It cannot run before approval.
    await expect(w.app.engine.startRun(versionId, w.alice.id, { project: 'OPS' })).rejects.toThrow();
  });
});

describe('with a new module', () => {
  it('a module that fails its sandbox checks keeps nothing', async () => {
    const before = (await w.db.query(`SELECT count(*)::int AS n FROM module_versions`)).rows[0].n;
    const r = await call('save_as_flow', {
      name: 'Tell the team', explanation: 'x', modules: [newModule('1.0.0', 'const fs = require("fs");\nexport default {};')],
      definition: { inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', type: 'action', module: 'teamchat@1.0.0', action: 'post_message', input: { channel: 'C1', text: 'hi' } }] },
    });
    expect(r.data.saved).toBe(false);
    expect(r.data.problems.join(' ')).toContain('module teamchat:');
    expect((await w.db.query(`SELECT count(*)::int AS n FROM module_versions`)).rows[0].n).toBe(before);
  });

  it('new modules go to admins for review with the Flow; a version already taken is renumbered in the Flow too', async () => {
    const def = (ref: string) => ({
      inputs: { type: 'object', properties: { text: { type: 'string', description: 'What to say', examples: ['Hello'] } }, required: ['text'] },
      steps: [{ id: 'ok', type: 'approval' }, { id: 'post', type: 'action', module: ref, action: 'post_message', input: { channel: 'C1', text: '{{ inputs.text }}' } }],
    });
    const first = await call('save_as_flow', { name: 'Tell the team', explanation: 'Posts a message after a sign-off.', modules: [newModule()], definition: def('teamchat@1.0.0') });
    expect(first.data).toMatchObject({ saved: true, modules: [{ ref: 'teamchat@1.0.0', status: 'pending_review' }] });
    const mv = (await w.db.query(`SELECT origin, status, created_by, generation FROM module_versions WHERE name = 'teamchat' AND version = '1.0.0'`)).rows[0];
    expect(mv).toMatchObject({ origin: 'assistant', status: 'pending_review', created_by: w.alice.id });
    expect(mv.generation.assistant.token).toBe('Claude on my laptop');
    const id = (await w.db.query(`SELECT id FROM module_versions WHERE name = 'teamchat' AND version = '1.0.0'`)).rows[0].id;
    const review = (await api.inject({ method: 'GET', url: `/api/modules/${id}/review`, headers: auth(w.tokens.admin) })).json();
    expect(review).toMatchObject({ origin: 'assistant', generation: { assistant: { explanation: 'Posts a message after a sign-off.' } } });
    expect((await w.db.query(`SELECT 1 FROM notifications WHERE kind = 'module_review_needed' AND member_id = $1`, [w.admin.id])).rowCount).toBeGreaterThan(0);
    // The Flow cannot be approved while its module waits for review.
    const v1 = (await w.app.flows.versions(first.data.flow.id))[0]!;
    await expect(w.app.flows.decide(v1.id, w.approver, 'approved')).rejects.toThrow();

    // Saved again as a new version of the same Flow, with the module at a version that exists: it becomes 1.0.1 everywhere.
    const second = await call('save_as_flow', { name: 'Tell the team', explanation: 'Same, revised.', flowId: first.data.flow.id, modules: [newModule()], definition: def('teamchat@1.0.0') });
    expect(second.data).toMatchObject({ saved: true, flow: { version: 2 }, modules: [{ ref: 'teamchat@1.0.1' }] });
    const v2 = (await w.app.flows.versions(first.data.flow.id)).find((v) => v.version === 2)!;
    expect(JSON.stringify(v2.definition)).toContain('teamchat@1.0.1');
  });

  it('only the owner saves a new version of a Flow', async () => {
    const flowId = (await w.db.query(`SELECT id FROM flows WHERE name = 'Open bugs'`)).rows[0].id;
    const bobToken = (await api.inject({ method: 'POST', url: '/api/me/mcp-tokens', headers: auth(w.tokens.bob), payload: { name: 'Bob', scopes: { tools: {}, drafting: true } } })).json().token;
    const mine = token;
    token = bobToken;
    const r = await call('save_as_flow', { name: 'Open bugs', explanation: 'x', flowId, definition });
    token = mine;
    expect(r.data.saved).toBe(false);
    expect(r.data.problems.join(' ')).toMatch(/flow: (forbidden|not_team_member)/);
  });
});

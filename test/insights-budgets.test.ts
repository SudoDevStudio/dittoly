import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseFlow, releaseInputs, type World } from './helpers.js';

/** Run insights (failures, durations, waits on people, time saved) and AI budgets per team. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('run insights', () => {
  it('counts runs, failures by step, waits on sign-offs, and time saved', async () => {
    const v = await approvedReleaseFlow(w);
    await giveAllCredentials(w, w.alice);
    // One run signed off and finished.
    const ok = await w.app.engine.startRun(v.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    await w.db.query(`UPDATE run_steps SET started_at = now() - interval '2 hours' WHERE run_id = $1 AND step_id = 'signoff'`, [ok]);
    await w.app.engine.decideGate(ok, 'signoff', w.approver, 'approved');
    await w.app.worker.drain();
    // One run where Slack refuses the message.
    w.fake.mrs.forEach((m) => (m.state = 'merged'));
    w.fake.failNext['POST slack.com/api/chat.postMessage'] = [404];
    await w.app.engine.startRun(v.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    // A dry run is counted apart.
    await w.app.engine.startRun(v.id, w.alice.id, releaseInputs, { actorId: w.alice.id, dry: true });
    await w.app.worker.drain();

    let r = (await api.inject({ method: 'GET', url: '/api/insights?days=30', headers: auth(w.tokens.alice) })).json();
    const flow = r.flows.find((f: { flowId: string }) => f.flowId === v.flowId);
    expect(flow).toMatchObject({ runs: 3, succeeded: 1, failed: 1, dry: 1, successRate: 0.5, manualMinutes: null, savedMinutes: null });
    expect(flow.topFailures).toEqual([{ step: 'Tell the channel', errorType: 'http_404', count: 1 }]);
    expect(flow.waitingSeconds).toBeGreaterThanOrEqual(7190);
    expect(r.waits.find((x: { kind: string }) => x.kind === 'sign-off')).toMatchObject({ count: 1 });
    expect(r.totals.flowsWithoutManualTime).toBe(1);

    // Only the owner (or an admin) says how long it takes by hand.
    expect((await api.inject({ method: 'PUT', url: `/api/flows/${v.flowId}/manual-minutes`, headers: auth(w.tokens.bob), payload: { minutes: 30 } })).statusCode).toBe(403);
    expect((await api.inject({ method: 'PUT', url: `/api/flows/${v.flowId}/manual-minutes`, headers: auth(w.tokens.alice), payload: { minutes: 30 } })).statusCode).toBe(204);
    r = (await api.inject({ method: 'GET', url: '/api/insights?days=30', headers: auth(w.tokens.alice) })).json();
    expect(r.flows.find((f: { flowId: string }) => f.flowId === v.flowId)).toMatchObject({ manualMinutes: 30, savedMinutes: 30 });
    expect(r.totals.savedMinutes).toBe(30);
    expect((await api.inject({ method: 'GET', url: '/api/insights?days=0', headers: auth(w.tokens.alice) })).statusCode).toBe(400);
  });
});

describe('AI budgets', () => {
  const draft = async (token: string) => {
    ai.enqueue({ name: 'Release', definitionJson: JSON.stringify((await releaseFlow()).definition), explanation: 'x' });
    return api.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(token), payload: { request: 'gather approved tickets and notify the channel' } });
  };

  it("counts every call's tokens for the person's team, and stops calls once the team's monthly budget is used", async () => {
    expect((await draft(w.tokens.alice)).statusCode).toBe(201);
    let usage = (await api.inject({ method: 'GET', url: '/api/ai/usage', headers: auth(w.tokens.admin) })).json();
    const line = usage.lines.find((l: { purpose: string }) => l.purpose === 'flow');
    expect(line).toMatchObject({ team: 'Default', keyOwner: 'organization', provider: 'mock', model: 'mock', calls: 1, estimatedCost: null });
    expect(line.inputTokens).toBeGreaterThan(100);
    expect(usage.unpriced).toEqual(['mock/mock']);

    // Only organization admins set budgets and prices.
    const team = usage.teams.find((t: { team: string }) => t.team === 'Default') ?? usage.lines[0];
    const teamId = team.teamId;
    expect((await api.inject({ method: 'PUT', url: `/api/teams/${teamId}/ai-budget`, headers: auth(w.tokens.approver), payload: { monthlyTokens: 5000 } })).json()).toEqual({ error: 'admin_only' });
    expect((await api.inject({ method: 'PUT', url: `/api/teams/${teamId}/ai-budget`, headers: auth(w.tokens.admin), payload: { monthlyTokens: 1000, warnPercent: 50 } })).statusCode).toBe(204);
    expect((await api.inject({ method: 'PUT', url: '/api/ai/prices', headers: auth(w.tokens.admin), payload: { provider: 'mock', model: 'mock', inputPerMillion: 3, outputPerMillion: 15 } })).statusCode).toBe(204);
    usage = (await api.inject({ method: 'GET', url: '/api/ai/usage', headers: auth(w.tokens.admin) })).json();
    expect(usage.lines[0].estimatedCost).toBeGreaterThan(0);
    expect(usage.teams.find((t: { teamId: string }) => t.teamId === teamId)).toMatchObject({ budgetTokens: 1000 });

    // Already over the budget: the next call is refused before it reaches the AI.
    const before = ai.requests.length;
    const refused = await api.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'another one' } });
    expect(refused.json().error).toBe('ai_budget_exhausted');
    expect(ai.requests.length).toBe(before);

    // Raising it lets calls through again; team admins were told when it passed the warning share.
    await api.inject({ method: 'PUT', url: `/api/teams/${teamId}/ai-budget`, headers: auth(w.tokens.admin), payload: { monthlyTokens: 100_000, warnPercent: 1 } });
    expect((await draft(w.tokens.alice)).statusCode).toBe(201);
    const admins = await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'ai_budget_warning'`);
    expect(admins.rows[0].n).toBeGreaterThan(0);
  });

  it('shows team admins their own teams only, and members nothing', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/ai/usage', headers: auth(w.tokens.bob) })).json()).toEqual({ error: 'team_admin_only' });
    expect((await api.inject({ method: 'GET', url: '/api/ai/usage?month=2026-13', headers: auth(w.tokens.admin) })).statusCode).toBe(400);
  });
});

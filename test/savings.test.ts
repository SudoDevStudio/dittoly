import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, giveAllCredentials, makeWorld, releaseFlow, type World } from './helpers.js';

/** Proof of savings: tokens and money not spent asking an AI every time, per Flow and team, after what fixes cost. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let bugs = '';
type Savings = { totals: any; fixes: any; teams: any[]; flows: any[] };
const get = async (token: string, q = '') => (await api.inject({ method: 'GET', url: `/api/insights/savings?days=30${q}`, headers: auth(token) })).json() as Savings;

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  api = buildServer(w.app);
  const v = await w.app.flows.create('Open bugs', {
    inputs: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
    moduleSettings: { jira: { site: 'example.atlassian.net' } },
    steps: [{ id: 'bugs', type: 'action', module: 'jira@1.1.0', action: 'search_issues', input: { jql: 'project = {{ inputs.project }}' } }],
  }, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  bugs = v.flowId;
  for (let i = 0; i < 3; i++) await w.app.engine.startRun(v.id, w.alice.id, { project: 'OPS' });
  await w.app.engine.startRun(v.id, w.alice.id, { project: 'OPS' }, { actorId: w.alice.id, dry: true }); // dry runs save nothing
  await w.app.worker.drain();
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('the baseline', () => {
  it('Flows drafted by Dittoly\'s AI start from what drafting cost', async () => {
    ai.enqueue({ name: 'Release coordination', definitionJson: JSON.stringify((await releaseFlow()).definition), explanation: 'x' });
    const r = await api.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'coordinate the release' } });
    expect(r.statusCode, r.body).toBe(201);
    const row = (await w.db.query(`SELECT ai_baseline_source, ai_baseline_input_tokens, ai_baseline_output_tokens, ai_baseline_model FROM flows WHERE id = $1`, [r.json().flowId])).rows[0];
    expect(row.ai_baseline_source).toBe('drafting');
    expect(row.ai_baseline_input_tokens).toBeGreaterThan(0);
    expect(row.ai_baseline_model).toBe('mock');
  });

  it('only the owner (or an admin) sets it; it can be cleared', async () => {
    const body = { baseline: { inputTokens: 40_000, outputTokens: 2_000, provider: 'anthropic', model: 'claude-x' } };
    expect((await api.inject({ method: 'PUT', url: `/api/flows/${bugs}/ai-baseline`, headers: auth(w.tokens.bob), payload: body })).statusCode).toBe(403);
    expect((await api.inject({ method: 'PUT', url: `/api/flows/${bugs}/ai-baseline`, headers: auth(w.tokens.alice), payload: { baseline: null } })).statusCode).toBe(204);
    expect((await get(w.tokens.alice)).totals.flowsWithoutBaseline).toBeGreaterThanOrEqual(1);
    expect((await api.inject({ method: 'PUT', url: `/api/flows/${bugs}/ai-baseline`, headers: auth(w.tokens.alice), payload: body })).statusCode).toBe(204);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'flow.ai_baseline_set'`)).rowCount).toBe(2);
  });
});

describe('the savings', () => {
  it('tokens avoided by every successful run, minus what the runs\' own AI used; money once the model has a price', async () => {
    let s = await get(w.tokens.admin);
    let f = s.flows.find((x) => x.flowId === bugs);
    expect(f).toMatchObject({ succeeded: 3, avoidedTokens: 126_000, usedTokens: 0, savedTokens: 126_000, savedMoney: null, baseline: { source: 'owner', costPerRun: null } });
    expect(s.totals.unpricedBaselines).toContain('anthropic/claude-x');

    await api.inject({ method: 'PUT', url: '/api/ai/prices', headers: auth(w.tokens.admin), payload: { provider: 'anthropic', model: 'claude-x', inputPerMillion: 3, outputPerMillion: 15 } });
    // One run's AI step used some tokens; a module fix used some too.
    const run = (await w.db.query(`SELECT r.id FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE v.flow_id = $1 AND NOT r.dry LIMIT 1`, [bugs])).rows[0].id;
    await w.db.query(`INSERT INTO ai_usage (purpose, key_owner, provider, model, input_tokens, output_tokens, run_id) VALUES ('step', 'organization', 'anthropic', 'claude-x', 1000, 100, $1)`, [run]);
    await w.db.query(`INSERT INTO ai_usage (purpose, key_owner, provider, model, input_tokens, output_tokens) VALUES ('fix', 'organization', 'anthropic', 'claude-x', 10000, 1000)`);

    s = await get(w.tokens.admin);
    f = s.flows.find((x) => x.flowId === bugs);
    expect(f.baseline.costPerRun).toEqual({ amount: 0.15, currency: 'USD' });
    expect(f).toMatchObject({ usedTokens: 1100, savedTokens: 124_900, savedMoney: { USD: 0.4455 } });
    expect(s.fixes).toEqual({ tokens: 11_000, cost: { USD: 0.045 } });
    expect(s.totals.netMoney.USD).toBeCloseTo(s.totals.savedMoney.USD - 0.045, 4);
    expect(s.teams.find((t) => t.flows >= 1 && t.savedTokens >= 124_900)).toBeTruthy();
    // A baseline that names only the model is priced too.
    await api.inject({ method: 'PUT', url: `/api/flows/${bugs}/ai-baseline`, headers: auth(w.tokens.alice), payload: { baseline: { inputTokens: 40_000, outputTokens: 2_000, model: 'claude-x' } } });
    expect((await get(w.tokens.admin)).flows.find((x) => x.flowId === bugs).baseline.costPerRun).toEqual({ amount: 0.15, currency: 'USD' });
  });

  it('members see their teams\' Flows but not the organization\'s fix spending', async () => {
    const s = await get(w.tokens.alice);
    expect(s.flows.some((x) => x.flowId === bugs)).toBe(true);
    expect(s.fixes).toBeNull();
  });
});

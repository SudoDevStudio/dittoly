import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { evidencePack } from '../src/governance/evidence-pack.js';
import { makeWorld, type World } from './helpers.js';
import { AUTO_STOP_DEFAULTS, setAutoStopSettings } from '../src/governance/auto-stop.js';

/** Per-run AI cost caps (pause and ask), the cost forecast at approval, and cost per successful run. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const mails: { to: string; subject: string; text: string }[] = [];

// About 150 tokens per call with the mock (four characters a token): one step passes a cap of 100.
const long = 'Summarize the ticket for the support lead, in plain words, with what was asked and what is still open. '.repeat(5);
const definition = (extra: Record<string, unknown> = {}) => ({
  inputs: { type: 'object', properties: { ticket: { type: 'string' } } },
  ...extra,
  steps: [
    { id: 'first', type: 'ai', ai: 'organization', instruction: long, input: { ticket: '{{ inputs.ticket }}' }, output: 'text' },
    { id: 'second', type: 'ai', ai: 'organization', instruction: 'Now say it in five words.', input: { summary: '{{ steps.first.output.text }}' }, output: 'text' },
  ],
});

async function approved(name: string, def: Record<string, unknown>) {
  const v = await w.app.flows.create(name, def, w.alice);
  return w.app.flows.decide(v.id, w.approver, 'approved');
}

async function start(versionId: string, opts: { dry?: boolean } = {}) {
  ai.enqueue({ text: 'The printer is broken and nobody came yet.' });
  ai.enqueue({ text: 'Printer broken, still waiting.' });
  const id = await w.app.engine.startRun(versionId, w.alice.id, { ticket: 'T-9: printer broken' }, { actorId: w.alice.id, ...opts });
  await w.app.worker.drain();
  return id;
}

beforeAll(async () => {
  w = await makeWorld({}, { ai, mailer: { async send(m) { mails.push(m); } } });
  api = buildServer(w.app);
  // These runs reach their cost cap on purpose, again and again. Automatic stops are tested in auto-stop.test.ts.
  await setAutoStopSettings(w.db, w.admin, { ...AUTO_STOP_DEFAULTS, spendSpike: { ...AUTO_STOP_DEFAULTS.spendSpike, enabled: false } });
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('cost caps', () => {
  let capped = '';

  it('validates caps in the definition and shows them, with a forecast, on the review page', async () => {
    const bad = await api.inject({ method: 'POST', url: '/api/flows', headers: auth(w.tokens.alice), payload: { name: 'Bad', definition: definition({ costCap: {} }) } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toMatch(/cost cap needs tokens, amount or both/);
    const v = await approved('Capped summary', definition({ costCap: { tokens: 100 } }));
    capped = v.id;
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.approver) })).json();
    expect(review.costForecast).toMatchObject({ model: 'mock:default', basis: 'definition', tests: 0, priced: false, runs: null, cap: { tokens: 100 }, capFromOrg: false });
    expect(review.costForecast.estimate.tokens).toBeGreaterThan(200);
    expect(review.costForecast.steps.map((s: { stepId: string }) => s.stepId)).toEqual(['first', 'second']);
  });

  it('pauses the run like a sign-off when it reaches its cap, with the reason, and tells the owner and approvers', async () => {
    const runId = await start(capped);
    const view = await w.app.engine.runView(runId, w.alice);
    expect(view.status).toBe('waiting');
    expect(view.waitReason).toBe('cost_cap');
    expect(view.steps.map((s) => s.status)).toEqual(['succeeded', 'waiting']);
    expect(view.costCap).toMatchObject({ stepId: 'second', scope: 'run', cap: { tokens: 100 } });
    expect(view.costCap!.reason).toMatch(/^cost cap reached: spent \d[\d,]* tokens of 100 tokens$/);
    expect(view.aiSpend.tokens).toBeGreaterThanOrEqual(100);
    for (const m of [w.alice, w.approver]) {
      expect((await w.db.query(`SELECT 1 FROM notifications WHERE member_id = $1 AND kind = 'cost_cap_reached' AND run_id = $2`, [m.id, runId])).rowCount).toBe(1);
    }
    // It is in the owner's and the approver's queue, and not taken for a sign-off.
    const queue = (await api.inject({ method: 'GET', url: '/api/approvals', headers: auth(w.tokens.approver) })).json();
    expect(queue.filter((a: { runId?: string }) => a.runId === runId).map((a: { kind: string }) => a.kind)).toEqual(['cost_cap']);
    const own = (await api.inject({ method: 'GET', url: '/api/approvals', headers: auth(w.tokens.alice) })).json();
    expect(own.filter((a: { runId?: string }) => a.runId === runId)).toMatchObject([{ kind: 'cost_cap', stepId: 'second' }]);
    expect((await api.inject({ method: 'POST', url: `/api/runs/${runId}/steps/second/gate`, headers: auth(w.tokens.approver), payload: { decision: 'approved' } })).statusCode).toBe(409);
    // The usage is attributed to the run's step.
    const steps = (await w.db.query<{ step_id: string }>(`SELECT step_id FROM ai_usage WHERE run_id = $1`, [runId])).rows.map((r) => r.step_id);
    expect(steps).toEqual(['first']);
  });

  it('lets only the owner or a team approver allow more, which is recorded and audited, and resumes the run', async () => {
    const runId = (await w.db.query<{ id: string }>(`SELECT id FROM runs WHERE wait_reason = 'cost_cap'`)).rows[0]!.id;
    const allow = (token: string, payload: Record<string, unknown>) => api.inject({ method: 'POST', url: `/api/runs/${runId}/allow-spend`, headers: auth(token), payload });
    expect((await allow(w.tokens.bob, { tokens: 1000 })).statusCode).toBe(403);
    expect((await allow(w.tokens.approver, {})).statusCode).toBe(400);
    expect((await allow(w.tokens.approver, { tokens: 1000 })).statusCode).toBe(202);
    await w.app.worker.drain();
    const view = await w.app.engine.runView(runId, w.alice);
    expect(view.status).toBe('succeeded');
    expect(view.costCap).toBeNull();
    const row = (await w.db.query(`SELECT tokens::int, allowed_by FROM run_cost_allowances WHERE run_id = $1`, [runId])).rows[0];
    expect(row).toEqual({ tokens: 1000, allowed_by: w.approver.id });
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'run.cost_allowance_added' AND subject_id = $1 AND actor_id = $2`, [runId, w.approver.id])).rowCount).toBe(1);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'run.cost_cap_reached' AND subject_id = $1`, [`${runId}:second`])).rowCount).toBe(1);
    // The run's evidence pack shows the AI use per step and who allowed the extra spend.
    const pack = await evidencePack(w.app, runId, w.alice);
    expect(pack.ai.allowances).toEqual([expect.objectContaining({ tokens: 1000, by: w.approver.handle })]);
    expect(pack.ai.usage.map((u) => u.step)).toContain('second');
    // Nothing to allow once it is no longer waiting.
    expect((await allow(w.tokens.alice, { tokens: 10 })).json()).toEqual({ error: 'not_waiting_for_cost_cap' });
  });

  it('lets the owner allow more too, and an approver (not another member) cancel', async () => {
    const own = await start(capped);
    expect((await api.inject({ method: 'POST', url: `/api/runs/${own}/allow-spend`, headers: auth(w.tokens.alice), payload: { tokens: 500 } })).statusCode).toBe(202);
    await w.app.worker.drain();
    expect((await w.app.engine.runView(own, w.alice)).status).toBe('succeeded');

    const runId = await start(capped);
    expect((await api.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, headers: auth(w.tokens.bob) })).statusCode).toBe(403);
    expect((await api.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, headers: auth(w.tokens.approver) })).statusCode).toBe(204);
    expect((await w.app.engine.runView(runId, w.alice)).status).toBe('cancelled');
  });

  it('applies the organization default when the Flow sets no cap, with money from the price table', async () => {
    const v = await approved('Uncapped summary', definition());
    // Only admins set the default.
    expect((await api.inject({ method: 'PUT', url: '/api/ai/run-cap', headers: auth(w.tokens.approver), payload: { cap: { tokens: 100 } } })).statusCode).toBe(403);
    expect((await api.inject({ method: 'PUT', url: '/api/ai/run-cap', headers: auth(w.tokens.admin), payload: { cap: { amount: 0.0001 } } })).json()).toEqual({ cap: { amount: 0.0001 } });
    await api.inject({ method: 'PUT', url: '/api/ai/prices', headers: auth(w.tokens.admin), payload: { provider: 'mock', model: 'mock', inputPerMillion: 3, outputPerMillion: 15 } });
    const runId = await start(v.id);
    const view = await w.app.engine.runView(runId, w.alice);
    expect(view.waitReason).toBe('cost_cap');
    expect(view.costCap!.reason).toMatch(/^cost cap reached: spent 0\.\d{4} USD of 0\.0001 USD$/);
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.approver) })).json();
    expect(review.costForecast).toMatchObject({ priced: true, currency: 'USD', cap: { amount: 0.0001 }, capFromOrg: true });
    expect(review.costForecast.estimate.amount).toBeGreaterThan(0);
    await w.app.engine.cancel(runId, w.alice);
    expect((await api.inject({ method: 'PUT', url: '/api/ai/run-cap', headers: auth(w.tokens.admin), payload: { cap: null } })).json()).toEqual({ cap: null });
  });

  it('does not stop dry runs', async () => {
    const runId = await start(capped, { dry: true });
    expect((await w.app.engine.runView(runId, w.alice)).status).toBe('succeeded');
  });
});

describe('forecast and insights', () => {
  it("estimates from the Flow's tests, then from its real runs", async () => {
    const { id: versionId, flow_id: flowId } = (await w.db.query<{ id: string; flow_id: string }>(`SELECT v.id, v.flow_id FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE f.name = 'Capped summary'`)).rows[0]!;
    await w.app.flowTests.save(w.alice, flowId, {
      name: 'long ticket',
      case: { inputs: { ticket: 'x'.repeat(4000) }, answers: { first: { output: { text: 'y'.repeat(400) } }, second: { output: { text: 'short' } } } },
    });
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: auth(w.tokens.approver) })).json();
    const f = review.costForecast;
    expect(f).toMatchObject({ basis: 'tests', tests: 1, priced: true, currency: 'USD' });
    expect(f.runs.median.amount).toBeGreaterThan(0);
    // The 4,000-character ticket is about 1,000 tokens; the recorded answer about 100.
    expect(f.steps[0].inputTokens).toBeGreaterThan(1000);
    expect(f.steps[0].outputTokens).toBeGreaterThanOrEqual(100);
    // Three finished real runs (two succeeded, one cancelled); the dry run does not count.
    expect(f.runs.count).toBe(3);
    expect(f.runs.median.tokens).toBeGreaterThan(0);
    expect(f.runs.p90.tokens).toBeGreaterThanOrEqual(f.runs.median.tokens);
  });

  it('estimates a fix step from maxTurns at a typical turn, then from its real runs; approvers read the forecast in the request', async () => {
    await w.db.query(`UPDATE members SET email = 'approver@example.com' WHERE id = $1`, [w.approver.id]);
    const def = {
      inputs: { type: 'object', properties: { error: { type: 'string' } } },
      costCap: { tokens: 500_000 },
      steps: [{ id: 'fix', type: 'fix', ai: 'organization', repo: 'https://git.example.com/acme/shop.git', ref: 'main', test: 'node test.js', reproduce: 'node repro.js', instruction: 'Fix this production error: {{ inputs.error }}', maxTurns: 10 }],
    };
    const v = await w.app.flows.create('Fix forecast', def, w.alice);
    const forecast = async () => (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.approver) })).json().costForecast;
    const before = await forecast();
    expect(before.steps).toMatchObject([{ stepId: 'fix', type: 'fix', from: 'turns', turns: 10 }]);
    // Ten turns of at least 4,000 tokens sent and 400 back.
    expect(before.steps[0].inputTokens).toBeGreaterThanOrEqual(40_000);
    expect(before.steps[0].outputTokens).toBe(4000);
    expect(before.estimate.tokens).toBe(before.steps[0].inputTokens + 4000);

    // The request approvers get (here by email) carries the forecast.
    await w.app.worker.drain();
    const mail = mails.find((m) => m.to === 'approver@example.com' && m.text.startsWith('A new Flow version is waiting for your approval.'));
    expect(mail?.text).toContain(`Expected AI cost per run: about ${before.estimate.tokens.toLocaleString('en-US')} tokens (about ${before.estimate.amount} USD), from its definition. Fix steps: fix at all 10 turns. Cap per run: 500,000 tokens.`);

    // Once the step has real runs, their median replaces the turns (dry runs do not count).
    const approvedV = await w.app.flows.decide(v.id, w.approver, 'approved');
    for (const [tokens, dry] of [[1000, false], [3000, false], [5000, false], [900_000, true]] as const) {
      const run = (await w.db.query<{ id: string }>(`INSERT INTO runs (flow_version_id, run_as, status, dry, finished_at) VALUES ($1, $2, 'succeeded', $3, now()) RETURNING id`, [approvedV.id, w.alice.id, dry])).rows[0]!.id;
      await w.db.query(`INSERT INTO ai_usage (purpose, key_owner, provider, model, input_tokens, output_tokens, run_id, step_id) VALUES ('step', 'organization', 'mock', 'default', $1, 100, $2, 'fix'), ('step', 'organization', 'mock', 'default', $1, 100, $2, 'fix')`, [tokens, run]);
    }
    const after = await forecast();
    expect(after.steps).toMatchObject([{ stepId: 'fix', type: 'fix', from: 'runs', inputTokens: 6000, outputTokens: 200 }]);
    expect(after.estimate.tokens).toBe(6200);
  });

  it('shows the AI cost per successful run, failed and cancelled runs included', async () => {
    const r = (await api.inject({ method: 'GET', url: '/api/insights/savings?days=30', headers: auth(w.tokens.alice) })).json();
    const flow = r.flows.find((x: { name: string }) => x.name === 'Capped summary');
    const used = (await w.db.query<{ n: number }>(
      `SELECT sum(u.input_tokens + u.output_tokens)::int AS n FROM ai_usage u JOIN runs r ON r.id = u.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id WHERE f.name = 'Capped summary' AND NOT r.dry`,
    )).rows[0]!.n;
    expect(flow.succeeded).toBe(2);
    // Priced with the price table entered above (prices apply to past use too).
    expect(flow.aiCostPerSuccessfulRun).toMatchObject({ tokens: Math.round(used / 2), unpriced: false });
    expect(flow.aiCostPerSuccessfulRun.money.USD).toBeGreaterThan(0);
    const priced = r.flows.find((x: { name: string }) => x.name === 'Uncapped summary');
    expect(priced.aiCostPerSuccessfulRun).toBeNull();
  });
});

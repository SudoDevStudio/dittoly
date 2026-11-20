import { audit } from '../core/audit.js';
import { forbidden } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';
import type { AiStep, BrowseStep, CostCap, FixStep, FlowDefinition, Step } from '../flows/definition.js';
import type { FlowService } from '../flows/service.js';
import { playTest, type FlowTests } from '../flows/tests.js';
import { resolve, type TemplateScope } from '../flows/template.js';
import { toChecks, withFlowInstructions } from '../runtime/ai-step.js';
import { orgAiSteps, splitModel } from './models.js';

/**
 * What runs spend on AI, and the caps on it. A Flow can cap one run's spend (tokens and/or
 * money in the price table's currency) and each AI or browse step's; without its own cap a run
 * gets the organization's default, if an admin set one. A run that reaches a cap waits, like
 * for a sign-off, until its owner or an approver of its team allows more, or cancels it.
 * Dry runs have no caps. Team monthly budgets (metering.ts) still stop calls outright.
 */

export interface Price { input: number; output: number; currency: string }
export interface Spend { tokens: number; amount: number; currency: string | null }

export async function loadPrices(db: Queryable): Promise<Map<string, Price>> {
  const { rows } = await db.query<{ provider: string; model: string; input_per_million: string; output_per_million: string; currency: string }>(`SELECT * FROM ai_prices`);
  return new Map(rows.map((p) => [`${p.provider}/${p.model}`, { input: Number(p.input_per_million), output: Number(p.output_per_million), currency: p.currency }]));
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * The price of a pinned model ("provider:model"). Prices are entered per model as providers
 * report it; for a provider's own default ("default", the CLIs), the model it reported last.
 */
export async function priceOf(db: Queryable, prices: Map<string, Price>, pinned: string): Promise<Price | null> {
  const { provider, model } = splitModel(pinned);
  const direct = prices.get(`${provider}/${model}`);
  if (direct || model !== 'default') return direct ?? null;
  const last = (await db.query<{ model: string }>(`SELECT model FROM ai_usage WHERE provider = $1 AND key_owner = 'organization' ORDER BY at DESC LIMIT 1`, [provider])).rows[0];
  return (last && prices.get(`${provider}/${last.model}`)) ?? null;
}

/** Tokens a run (or one of its steps) used, and their cost where the model has a price. Unpriced calls count as tokens only. */
export async function runSpend(db: Queryable, runId: string, stepId?: string): Promise<Spend> {
  const { rows } = await db.query<{ provider: string; model: string; input: string; output: string }>(
    `SELECT provider, model, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output FROM ai_usage
     WHERE run_id = $1 AND ($2::text IS NULL OR step_id = $2) GROUP BY provider, model`,
    [runId, stepId ?? null],
  );
  const prices = rows.length ? await loadPrices(db) : new Map<string, Price>();
  const out: Spend = { tokens: 0, amount: 0, currency: null };
  for (const r of rows) {
    out.tokens += Number(r.input) + Number(r.output);
    const p = prices.get(`${r.provider}/${r.model}`);
    if (p) {
      out.amount += (Number(r.input) * p.input + Number(r.output) * p.output) / 1e6;
      out.currency ??= p.currency;
    }
  }
  out.amount = round(out.amount);
  return out;
}

// ---------------------------------------------------------------- the organization's default

const KEY = 'ai_run_cap';

export async function getDefaultRunCap(db: Queryable): Promise<CostCap | null> {
  const row = (await db.query<{ value: CostCap | null }>(`SELECT value FROM org_settings WHERE key = $1`, [KEY])).rows[0];
  return row?.value ?? null;
}

export async function setDefaultRunCap(db: Queryable, actor: Member, value: CostCap | null): Promise<CostCap | null> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (value === null) await db.query(`DELETE FROM org_settings WHERE key = $1`, [KEY]);
  else
    await db.query(
      `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [KEY, JSON.stringify(value), actor.id],
    );
  await audit(db, { actorId: actor.id, action: value ? 'ai.run_cap_set' : 'ai.run_cap_removed', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
  return value;
}

// ---------------------------------------------------------------- caps during a run

export interface CapReached {
  scope: 'run' | 'step';
  stepId: string;
  spent: Spend;
  /** The cap with what was allowed on top. */
  cap: CostCap;
  reason: string;
}

/** More spend people allowed for this run (raises the run's cap and each step's). */
export async function allowances(db: Queryable, runId: string): Promise<{ tokens: number; amount: number }> {
  const { rows } = await db.query<{ tokens: string | null; amount: string | null }>(`SELECT sum(tokens) AS tokens, sum(amount) AS amount FROM run_cost_allowances WHERE run_id = $1`, [runId]);
  return { tokens: Number(rows[0]?.tokens ?? 0), amount: Number(rows[0]?.amount ?? 0) };
}

const fmtTokens = (n: number) => `${n.toLocaleString('en-US')} tokens`;
const fmtMoney = (n: number, currency: string | null) => `${n.toFixed(n < 1 ? 4 : 2)} ${currency ?? ''}`.trim();

function reached(spent: Spend, cap: CostCap): string | null {
  if (cap.tokens !== undefined && spent.tokens >= cap.tokens) return `spent ${fmtTokens(spent.tokens)} of ${fmtTokens(cap.tokens)}`;
  if (cap.amount !== undefined && spent.amount >= cap.amount) return `spent ${fmtMoney(spent.amount, spent.currency)} of ${fmtMoney(cap.amount, spent.currency)}`;
  return null;
}

const raise = (cap: CostCap, more: { tokens: number; amount: number }): CostCap => ({
  ...(cap.tokens !== undefined ? { tokens: cap.tokens + more.tokens } : {}),
  ...(cap.amount !== undefined ? { amount: round(cap.amount + more.amount) } : {}),
});

/** The run's cap: the Flow's own, else the organization's default. */
export async function runCapOf(db: Queryable, def: FlowDefinition): Promise<CostCap | null> {
  return def.costCap ?? (await getDefaultRunCap(db));
}

/** Whether a step of a run may (still) ask its AI: null, or which cap is reached and why. */
export async function capReached(db: Queryable, runId: string, def: FlowDefinition, step: Step): Promise<CapReached | null> {
  const runCap = await runCapOf(db, def);
  const stepCap = step.type === 'ai' || step.type === 'browse' || step.type === 'fix' ? step.costCap : undefined;
  if (!runCap && !stepCap) return null;
  const more = await allowances(db, runId);
  if (runCap) {
    const spent = await runSpend(db, runId);
    const cap = raise(runCap, more);
    const why = reached(spent, cap);
    if (why) return { scope: 'run', stepId: step.id, spent, cap, reason: `cost cap reached: ${why}` };
  }
  if (stepCap) {
    const spent = await runSpend(db, runId, step.id);
    const cap = raise(stepCap, more);
    const why = reached(spent, cap);
    if (why) return { scope: 'step', stepId: step.id, spent, cap, reason: `cost cap reached for step ${step.id}: ${why}` };
  }
  return null;
}

// ---------------------------------------------------------------- forecast

/** Rough sizes, for a forecast only: about four characters a token. */
const SYSTEM_TOKENS = 150;
const ANSWER_TOKENS = { text: 250, checklist: 500, json: 800 } as const;
/** A browse step looks at the page a few times per check; each look sends up to 20,000 characters of page. */
const BROWSE_LOOKS_PER_CHECK = 4;
const BROWSE_LOOK_INPUT = 3000;
const BROWSE_LOOK_OUTPUT = 60;
/**
 * A fix step asks its AI once a turn, up to maxTurns: each turn sends the instructions, the task and
 * its data, the repository's top folder and the steps so far (the last two results in full), and
 * gets one action back (a file written is the largest). Until the Flow has real runs, every turn is counted.
 */
const FIX_TURN_INPUT = 4000;
const FIX_TURN_OUTPUT = 400;
const tokensOf = (v: unknown) => Math.ceil((typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length) / 4);

interface StepEstimate {
  stepId: string;
  type: 'ai' | 'browse' | 'fix';
  inputTokens: number;
  outputTokens: number;
  /** Fix steps: maxTurns times a typical turn, or the median of the step's real runs. */
  from?: 'turns' | 'runs';
  /** Fix steps estimated from turns: how many. */
  turns?: number;
}

function filled<T>(v: T, scope: TemplateScope | null): unknown {
  if (!scope) return v;
  try {
    return resolve(v, scope);
  } catch {
    // A template the test does not fill: count the template itself.
    return v;
  }
}

function estimateFix(step: FixStep, scope: TemplateScope | null): StepEstimate {
  const task = tokensOf(filled(step.instruction, scope)) + tokensOf(JSON.stringify(filled(step.context, scope), null, 1).slice(0, 40_000));
  return { stepId: step.id, type: 'fix', inputTokens: step.maxTurns * (FIX_TURN_INPUT + task), outputTokens: step.maxTurns * FIX_TURN_OUTPUT, from: 'turns', turns: step.maxTurns };
}

function estimateStep(step: AiStep | BrowseStep | FixStep, scope: TemplateScope | null, answer: unknown): StepEstimate {
  if (step.type === 'fix') return estimateFix(step, scope);
  if (step.type === 'ai') {
    let data: unknown = step.input;
    if (scope) {
      try {
        data = resolve(step.input, scope);
      } catch {
        // A template the test does not fill: count the template itself.
      }
    }
    const inputTokens = SYSTEM_TOKENS + tokensOf(step.instruction) + tokensOf(JSON.stringify(data, null, 1).slice(0, 60_000));
    return { stepId: step.id, type: 'ai', inputTokens, outputTokens: answer !== undefined ? tokensOf(answer) : ANSWER_TOKENS[step.output] };
  }
  let checks = Array.isArray(step.checks) ? step.checks.length : 5;
  if (scope) {
    try {
      checks = toChecks(resolve(step.checks, scope)).length || checks;
    } catch {
      // As above.
    }
  }
  const looks = checks * Math.min(step.maxActions, BROWSE_LOOKS_PER_CHECK);
  return { stepId: step.id, type: 'browse', inputTokens: looks * BROWSE_LOOK_INPUT, outputTokens: looks * BROWSE_LOOK_OUTPUT };
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : 0);

/**
 * What one run of a version is expected to cost: estimated from its tests (prompt sizes and
 * recorded answers; recorded token counts do not exist) or, without tests, from the definition;
 * and, once the Flow has run, the median and 90th percentile of its real runs.
 */
export async function costForecast(db: Queryable, flows: FlowService, tests: FlowTests, versionId: string, currentModel: string | null) {
  const v = await flows.getVersion(db, versionId);
  if (!v) return null;
  const prices = await loadPrices(db);
  const model = v.aiModel ?? currentModel;
  const price = model ? await priceOf(db, prices, model) : null;
  const priced = (input: number, output: number) => (price ? round((input * price.input + output * price.output) / 1e6) : null);

  const steps = orgAiSteps(v.definition);
  // Steps on the runner's own key are counted too, at the same sizes (priced like the organization's model).
  const all = v.definition.steps
    .filter((s): s is AiStep | BrowseStep | FixStep => s.type === 'ai' || s.type === 'browse' || s.type === 'fix')
    .map((s) => (s.type === 'ai' ? withFlowInstructions(s, v.definition.instructions) : s));
  const cases = await tests.casesFor(v.flowId);
  let modules = new Map();
  try {
    modules = await flows.pinnedModules(db, v.definition);
  } catch {
    // Unknown modules: their tests still give the AI steps' inputs where they reach them.
  }
  const perTest: StepEstimate[][] = [];
  for (const c of cases) {
    const played = playTest(v.definition, modules, c.case);
    const scope: TemplateScope = { inputs: c.case.inputs, steps: {} };
    for (const s of played.steps) if (s.status === 'succeeded' && s.output !== undefined) scope.steps[s.id] = { output: s.output };
    perTest.push(all.filter((s) => played.steps.find((p) => p.id === s.id)?.status === 'succeeded').map((s) => estimateStep(s, scope, c.case.answers[s.id]?.output)));
  }
  const fromTests = perTest.length > 0;
  // The test whose AI use is largest stands for a run (the forecast should not undersell).
  const basis = fromTests
    ? perTest.reduce((a, b) => (b.reduce((n, x) => n + x.inputTokens + x.outputTokens, 0) > a.reduce((n, x) => n + x.inputTokens + x.outputTokens, 0) ? b : a))
    : all.map((s) => estimateStep(s, null, undefined));
  // What a fix step spends depends on the repository and the bug: once it has real runs, their median replaces the turns.
  const fixIds = basis.filter((x) => x.type === 'fix').map((x) => x.stepId);
  if (fixIds.length) {
    const real = await db.query<{ step_id: string; input: string; output: string }>(
      `SELECT step_id, percentile_disc(0.5) WITHIN GROUP (ORDER BY input) AS input, percentile_disc(0.5) WITHIN GROUP (ORDER BY output) AS output
       FROM (SELECT u.run_id, u.step_id, sum(u.input_tokens)::bigint AS input, sum(u.output_tokens)::bigint AS output
             FROM ai_usage u JOIN runs r ON r.id = u.run_id JOIN flow_versions v ON v.id = r.flow_version_id
             WHERE v.flow_id = $1 AND u.step_id = ANY($2) AND NOT r.dry AND r.status IN ('succeeded', 'failed', 'cancelled') AND r.created_at > now() - interval '90 days'
             GROUP BY u.run_id, u.step_id) x
       GROUP BY step_id`,
      [v.flowId, fixIds],
    );
    for (const r of real.rows) {
      const i = basis.findIndex((x) => x.stepId === r.step_id);
      if (i >= 0) basis[i] = { stepId: r.step_id, type: 'fix', inputTokens: Number(r.input), outputTokens: Number(r.output), from: 'runs' };
    }
  }
  const input = basis.reduce((n, x) => n + x.inputTokens, 0);
  const output = basis.reduce((n, x) => n + x.outputTokens, 0);

  // Real runs of the Flow (any version, last 90 days, not dry runs), retries and failures included.
  const { rows } = await db.query<{ run_id: string; provider: string | null; model: string | null; input: string | null; output: string | null }>(
    `SELECT r.id AS run_id, u.provider, u.model, sum(u.input_tokens)::bigint AS input, sum(u.output_tokens)::bigint AS output
     FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id LEFT JOIN ai_usage u ON u.run_id = r.id
     WHERE v.flow_id = $1 AND NOT r.dry AND r.status IN ('succeeded', 'failed', 'cancelled') AND r.created_at > now() - interval '90 days'
     GROUP BY r.id, u.provider, u.model`,
    [v.flowId],
  );
  const runs = new Map<string, { tokens: number; amount: number; unpriced: boolean }>();
  for (const r of rows) {
    const cur = runs.get(r.run_id) ?? { tokens: 0, amount: 0, unpriced: false };
    if (r.provider) {
      cur.tokens += Number(r.input) + Number(r.output);
      const p = prices.get(`${r.provider}/${r.model}`);
      if (p) cur.amount += (Number(r.input) * p.input + Number(r.output) * p.output) / 1e6;
      else cur.unpriced = true;
    }
    runs.set(r.run_id, cur);
  }
  const list = [...runs.values()];
  const tokens = list.map((r) => r.tokens).sort((a, b) => a - b);
  const amounts = list.every((r) => !r.unpriced) ? list.map((r) => r.amount).sort((a, b) => a - b) : null;
  return {
    model,
    currency: price?.currency ?? null,
    /** Whether the model has a price: without one, tokens only. */
    priced: price !== null,
    basis: fromTests ? ('tests' as const) : ('definition' as const),
    tests: cases.length,
    estimate: { inputTokens: input, outputTokens: output, tokens: input + output, amount: priced(input, output) },
    steps: basis.map((x) => ({ ...x, amount: priced(x.inputTokens, x.outputTokens), organization: steps.some((s) => s.id === x.stepId) })),
    runs: list.length
      ? {
          count: list.length,
          median: { tokens: percentile(tokens, 0.5), amount: amounts ? round(percentile(amounts, 0.5)) : null },
          p90: { tokens: percentile(tokens, 0.9), amount: amounts ? round(percentile(amounts, 0.9)) : null },
        }
      : null,
    /** The cap a run of this version gets. */
    cap: await runCapOf(db, v.definition),
    capFromOrg: !v.definition.costCap,
  };
}

const tokenText = (n: number) => `${n.toLocaleString('en-US')} tokens`;
const moneyText = (n: number | null, currency: string | null) => (n === null ? '' : ` (about ${n} ${currency ?? ''})`.replace(/ \)$/, ')'));

/** The forecast in a sentence or two, for the approval request approvers get (email, Slack, Teams). */
export function forecastText(f: NonNullable<Awaited<ReturnType<typeof costForecast>>>): string | null {
  if (!f.steps.length && !f.runs) return null;
  const from = f.basis === 'tests' ? `from the largest of its ${f.tests} test${f.tests === 1 ? '' : 's'}` : 'from its definition';
  const fixes = f.steps.filter((s) => s.type === 'fix');
  const fixNote = fixes.length
    ? ` Fix steps: ${fixes.map((s) => (s.from === 'runs' ? `${s.stepId} from its real runs` : `${s.stepId} at all ${s.turns} turns`)).join(', ')}.`
    : '';
  const runs = f.runs ? ` Its last ${f.runs.count} real run${f.runs.count === 1 ? '' : 's'}: median ${tokenText(f.runs.median.tokens)}${moneyText(f.runs.median.amount, f.currency)}.` : '';
  const cap = f.cap
    ? ` Cap per run: ${[f.cap.tokens !== undefined ? tokenText(f.cap.tokens) : null, f.cap.amount !== undefined ? `${f.cap.amount} ${f.currency ?? ''}`.trim() : null].filter(Boolean).join(' or ')}${f.capFromOrg ? " (the organization's default)" : ''}.`
    : ' No cap per run.';
  return `Expected AI cost per run: about ${tokenText(f.estimate.tokens)}${moneyText(f.estimate.amount, f.currency)}, ${from}.${fixNote}${runs}${cap}`;
}

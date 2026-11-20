import { z } from 'zod';
import { audit } from '../core/audit.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';

/**
 * Proof of savings: what the Flows saved by not asking an AI every time.
 *
 * Each Flow has a baseline: the tokens doing its task with AI once cost. It is reported by the
 * assistant that saved the Flow ("assistant"), or is what Dittoly's AI used to draft it
 * ("drafting", a stand-in), or was set by its owner ("owner"). Every successful run (not dry
 * runs) avoided that much, minus the AI its own AI steps used. Prices come from the admins'
 * price table; a model without a price shows tokens only. The AI Dittoly used to fix modules
 * after apps changed is shown next to it, so the total is honest.
 */

const canSeeAll = (m: Member) => m.role === 'admin' || m.role === 'approver';
const VISIBLE = `($2 OR f.team_id IN (SELECT team_id FROM team_members WHERE member_id = $1))`;

type Money = Record<string, number>;
const addMoney = (a: Money, currency: string, n: number) => ((a[currency] = Math.round(((a[currency] ?? 0) + n) * 10_000) / 10_000), a);

export interface FlowSavings {
  flowId: string;
  name: string;
  team: string | null;
  succeeded: number;
  baseline: { inputTokens: number; outputTokens: number; provider: string | null; model: string | null; source: 'assistant' | 'drafting' | 'owner'; costPerRun: { amount: number; currency: string } | null } | null;
  /** Tokens the runs did not need: runs x baseline. */
  avoidedTokens: number;
  /** Tokens the runs' own AI steps used. */
  usedTokens: number;
  savedTokens: number;
  /** By currency; null when the baseline's model has no price. */
  savedMoney: Money | null;
  savedMinutes: number | null;
  /**
   * What its AI steps cost per successful run: all real runs' AI use (retries and failed runs
   * included) over the successful ones. Money leaves out models without a price.
   */
  aiCostPerSuccessfulRun: { tokens: number; money: Money; unpriced: boolean } | null;
}

interface Price { input: number; output: number; currency: string }

export async function savings(db: Queryable, member: Member, days: number, teamId?: string) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest('invalid_days');
  const args = [member.id, canSeeAll(member), days, teamId ?? null];
  const where = `${VISIBLE} AND ($4::uuid IS NULL OR f.team_id = $4)`;
  const since = `now() - make_interval(days => $3)`;

  const prices = new Map<string, Price>();
  for (const p of (await db.query<{ provider: string; model: string; input_per_million: string; output_per_million: string; currency: string }>(`SELECT * FROM ai_prices`)).rows) {
    prices.set(`${p.provider}/${p.model}`, { input: Number(p.input_per_million), output: Number(p.output_per_million), currency: p.currency });
  }
  const cost = (provider: string | null, model: string | null, input: number, output: number) => {
    // A baseline may name only the model: any provider's price for it will do.
    const p = !model ? undefined : provider ? prices.get(`${provider}/${model}`) : [...prices.entries()].find(([k]) => k.endsWith(`/${model}`))?.[1];
    return p ? { amount: (input * p.input + output * p.output) / 1_000_000, currency: p.currency } : null;
  };

  const flows = await db.query<{
    flow_id: string; name: string; team: string | null; manual_minutes: number | null; succeeded: number;
    bi: number | null; bo: number | null; bp: string | null; bm: string | null; bs: 'assistant' | 'drafting' | 'owner' | null;
  }>(
    `SELECT f.id AS flow_id, f.name, t.name AS team, f.manual_minutes,
            count(r.id) FILTER (WHERE r.status = 'succeeded' AND NOT r.dry)::int AS succeeded,
            f.ai_baseline_input_tokens AS bi, f.ai_baseline_output_tokens AS bo, f.ai_baseline_provider AS bp, f.ai_baseline_model AS bm, f.ai_baseline_source AS bs
     FROM flows f LEFT JOIN teams t ON t.id = f.team_id
     LEFT JOIN flow_versions v ON v.flow_id = f.id
     LEFT JOIN runs r ON r.flow_version_id = v.id AND r.created_at > ${since}
     WHERE ${where}
     GROUP BY f.id, t.name ORDER BY f.name`,
    args,
  );
  // What the runs' own AI steps used (anyone's key), by model so each can be priced.
  const used = await db.query<{ flow_id: string; provider: string; model: string; input: string; output: string }>(
    `SELECT f.id AS flow_id, u.provider, u.model, sum(u.input_tokens)::bigint AS input, sum(u.output_tokens)::bigint AS output
     FROM ai_usage u JOIN runs r ON r.id = u.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
     WHERE u.at > ${since} AND NOT r.dry AND ${where}
     GROUP BY f.id, u.provider, u.model`,
    args,
  );

  const out: FlowSavings[] = flows.rows.map((r) => {
    const mine = used.rows.filter((u) => u.flow_id === r.flow_id);
    const usedTokens = mine.reduce((n, u) => n + Number(u.input) + Number(u.output), 0);
    const baseline = r.bs && r.bi !== null && r.bo !== null
      ? { inputTokens: r.bi, outputTokens: r.bo, provider: r.bp, model: r.bm, source: r.bs, costPerRun: cost(r.bp, r.bm, r.bi, r.bo) }
      : null;
    const avoidedTokens = baseline ? r.succeeded * (baseline.inputTokens + baseline.outputTokens) : 0;
    let savedMoney: Money | null = null;
    if (baseline?.costPerRun) {
      savedMoney = addMoney({}, baseline.costPerRun.currency, r.succeeded * baseline.costPerRun.amount);
      for (const u of mine) {
        const c = cost(u.provider, u.model, Number(u.input), Number(u.output));
        if (c) addMoney(savedMoney, c.currency, -c.amount);
      }
    }
    // Every real run's AI (successful, failed, retried) is what the successful ones cost.
    const spent: Money = {};
    let unpriced = false;
    for (const u of mine) {
      const c = cost(u.provider, u.model, Number(u.input), Number(u.output));
      if (c) addMoney(spent, c.currency, c.amount);
      else unpriced = true;
    }
    const aiCostPerSuccessfulRun = r.succeeded && usedTokens
      ? { tokens: Math.round(usedTokens / r.succeeded), money: Object.fromEntries(Object.entries(spent).map(([c, n]) => [c, Math.round((n / r.succeeded) * 10_000) / 10_000])), unpriced }
      : null;
    return {
      flowId: r.flow_id,
      name: r.name,
      team: r.team,
      succeeded: r.succeeded,
      baseline,
      avoidedTokens,
      usedTokens,
      savedTokens: baseline ? avoidedTokens - usedTokens : 0,
      savedMoney,
      savedMinutes: r.manual_minutes === null ? null : r.manual_minutes * r.succeeded,
      aiCostPerSuccessfulRun,
    };
  });

  // AI spent fixing modules after apps changed (organization-wide; shown to admins and approvers).
  let fixes: { tokens: number; cost: Money } | null = null;
  if (canSeeAll(member) && !teamId) {
    fixes = { tokens: 0, cost: {} };
    for (const u of (await db.query<{ provider: string; model: string; input: string; output: string }>(
      `SELECT provider, model, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output FROM ai_usage
       WHERE purpose = 'fix' AND at > now() - make_interval(days => $1) GROUP BY provider, model`,
      [days],
    )).rows) {
      fixes.tokens += Number(u.input) + Number(u.output);
      const c = cost(u.provider, u.model, Number(u.input), Number(u.output));
      if (c) addMoney(fixes.cost, c.currency, c.amount);
    }
  }

  const sumMoney = (list: (Money | null)[]) => list.reduce<Money>((acc, m) => {
    for (const [c, n] of Object.entries(m ?? {})) addMoney(acc, c, n);
    return acc;
  }, {});
  const teams = new Map<string, FlowSavings[]>();
  for (const f of out) teams.set(f.team ?? '—', [...(teams.get(f.team ?? '—') ?? []), f]);
  const total = (list: FlowSavings[]) => ({
    runs: list.reduce((n, f) => n + f.succeeded, 0),
    avoidedTokens: list.reduce((n, f) => n + f.avoidedTokens, 0),
    usedTokens: list.reduce((n, f) => n + f.usedTokens, 0),
    savedTokens: list.reduce((n, f) => n + f.savedTokens, 0),
    savedMoney: sumMoney(list.map((f) => f.savedMoney)),
    savedMinutes: list.reduce((n, f) => n + (f.savedMinutes ?? 0), 0),
  });
  const totals = total(out);
  return {
    days,
    totals: {
      ...totals,
      /** After the AI spent on fixes. */
      netTokens: totals.savedTokens - (fixes?.tokens ?? 0),
      netMoney: fixes ? sumMoney([totals.savedMoney, Object.fromEntries(Object.entries(fixes.cost).map(([c, n]) => [c, -n]))]) : totals.savedMoney,
      /** Flows that ran but have no baseline: their AI savings are not counted. */
      flowsWithoutBaseline: out.filter((f) => f.succeeded > 0 && !f.baseline).length,
      /** Baselines whose model has no price in the price table. */
      unpricedBaselines: [...new Set(out.filter((f) => f.baseline && !f.baseline.costPerRun).map((f) => `${f.baseline!.provider ?? '?'}/${f.baseline!.model ?? '?'}`))],
    },
    fixes,
    teams: [...teams.entries()].map(([team, list]) => ({ team, flows: list.length, ...total(list) })),
    flows: out,
  };
}

export const baselineBody = z
  .object({
    baseline: z
      .object({
        inputTokens: z.number().int().min(0).max(100_000_000),
        outputTokens: z.number().int().min(0).max(100_000_000),
        provider: z.string().trim().max(40).optional(),
        model: z.string().trim().max(100).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** The Flow's owner (or an admin) sets what doing its task with AI would cost per run, or clears it. */
export async function setBaseline(db: Queryable, actor: Member, flowId: string, body: z.infer<typeof baselineBody>): Promise<void> {
  const owner = (await db.query<{ created_by: string }>(`SELECT created_by FROM flows WHERE id = $1`, [flowId])).rows[0];
  if (!owner) throw notFound('flow');
  if (owner.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
  const b = body.baseline;
  await db.query(
    `UPDATE flows SET ai_baseline_input_tokens = $2, ai_baseline_output_tokens = $3, ai_baseline_provider = $4, ai_baseline_model = $5, ai_baseline_source = $6 WHERE id = $1`,
    [flowId, b?.inputTokens ?? null, b?.outputTokens ?? null, b?.provider || null, b?.model || null, b ? 'owner' : null],
  );
  await audit(db, { actorId: actor.id, action: 'flow.ai_baseline_set', subjectType: 'flow', subjectId: flowId, outcome: 'ok' });
}

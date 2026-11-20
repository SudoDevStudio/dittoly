import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import { badRequest, forbidden } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { notify } from '../core/notify.js';
import { assertTeamAdmin, defaultTeamFor } from '../core/teams.js';
import { noteSpend } from '../governance/auto-stop.js';
import type { Queryable } from '../db/db.js';
import { AiError, type AiProvider, type JsonRequest } from './provider.js';

/**
 * AI use per team: every call's tokens are recorded (never prompts or answers), teams
 * can have a monthly token budget for the organization's AI, and an admin-entered price
 * table turns tokens into an estimated cost. Calls made with a runner's own key are
 * recorded but never limited.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

export type AiPurpose = 'step' | 'module' | 'flow' | 'plan' | 'command' | 'fix' | 'check' | 'other';

export interface AiContext {
  memberId?: string;
  teamId?: string;
  runId?: string;
  /** The run's step the call is for (per-step cost caps). */
  stepId?: string;
  purpose: AiPurpose;
  /** Adds up the tokens of the calls made inside (e.g. what drafting a Flow cost). */
  tally?: AiTally;
  /**
   * The model to draft with inside this context, when the Flow, module, plan or member chose one
   * (src/ai/draft-model.ts). The organization's model is used where nobody chose.
   */
  draftModel?: { provider?: string | undefined; model: string; effort?: string | undefined } | undefined;
}

export interface AiTally { input: number; output: number; provider?: string; model?: string; effort?: string; /** How many AI calls were made inside: a draft that took four needed three rounds of fixing. */ calls?: number }

const context = new AsyncLocalStorage<AiContext>();

/** Run `fn` with who and what AI calls inside it are for. */
export function withAiContext<T>(ctx: AiContext, fn: () => T): T {
  return context.run(ctx, fn);
}
/** For a callback-style hook: everything after `done` runs with this context. */
export function enterAiContext(ctx: AiContext, done: () => void): void {
  context.run(ctx, done);
}
export const currentAiContext = () => context.getStore();

/** The current calendar month (UTC), e.g. 2026-10. */
const monthOf = (d: Date) => d.toISOString().slice(0, 7);

export async function tokensThisMonth(db: Queryable, teamId: string, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ n: string | null }>(
    `SELECT sum(input_tokens + output_tokens)::bigint AS n FROM ai_usage
     WHERE team_id = $1 AND key_owner = 'organization' AND at >= date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [teamId, now],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Wraps a provider: refuses a call when the team's budget is used up (organization key),
 * and records the tokens each call used.
 */
export class MeteredProvider implements AiProvider {
  constructor(
    private readonly db: Queryable,
    private readonly inner: AiProvider,
    private readonly keyOwner: 'organization' | 'runner',
  ) {}

  get id() {
    return this.inner.id;
  }

  /** The wrapped provider's models (listing costs no tokens). */
  get listModels(): (() => Promise<string[]>) | undefined {
    return this.inner.listModels ? () => this.inner.listModels!() : undefined;
  }

  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    const ctx = context.getStore() ?? { purpose: 'other' as const };
    const teamId = ctx.teamId ?? (ctx.memberId ? await defaultTeamFor(this.db, ctx.memberId).catch(() => undefined) : undefined);
    if (teamId && this.keyOwner === 'organization') {
      const budget = (await this.db.query<{ monthly_tokens: string }>(`SELECT monthly_tokens FROM ai_budgets WHERE team_id = $1`, [teamId])).rows[0];
      if (budget && (await tokensThisMonth(this.db, teamId)) >= Number(budget.monthly_tokens)) throw new AiError('ai_budget_exhausted');
    }
    let usage: Usage | null = null;
    if (ctx.tally) {
      ctx.tally.calls = (ctx.tally.calls ?? 0) + 1;
      if (req.effort) ctx.tally.effort = req.effort;
      // What was asked for, in case the answer does not say (a CLI that reports no usage); the answer wins below.
      ctx.tally.provider = this.inner.id;
      ctx.tally.model = req.model ?? this.inner.configuredModel ?? ctx.tally.model;
    }
    try {
      return await this.inner.generateJson({ ...req, onUsage: (u) => (usage = u) });
    } finally {
      // Recorded even when the answer is refused or cut off: the tokens were used.
      await this.record(usage as Usage | null, ctx, teamId);
    }
  }

  private async record(u: Usage | null, ctx: AiContext, teamId: string | undefined): Promise<void> {
    if (u && ctx.tally) {
      ctx.tally.input += u.inputTokens;
      ctx.tally.output += u.outputTokens;
      ctx.tally.provider = this.inner.id;
      // The model the answer itself came from: "the newest Opus" is a different model month to month, and a draft
      // that only says "default" cannot be compared with anything.
      if (u.model) ctx.tally.model = u.model.slice(0, 100);
    }
    if (u) {
      await this.db
        .query(
          `INSERT INTO ai_usage (team_id, member_id, purpose, key_owner, provider, model, input_tokens, output_tokens, run_id, step_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [teamId ?? null, ctx.memberId ?? null, ctx.purpose, this.keyOwner, this.inner.id, (u.model ?? 'unknown').slice(0, 100), u.inputTokens, u.outputTokens, ctx.runId ?? null, ctx.stepId ?? null],
        )
        .catch(() => log.warn('ai_usage_not_recorded', {}));
      if (teamId && this.keyOwner === 'organization') await this.warnIfNear(teamId).catch(() => undefined);
      // A run's AI use counts toward its Flow's (and agent's) spend spike; a failed check never fails the call.
      if (ctx.runId) await noteSpend(this.db, ctx.runId, u.inputTokens + u.outputTokens).catch(() => log.warn('autostop_spend_not_counted', {}));
    }
  }

  /** Team admins are told once a month when the team passes its warning share. */
  private async warnIfNear(teamId: string): Promise<void> {
    const b = (await this.db.query<{ monthly_tokens: string; warn_percent: number; warned_month: string | null }>(
      `SELECT monthly_tokens, warn_percent, warned_month FROM ai_budgets WHERE team_id = $1`,
      [teamId],
    )).rows[0];
    const month = monthOf(new Date());
    if (!b || b.warned_month === month) return;
    if ((await tokensThisMonth(this.db, teamId)) * 100 < Number(b.monthly_tokens) * b.warn_percent) return;
    const claimed = await this.db.query(`UPDATE ai_budgets SET warned_month = $2 WHERE team_id = $1 AND warned_month IS DISTINCT FROM $2`, [teamId, month]);
    if (!claimed.rowCount) return;
    // The team's admins; a team without its own admins is the organization admins' to watch.
    let admins = (await this.db.query<{ member_id: string }>(`SELECT member_id FROM team_members WHERE team_id = $1 AND role = 'admin'`, [teamId])).rows;
    if (!admins.length) admins = (await this.db.query<{ member_id: string }>(`SELECT id AS member_id FROM members WHERE role = 'admin' AND NOT disabled`)).rows;
    for (const a of admins) await notify(this.db, a.member_id, 'ai_budget_warning');
  }
}

// ---------------------------------------------------------------- budgets and prices

export const budgetBody = z.object({ monthlyTokens: z.number().int().min(1000).max(1e12), warnPercent: z.number().int().min(1).max(100).default(80) }).strict();
export const priceBody = z
  .object({
    provider: z.string().min(1).max(40),
    model: z.string().min(1).max(100),
    inputPerMillion: z.number().min(0).max(100_000),
    outputPerMillion: z.number().min(0).max(100_000),
    currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  })
  .strict();

export async function setBudget(db: Queryable, actor: Member, teamId: string, body: z.infer<typeof budgetBody> | null): Promise<void> {
  // Budgets are set by organization admins: team admins could otherwise lift their own limit.
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (body === null) await db.query(`DELETE FROM ai_budgets WHERE team_id = $1`, [teamId]);
  else
    await db.query(
      `INSERT INTO ai_budgets (team_id, monthly_tokens, warn_percent, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id) DO UPDATE SET monthly_tokens = EXCLUDED.monthly_tokens, warn_percent = EXCLUDED.warn_percent, updated_by = EXCLUDED.updated_by, updated_at = now(), warned_month = NULL`,
      [teamId, body.monthlyTokens, body.warnPercent, actor.id],
    );
  await audit(db, { actorId: actor.id, action: body ? 'ai.budget_set' : 'ai.budget_removed', subjectType: 'team', subjectId: teamId, outcome: 'ok' });
}

export async function setPrice(db: Queryable, actor: Member, body: z.infer<typeof priceBody>): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  await db.query(
    `INSERT INTO ai_prices (provider, model, input_per_million, output_per_million, currency) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, model) DO UPDATE SET input_per_million = EXCLUDED.input_per_million, output_per_million = EXCLUDED.output_per_million, currency = EXCLUDED.currency, updated_at = now()`,
    [body.provider, body.model, body.inputPerMillion, body.outputPerMillion, body.currency],
  );
  await audit(db, { actorId: actor.id, action: 'ai.price_set', subjectType: 'org', subjectId: 'ai_prices', outcome: 'ok' });
}

export async function deletePrice(db: Queryable, actor: Member, provider: string, model: string): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  await db.query(`DELETE FROM ai_prices WHERE provider = $1 AND model = $2`, [provider, model]);
  await audit(db, { actorId: actor.id, action: 'ai.price_removed', subjectType: 'org', subjectId: 'ai_prices', outcome: 'ok' });
}

/**
 * Use for a month: per team (with budget), per purpose and per model, with the estimated
 * cost where a price is set. Admins see every team; team admins their own teams.
 */
export async function usageReport(db: Queryable, actor: Member, month?: string) {
  const m = month ?? monthOf(new Date());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw badRequest('invalid_month');
  const from = new Date(`${m}-01T00:00:00Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const visible = actor.role === 'admin' ? null : (await db.query<{ team_id: string }>(`SELECT team_id FROM team_members WHERE member_id = $1 AND role = 'admin'`, [actor.id])).rows.map((r) => r.team_id);
  if (visible && visible.length === 0) throw forbidden('team_admin_only');
  const { rows } = await db.query<{ team_id: string | null; team: string | null; purpose: string; key_owner: string; provider: string; model: string; calls: number; input: string; output: string }>(
    `SELECT u.team_id, t.name AS team, u.purpose, u.key_owner, u.provider, u.model, count(*)::int AS calls, sum(u.input_tokens)::bigint AS input, sum(u.output_tokens)::bigint AS output
     FROM ai_usage u LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.at >= $1 AND u.at < $2 AND ($3::uuid[] IS NULL OR u.team_id = ANY($3))
     GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 2 NULLS LAST, 3`,
    [from, to, visible],
  );
  const prices = new Map(
    (await db.query<{ provider: string; model: string; input_per_million: string; output_per_million: string; currency: string }>(`SELECT * FROM ai_prices`)).rows.map((p) => [
      `${p.provider}/${p.model}`,
      { input: Number(p.input_per_million), output: Number(p.output_per_million), currency: p.currency },
    ]),
  );
  const budgets = new Map((await db.query<{ team_id: string; monthly_tokens: string; warn_percent: number }>(`SELECT team_id, monthly_tokens, warn_percent FROM ai_budgets`)).rows.map((b) => [b.team_id, b]));
  const lines = rows.map((r) => {
    const price = prices.get(`${r.provider}/${r.model}`);
    const input = Number(r.input);
    const output = Number(r.output);
    return {
      teamId: r.team_id,
      team: r.team ?? 'Not attributed',
      purpose: r.purpose,
      keyOwner: r.key_owner,
      provider: r.provider,
      model: r.model,
      calls: r.calls,
      inputTokens: input,
      outputTokens: output,
      estimatedCost: price ? Math.round(((input * price.input + output * price.output) / 1e6) * 10_000) / 10_000 : null,
      currency: price?.currency ?? null,
    };
  });
  const teamIds = new Set([...lines.map((l) => l.teamId).filter((x): x is string => !!x), ...(visible ?? [...budgets.keys()])]);
  const teams = [];
  for (const id of teamIds) {
    const name = lines.find((l) => l.teamId === id)?.team ?? (await db.query<{ name: string }>(`SELECT name FROM teams WHERE id = $1`, [id])).rows[0]?.name ?? id;
    const b = budgets.get(id);
    const used = lines.filter((l) => l.teamId === id && l.keyOwner === 'organization').reduce((n, l) => n + l.inputTokens + l.outputTokens, 0);
    teams.push({ teamId: id, team: name, usedTokens: used, budgetTokens: b ? Number(b.monthly_tokens) : null, warnPercent: b?.warn_percent ?? null });
  }
  return {
    month: m,
    teams: teams.sort((a, b) => a.team.localeCompare(b.team)),
    lines,
    prices: [...prices.entries()].map(([k, p]) => ({ provider: k.split('/')[0]!, model: k.split('/').slice(1).join('/'), inputPerMillion: p.input, outputPerMillion: p.output, currency: p.currency })),
    /** Models used this month without a price: their cost is not estimated. */
    unpriced: [...new Set(lines.filter((l) => l.estimatedCost === null).map((l) => `${l.provider}/${l.model}`))],
  };
}

export async function assertCanSeeTeamUsage(db: Queryable, actor: Member, teamId: string): Promise<void> {
  await assertTeamAdmin(db, teamId, actor);
}

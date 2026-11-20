import { z } from 'zod';
import { audit } from '../core/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { notify, type NotificationKind } from '../core/notify.js';
import { withTx, type Db, type Queryable, type Tx } from '../db/db.js';
import type { FlowDefinition } from '../flows/definition.js';
import { DRIFT_ERRORS } from '../modules/health.js';
import { approvalAuthority, approversOf } from './approvals.js';

/**
 * Automatic stops: when a control keeps failing, the Flow or AI agent behind it stops until a
 * person looks. Four triggers, each on by default and tuned (or turned off) by admins for the
 * whole organization:
 * - blocked calls: the broker refused calls of a Flow's runs (undeclared host, a credential on the
 *   wrong host, a write in a read action, ...), or an agent called tools outside its scopes;
 * - spend spike: a Flow's or agent's AI tokens in the last hour far above its usual hour, or a
 *   Flow's runs reaching their cost cap again and again;
 * - failure spike: a Flow's runs failing far more than usual, or drift errors piling up for a
 *   module it uses;
 * - rejected sign-offs: people rejecting what the AI wrote, again and again (a sign the AI is
 *   being steered).
 * Events are counted where they happen (one small row each; counters are sums over the last
 * window). A stopped Flow starts no runs (`flow_stopped`), and its runs under way wait before
 * their next step (wait reason `auto_stop`); a stopped agent's tool calls are refused
 * (`agent_stopped`). An approver of the Flow's team, the agent's person, or an admin resumes it
 * with a reason. Dry runs never count; break-glass does not get past a stop.
 */

export type Trigger = 'blocked_calls' | 'spend_spike' | 'failure_spike' | 'rejected_signoffs';
export type SubjectType = 'flow' | 'agent';
export interface Subject { type: SubjectType; id: string }

export const TRIGGER_NAMES: Record<Trigger, string> = {
  blocked_calls: 'Blocked calls',
  spend_spike: 'Spend spike',
  failure_spike: 'Failure spike',
  rejected_signoffs: 'Rejected sign-offs',
};

const enabled = z.boolean();
const count = z.number().int().min(1).max(1000);
const minutes = z.number().int().min(1).max(1440);

export const autoStopSettingsSchema = z
  .object({
    blockedCalls: z.object({ enabled, count, minutes }).strict(),
    /** Within one hour: tokens `multiplier` times the usual hour (and at least `floorTokens`), or `costCapHits` runs at their cap. */
    spendSpike: z.object({ enabled, multiplier: z.number().min(1.5).max(100), floorTokens: z.number().int().min(1000).max(1e10), costCapHits: count }).strict(),
    /** `count` failed runs in `minutes` that are at least `percent` of the runs then; or `driftErrors` drift errors of one module. */
    failureSpike: z.object({ enabled, count, minutes, percent: z.number().int().min(1).max(100), driftErrors: count }).strict(),
    rejectedSignOffs: z.object({ enabled, count, minutes }).strict(),
  })
  .strict();
export type AutoStopSettings = z.infer<typeof autoStopSettingsSchema>;

export const AUTO_STOP_DEFAULTS: AutoStopSettings = {
  blockedCalls: { enabled: true, count: 3, minutes: 10 },
  spendSpike: { enabled: true, multiplier: 5, floorTokens: 200_000, costCapHits: 3 },
  failureSpike: { enabled: true, count: 5, minutes: 10, percent: 50, driftErrors: 5 },
  rejectedSignOffs: { enabled: true, count: 3, minutes: 60 },
};

const KEY = 'auto_stop';
/** The spend spike compares one hour with the usual hour. */
const SPEND_MINUTES = 60;
/** Codes that are a stop's own doing, not a failure of the Flow. */
const NOT_FAILURES = new Set(['flow_stopped']);
const EVIDENCE_EVENTS = 20;

export async function getAutoStopSettings(db: Queryable): Promise<AutoStopSettings> {
  const row = (await db.query<{ value: Partial<AutoStopSettings> }>(`SELECT value FROM org_settings WHERE key = $1`, [KEY])).rows[0];
  const v = row?.value ?? {};
  return {
    blockedCalls: { ...AUTO_STOP_DEFAULTS.blockedCalls, ...v.blockedCalls },
    spendSpike: { ...AUTO_STOP_DEFAULTS.spendSpike, ...v.spendSpike },
    failureSpike: { ...AUTO_STOP_DEFAULTS.failureSpike, ...v.failureSpike },
    rejectedSignOffs: { ...AUTO_STOP_DEFAULTS.rejectedSignOffs, ...v.rejectedSignOffs },
  };
}

export async function setAutoStopSettings(db: Queryable, actor: Member, value: AutoStopSettings): Promise<AutoStopSettings> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(value), actor.id],
  );
  const off = Object.entries(value).filter(([, t]) => !t.enabled).map(([k]) => k);
  await audit(db, { actorId: actor.id, action: 'autostop.settings_changed', subjectType: 'org', subjectId: KEY, outcome: 'ok', errorType: off.length ? `off:${off.join(',')}`.slice(0, 80) : undefined });
  return getAutoStopSettings(db);
}

/** The organization's thresholds, with the Flow's own counts and windows over them. */
function thresholds<K extends keyof AutoStopSettings>(s: AutoStopSettings, key: K, def?: FlowDefinition | null): AutoStopSettings[K] {
  const own = (def?.autoStop as Record<string, object | undefined> | undefined)?.[key];
  return { ...s[key], ...own, enabled: s[key].enabled };
}

// ---------------------------------------------------------------- state

export interface OpenStop { id: string; trigger: Trigger; trippedAt: Date; evidence: Evidence }

export async function openStop(db: Queryable, subject: Subject): Promise<OpenStop | null> {
  const r = (await db.query<{ id: string; trigger: Trigger; tripped_at: Date; evidence: Evidence }>(
    `SELECT id, trigger, tripped_at, evidence FROM autostops WHERE subject_type = $1 AND subject_id = $2 AND resumed_at IS NULL`,
    [subject.type, subject.id],
  )).rows[0];
  return r ? { id: r.id, trigger: r.trigger, trippedAt: r.tripped_at, evidence: r.evidence } : null;
}

export async function isStopped(db: Queryable, type: SubjectType, id: string): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM autostops WHERE subject_type = $1 AND subject_id = $2 AND resumed_at IS NULL`, [type, id])).rowCount !== 0;
}

/** Refused starts and calls say why, and who can resume. */
export const flowStopped = () =>
  new AppError('flow_stopped', 409, 'This Flow was stopped automatically because a control kept failing. An approver of its team or an admin can resume it under Automatic stops.');
export const agentStopped = () =>
  new AppError('agent_stopped', 409, 'This agent was stopped automatically because a control kept failing. Its person or an admin can resume it under Automatic stops in Dittoly.');

// ---------------------------------------------------------------- counting

interface EventRow { id: string; kind: string; detail: string | null; run_id: string | null; amount: string; at: Date }
export interface Evidence {
  /** What was crossed, in words: "3 blocked calls in 10 minutes (threshold 3)". */
  summary: string;
  threshold: Record<string, number>;
  observed: Record<string, number>;
  /** The events that crossed it, newest first (ids, codes, run ids; no data). */
  events: { id: string; kind: string; detail: string | null; runId: string | null; amount: number; at: Date }[];
  module?: string;
}

/** Counters start again after a resume. */
async function windowStart(db: Queryable, s: Subject, mins: number): Promise<Date> {
  const r = (await db.query<{ since: Date }>(
    `SELECT greatest(now() - make_interval(mins => $3), coalesce((SELECT max(resumed_at) FROM autostops WHERE subject_type = $1 AND subject_id = $2), '-infinity')) AS since`,
    [s.type, s.id, mins],
  )).rows[0]!;
  return r.since;
}

async function note(db: Queryable, s: Subject, trigger: Trigger, kind: string, e: { detail?: string | null; runId?: string | null; amount?: number } = {}): Promise<void> {
  await db.query(`INSERT INTO autostop_events (subject_type, subject_id, trigger, kind, detail, run_id, amount) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    s.type,
    s.id,
    trigger,
    kind,
    e.detail?.slice(0, 80) ?? null,
    e.runId ?? null,
    e.amount ?? 1,
  ]);
}

async function recent(db: Queryable, s: Subject, trigger: Trigger, since: Date, kinds: string[]): Promise<EventRow[]> {
  return (await db.query<EventRow>(
    `SELECT id::text, kind, detail, run_id, amount::text, at FROM autostop_events
     WHERE subject_type = $1 AND subject_id = $2 AND trigger = $3 AND kind = ANY($4) AND at > $5 ORDER BY at DESC, id DESC LIMIT ${EVIDENCE_EVENTS}`,
    [s.type, s.id, trigger, kinds, since],
  )).rows;
}

async function counted(db: Queryable, s: Subject, trigger: Trigger, since: Date, kinds: string[]): Promise<{ n: number; runs: number; sum: number }> {
  const r = (await db.query<{ n: number; runs: number; sum: string | null }>(
    `SELECT count(*)::int AS n, count(DISTINCT run_id)::int AS runs, sum(amount)::bigint::text AS sum FROM autostop_events
     WHERE subject_type = $1 AND subject_id = $2 AND trigger = $3 AND kind = ANY($4) AND at > $5`,
    [s.type, s.id, trigger, kinds, since],
  )).rows[0]!;
  return { n: r.n, runs: r.runs, sum: Number(r.sum ?? 0) };
}

const asEvidence = (rows: EventRow[]) => rows.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, runId: e.run_id, amount: Number(e.amount), at: e.at }));

/** A refused call: the broker blocked a run's request, or an agent called a tool outside its scopes. */
export async function noteBlockedCall(db: Queryable, e: { flowId?: string | null; agentId?: string | null; runId?: string; code: string; kind: 'violation' | 'scope_denied' }, def?: FlowDefinition | null): Promise<void> {
  const settings = await getAutoStopSettings(db);
  const subjects: Subject[] = [...(e.flowId ? [{ type: 'flow' as const, id: e.flowId }] : []), ...(e.agentId ? [{ type: 'agent' as const, id: e.agentId }] : [])];
  for (const s of subjects) {
    await note(db, s, 'blocked_calls', e.kind, { detail: e.code, runId: e.runId ?? null });
    const t = thresholds(settings, 'blockedCalls', s.type === 'flow' ? def : null);
    if (!t.enabled) continue;
    const since = await windowStart(db, s, t.minutes);
    const c = await counted(db, s, 'blocked_calls', since, ['violation', 'scope_denied']);
    if (c.n < t.count) continue;
    await trip(db, s, 'blocked_calls', {
      summary: `${c.n} blocked calls in ${t.minutes} minutes (threshold ${t.count})`,
      threshold: { count: t.count, minutes: t.minutes },
      observed: { count: c.n },
      events: asEvidence(await recent(db, s, 'blocked_calls', since, ['violation', 'scope_denied'])),
    });
  }
}

/** Tokens an AI call of a run used: counted for its Flow, and for the agent that started the run. Dry runs never count. */
export async function noteSpend(db: Queryable, runId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const run = (await db.query<{ dry: boolean; mcp_token_id: string | null; flow_id: string }>(
    `SELECT r.dry, r.mcp_token_id, v.flow_id FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE r.id = $1`,
    [runId],
  )).rows[0];
  if (!run || run.dry) return;
  const settings = await getAutoStopSettings(db);
  const t = settings.spendSpike;
  const subjects: Subject[] = [{ type: 'flow', id: run.flow_id }, ...(run.mcp_token_id ? [{ type: 'agent' as const, id: run.mcp_token_id }] : [])];
  for (const s of subjects) {
    await note(db, s, 'spend_spike', 'ai_tokens', { runId, amount: tokens });
    if (!t.enabled) continue;
    const since = await windowStart(db, s, SPEND_MINUTES);
    const hour = (await counted(db, s, 'spend_spike', since, ['ai_tokens'])).sum;
    // Below the floor nothing trips, so the usual hour is only worked out when it might.
    if (hour < t.floorTokens) continue;
    // The usual hour: the median of the hours with any spend in the 7 days before this hour.
    const base = (await db.query<{ median: number | null; hours: number }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY tokens) AS median, count(*)::int AS hours FROM (
         SELECT date_trunc('hour', at) AS h, sum(amount) AS tokens FROM autostop_events
         WHERE subject_type = $1 AND subject_id = $2 AND trigger = 'spend_spike' AND kind = 'ai_tokens'
           AND at > now() - interval '7 days' AND at <= now() - make_interval(mins => $3) GROUP BY 1) h`,
      [s.type, s.id, SPEND_MINUTES],
    )).rows[0]!;
    // Without a usual hour yet (a new Flow or agent), its first runs never trip this.
    if (base.median === null || base.hours === 0) continue;
    const median = Math.round(Number(base.median));
    if (hour < t.multiplier * median) continue;
    await trip(db, s, 'spend_spike', {
      summary: `${hour.toLocaleString('en-US')} AI tokens in the last hour, ${median ? `${Math.round((hour / median) * 10) / 10}x` : 'far above'} its usual hour of ${median.toLocaleString('en-US')} (threshold ${t.multiplier}x and at least ${t.floorTokens.toLocaleString('en-US')})`,
      threshold: { multiplier: t.multiplier, floorTokens: t.floorTokens },
      observed: { tokens: hour, usualHour: median, hours: base.hours },
      events: asEvidence(await recent(db, s, 'spend_spike', since, ['ai_tokens'])),
    });
  }
}

/** A run of the Flow reached its AI cost cap. */
export async function noteCostCap(db: Queryable, e: { flowId: string; runId: string }): Promise<void> {
  const s: Subject = { type: 'flow', id: e.flowId };
  await note(db, s, 'spend_spike', 'cost_cap', { runId: e.runId });
  const t = (await getAutoStopSettings(db)).spendSpike;
  if (!t.enabled) return;
  const since = await windowStart(db, s, SPEND_MINUTES);
  const c = await counted(db, s, 'spend_spike', since, ['cost_cap']);
  if (c.n < t.costCapHits) return;
  await trip(db, s, 'spend_spike', {
    summary: `runs reached their AI cost cap ${c.n} times in an hour (threshold ${t.costCapHits})`,
    threshold: { costCapHits: t.costCapHits, minutes: SPEND_MINUTES },
    observed: { costCapHits: c.n },
    events: asEvidence(await recent(db, s, 'spend_spike', since, ['cost_cap'])),
  });
}

/** A step of a run failed and the run paused. `module` is the module of an action step. */
export async function noteRunFailure(db: Queryable, e: { flowId: string; runId: string; errorType: string; module?: string | null }, def?: FlowDefinition | null): Promise<void> {
  if (NOT_FAILURES.has(e.errorType)) return;
  const s: Subject = { type: 'flow', id: e.flowId };
  const drift = !!e.module && DRIFT_ERRORS.has(e.errorType);
  await note(db, s, 'failure_spike', drift ? 'drift_error' : 'run_failed', { detail: drift ? `${e.module}:${e.errorType}` : e.errorType, runId: e.runId });
  const settings = await getAutoStopSettings(db);
  const t = thresholds(settings, 'failureSpike', def);
  if (!t.enabled) return;
  const since = await windowStart(db, s, t.minutes);
  const failed = (await counted(db, s, 'failure_spike', since, ['run_failed', 'drift_error'])).runs;
  const total = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE v.flow_id = $1 AND r.created_at > $2 AND NOT r.dry`,
    [e.flowId, since],
  )).rows[0]!.n;
  const share = Math.round((failed * 100) / Math.max(total, failed, 1));
  if (failed >= t.count && share >= t.percent) {
    await trip(db, s, 'failure_spike', {
      summary: `${failed} failed runs in ${t.minutes} minutes, ${share}% of its runs (threshold ${t.count} and ${t.percent}%)`,
      threshold: { count: t.count, minutes: t.minutes, percent: t.percent },
      observed: { failedRuns: failed, runs: Math.max(total, failed), percent: share },
      events: asEvidence(await recent(db, s, 'failure_spike', since, ['run_failed', 'drift_error'])),
    });
    return;
  }
  if (!drift) return;
  // Drift errors of the module, whichever Flow made the calls (src/modules/health.ts counts every call).
  const errors = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM module_calls WHERE module_name = $1 AND at > $2 AND error_type = ANY($3)`,
    [e.module, since, [...DRIFT_ERRORS]],
  )).rows[0]!.n;
  if (errors < t.driftErrors) return;
  await trip(db, s, 'failure_spike', {
    summary: `${errors} drift errors for module ${e.module} in ${t.minutes} minutes (threshold ${t.driftErrors})`,
    threshold: { driftErrors: t.driftErrors, minutes: t.minutes },
    observed: { driftErrors: errors },
    events: asEvidence(await recent(db, s, 'failure_spike', since, ['drift_error'])),
    module: e.module!,
  });
}

/** A person rejected a sign-off on what the AI wrote (a guarded step, not a sign-off step of the Flow). */
export async function noteRejectedSignOff(db: Queryable, e: { flowId: string; runId: string; stepId: string }, def?: FlowDefinition | null): Promise<void> {
  const s: Subject = { type: 'flow', id: e.flowId };
  await note(db, s, 'rejected_signoffs', 'sign_off_rejected', { detail: e.stepId, runId: e.runId });
  const t = thresholds(await getAutoStopSettings(db), 'rejectedSignOffs', def);
  if (!t.enabled) return;
  const since = await windowStart(db, s, t.minutes);
  const c = await counted(db, s, 'rejected_signoffs', since, ['sign_off_rejected']);
  if (c.n < t.count) return;
  await trip(db, s, 'rejected_signoffs', {
    summary: `${c.n} sign-offs on AI-written text rejected in ${t.minutes} minutes (threshold ${t.count})`,
    threshold: { count: t.count, minutes: t.minutes },
    observed: { count: c.n },
    events: asEvidence(await recent(db, s, 'rejected_signoffs', since, ['sign_off_rejected'])),
  });
}

// ---------------------------------------------------------------- trip and resume

/** Who hears of a stop: the Flow's owner, its team's approvers and the admins; or the agent's person and the admins. */
async function audience(db: Queryable, s: Subject): Promise<{ to: string[]; flowVersionId?: string }> {
  const admins = (await db.query<{ id: string }>(`SELECT id FROM members WHERE role = 'admin' AND NOT disabled`)).rows.map((r) => r.id);
  if (s.type === 'agent') {
    const person = (await db.query<{ member_id: string }>(`SELECT member_id FROM mcp_tokens WHERE id = $1`, [s.id])).rows[0]?.member_id;
    return { to: [...new Set([...(person ? [person] : []), ...admins])] };
  }
  const f = (await db.query<{ created_by: string; team_id: string; version_id: string | null }>(
    `SELECT f.created_by, f.team_id, (SELECT v.id FROM flow_versions v WHERE v.flow_id = f.id ORDER BY v.version DESC LIMIT 1) AS version_id FROM flows f WHERE f.id = $1`,
    [s.id],
  )).rows[0];
  if (!f) return { to: admins };
  return { to: [...new Set([f.created_by, ...(await approversOf(db, f.team_id, '')), ...admins])], ...(f.version_id ? { flowVersionId: f.version_id } : {}) };
}

async function tell(db: Queryable, s: Subject, kind: NotificationKind): Promise<void> {
  const { to, flowVersionId } = await audience(db, s);
  for (const id of to) await notify(db, id, kind, flowVersionId ? { flowVersionId } : {});
}

/** One open stop per Flow or agent: when two workers trip at once, the second finds the first. */
async function trip(db: Queryable, s: Subject, trigger: Trigger, evidence: Evidence): Promise<void> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO autostops (subject_type, subject_id, trigger, evidence) VALUES ($1, $2, $3, $4)
     ON CONFLICT (subject_type, subject_id) WHERE resumed_at IS NULL DO NOTHING RETURNING id`,
    [s.type, s.id, trigger, JSON.stringify(evidence)],
  );
  const id = r.rows[0]?.id;
  if (!id) return;
  if (s.type === 'flow') {
    await audit(db, { actorId: null, action: 'autostop.tripped', subjectType: 'flow', subjectId: s.id, outcome: 'denied', errorType: trigger, relatedId: id });
  } else {
    const person = (await db.query<{ member_id: string }>(`SELECT member_id FROM mcp_tokens WHERE id = $1`, [s.id])).rows[0]?.member_id ?? s.id;
    await audit(db, { actorId: null, action: 'autostop.tripped', subjectType: 'member', subjectId: person, outcome: 'denied', errorType: trigger, relatedId: s.id });
  }
  await tell(db, s, 'autostop_tripped');
  log.warn('autostop_tripped', { action: trigger, errorType: `${s.type}_stopped` });
}

export const resumeBody = z
  .object({
    reason: z.string().trim().min(10).max(500),
    /** Per paused run: go on, or be cancelled. Runs not listed go on. */
    runs: z.record(z.string().uuid(), z.enum(['continue', 'cancel'])).default({}),
  })
  .strict();

/** What a resume does to one paused run; the engine owns runs. */
export type SettleRun = (tx: Tx, runId: string, decision: 'continue' | 'cancel', actorId: string) => Promise<void>;

interface StopRow { id: string; subject_type: SubjectType; subject_id: string; trigger: Trigger; evidence: Evidence; tripped_at: Date; resumed_at: Date | null; resumed_by: string | null; resume_reason: string | null; run_decisions: Record<string, string> | null }

/** Who may resume: for a Flow an approver of its team (under the team rule) or an admin; for an agent its person or an admin. */
async function assertMayResume(db: Queryable, actor: Member, stop: StopRow): Promise<void> {
  if (actor.role === 'admin') return;
  if (stop.subject_type === 'agent') {
    const person = (await db.query<{ member_id: string }>(`SELECT member_id FROM mcp_tokens WHERE id = $1`, [stop.subject_id])).rows[0]?.member_id;
    if (person !== actor.id) throw forbidden('agent_person_or_admin_only');
    return;
  }
  const f = (await db.query<{ team_id: string; created_by: string }>(`SELECT team_id, created_by FROM flows WHERE id = $1`, [stop.subject_id])).rows[0];
  if (!f) throw notFound('flow');
  await approvalAuthority(db, actor, f.team_id, f.created_by);
}

async function mayResume(db: Queryable, actor: Member, stop: StopRow): Promise<boolean> {
  try {
    await assertMayResume(db, actor, stop);
    return true;
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

/** Runs of a Flow waiting because it was stopped. */
async function pausedRuns(db: Queryable, flowId: string): Promise<{ id: string; run_as: string; created_at: Date; step_id: string | null }[]> {
  return (await db.query<{ id: string; run_as: string; created_at: Date; step_id: string | null }>(
    `SELECT r.id, m.handle AS run_as, r.created_at, (SELECT s.step_id FROM run_steps s WHERE s.run_id = r.id AND s.status = 'waiting' ORDER BY s.idx LIMIT 1) AS step_id
     FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN members m ON m.id = r.run_as
     WHERE v.flow_id = $1 AND r.status = 'waiting' AND r.wait_reason = 'auto_stop' ORDER BY r.created_at`,
    [flowId],
  )).rows;
}

/** Resume a stopped Flow or agent, with a reason; each paused run goes on or is cancelled. Counters start again. */
export async function resumeStop(db: Db, settle: SettleRun, actor: Member, stopId: string, body: z.infer<typeof resumeBody>): Promise<void> {
  const s = await withTx(db, async (tx) => {
    const stop = (await tx.query<StopRow>(`SELECT * FROM autostops WHERE id = $1 FOR UPDATE`, [stopId])).rows[0];
    if (!stop) throw notFound('autostop');
    await assertMayResume(tx, actor, stop);
    if (stop.resumed_at) throw conflict('already_resumed');
    const decisions: Record<string, 'continued' | 'cancelled'> = {};
    if (stop.subject_type === 'flow') {
      const paused = await pausedRuns(tx, stop.subject_id);
      const unknown = Object.keys(body.runs).filter((id) => !paused.some((p) => p.id === id));
      if (unknown.length) throw badRequest('run_not_paused_by_stop', `not paused by this stop: ${unknown.join(', ')}`);
      // The stop ends first, so a run that goes on does not wait again at its next step.
      await tx.query(`UPDATE autostops SET resumed_at = now(), resumed_by = $2, resume_reason = $3 WHERE id = $1`, [stopId, actor.id, body.reason]);
      for (const p of paused) {
        const d = body.runs[p.id] ?? 'continue';
        await settle(tx, p.id, d, actor.id);
        decisions[p.id] = d === 'continue' ? 'continued' : 'cancelled';
      }
    } else {
      await tx.query(`UPDATE autostops SET resumed_at = now(), resumed_by = $2, resume_reason = $3 WHERE id = $1`, [stopId, actor.id, body.reason]);
    }
    await tx.query(`UPDATE autostops SET run_decisions = $2 WHERE id = $1`, [stopId, JSON.stringify(decisions)]);
    if (stop.subject_type === 'flow') {
      await audit(tx, { actorId: actor.id, action: 'autostop.resumed', subjectType: 'flow', subjectId: stop.subject_id, outcome: 'ok', errorType: stop.trigger, relatedId: stopId });
    } else {
      const person = (await tx.query<{ member_id: string }>(`SELECT member_id FROM mcp_tokens WHERE id = $1`, [stop.subject_id])).rows[0]?.member_id ?? stop.subject_id;
      await audit(tx, { actorId: actor.id, action: 'autostop.resumed', subjectType: 'member', subjectId: person, outcome: 'ok', errorType: stop.trigger, relatedId: stop.subject_id });
    }
    return { type: stop.subject_type, id: stop.subject_id } as Subject;
  });
  await tell(db, s, 'autostop_resumed');
}

// ---------------------------------------------------------------- lists

export interface StopView {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  /** The Flow's or agent's name. */
  name: string;
  /** The Flow's team, or the agent's person. */
  owner: string | null;
  trigger: Trigger;
  triggerName: string;
  evidence: Evidence;
  trippedAt: Date;
  resumedAt: Date | null;
  resumedBy: string | null;
  reason: string | null;
  runDecisions: Record<string, string> | null;
  /** Runs waiting for a decision (open Flow stops). */
  pausedRuns: { id: string; runAs: string; createdAt: Date; stepId: string | null }[];
  canResume: boolean;
}

async function view(db: Queryable, actor: Member, r: StopRow & { name: string | null; owner: string | null; resumed_by_handle: string | null }): Promise<StopView> {
  return {
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    name: r.name ?? r.subject_id,
    owner: r.owner,
    trigger: r.trigger,
    triggerName: TRIGGER_NAMES[r.trigger],
    evidence: r.evidence,
    trippedAt: r.tripped_at,
    resumedAt: r.resumed_at,
    resumedBy: r.resumed_by_handle,
    reason: r.resume_reason,
    runDecisions: r.run_decisions,
    pausedRuns: r.subject_type === 'flow' && !r.resumed_at ? (await pausedRuns(db, r.subject_id)).map((p) => ({ id: p.id, runAs: p.run_as, createdAt: p.created_at, stepId: p.step_id })) : [],
    canResume: !r.resumed_at && (await mayResume(db, actor, r)),
  };
}

const STOP_SELECT = `SELECT a.*, coalesce(f.name, t.name) AS name, coalesce(tm.name, pm.handle) AS owner, rb.handle AS resumed_by_handle
  FROM autostops a
  LEFT JOIN flows f ON a.subject_type = 'flow' AND f.id = a.subject_id LEFT JOIN teams tm ON tm.id = f.team_id
  LEFT JOIN mcp_tokens t ON a.subject_type = 'agent' AND t.id = a.subject_id LEFT JOIN members pm ON pm.id = t.member_id
  LEFT JOIN members rb ON rb.id = a.resumed_by`;

/**
 * Open stops and those resumed in the last 30 days. Admins see all; approvers the Flows they may
 * resume; everyone the Flows of their teams and their own agents.
 */
export async function listStops(db: Queryable, actor: Member): Promise<StopView[]> {
  const { rows } = await db.query<StopRow & { name: string | null; owner: string | null; resumed_by_handle: string | null }>(
    `${STOP_SELECT}
     WHERE (a.resumed_at IS NULL OR a.resumed_at > now() - interval '30 days')
       AND ($2 OR (a.subject_type = 'agent' AND t.member_id = $1)
            OR (a.subject_type = 'flow' AND ($3 OR f.created_by = $1 OR EXISTS (SELECT 1 FROM team_members x WHERE x.team_id = f.team_id AND x.member_id = $1))))
     ORDER BY a.resumed_at IS NOT NULL, a.tripped_at DESC LIMIT 200`,
    [actor.id, actor.role === 'admin', actor.role === 'approver'],
  );
  const out: StopView[] = [];
  for (const r of rows) {
    const v = await view(db, actor, r);
    // Approvers outside the team rule's reach see only what they may resume (and their own teams').
    if (actor.role === 'approver' && r.subject_type === 'flow' && !v.canResume && !r.resumed_at) {
      const own = await db.query(`SELECT 1 FROM flows f JOIN team_members x ON x.team_id = f.team_id WHERE f.id = $1 AND x.member_id = $2`, [r.subject_id, actor.id]);
      if (!own.rowCount) continue;
    }
    out.push(v);
  }
  return out;
}

/** The open stop of one Flow or agent, for its page's banner. */
export async function stopFor(db: Queryable, actor: Member, s: Subject): Promise<StopView | null> {
  const r = (await db.query<StopRow & { name: string | null; owner: string | null; resumed_by_handle: string | null }>(
    `${STOP_SELECT} WHERE a.subject_type = $1 AND a.subject_id = $2 AND a.resumed_at IS NULL`,
    [s.type, s.id],
  )).rows[0];
  return r ? view(db, actor, r) : null;
}

/** Stops of a Flow that paused this run (its run evidence pack). */
export async function stopsOfRun(db: Queryable, runId: string) {
  const { rows } = await db.query<StopRow & { resumed_by_handle: string | null }>(
    `SELECT a.*, rb.handle AS resumed_by_handle FROM autostops a LEFT JOIN members rb ON rb.id = a.resumed_by
     WHERE a.subject_type = 'flow' AND a.subject_id = (SELECT v.flow_id FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE r.id = $1)
       AND (a.run_decisions ? $1::text
            OR (a.resumed_at IS NULL AND EXISTS (SELECT 1 FROM runs r WHERE r.id = $1 AND r.status = 'waiting' AND r.wait_reason = 'auto_stop')))
     ORDER BY a.tripped_at`,
    [runId],
  );
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    triggerName: TRIGGER_NAMES[r.trigger],
    summary: r.evidence.summary,
    evidence: r.evidence,
    trippedAt: r.tripped_at,
    resumedAt: r.resumed_at,
    resumedBy: r.resumed_by_handle,
    reason: r.resume_reason,
    thisRun: r.run_decisions?.[runId] ?? (r.resumed_at ? null : 'waiting'),
  }));
}

/** Maintenance: counted events are kept a little longer than the spend spike looks back. */
export async function pruneAutoStopEvents(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM autostop_events WHERE at < now() - interval '8 days'`);
}

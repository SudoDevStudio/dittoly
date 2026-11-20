import { z } from 'zod';
import { audit } from '../core/audit.js';
import { AppError, badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';
import type { FlowDefinition } from '../flows/definition.js';
import type { Manifest } from '../modules/manifest.js';
import type { ModuleVersion } from '../modules/registry.js';

/**
 * Organization rules an admin sets in a form, enforced where things happen:
 * when a module or Flow is approved, when a run starts, and when someone asks a
 * teammate to run a step. A rule that blocks something says which rule and why.
 */

const moduleName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const hostPattern = z.string().regex(/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i, 'a host like api.acme.com or *.acme.com');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 09:00');

export const policyConfigs = {
  /** Flows whose steps CHANGE data (in this module, or any) need this many different approvers. */
  approvals_for_writes: z.object({ count: z.number().int().min(2).max(5), module: moduleName.optional() }).strict(),
  /** Modules may only reach hosts matching these patterns; anything else cannot be approved. */
  allowed_hosts: z.object({ patterns: z.array(hostPattern).min(1).max(50) }).strict(),
  /** Steps of this module (or any) may not be handed to a teammate. */
  no_delegation: z.object({ module: moduleName.optional() }).strict(),
  /** Runs that change data start only in these hours (the organization's time zone). */
  run_window: z
    .object({
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      from: hhmm,
      to: hhmm,
      timezone: z.string().min(1).max(60),
      writesOnly: z.boolean().default(true),
    })
    .strict(),
  /** At most this many runs per person per day (UTC). */
  max_runs_per_day: z.object({ count: z.number().int().min(1).max(10_000) }).strict(),
  /** Only approvers in a Flow's own team (or their stand-ins) approve it and sign off its runs; org admins may step in. */
  team_approvals: z.object({}).strict(),
  /** Approvals waiting this long remind the approvers, then go to the team's admins, then to org admins. */
  approval_deadlines: z
    .object({
      remindAfterHours: z.number().int().min(1).max(720),
      escalateAfterHours: z.number().int().min(1).max(720),
      orgAdminsAfterHours: z.number().int().min(1).max(1440).optional(),
    })
    .strict()
    .refine((c) => c.escalateAfterHours > c.remindAfterHours, { message: 'escalate after more hours than the reminder', path: ['escalateAfterHours'] })
    .refine((c) => c.orgAdminsAfterHours === undefined || c.orgAdminsAfterHours > c.escalateAfterHours, {
      message: 'org admins after more hours than the team admins',
      path: ['orgAdminsAfterHours'],
    }),
} as const;
export type PolicyKind = keyof typeof policyConfigs;
export const POLICY_KINDS = Object.keys(policyConfigs) as PolicyKind[];

export interface Policy {
  id: string;
  kind: PolicyKind;
  config: Record<string, unknown>;
  enabled: boolean;
  note: string | null;
  createdAt: Date;
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** One line an approver or runner can read: what the rule says. */
export function describePolicy(p: Pick<Policy, 'kind' | 'config'>): string {
  const c = p.config as {
    count?: number; module?: string; patterns?: string[]; days?: number[]; from?: string; to?: string; timezone?: string; writesOnly?: boolean;
    remindAfterHours?: number; escalateAfterHours?: number; orgAdminsAfterHours?: number;
  };
  switch (p.kind) {
    case 'approvals_for_writes':
      return `Flows that change data${c.module ? ` with ${c.module}` : ''} need ${c.count} different approvers.`;
    case 'allowed_hosts':
      return `Modules may only connect to ${(c.patterns ?? []).join(', ')}.`;
    case 'no_delegation':
      return c.module ? `Steps using ${c.module} cannot be handed to a teammate.` : 'No step can be handed to a teammate.';
    case 'run_window':
      return `${c.writesOnly ? 'Runs that change data' : 'Runs'} start only on ${(c.days ?? []).map((d) => DAY[d]).join(', ')}, ${c.from}–${c.to} (${c.timezone}).`;
    case 'max_runs_per_day':
      return `At most ${c.count} runs per person per day.`;
    case 'team_approvals':
      return "Only approvers in a Flow's own team (or their stand-ins) approve it and sign off its runs; org admins may step in.";
    case 'approval_deadlines':
      return `Approvals waiting ${c.remindAfterHours} h remind the approvers; after ${c.escalateAfterHours} h they go to the team's admins, after ${c.orgAdminsAfterHours ?? 2 * (c.escalateAfterHours ?? 0)} h to org admins.`;
  }
}

function violation(p: Policy, detail: string): AppError {
  return new AppError('policy_violation', 409, `${describePolicy(p)} ${detail}`.trim());
}

export async function listPolicies(db: Queryable, onlyEnabled = false): Promise<Policy[]> {
  const { rows } = await db.query<{ id: string; kind: PolicyKind; config: Record<string, unknown>; enabled: boolean; note: string | null; created_at: Date }>(
    `SELECT id, kind, config, enabled, note, created_at FROM policies ${onlyEnabled ? 'WHERE enabled' : ''} ORDER BY created_at`,
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, config: r.config, enabled: r.enabled, note: r.note, createdAt: r.created_at }));
}

export async function createPolicy(db: Queryable, actor: Member, body: unknown): Promise<Policy> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const base = z.object({ kind: z.enum(POLICY_KINDS as [PolicyKind, ...PolicyKind[]]), config: z.unknown(), note: z.string().max(300).optional() }).strict().safeParse(body);
  if (!base.success) throw badRequest('invalid_policy');
  const cfg = policyConfigs[base.data.kind].safeParse(base.data.config);
  if (!cfg.success) throw badRequest('invalid_policy', cfg.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; '));
  if (base.data.kind === 'run_window') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: (cfg.data as { timezone: string }).timezone });
    } catch {
      throw badRequest('invalid_policy', 'timezone: not a known IANA time zone');
    }
  }
  const { rows } = await db.query<{ id: string }>(`INSERT INTO policies (kind, config, note, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [
    base.data.kind,
    JSON.stringify(cfg.data),
    base.data.note ?? null,
    actor.id,
  ]);
  await audit(db, { actorId: actor.id, action: 'policy.created', subjectType: 'policy', subjectId: rows[0]!.id, outcome: 'ok' });
  return (await listPolicies(db)).find((p) => p.id === rows[0]!.id)!;
}

export async function setPolicyEnabled(db: Queryable, actor: Member, id: string, enabled: boolean): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rowCount } = await db.query(`UPDATE policies SET enabled = $2 WHERE id = $1`, [id, enabled]);
  if (!rowCount) throw notFound('policy');
  await audit(db, { actorId: actor.id, action: enabled ? 'policy.enabled' : 'policy.disabled', subjectType: 'policy', subjectId: id, outcome: 'ok' });
}

export async function deletePolicy(db: Queryable, actor: Member, id: string): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rowCount } = await db.query(`DELETE FROM policies WHERE id = $1`, [id]);
  if (!rowCount) throw notFound('policy');
  await audit(db, { actorId: actor.id, action: 'policy.deleted', subjectType: 'policy', subjectId: id, outcome: 'ok' });
}

// ---------------------------------------------------------------- checks

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h.endsWith(`.${base}`) || h === base;
  }
  return h === p || h.replace(/:\d+$/, '') === p;
}

/** Every host a module can reach (settings placeholders cannot be checked until set, and are reported). */
function moduleHosts(m: Manifest): string[] {
  return [...m.hosts, ...(m.browser?.hosts ?? []), ...(m.endpoints ?? []).map((e) => e.host)];
}

/**
 * Whether a host stays inside the allowed patterns. A host setting ("{{settings.site}}") can later
 * be set to anything its reviewed pattern allows, so that whole pattern must be inside an allowed one.
 */
function withinPatterns(host: string, m: Manifest, patterns: string[]): boolean {
  if (!host.includes('{{')) return patterns.some((pat) => hostMatches(host, pat));
  const id = /^\{\{\s*settings\.([A-Za-z0-9_]+)\s*\}\}$/.exec(host)?.[1];
  const setting = m.settings?.find((s) => s.id === id && s.type === 'host') as { pattern?: string } | undefined;
  if (!setting?.pattern) return false;
  const p = setting.pattern;
  const wild = /^\*+\./.test(p);
  // A wildcard setting needs a wildcard rule covering it; an exact one, any rule matching it.
  return patterns.some((pat) => hostMatches(p.replace(/^\*+\./, 'any.'), pat) && (!wild || pat.startsWith('*.')));
}

/** Before a host setting is saved: the host must be inside every allowed-hosts rule. */
export async function checkAllowedHost(db: Queryable, host: string): Promise<void> {
  for (const p of (await listPolicies(db, true)).filter((x) => x.kind === 'allowed_hosts')) {
    if (!(p.config as { patterns: string[] }).patterns.some((pat) => hostMatches(host, pat))) throw violation(p, `${host} is outside it.`);
  }
}

/** Before a module is approved. */
export async function checkModuleApproval(db: Queryable, manifest: Manifest): Promise<void> {
  for (const p of (await listPolicies(db, true)).filter((x) => x.kind === 'allowed_hosts')) {
    const patterns = (p.config as { patterns: string[] }).patterns;
    const outside = moduleHosts(manifest).filter((h) => !withinPatterns(h, manifest, patterns));
    if (outside.length) throw violation(p, `This module reaches ${outside.join(', ')}.`);
    if (manifest.publicWeb === 'read') throw violation(p, 'This module may read any public website.');
  }
}

/**
 * Whether a Flow changes anything (for one module's rule: through that module). Besides write
 * actions, table writes, app steps (they run a branch's code) and Flow steps count: a child Flow
 * is judged as changing data, the safe side for a rule.
 */
const writesWith = (def: FlowDefinition, modules: Map<string, ModuleVersion>, only?: string) =>
  def.steps.some((s) => {
    if (!only && ((s.type === 'table' && s.op !== 'get' && s.op !== 'list') || s.type === 'app' || s.type === 'fix' || s.type === 'flow')) return true;
    if (s.type !== 'action') return false;
    const mv = modules.get(s.module);
    if (!mv || (only && mv.name !== only)) return false;
    return mv.manifest.actions.find((a) => a.name === s.action)?.effect === 'write';
  });

/** How many different approvers a Flow version needs (1 unless a rule says more). */
export async function requiredApprovals(db: Queryable, def: FlowDefinition, modules: Map<string, ModuleVersion>): Promise<{ count: number; because: string | null }> {
  let best = { count: 1, because: null as string | null };
  for (const p of (await listPolicies(db, true)).filter((x) => x.kind === 'approvals_for_writes')) {
    const c = p.config as { count: number; module?: string };
    if (c.count > best.count && writesWith(def, modules, c.module)) best = { count: c.count, because: describePolicy(p) };
  }
  return best;
}

/** Before a Flow version is approved: hosts of its modules, and no delegation where a rule forbids it. */
export async function checkFlowApproval(db: Queryable, def: FlowDefinition, modules: Map<string, ModuleVersion>): Promise<void> {
  for (const mv of modules.values()) await checkModuleApproval(db, mv.manifest);
  for (const p of (await listPolicies(db, true)).filter((x) => x.kind === 'no_delegation')) {
    const only = (p.config as { module?: string }).module;
    const step = def.steps.find((s) => s.type === 'action' && s.delegateTo && (!only || modules.get(s.module)?.name === only));
    if (step) throw violation(p, `Step "${step.id}" hands its action to a teammate.`);
  }
}

/** Before a teammate is asked to run a step. */
export async function checkDelegation(db: Queryable, moduleName: string): Promise<void> {
  for (const p of (await listPolicies(db, true)).filter((x) => x.kind === 'no_delegation')) {
    const only = (p.config as { module?: string }).module;
    if (!only || only === moduleName) throw violation(p, '');
  }
}

function localParts(now: Date, timezone: string): { day: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Before a run starts (any way: the portal, a schedule, a webhook, a URL, a phone, a Super Flow). */
export async function checkRunStart(
  db: Queryable,
  runAs: string,
  def: FlowDefinition,
  modules: Map<string, ModuleVersion>,
  now = new Date(),
): Promise<void> {
  const policies = await listPolicies(db, true);
  for (const p of policies.filter((x) => x.kind === 'run_window')) {
    const c = p.config as { days: number[]; from: string; to: string; timezone: string; writesOnly: boolean };
    if (c.writesOnly && !writesWith(def, modules)) continue;
    const { day, minutes } = localParts(now, c.timezone);
    const [fh, fm] = c.from.split(':').map(Number);
    const [th, tm] = c.to.split(':').map(Number);
    const from = fh! * 60 + fm!;
    const to = th! * 60 + tm!;
    const inHours = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
    if (!c.days.includes(day) || !inHours) throw violation(p, 'It is outside those hours now.');
  }
  for (const p of policies.filter((x) => x.kind === 'max_runs_per_day')) {
    const c = p.config as { count: number };
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runs WHERE run_as = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND NOT dry`,
      [runAs],
    );
    if (rows[0]!.n >= c.count) throw violation(p, 'The limit for today is reached.');
  }
}

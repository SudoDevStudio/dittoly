import { z } from 'zod';
import { audit } from '../core/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { canApprove, type Member } from '../core/members.js';
import { notify, type NotificationKind, type NotificationRefs } from '../core/notify.js';
import type { Queryable } from '../db/db.js';
import type { FlowDefinition } from '../flows/definition.js';
import { listPolicies } from './policies.js';

/**
 * Who may approve, who is told, and what happens when nobody decides:
 * - stand-ins: "while I'm away, Sam approves for me", between two dates;
 * - team approvals (a rule): only approvers in a Flow's own team approve it and sign off its
 *   runs, or a stand-in for one of them; an org admin may step in, and that is recorded;
 * - deadlines (a rule, or set on a sign-off step): remind the approvers, then tell the team's
 *   admins, then org admins. Nothing is rejected on its own.
 */

// ---------------------------------------------------------------- stand-ins

export interface Standin {
  id: string;
  memberId: string;
  member: string;
  standinId: string;
  standin: string;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  active: boolean;
}

const MAX_DAYS = 366;

const standinBody = z
  .object({
    memberId: z.string().uuid().optional(),
    standinId: z.string().uuid(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    note: z.string().max(300).optional(),
  })
  .strict();

/** Stand-ins the actor set or is part of; admins see everyone's. Ended and cancelled ones drop off after a week. */
export async function listStandins(db: Queryable, actor: Member, now = new Date()): Promise<Standin[]> {
  const { rows } = await db.query<{
    id: string; member_id: string; member: string; standin_id: string; standin: string; starts_at: Date; ends_at: Date; note: string | null; cancelled_at: Date | null;
  }>(
    `SELECT s.id, s.member_id, m.handle AS member, s.standin_id, t.handle AS standin, s.starts_at, s.ends_at, s.note, s.cancelled_at
     FROM approval_standins s JOIN members m ON m.id = s.member_id JOIN members t ON t.id = s.standin_id
     WHERE s.cancelled_at IS NULL AND s.ends_at > $2::timestamptz - interval '7 days'
       AND ($3 OR s.member_id = $1 OR s.standin_id = $1)
     ORDER BY s.starts_at`,
    [actor.id, now, actor.role === 'admin'],
  );
  return rows.map((r) => ({
    id: r.id, memberId: r.member_id, member: r.member, standinId: r.standin_id, standin: r.standin,
    startsAt: r.starts_at, endsAt: r.ends_at, note: r.note, active: r.starts_at <= now && r.ends_at > now,
  }));
}

/** Members set their own stand-in; admins may set one for anyone (someone who left in a hurry). */
export async function createStandin(db: Queryable, actor: Member, body: unknown, now = new Date()): Promise<Standin> {
  const b = standinBody.safeParse(body);
  if (!b.success) throw badRequest('invalid_standin', b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const memberId = b.data.memberId ?? actor.id;
  if (memberId !== actor.id && actor.role !== 'admin') throw forbidden('admin_only');
  if (memberId === b.data.standinId) throw badRequest('invalid_standin', 'standinId: someone else must stand in');
  if (b.data.endsAt <= b.data.startsAt) throw badRequest('invalid_standin', 'endsAt: must be after startsAt');
  if (b.data.endsAt <= now) throw badRequest('invalid_standin', 'endsAt: must be in the future');
  if (b.data.endsAt.getTime() - b.data.startsAt.getTime() > MAX_DAYS * 86_400_000) throw badRequest('invalid_standin', `at most ${MAX_DAYS} days`);
  const people = await db.query<{ id: string; role: string; disabled: boolean }>(`SELECT id, role, disabled FROM members WHERE id = ANY($1)`, [[memberId, b.data.standinId]]);
  const member = people.rows.find((r) => r.id === memberId);
  const standin = people.rows.find((r) => r.id === b.data.standinId);
  if (!member) throw notFound('member');
  if (!standin || standin.disabled) throw notFound('standin');
  // A stand-in approves; only someone who approves needs one, and only an approver can be one.
  if (!['admin', 'approver'].includes(member.role)) throw badRequest('invalid_standin', 'only admins and approvers approve, so only they need a stand-in');
  if (!['admin', 'approver'].includes(standin.role)) throw badRequest('invalid_standin', 'the stand-in must be an admin or approver');
  // One stand-in at a time keeps "who approves for Maya" unambiguous.
  const overlap = await db.query(
    `SELECT 1 FROM approval_standins WHERE member_id = $1 AND cancelled_at IS NULL AND starts_at < $3 AND ends_at > $2`,
    [memberId, b.data.startsAt, b.data.endsAt],
  );
  if (overlap.rowCount) throw conflict('standin_overlaps');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO approval_standins (member_id, standin_id, starts_at, ends_at, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [memberId, b.data.standinId, b.data.startsAt, b.data.endsAt, b.data.note ?? null, actor.id],
  );
  const id = rows[0]!.id;
  await audit(db, { actorId: actor.id, action: 'standin.created', subjectType: 'member', subjectId: memberId, outcome: 'ok', relatedId: b.data.standinId });
  await notify(db, b.data.standinId, 'standin_assigned');
  return (await listStandins(db, { ...actor, role: 'admin' }, now)).find((s) => s.id === id)!;
}

export async function cancelStandin(db: Queryable, actor: Member, id: string): Promise<void> {
  const { rows } = await db.query<{ member_id: string; created_by: string }>(`SELECT member_id, created_by FROM approval_standins WHERE id = $1 AND cancelled_at IS NULL`, [id]);
  const s = rows[0];
  if (!s) throw notFound('standin');
  if (actor.role !== 'admin' && actor.id !== s.member_id && actor.id !== s.created_by) throw forbidden();
  await db.query(`UPDATE approval_standins SET cancelled_at = now() WHERE id = $1`, [id]);
  await audit(db, { actorId: actor.id, action: 'standin.cancelled', subjectType: 'member', subjectId: s.member_id, outcome: 'ok' });
}

const ACTIVE = `s.cancelled_at IS NULL AND s.starts_at <= $NOW AND s.ends_at > $NOW`;
const active = (sql: string, nowParam: number) => sql.replaceAll('$NOW', () => `$${nowParam}`);

// ---------------------------------------------------------------- who may approve

export async function teamApprovalsOn(db: Queryable): Promise<boolean> {
  return (await listPolicies(db, true)).some((p) => p.kind === 'team_approvals');
}

export interface Authority {
  /** A stand-in approving for this member. */
  onBehalfOf: string | null;
  /** An org admin approving a team's work from outside the team (team approvals rule). */
  outsideTeam: boolean;
}

/**
 * Whether the actor may approve the work of a team (a Flow version, or a run's sign-off), and
 * in whose name. ownerId is who made the version or runs the run: nobody approves their own
 * work on a shared server (the callers check the actor), and a stand-in cannot approve it for them either.
 */
export async function approvalAuthority(db: Queryable, actor: Member, teamId: string, ownerId: string, now = new Date()): Promise<Authority> {
  if (!canApprove(actor)) throw forbidden('approver_only');
  if (!(await teamApprovalsOn(db))) return { onBehalfOf: null, outsideTeam: false };
  const own = await db.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2`, [teamId, actor.id]);
  if (own.rowCount) return { onBehalfOf: null, outsideTeam: false };
  const forWhom = await db.query<{ member_id: string }>(
    active(
      `SELECT s.member_id FROM approval_standins s
       JOIN members m ON m.id = s.member_id JOIN team_members tm ON tm.member_id = s.member_id AND tm.team_id = $2
       WHERE s.standin_id = $1 AND ${ACTIVE} AND m.role IN ('admin', 'approver') AND NOT m.disabled AND s.member_id <> $3
       ORDER BY s.starts_at LIMIT 1`,
      4,
    ),
    [actor.id, teamId, ownerId, now],
  );
  if (forWhom.rows[0]) return { onBehalfOf: forWhom.rows[0].member_id, outsideTeam: false };
  if (actor.role === 'admin') return { onBehalfOf: null, outsideTeam: true };
  throw forbidden('not_team_approver');
}

/**
 * For the approvals queue: whether the team rule is on, the actor's own teams, and the teams
 * they may approve for as someone's stand-in (with that person's handle).
 */
export async function queueScope(db: Queryable, actor: Member, now = new Date()): Promise<{ rule: boolean; mine: Set<string>; standingIn: Map<string, string> }> {
  const rule = await teamApprovalsOn(db);
  const mine = new Set((await db.query<{ team_id: string }>(`SELECT team_id FROM team_members WHERE member_id = $1`, [actor.id])).rows.map((r) => r.team_id));
  const { rows } = await db.query<{ team_id: string; handle: string }>(
    active(
      `SELECT tm.team_id, m.handle FROM approval_standins s JOIN members m ON m.id = s.member_id JOIN team_members tm ON tm.member_id = s.member_id
       WHERE s.standin_id = $1 AND ${ACTIVE} AND m.role IN ('admin', 'approver') AND NOT m.disabled`,
      2,
    ),
    [actor.id, now],
  );
  return { rule, mine, standingIn: new Map(rows.map((r) => [r.team_id, r.handle])) };
}

// ---------------------------------------------------------------- who is told

/** Members away right now, and who stands in for them. */
async function awayMap(db: Queryable, ids: string[], now: Date): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<{ member_id: string; standin_id: string }>(
    active(
      `SELECT s.member_id, s.standin_id FROM approval_standins s JOIN members t ON t.id = s.standin_id
       WHERE s.member_id = ANY($1) AND ${ACTIVE} AND t.role IN ('admin', 'approver') AND NOT t.disabled`,
      2,
    ),
    [ids, now],
  );
  return new Map(rows.map((r) => [r.member_id, r.standin_id]));
}

/** Send to these people, or to their stand-ins while they are away; never to the owner of the work. */
async function sendRouted(db: Queryable, ids: string[], kind: NotificationKind, refs: NotificationRefs, ownerId: string, now: Date): Promise<number> {
  const away = await awayMap(db, ids, now);
  const to = new Set<string>();
  for (const id of ids) {
    const target = away.get(id) ?? id;
    if (target !== ownerId) to.add(target);
  }
  for (const id of to) await notify(db, id, kind, refs);
  return to.size;
}

async function orgAdmins(db: Queryable): Promise<string[]> {
  return (await db.query<{ id: string }>(`SELECT id FROM members WHERE role = 'admin' AND NOT disabled`)).rows.map((r) => r.id);
}

/** The approvers of a team's work: its approvers when the team rule is on (org admins if it has none), else every approver. */
export async function approversOf(db: Queryable, teamId: string, ownerId: string): Promise<string[]> {
  const rows = (await teamApprovalsOn(db))
    ? (
        await db.query<{ id: string }>(
          `SELECT m.id FROM members m JOIN team_members tm ON tm.member_id = m.id
           WHERE tm.team_id = $1 AND m.role IN ('admin', 'approver') AND NOT m.disabled`,
          [teamId],
        )
      ).rows
    : (await db.query<{ id: string }>(`SELECT id FROM members WHERE role IN ('admin', 'approver') AND NOT disabled`)).rows;
  const ids = rows.map((r) => r.id).filter((id) => id !== ownerId);
  return ids.length ? ids : (await orgAdmins(db)).filter((id) => id !== ownerId);
}

/** Tell a team's approvers (or their stand-ins) that something waits for them. */
export async function notifyApprovers(db: Queryable, teamId: string, ownerId: string, kind: NotificationKind, refs: NotificationRefs, now = new Date()): Promise<number> {
  return sendRouted(db, await approversOf(db, teamId, ownerId), kind, refs, ownerId, now);
}

// ---------------------------------------------------------------- deadlines

export interface Deadlines {
  remindAfterHours: number;
  escalateAfterHours: number;
  orgAdminsAfterHours: number;
}

async function deadlineRule(db: Queryable): Promise<Deadlines | null> {
  const p = (await listPolicies(db, true)).find((x) => x.kind === 'approval_deadlines');
  if (!p) return null;
  const c = p.config as { remindAfterHours: number; escalateAfterHours: number; orgAdminsAfterHours?: number };
  return { remindAfterHours: c.remindAfterHours, escalateAfterHours: c.escalateAfterHours, orgAdminsAfterHours: c.orgAdminsAfterHours ?? 2 * c.escalateAfterHours };
}

/** A sign-off step's own times win over the organization's rule; either may be missing. */
export function stepDeadlines(step: { remindAfterHours?: number | undefined; escalateAfterHours?: number | undefined }, rule: Deadlines | null): Deadlines | null {
  if (step.remindAfterHours === undefined && step.escalateAfterHours === undefined) return rule;
  const remind = step.remindAfterHours ?? rule?.remindAfterHours ?? step.escalateAfterHours!;
  const escalate = step.escalateAfterHours ?? rule?.escalateAfterHours ?? 2 * remind;
  return { remindAfterHours: remind, escalateAfterHours: escalate, orgAdminsAfterHours: 2 * escalate };
}

const HOUR = 3_600_000;

interface Waiting {
  table: 'run_steps' | 'flow_versions';
  key: string[];
  since: Date;
  teamId: string;
  ownerId: string;
  deadlines: Deadlines;
  reminded: boolean;
  escalated: boolean;
  escalatedOrg: boolean;
  refs: NotificationRefs;
}

/** Marks a stage done once, so two workers never send the same reminder twice. */
async function claim(db: Queryable, w: Waiting, column: 'reminded_at' | 'escalated_at' | 'escalated_org_at', now: Date): Promise<boolean> {
  const where = w.table === 'run_steps' ? 'run_id = $2 AND step_id = $3' : 'id = $2';
  const r = await db.query(`UPDATE ${w.table} SET ${column} = $1 WHERE ${where} AND ${column} IS NULL`, [now, ...w.key]);
  return (r.rowCount ?? 0) > 0;
}

async function teamAdmins(db: Queryable, teamId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT m.id FROM members m JOIN team_members tm ON tm.member_id = m.id WHERE tm.team_id = $1 AND tm.role = 'admin' AND NOT m.disabled`,
    [teamId],
  );
  return rows.map((r) => r.id);
}

async function advance(db: Queryable, w: Waiting, now: Date): Promise<{ reminded: number; escalated: number }> {
  const waited = now.getTime() - w.since.getTime();
  const out = { reminded: 0, escalated: 0 };
  if (!w.reminded && waited >= w.deadlines.remindAfterHours * HOUR && (await claim(db, w, 'reminded_at', now))) {
    await sendRouted(db, await approversOf(db, w.teamId, w.ownerId), 'approval_reminder', w.refs, w.ownerId, now);
    out.reminded++;
  }
  if (!w.escalated && waited >= w.deadlines.escalateAfterHours * HOUR && (await claim(db, w, 'escalated_at', now))) {
    const admins = (await teamAdmins(db, w.teamId)).filter((id) => id !== w.ownerId);
    if (admins.length) await sendRouted(db, admins, 'approval_escalated', w.refs, w.ownerId, now);
    // A team without admins of its own goes straight to the organization's admins.
    else if (await claim(db, w, 'escalated_org_at', now)) await sendRouted(db, await orgAdmins(db), 'approval_escalated', w.refs, w.ownerId, now);
    out.escalated++;
  }
  if (!w.escalatedOrg && waited >= w.deadlines.orgAdminsAfterHours * HOUR && (await claim(db, w, 'escalated_org_at', now))) {
    await sendRouted(db, await orgAdmins(db), 'approval_escalated', w.refs, w.ownerId, now);
    out.escalated++;
  }
  return out;
}

/** Run by maintenance: remind and escalate sign-offs and Flow versions that wait too long. */
export async function sweepApprovalDeadlines(db: Queryable, now = new Date()): Promise<{ reminded: number; escalated: number }> {
  const rule = await deadlineRule(db);
  const total = { reminded: 0, escalated: 0 };
  const gates = await db.query<{
    run_id: string; step_id: string; started_at: Date; team_id: string; run_as: string; definition: FlowDefinition;
    reminded_at: Date | null; escalated_at: Date | null; escalated_org_at: Date | null;
  }>(
    `SELECT s.run_id, s.step_id, s.started_at, f.team_id, r.run_as, v.definition, s.reminded_at, s.escalated_at, s.escalated_org_at
     FROM run_steps s JOIN runs r ON r.id = s.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
     WHERE s.status = 'waiting' AND r.wait_reason = 'approval' AND s.escalated_org_at IS NULL AND s.started_at IS NOT NULL`,
  );
  for (const g of gates.rows) {
    const step = g.definition.steps.find((x) => x.id === g.step_id);
    if (step?.type !== 'approval') continue;
    const deadlines = stepDeadlines(step, rule);
    if (!deadlines) continue;
    const r = await advance(db, {
      table: 'run_steps', key: [g.run_id, g.step_id], since: g.started_at, teamId: g.team_id, ownerId: g.run_as, deadlines,
      reminded: !!g.reminded_at, escalated: !!g.escalated_at, escalatedOrg: !!g.escalated_org_at, refs: { runId: g.run_id, stepId: g.step_id },
    }, now);
    total.reminded += r.reminded;
    total.escalated += r.escalated;
  }
  if (rule) {
    const versions = await db.query<{ id: string; created_at: Date; team_id: string; created_by: string; reminded_at: Date | null; escalated_at: Date | null; escalated_org_at: Date | null }>(
      `SELECT v.id, v.created_at, f.team_id, v.created_by, v.reminded_at, v.escalated_at, v.escalated_org_at
       FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE v.status = 'pending' AND v.escalated_org_at IS NULL`,
    );
    for (const v of versions.rows) {
      const r = await advance(db, {
        table: 'flow_versions', key: [v.id], since: v.created_at, teamId: v.team_id, ownerId: v.created_by, deadlines: rule,
        reminded: !!v.reminded_at, escalated: !!v.escalated_at, escalatedOrg: !!v.escalated_org_at, refs: { flowVersionId: v.id },
      }, now);
      total.reminded += r.reminded;
      total.escalated += r.escalated;
    }
  }
  return total;
}

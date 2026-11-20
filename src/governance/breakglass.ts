import { z } from 'zod';
import { audit } from '../core/audit.js';
import { AppError, badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { notify, notifyRole } from '../core/notify.js';
import type { Queryable } from '../db/db.js';

/**
 * Break-glass: in an emergency (the person who owns the access is away and something
 * must run now), a member an admin has marked for it can run Flows as that person for
 * up to an hour. They must give a reason; admins and that person are told at once;
 * every run carries the grant and shows in the audit report.
 */

export const breakglassBody = z
  .object({ actAs: z.string().uuid(), reason: z.string().trim().min(10).max(500), minutes: z.number().int().min(5).max(60).default(30) })
  .strict();

export interface Grant {
  id: string;
  memberId: string;
  member: string;
  actAsId: string;
  actAs: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  active: boolean;
}

export async function setBreakglass(db: Queryable, actor: Member, memberId: string, enabled: boolean): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rowCount } = await db.query(`UPDATE members SET breakglass = $2 WHERE id = $1`, [memberId, enabled]);
  if (!rowCount) throw notFound('member');
  await audit(db, { actorId: actor.id, action: enabled ? 'breakglass.allowed' : 'breakglass.disallowed', subjectType: 'breakglass', subjectId: memberId, outcome: 'ok' });
}

export async function startGrant(db: Queryable, actor: Member, body: z.infer<typeof breakglassBody>): Promise<Grant> {
  const allowed = (await db.query<{ breakglass: boolean }>(`SELECT breakglass FROM members WHERE id = $1`, [actor.id])).rows[0]?.breakglass;
  if (!allowed) throw forbidden('breakglass_not_allowed');
  if (body.actAs === actor.id) throw badRequest('breakglass_self');
  const target = await db.query(`SELECT 1 FROM members WHERE id = $1`, [body.actAs]);
  if (!target.rowCount) throw notFound('member');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO breakglass_grants (member_id, act_as, reason, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id`,
    [actor.id, body.actAs, body.reason, body.minutes],
  );
  const id = rows[0]!.id;
  await audit(db, { actorId: actor.id, action: 'breakglass.started', subjectType: 'breakglass', subjectId: id, outcome: 'ok', relatedId: body.actAs });
  await notifyRole(db, ['admin'], 'breakglass_used', {}, actor.id);
  await notify(db, body.actAs, 'breakglass_used');
  return (await listGrants(db, actor, id))[0]!;
}

export async function endGrant(db: Queryable, actor: Member, id: string): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE breakglass_grants SET ended_at = now() WHERE id = $1 AND ended_at IS NULL AND (member_id = $2 OR $3)`,
    [id, actor.id, actor.role === 'admin'],
  );
  if (!rowCount) throw notFound('breakglass_grant');
  await audit(db, { actorId: actor.id, action: 'breakglass.ended', subjectType: 'breakglass', subjectId: id, outcome: 'ok' });
}

/** Admins see every grant; others see their own and the ones used as them. */
export async function listGrants(db: Queryable, actor: Member, id?: string): Promise<Grant[]> {
  const { rows } = await db.query<{ id: string; member_id: string; member: string; act_as: string; act_as_handle: string; reason: string; started_at: Date; expires_at: Date; ended_at: Date | null; active: boolean }>(
    `SELECT g.id, g.member_id, m.handle AS member, g.act_as, a.handle AS act_as_handle, g.reason, g.started_at, g.expires_at, g.ended_at,
            g.ended_at IS NULL AND g.expires_at > now() AS active
     FROM breakglass_grants g JOIN members m ON m.id = g.member_id JOIN members a ON a.id = g.act_as
     WHERE ($1 OR g.member_id = $2 OR g.act_as = $2) AND ($3::uuid IS NULL OR g.id = $3)
     ORDER BY g.started_at DESC LIMIT 100`,
    [actor.role === 'admin', actor.id, id ?? null],
  );
  return rows.map((r) => ({ id: r.id, memberId: r.member_id, member: r.member, actAsId: r.act_as, actAs: r.act_as_handle, reason: r.reason, startedAt: r.started_at, expiresAt: r.expires_at, endedAt: r.ended_at, active: r.active }));
}

/** Who a run started under a grant runs as; refuses an ended, expired or someone else's grant. */
export async function grantRunAs(db: Queryable, actor: Member, grantId: string): Promise<string> {
  const g = (await db.query<{ act_as: string }>(
    `SELECT act_as FROM breakglass_grants WHERE id = $1 AND member_id = $2 AND ended_at IS NULL AND expires_at > now()`,
    [grantId, actor.id],
  )).rows[0];
  if (!g) throw new AppError('breakglass_inactive', 409, 'This break-glass access has ended or expired.');
  return g.act_as;
}

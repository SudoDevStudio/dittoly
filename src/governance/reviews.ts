import { z } from 'zod';
import { audit } from '../core/audit.js';
import { notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { notify } from '../core/notify.js';
import { removeTeamCredential } from '../core/team-credentials.js';
import { assertTeamAdmin, removeTeamMember } from '../core/teams.js';
import type { Queryable } from '../db/db.js';

/**
 * Access reviews: every stored credential and every team membership is confirmed
 * every 90 days. People are told when one is due; a credential nobody confirms within
 * 14 days after that is removed (and the owner told). Memberships are only flagged,
 * since removing someone from a team is a decision for a person.
 */

const GRACE_DAYS = 14;
/** Shown in the review list this many days before they are due. */
const SOON_DAYS = 14;

export const reviewBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('credential'), service: z.string().max(40), keep: z.boolean() }).strict(),
  z.object({ kind: z.literal('team_credential'), teamId: z.string().uuid(), service: z.string().max(40), keep: z.boolean() }).strict(),
  z.object({ kind: z.literal('membership'), teamId: z.string().uuid(), memberId: z.string().uuid(), keep: z.boolean() }).strict(),
]);

/** What this member should review now: their credentials, and in teams they admin, the team's credentials and members. */
export async function reviewsFor(db: Queryable, member: Member) {
  const credentials = await db.query<{ service: string; review_due_at: Date }>(
    `SELECT service, review_due_at FROM credentials WHERE member_id = $1 AND review_due_at <= now() + make_interval(days => $2) ORDER BY review_due_at`,
    [member.id, SOON_DAYS],
  );
  const adminOf = `(SELECT team_id FROM team_members WHERE member_id = $1 AND role = 'admin' UNION SELECT id FROM teams WHERE $3)`;
  const teamCredentials = await db.query<{ team_id: string; team: string; service: string; review_due_at: Date }>(
    `SELECT tc.team_id, t.name AS team, tc.service, tc.review_due_at FROM team_credentials tc JOIN teams t ON t.id = tc.team_id
     WHERE tc.team_id IN ${adminOf} AND tc.review_due_at <= now() + make_interval(days => $2) ORDER BY tc.review_due_at`,
    [member.id, SOON_DAYS, member.role === 'admin'],
  );
  const memberships = await db.query<{ team_id: string; team: string; member_id: string; handle: string; role: string; review_due_at: Date }>(
    `SELECT tm.team_id, t.name AS team, tm.member_id, m.handle, tm.role, tm.review_due_at FROM team_members tm
     JOIN teams t ON t.id = tm.team_id JOIN members m ON m.id = tm.member_id
     WHERE tm.team_id IN ${adminOf} AND tm.review_due_at <= now() + make_interval(days => $2) ORDER BY tm.review_due_at`,
    [member.id, SOON_DAYS, member.role === 'admin'],
  );
  const removeAt = (due: Date) => new Date(due.getTime() + GRACE_DAYS * 86_400_000);
  return {
    credentials: credentials.rows.map((r) => ({ service: r.service, dueAt: r.review_due_at, removedAfter: removeAt(r.review_due_at) })),
    teamCredentials: teamCredentials.rows.map((r) => ({ teamId: r.team_id, team: r.team, service: r.service, dueAt: r.review_due_at, removedAfter: removeAt(r.review_due_at) })),
    memberships: memberships.rows.map((r) => ({ teamId: r.team_id, team: r.team, memberId: r.member_id, handle: r.handle, role: r.role, dueAt: r.review_due_at })),
  };
}

export async function review(db: Queryable, actor: Member, body: z.infer<typeof reviewBody>): Promise<void> {
  const next = `review_due_at = now() + interval '90 days', review_notified_at = NULL`;
  if (body.kind === 'credential') {
    if (body.keep) {
      const r = await db.query(`UPDATE credentials SET ${next} WHERE member_id = $1 AND service = $2`, [actor.id, body.service]);
      if (!r.rowCount) throw notFound('credential');
    } else await db.query(`DELETE FROM credentials WHERE member_id = $1 AND service = $2`, [actor.id, body.service]);
    await audit(db, { actorId: actor.id, action: body.keep ? 'access.review_kept' : 'access.review_removed', subjectType: 'credential', subjectId: body.service, outcome: 'ok' });
    return;
  }
  await assertTeamAdmin(db, body.teamId, actor);
  if (body.kind === 'team_credential') {
    if (body.keep) {
      const r = await db.query(`UPDATE team_credentials SET ${next} WHERE team_id = $1 AND service = $2`, [body.teamId, body.service]);
      if (!r.rowCount) throw notFound('credential');
    } else await removeTeamCredential(db, actor, body.teamId, body.service);
  } else if (body.keep) {
    const r = await db.query(`UPDATE team_members SET ${next} WHERE team_id = $1 AND member_id = $2`, [body.teamId, body.memberId]);
    if (!r.rowCount) throw notFound('team_member');
  } else await removeTeamMember(db, actor, body.teamId, body.memberId);
  await audit(db, {
    actorId: actor.id,
    action: body.keep ? 'access.review_kept' : 'access.review_removed',
    subjectType: 'team',
    subjectId: body.teamId,
    outcome: 'ok',
    relatedId: body.kind === 'membership' ? body.memberId : body.service,
  });
}

async function teamAdmins(db: Queryable, teamId: string): Promise<string[]> {
  const { rows } = await db.query<{ member_id: string }>(`SELECT member_id FROM team_members WHERE team_id = $1 AND role = 'admin'`, [teamId]);
  return rows.map((r) => r.member_id);
}

/** Maintenance: tell people what is due, and remove credentials nobody confirmed in time. */
export async function sweepReviews(db: Queryable): Promise<void> {
  const due = await db.query<{ member_id: string }>(
    `UPDATE credentials SET review_notified_at = now() WHERE review_due_at <= now() AND review_notified_at IS NULL RETURNING member_id`,
  );
  for (const id of new Set(due.rows.map((r) => r.member_id))) await notify(db, id, 'access_review_due');
  const teamDue = await db.query<{ team_id: string }>(
    `UPDATE team_credentials SET review_notified_at = now() WHERE review_due_at <= now() AND review_notified_at IS NULL RETURNING team_id`,
  );
  const memberDue = await db.query<{ team_id: string }>(
    `UPDATE team_members SET review_notified_at = now() WHERE review_due_at <= now() AND review_notified_at IS NULL RETURNING team_id`,
  );
  const teams = new Set([...teamDue.rows, ...memberDue.rows].map((r) => r.team_id));
  const told = new Set<string>();
  for (const t of teams) for (const id of await teamAdmins(db, t)) if (!told.has(id)) (told.add(id), await notify(db, id, 'access_review_due'));

  const expired = await db.query<{ member_id: string; service: string }>(
    `DELETE FROM credentials WHERE review_due_at < now() - make_interval(days => $1) RETURNING member_id, service`,
    [GRACE_DAYS],
  );
  for (const r of expired.rows) {
    await audit(db, { actorId: null, action: 'access.expired_unreviewed', subjectType: 'credential', subjectId: r.service, outcome: 'ok', relatedId: r.member_id });
    await notify(db, r.member_id, 'access_removed');
  }
  const teamExpired = await db.query<{ team_id: string; service: string }>(
    `DELETE FROM team_credentials WHERE review_due_at < now() - make_interval(days => $1) RETURNING team_id, service`,
    [GRACE_DAYS],
  );
  for (const r of teamExpired.rows) {
    await audit(db, { actorId: null, action: 'access.expired_unreviewed', subjectType: 'team', subjectId: r.team_id, outcome: 'ok', relatedId: r.service });
    for (const id of await teamAdmins(db, r.team_id)) await notify(db, id, 'access_removed');
  }
}

import type { Queryable } from '../db/db.js';
import { audit } from './audit.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import type { Member } from './members.js';

/**
 * Teams. Flows belong to a team; its members can see and run them. Team admins
 * manage the team's members (and its credentials and
 * notification channels). Org admins can do everything in every team.
 */

export type TeamRole = 'admin' | 'member';

export interface Team {
  id: string;
  name: string;
  isDefault: boolean;
  /** The asking member's role in it; null for org admins who are not members. */
  myRole: TeamRole | null;
  members: number;
  /** How many runs of this team may go at once; null: no cap (src/engine/jobs.ts). */
  runLimit: number | null;
}

export async function teamRole(db: Queryable, teamId: string, memberId: string): Promise<TeamRole | null> {
  const r = await db.query<{ role: TeamRole }>(`SELECT role FROM team_members WHERE team_id = $1 AND member_id = $2`, [teamId, memberId]);
  return r.rows[0]?.role ?? null;
}

/** IDs of the teams a member belongs to. */
export async function memberTeamIds(db: Queryable, memberId: string): Promise<string[]> {
  return (await db.query<{ team_id: string }>(`SELECT team_id FROM team_members WHERE member_id = $1`, [memberId])).rows.map((r) => r.team_id);
}

/** Whether the member may see and run a team's Flows. */
export async function canUseTeam(db: Queryable, teamId: string, actor: Member): Promise<boolean> {
  return actor.role === 'admin' || (await teamRole(db, teamId, actor.id)) !== null;
}

export async function assertTeamMember(db: Queryable, teamId: string, actor: Member): Promise<void> {
  if (!(await canUseTeam(db, teamId, actor))) throw forbidden('not_in_team');
}

/** Org admins, and the team's own admins. */
export async function assertTeamAdmin(db: Queryable, teamId: string, actor: Member): Promise<void> {
  if (actor.role === 'admin') return;
  if ((await teamRole(db, teamId, actor.id)) !== 'admin') throw forbidden('team_admin_only');
}

/** The team new Flows go to when none is named: the member's default team, else their first. */
export async function defaultTeamFor(db: Queryable, memberId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.member_id = $1 ORDER BY t.is_default DESC, t.name LIMIT 1`,
    [memberId],
  );
  if (!r.rows[0]) throw conflict('not_in_any_team');
  return r.rows[0].id;
}

/** Teams the member can see: all of them for org admins, otherwise their own. */
export async function listTeams(db: Queryable, actor: Member): Promise<Team[]> {
  const { rows } = await db.query<{ id: string; name: string; is_default: boolean; my_role: TeamRole | null; members: string; run_limit: number | null }>(
    `SELECT t.id, t.name, t.is_default, t.run_limit,
            (SELECT role FROM team_members WHERE team_id = t.id AND member_id = $1) AS my_role,
            (SELECT count(*) FROM team_members WHERE team_id = t.id) AS members
     FROM teams t
     WHERE $2 OR EXISTS (SELECT 1 FROM team_members WHERE team_id = t.id AND member_id = $1)
     ORDER BY t.is_default DESC, t.name`,
    [actor.id, actor.role === 'admin'],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, isDefault: r.is_default, myRole: r.my_role, members: Number(r.members), runLimit: r.run_limit }));
}

/** Org admins cap how many runs a team has going at once (1–100), or lift the cap (null). */
export async function setRunLimit(db: Queryable, actor: Member, teamId: string, limit: number | null): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw badRequest('invalid_run_limit', 'a whole number from 1 to 100, or none');
  const r = await db.query(`UPDATE teams SET run_limit = $2 WHERE id = $1`, [teamId, limit]);
  if (!r.rowCount) throw notFound('team');
  await audit(db, { actorId: actor.id, action: 'team.run_limit_set', subjectType: 'team', subjectId: teamId, outcome: 'ok' });
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._&'-]{0,59}$/u;

export async function createTeam(db: Queryable, actor: Member, name: string): Promise<{ id: string }> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const clean = name.trim();
  if (!NAME.test(clean)) throw badRequest('invalid_team_name');
  const r = await db.query<{ id: string }>(`INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`, [clean]);
  if (!r.rows[0]) throw conflict('team_name_taken');
  // Whoever creates a team administers it.
  await db.query(`INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, 'admin')`, [r.rows[0].id, actor.id]);
  await audit(db, { actorId: actor.id, action: 'team.created', subjectType: 'team', subjectId: r.rows[0].id, outcome: 'ok' });
  return r.rows[0];
}

export async function renameTeam(db: Queryable, actor: Member, teamId: string, name: string): Promise<void> {
  await assertTeamAdmin(db, teamId, actor);
  const clean = name.trim();
  if (!NAME.test(clean)) throw badRequest('invalid_team_name');
  const r = await db.query(`UPDATE teams SET name = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM teams WHERE name = $2 AND id <> $1)`, [teamId, clean]);
  if (!r.rowCount) throw conflict('team_name_taken');
  await audit(db, { actorId: actor.id, action: 'team.renamed', subjectType: 'team', subjectId: teamId, outcome: 'ok' });
}

export async function teamMembers(db: Queryable, actor: Member, teamId: string) {
  await assertTeamMember(db, teamId, actor);
  const { rows } = await db.query<{ id: string; handle: string; display_name: string | null; role: TeamRole }>(
    `SELECT m.id, m.handle, m.display_name, tm.role FROM team_members tm JOIN members m ON m.id = tm.member_id
     WHERE tm.team_id = $1 ORDER BY tm.role, m.handle`,
    [teamId],
  );
  return rows.map((r) => ({ id: r.id, handle: r.handle, displayName: r.display_name, role: r.role }));
}

/** Add a member to a team, or change their role in it. */
export async function setTeamMember(db: Queryable, actor: Member, teamId: string, memberId: string, role: TeamRole): Promise<void> {
  await assertTeamAdmin(db, teamId, actor);
  const exists = await db.query(`SELECT 1 FROM members WHERE id = $1 AND NOT disabled`, [memberId]);
  if (!exists.rowCount) throw notFound('member');
  const before = await teamRole(db, teamId, memberId);
  if (before === 'admin' && role !== 'admin') await assertNotLastAdmin(db, teamId, memberId);
  await db.query(
    `INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, member_id) DO UPDATE SET role = EXCLUDED.role`,
    [teamId, memberId, role],
  );
  await audit(db, { actorId: actor.id, action: before ? 'team.role_changed' : 'team.member_added', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: memberId });
}

export async function removeTeamMember(db: Queryable, actor: Member, teamId: string, memberId: string): Promise<void> {
  await assertTeamAdmin(db, teamId, actor);
  if ((await teamRole(db, teamId, memberId)) === 'admin') await assertNotLastAdmin(db, teamId, memberId);
  await db.query(`DELETE FROM team_members WHERE team_id = $1 AND member_id = $2`, [teamId, memberId]);
  await audit(db, { actorId: actor.id, action: 'team.member_removed', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: memberId });
}

async function assertNotLastAdmin(db: Queryable, teamId: string, memberId: string): Promise<void> {
  const r = await db.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND role = 'admin' AND member_id <> $2`, [teamId, memberId]);
  if (!r.rowCount) throw conflict('last_team_admin');
}

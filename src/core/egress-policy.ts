import type { Queryable } from '../db/db.js';
import { APP_PHASES, FIX_PHASES, type AppStep, type FixStep, type StepPhase } from '../flows/definition.js';
import { allowedBy, parseDestinations, type Destination } from '../runtime/destinations.js';
import { audit } from './audit.js';
import { badRequest, forbidden, notFound } from './errors.js';
import type { Member } from './members.js';
import { assertTeamAdmin } from './teams.js';

/**
 * The ceiling on outside destinations app and fix steps may declare (their `egress`, per phase): the org
 * admin keeps the organization's list; a team admin may narrow it for their team, never widen it. A Flow
 * is approved only when every destination it declares is inside its team's ceiling, and checked again when
 * the step runs (the lists may have changed since). Empty by default: nothing beyond the git host and the
 * package registries.
 */

const KEY = 'egress_destinations';
const MAX = 100;

export async function orgEgress(db: Queryable): Promise<string[]> {
  const row = (await db.query<{ value: { destinations?: string[] } }>(`SELECT value FROM org_settings WHERE key = $1`, [KEY])).rows[0];
  return row?.value.destinations ?? [];
}

function normalized(list: readonly string[]): string[] {
  if (list.length > MAX) throw badRequest('too_many_destinations', `at most ${MAX}`);
  const { destinations, problems } = parseDestinations(list);
  if (problems.length) throw badRequest('invalid_destination', problems.join('; '));
  return [...new Set(destinations.map((d) => d.text))];
}

export async function setOrgEgress(db: Queryable, actor: Member, list: readonly string[]): Promise<string[]> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const clean = normalized(list);
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify({ destinations: clean }), actor.id],
  );
  await audit(db, { actorId: actor.id, action: 'org.egress_set', subjectType: 'org', subjectId: KEY, outcome: 'ok', relatedId: String(clean.length) });
  return clean;
}

export async function teamEgress(db: Queryable, teamId: string): Promise<string[] | null> {
  const r = await db.query<{ egress_allow: string[] | null }>(`SELECT egress_allow FROM teams WHERE id = $1`, [teamId]);
  if (!r.rows[0]) throw notFound('team');
  return r.rows[0].egress_allow;
}

/** A team admin narrows the organization's list for the team (null: the organization's list as it is). */
export async function setTeamEgress(db: Queryable, actor: Member, teamId: string, list: readonly string[] | null): Promise<string[] | null> {
  await assertTeamAdmin(db, teamId, actor);
  let clean: string[] | null = null;
  if (list) {
    clean = normalized(list);
    const org = parseDestinations(await orgEgress(db)).destinations;
    const outside = parseDestinations(clean).destinations.filter((d) => !allowedBy(org, d));
    if (outside.length) throw badRequest('outside_org_egress', `not in the organization's list: ${outside.map((d) => d.text).join(', ')}`);
  }
  const r = await db.query(`UPDATE teams SET egress_allow = $2 WHERE id = $1`, [teamId, clean]);
  if (!r.rowCount) throw notFound('team');
  await audit(db, { actorId: actor.id, action: 'team.egress_set', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: clean ? String(clean.length) : 'org' });
  return clean;
}

/** What a team's steps may declare now: the team's list (only entries the organization still allows), else the organization's. */
export async function egressCeiling(db: Queryable, teamId: string | null): Promise<Destination[]> {
  const org = parseDestinations(await orgEgress(db)).destinations;
  const team = teamId ? await teamEgress(db, teamId).catch(() => null) : null;
  if (!team) return org;
  return parseDestinations(team).destinations.filter((d) => allowedBy(org, d));
}

export interface PhaseDestination {
  phase: StepPhase;
  destination: string;
  allowed: boolean;
}

/** Each destination a step declares, per phase, and whether the ceiling allows it. */
export function judgeEgress(step: AppStep | FixStep, ceiling: readonly Destination[]): PhaseDestination[] {
  const phases: readonly StepPhase[] = step.type === 'app' ? APP_PHASES : FIX_PHASES;
  const out: PhaseDestination[] = [];
  for (const phase of phases) {
    const list = ((step.egress ?? {}) as Partial<Record<StepPhase, string[]>>)[phase] ?? [];
    for (const d of parseDestinations(list).destinations) out.push({ phase, destination: d.text, allowed: allowedBy(ceiling, d) !== null });
  }
  return out;
}

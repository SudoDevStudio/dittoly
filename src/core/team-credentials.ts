import type { Queryable } from '../db/db.js';
import { audit } from './audit.js';
import type { Cipher } from './crypto.js';
import { badRequest } from './errors.js';
import type { Member } from './members.js';
import { assertTeamAdmin, assertTeamMember } from './teams.js';

/**
 * Whose access a step uses, per team, module and credential service:
 * - personal (default): the member the step runs as, from their own vault;
 * - team: one shared account the team's admins store here, encrypted.
 * A team credential is never shown again, not even to its admins.
 */

export type CredentialMode = 'personal' | 'team';
export const teamCredentialAad = (teamId: string, service: string) => `team-credential:${teamId}:${service}`;
const SERVICE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** service -> mode for one module in one team (absent = personal). */
export async function credentialModes(db: Queryable, teamId: string, moduleName: string): Promise<Map<string, CredentialMode>> {
  const { rows } = await db.query<{ service: string; mode: CredentialMode }>(
    `SELECT service, mode FROM team_credential_modes WHERE team_id = $1 AND module_name = $2`,
    [teamId, moduleName],
  );
  return new Map(rows.map((r) => [r.service, r.mode]));
}

export async function setCredentialMode(db: Queryable, actor: Member, teamId: string, moduleName: string, service: string, mode: CredentialMode): Promise<void> {
  await assertTeamAdmin(db, teamId, actor);
  if (!SERVICE.test(service)) throw badRequest('invalid_service');
  await db.query(
    `INSERT INTO team_credential_modes (team_id, module_name, service, mode, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (team_id, module_name, service) DO UPDATE SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [teamId, moduleName, service, mode, actor.id],
  );
  await audit(db, { actorId: actor.id, action: `team.credential_mode_${mode}`, subjectType: 'team', subjectId: teamId, outcome: 'ok' });
}

export async function putTeamCredential(db: Queryable, cipher: Cipher, actor: Member, teamId: string, service: string, secret: string): Promise<void> {
  await assertTeamAdmin(db, teamId, actor);
  if (!SERVICE.test(service)) throw badRequest('invalid_service');
  if (!secret || secret.length > 10_000) throw badRequest('invalid_secret');
  await db.query(
    `INSERT INTO team_credentials (team_id, service, secret_enc, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (team_id, service) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_by = EXCLUDED.updated_by, updated_at = now(),
       review_due_at = now() + interval '90 days', review_notified_at = NULL, scope_check = NULL`,
    [teamId, service, cipher.encrypt(secret, teamCredentialAad(teamId, service)), actor.id],
  );
  await audit(db, { actorId: actor.id, action: 'team.credential_stored', subjectType: 'team', subjectId: teamId, outcome: 'ok' });
}

export async function removeTeamCredential(db: Queryable, actor: Member, teamId: string, service: string): Promise<void> {
  await assertTeamAdmin(db, teamId, actor);
  await db.query(`DELETE FROM team_credentials WHERE team_id = $1 AND service = $2`, [teamId, service]);
  await audit(db, { actorId: actor.id, action: 'team.credential_removed', subjectType: 'team', subjectId: teamId, outcome: 'ok' });
}

export async function teamSecret(db: Queryable, cipher: Cipher, teamId: string, service: string): Promise<string | null> {
  const r = await db.query<{ secret_enc: string }>(`SELECT secret_enc FROM team_credentials WHERE team_id = $1 AND service = $2`, [teamId, service]);
  return r.rows[0] ? cipher.decrypt(r.rows[0].secret_enc, teamCredentialAad(teamId, service)) : null;
}

/** Services a team has stored credentials for. */
export async function teamStoredServices(db: Queryable, teamId: string): Promise<Set<string>> {
  return new Set((await db.query<{ service: string }>(`SELECT service FROM team_credentials WHERE team_id = $1`, [teamId])).rows.map((r) => r.service));
}

/**
 * Every credential approved modules ask for, with this team's mode for it and
 * whether the team has stored one. Members can read it (no secrets).
 */
export async function listTeamCredentials(db: Queryable, actor: Member, teamId: string) {
  await assertTeamMember(db, teamId, actor);
  const { rows } = await db.query<{ module: string; title: string; service: string; label: string; placement: string }>(
    `SELECT DISTINCT ON (mv.name, c->>'service') mv.name AS module, mv.manifest->>'title' AS title,
            c->>'service' AS service, c->>'label' AS label, c->'placement'->>'type' AS placement
     FROM module_versions mv, jsonb_array_elements(mv.manifest->'credentials') c
     WHERE mv.status = 'approved'
     ORDER BY mv.name, c->>'service', mv.created_at DESC`,
  );
  const modes = await db.query<{ module_name: string; service: string; mode: CredentialMode }>(
    `SELECT module_name, service, mode FROM team_credential_modes WHERE team_id = $1`,
    [teamId],
  );
  const stored = await teamStoredServices(db, teamId);
  return rows.map((r) => ({
    module: r.module,
    moduleTitle: r.title,
    service: r.service,
    label: r.label,
    placement: r.placement,
    mode: modes.rows.find((m) => m.module_name === r.module && m.service === r.service)?.mode ?? ('personal' as CredentialMode),
    teamStored: stored.has(r.service),
  }));
}

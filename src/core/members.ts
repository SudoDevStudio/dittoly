import type { Queryable } from '../db/db.js';
import { randomToken, sha256Hex } from './crypto.js';
import { audit } from './audit.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

export type Role = 'admin' | 'approver' | 'member';
export const ROLES: readonly Role[] = ['admin', 'approver', 'member'];

export interface Member {
  id: string;
  handle: string;
  role: Role;
}

export interface MemberProfile extends Member {
  email: string | null;
  displayName: string | null;
  disabled: boolean;
  sso: boolean;
  /** May use break-glass access in an emergency (admins set it). */
  breakglass: boolean;
  /** Managed by the identity provider through SCIM. */
  scim: boolean;
  /** The role comes from a SCIM group mapping (not set by hand). */
  roleFromScim: boolean;
}

const HANDLE = /^[a-z0-9][a-z0-9_.-]{1,39}$/;
const MEMBER_COLS = 'id, handle, role';

/** API tokens are for automation and break-glass access; people sign in with SSO. */
export async function createMember(
  db: Queryable,
  handle: string,
  role: Role,
  actorId: string | null,
): Promise<{ member: Member; token: string }> {
  if (!HANDLE.test(handle)) throw badRequest('invalid_handle');
  const token = 'dty_' + randomToken();
  const { rows } = await db.query<Member>(
    `INSERT INTO members (handle, role, token_hash) VALUES ($1, $2, $3) RETURNING ${MEMBER_COLS}`,
    [handle, role, sha256Hex(token)],
  );
  const member = rows[0]!;
  await audit(db, { actorId, action: 'member.created', subjectType: 'member', subjectId: member.id, outcome: 'ok' });
  return { member, token };
}

export async function memberByToken(db: Queryable, token: string): Promise<Member | null> {
  const { rows } = await db.query<Member>(
    `SELECT ${MEMBER_COLS} FROM members WHERE token_hash = $1 AND NOT disabled`,
    [sha256Hex(token)],
  );
  return rows[0] ?? null;
}

export async function getMember(db: Queryable, id: string): Promise<Member | null> {
  const { rows } = await db.query<Member>(`SELECT ${MEMBER_COLS} FROM members WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export function canApprove(m: Member): boolean {
  return m.role === 'admin' || m.role === 'approver';
}

// ---------------------------------------------------------------- SSO members

export function handleFrom(email: string | undefined, sub: string): string {
  const base = (email?.split('@')[0] ?? `user-${sub}`)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 30);
  return base.length >= 2 ? base : `user-${sha256Hex(sub).slice(0, 8)}`;
}

/**
 * Find the member for an OIDC identity, creating one with the 'member' role on
 * first sign-in. Roles are managed in Dittoly by admins, never taken from the
 * identity provider's claims.
 */
export async function memberForOidc(
  db: Queryable,
  identity: { issuer: string; subject: string; email?: string | undefined; name?: string | undefined; objectId?: string | undefined },
): Promise<{ member: Member; created: boolean; disabled: boolean }> {
  const found = await db.query<Member & { disabled: boolean }>(
    `UPDATE members SET email = COALESCE($3, email), display_name = COALESCE($4, display_name)
     WHERE oidc_issuer = $1 AND oidc_subject = $2 RETURNING ${MEMBER_COLS}, disabled`,
    [identity.issuer, identity.subject, identity.email ?? null, identity.name ?? null],
  );
  if (found.rows[0]) {
    const { disabled, ...member } = found.rows[0];
    return { member, created: false, disabled };
  }
  // First sign-in of someone the identity provider provisioned through SCIM (docs/scim.md): their member
  // has never signed in, and either its SCIM externalId is this identity's subject (or Entra object id),
  // or its SCIM userName is this identity's verified email. An account that already signed in, or one the
  // identity provider does not manage, is never taken over by email.
  const linked = await db.query<Member & { disabled: boolean }>(
    `UPDATE members SET oidc_issuer = $1, oidc_subject = $2, email = COALESCE($3, email), display_name = COALESCE(display_name, $4)
     WHERE id = (SELECT id FROM members
                 WHERE scim_user_name IS NOT NULL AND scim_deleted_at IS NULL AND oidc_issuer IS NULL AND oidc_subject IS NULL
                   AND (scim_external_id IN ($2, $5) OR ($3::text IS NOT NULL AND lower(scim_user_name) = lower($3)))
                 ORDER BY scim_external_id IN ($2, $5) DESC LIMIT 1 FOR UPDATE)
     RETURNING ${MEMBER_COLS}, disabled`,
    [identity.issuer, identity.subject, identity.email ?? null, identity.name ?? null, identity.objectId ?? identity.subject],
  );
  if (linked.rows[0]) {
    const { disabled, ...member } = linked.rows[0];
    await audit(db, { actorId: member.id, action: 'member.sso_linked', subjectType: 'member', subjectId: member.id, outcome: 'ok' });
    return { member, created: false, disabled };
  }
  const base = handleFrom(identity.email, identity.subject);
  for (let i = 0; i < 20; i++) {
    const handle = i === 0 ? base : `${base.slice(0, 34)}-${i + 1}`;
    const { rows } = await db.query<Member>(
      `INSERT INTO members (handle, role, oidc_issuer, oidc_subject, email, display_name)
       VALUES ($1, 'member', $2, $3, $4, $5)
       ON CONFLICT (handle) DO NOTHING RETURNING ${MEMBER_COLS}`,
      [handle, identity.issuer, identity.subject, identity.email ?? null, identity.name ?? null],
    );
    if (rows[0]) {
      await audit(db, { actorId: rows[0].id, action: 'member.provisioned_sso', subjectType: 'member', subjectId: rows[0].id, outcome: 'ok' });
      return { member: rows[0], created: true, disabled: false };
    }
  }
  throw conflict('handle_unavailable');
}

// ---------------------------------------------------------------- sessions

export async function createSession(db: Queryable, memberId: string, ttlHours: number): Promise<string> {
  const token = randomToken(32);
  await db.query(`INSERT INTO sessions (token_hash, member_id, expires_at) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`, [
    sha256Hex(token),
    memberId,
    String(ttlHours),
  ]);
  return token;
}

export async function memberBySession(db: Queryable, token: string): Promise<Member | null> {
  const { rows } = await db.query<Member>(
    `UPDATE sessions s SET last_seen_at = now()
     FROM members m
     WHERE s.token_hash = $1 AND s.expires_at > now() AND m.id = s.member_id AND NOT m.disabled
     RETURNING m.id, m.handle, m.role`,
    [sha256Hex(token)],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256Hex(token)]);
}

// ---------------------------------------------------------------- administration

export async function listMembers(db: Queryable): Promise<MemberProfile[]> {
  const { rows } = await db.query<{
    id: string;
    handle: string;
    role: Role;
    email: string | null;
    display_name: string | null;
    disabled: boolean;
    oidc_subject: string | null;
    breakglass: boolean;
    scim: boolean;
    manual_role: string | null;
  }>(
    `SELECT id, handle, role, email, display_name, disabled, oidc_subject, breakglass, scim_user_name IS NOT NULL AND scim_deleted_at IS NULL AS scim, manual_role
     FROM members ORDER BY handle`,
  );
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    role: r.role,
    email: r.email,
    displayName: r.display_name,
    disabled: r.disabled,
    sso: r.oidc_subject !== null,
    breakglass: r.breakglass,
    scim: r.scim,
    roleFromScim: r.manual_role !== null,
  }));
}

/** Change a member's role or disable them. The last enabled admin can never be removed. */
export async function updateMember(
  db: Queryable,
  actor: Member,
  memberId: string,
  change: { role?: Role | undefined; disabled?: boolean | undefined },
): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const target = await getMember(db, memberId);
  if (!target) throw notFound('member');
  const losesAdmin = target.role === 'admin' && ((change.role && change.role !== 'admin') || change.disabled === true);
  if (losesAdmin) {
    const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM members WHERE role = 'admin' AND NOT disabled`);
    if (Number(rows[0]!.n) <= 1) throw conflict('last_admin');
  }
  // A role set by hand is the member's own again (a SCIM group mapping no longer raised it); enabling
  // by hand also ends a deactivation by the identity provider.
  await db.query(
    `UPDATE members SET role = COALESCE($2, role), disabled = COALESCE($3, disabled),
       manual_role = CASE WHEN $2::text IS NULL THEN manual_role END,
       scim_disabled = CASE WHEN $3::boolean IS FALSE THEN false ELSE scim_disabled END
     WHERE id = $1`,
    [
    memberId,
    change.role ?? null,
    change.disabled ?? null,
  ]);
  if (change.disabled) await db.query(`DELETE FROM sessions WHERE member_id = $1`, [memberId]);
  await audit(db, {
    actorId: actor.id,
    action: change.disabled ? 'member.disabled' : change.disabled === false ? 'member.enabled' : 'member.role_changed',
    subjectType: 'member',
    subjectId: memberId,
    outcome: 'ok',
  });
}

/** Issue a new API token for a member (shown once). Replaces the old one. */
/** A new API token for the member, issued by the member or an admin (organization policy). */
export async function rotateApiToken(db: Queryable, actor: Member, memberId: string): Promise<string> {
  if (actor.role !== 'admin' && actor.id !== memberId) throw forbidden();
  const token = 'dty_' + randomToken();
  const { rowCount } = await db.query(`UPDATE members SET token_hash = $2 WHERE id = $1`, [memberId, sha256Hex(token)]);
  if (!rowCount) throw notFound('member');
  await audit(db, { actorId: actor.id, action: 'member.token_rotated', subjectType: 'member', subjectId: memberId, outcome: 'ok' });
  return token;
}

/** Revoke a member's API token without issuing a new one. The member or an admin. */
export async function revokeApiToken(db: Queryable, actor: Member, memberId: string): Promise<void> {
  if (actor.role !== 'admin' && actor.id !== memberId) throw forbidden();
  const { rowCount } = await db.query(`UPDATE members SET token_hash = NULL WHERE id = $1`, [memberId]);
  if (!rowCount) throw notFound('member');
  await audit(db, { actorId: actor.id, action: 'member.token_revoked', subjectType: 'member', subjectId: memberId, outcome: 'ok' });
}

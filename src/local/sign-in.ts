import { ConfigError } from '../config.js';
import { createMember, rotateApiToken, type Member } from '../core/members.js';
import { withTx, type Db } from '../db/db.js';

/** Shared by the personal launcher and a local-mode server with an external database. */
export async function prepareLocalSignIn(db: Db, handle = 'admin'): Promise<{ member: Member; token: string }> {
  return withTx(db, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(4243)');
    const { rows } = await tx.query<Member>(
      `SELECT id, handle, role FROM members WHERE role = 'admin' AND NOT disabled ORDER BY created_at LIMIT 1`,
    );
    let member = rows[0];
    if (!member) {
      const existing = await tx.query('SELECT 1 FROM members LIMIT 1');
      if (existing.rowCount) throw new ConfigError('local sign-in requires an enabled administrator');
      member = (await createMember(tx, handle, 'admin', null)).member;
    }
    const token = await rotateApiToken(tx, member, member.id);
    return { member, token };
  });
}

/** Use the browser-facing URL, not Docker's wildcard bind address. */
export function localSignInUrl(publicUrl: string, token: string): string {
  const url = new URL(`${publicUrl.replace(/\/+$/, '')}/auth/local`);
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
  url.searchParams.set('token', token);
  return url.href;
}

import type { Queryable } from '../db/db.js';
import type { Cipher } from './crypto.js';
import { audit } from './audit.js';
import { badRequest } from './errors.js';

const SERVICE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const aad = (memberId: string, service: string) => `credential:${memberId}:${service}`;

/**
 * Personal credential vault. Every read is scoped to one member: there is no
 * function that returns another member's secret, and the ciphertext is bound
 * to (member, service) so it cannot be moved between rows.
 */
export class Vault {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: Cipher,
  ) {}

  async put(memberId: string, service: string, secret: string): Promise<void> {
    if (!SERVICE.test(service)) throw badRequest('invalid_service');
    if (!secret || secret.length > 8192) throw badRequest('invalid_secret');
    await this.db.query(
      `INSERT INTO credentials (member_id, service, secret_enc) VALUES ($1, $2, $3)
       ON CONFLICT (member_id, service) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now(),
         review_due_at = now() + interval '90 days', review_notified_at = NULL, scope_check = NULL`,
      [memberId, service, this.cipher.encrypt(secret, aad(memberId, service))],
    );
    await audit(this.db, {
      actorId: memberId,
      action: 'credential.stored',
      subjectType: 'credential',
      subjectId: service,
      outcome: 'ok',
    });
  }

  async remove(memberId: string, service: string): Promise<void> {
    await this.db.query(`DELETE FROM credentials WHERE member_id = $1 AND service = $2`, [memberId, service]);
  }

  /** Service names only; secrets are never returned through the API. */
  /** Stored services (never secrets), with the last token scope check and when access is next reviewed. */
  async list(memberId: string): Promise<{ service: string; updatedAt: Date; reviewDueAt: Date; scopeCheck: unknown }[]> {
    const { rows } = await this.db.query<{ service: string; updated_at: Date; review_due_at: Date; scope_check: unknown }>(
      `SELECT service, updated_at, review_due_at, scope_check FROM credentials WHERE member_id = $1 ORDER BY service`,
      [memberId],
    );
    return rows.map((r) => ({ service: r.service, updatedAt: r.updated_at, reviewDueAt: r.review_due_at, scopeCheck: r.scope_check }));
  }

  /** Services the member has no credential for. Pass the open transaction when called inside one. */
  async has(memberId: string, services: string[], db: Queryable = this.db): Promise<string[]> {
    if (services.length === 0) return [];
    const { rows } = await db.query<{ service: string }>(
      `SELECT service FROM credentials WHERE member_id = $1 AND service = ANY($2)`,
      [memberId, services],
    );
    const present = new Set(rows.map((r) => r.service));
    return services.filter((s) => !present.has(s));
  }

  /** Used only by the network broker, at request time, for the member a step runs as. */
  async reveal(memberId: string, service: string): Promise<string | null> {
    const { rows } = await this.db.query<{ secret_enc: string }>(
      `SELECT secret_enc FROM credentials WHERE member_id = $1 AND service = $2`,
      [memberId, service],
    );
    const row = rows[0];
    return row ? this.cipher.decrypt(row.secret_enc, aad(memberId, service)) : null;
  }
}

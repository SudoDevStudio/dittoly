import type { Queryable } from '../db/db.js';
import { audit } from './audit.js';
import { canonicalJson, sha256Hex, type Cipher } from './crypto.js';
import { badRequest, forbidden } from './errors.js';
import type { Member } from './members.js';

/**
 * How long a finished run keeps its inputs and step outputs (encrypted) so the
 * people who ran it can see what each step returned. Statuses are kept anyway.
 * 0 days restores the strict default: deleted when the run ends.
 */

const KEY = 'run_data_retention';
export const MAX_RETENTION_DAYS = 90;
export const defaultRetentionDays = (mode: 'local' | 'shared') => (mode === 'local' ? 30 : 7);

export interface Retention {
  days: number;
  isDefault: boolean;
}

export async function getRetention(db: Queryable, mode: 'local' | 'shared'): Promise<Retention> {
  const row = (await db.query<{ value: { days?: number } }>(`SELECT value FROM org_settings WHERE key = $1`, [KEY])).rows[0];
  const days = row?.value.days;
  return typeof days === 'number' ? { days, isDefault: false } : { days: defaultRetentionDays(mode), isDefault: true };
}

export async function setRetention(db: Queryable, actor: Member, days: number, mode: 'local' | 'shared', cipher?: Cipher): Promise<Retention> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) throw badRequest('invalid_retention', `days must be 0 to ${MAX_RETENTION_DAYS}`);
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify({ days }), actor.id],
  );
  // A shorter period applies to data already kept, too.
  await db.query(
    `UPDATE runs SET data_expires_at = LEAST(data_expires_at, COALESCE(finished_at, now()) + make_interval(days => $1))
     WHERE data_expires_at IS NOT NULL`,
    [days],
  );
  await purgeExpiredRunData(db, new Date(), cipher);
  await audit(db, { actorId: actor.id, action: 'org.run_retention_updated', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
  return getRetention(db, mode);
}

/** The same additional data the engine encrypts run inputs and step outputs with. */
export const runDataAad = (runId: string, stepId?: string) => (stepId === undefined ? `run:${runId}:inputs` : `run:${runId}:step:${stepId}:output`);

/** The hash an evidence pack shows for kept data: SHA-256 of its canonical JSON. */
export const runDataHash = (value: unknown) => sha256Hex(canonicalJson(value ?? null));

/**
 * Before kept data is deleted, its hashes are kept (run_data_hashes), so an evidence pack can
 * still show what was there. Needs the cipher; data that cannot be read is deleted without one.
 */
async function keepHashes(db: Queryable, cipher: Cipher, now: Date): Promise<void> {
  const runs = (await db.query<{ id: string; inputs_enc: string | null }>(`SELECT id, inputs_enc FROM runs WHERE data_expires_at IS NOT NULL AND data_expires_at <= $1`, [now])).rows;
  if (!runs.length) return;
  const steps = (await db.query<{ run_id: string; step_id: string; output_enc: string }>(
    `SELECT run_id, step_id, output_enc FROM run_steps WHERE run_id = ANY($1::uuid[]) AND output_enc IS NOT NULL`,
    [runs.map((r) => r.id)],
  )).rows;
  const items = [
    ...runs.filter((r) => r.inputs_enc).map((r) => ({ runId: r.id, stepId: '', enc: r.inputs_enc!, aad: runDataAad(r.id) })),
    ...steps.map((s) => ({ runId: s.run_id, stepId: s.step_id, enc: s.output_enc, aad: runDataAad(s.run_id, s.step_id) })),
  ];
  for (const it of items) {
    let hash: string;
    try {
      hash = runDataHash(cipher.decryptJson(it.enc, it.aad));
    } catch {
      continue;
    }
    await db.query(`INSERT INTO run_data_hashes (run_id, step_id, sha256) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [it.runId, it.stepId, hash]);
  }
}

/** Delete kept inputs and outputs whose time is up. Returns how many runs were purged. */
export async function purgeExpiredRunData(db: Queryable, now = new Date(), cipher?: Cipher): Promise<number> {
  if (cipher) await keepHashes(db, cipher, now);
  const { rows } = await db.query<{ id: string }>(
    `UPDATE runs SET inputs_enc = NULL, data_expires_at = NULL WHERE data_expires_at IS NOT NULL AND data_expires_at <= $1 RETURNING id`,
    [now],
  );
  // The values a sign-off showed are run data too; the hash the decision covers stays (gate_decisions).
  if (rows.length) await db.query(`UPDATE run_steps SET output_enc = NULL, sign_off_enc = NULL, proposed_enc = NULL, log_enc = NULL, detail_enc = NULL WHERE run_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
  if (rows.length) await db.query(`DELETE FROM run_commentary WHERE run_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
  // What a Super Flow kept of its child runs goes with its own outputs.
  if (rows.length) await db.query(`UPDATE run_children SET result_enc = NULL WHERE parent_run_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
  return rows.length;
}

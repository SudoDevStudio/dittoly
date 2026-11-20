import { createHash } from 'node:crypto';
import { withTx, type Db, type Queryable } from '../db/db.js';

/**
 * Tamper evidence for the audit log. Events cannot be updated or deleted (a database
 * trigger refuses it), and a background job chains each event's hash to the one before
 * it. Verifying recomputes the chain: a changed, removed or slipped-in event breaks it.
 * Someone with full database control could rebuild the whole chain, so the report
 * shows the latest hash ("head") to keep somewhere else; a later head must extend it.
 */

export const GENESIS = 'dittoly-audit-v1';

interface EventRow {
  id: string;
  at_us: string;
  actor_id: string | null;
  action: string;
  subject_type: string;
  subject_id: string;
  outcome: string;
  error_type: string | null;
  related_id: string | null;
}

// Qualified, so ORDER BY e.id sorts numbers, not the text alias.
const COLUMNS = `e.id::text AS id, (extract(epoch FROM at) * 1000000)::bigint::text AS at_us, actor_id, action, subject_type, subject_id, outcome, error_type, related_id`;

export function chainHash(prev: string, e: EventRow): string {
  const canonical = JSON.stringify([e.id, e.at_us, e.actor_id, e.action, e.subject_type, e.subject_id, e.outcome, e.error_type, e.related_id]);
  return createHash('sha256').update(`${prev}\n${canonical}`).digest('hex');
}

/** Seal settled events after the last sealed one. Returns how many were sealed. */
/** Events newer than `settleSeconds` wait for the next pass, so a slow transaction cannot commit an id below the seal. */
export async function sealAudit(db: Db, settleSeconds = 30, batch = 5000): Promise<number> {
  return withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(4244)');
    const last = (await tx.query<{ event_id: string; hash: string }>(`SELECT s.event_id::text AS event_id, s.hash FROM audit_seals s ORDER BY s.event_id DESC LIMIT 1`)).rows[0];
    const { rows } = await tx.query<EventRow>(
      `SELECT ${COLUMNS} FROM audit_events e WHERE e.id > $1 AND e.at <= now() - make_interval(secs => $3) ORDER BY e.id LIMIT $2`,
      [last?.event_id ?? '0', batch, settleSeconds],
    );
    let prev = last?.hash ?? GENESIS;
    for (const e of rows) {
      prev = chainHash(prev, e);
      await tx.query(`INSERT INTO audit_seals (event_id, hash) VALUES ($1, $2)`, [e.id, prev]);
    }
    return rows.length;
  });
}

export interface ChainReport {
  ok: boolean;
  /** Events covered by the chain. */
  sealed: number;
  /** Newest events not sealed yet (sealed within a minute or so). */
  pending: number;
  /** Latest chain hash; keep a copy elsewhere to detect a rebuilt chain. */
  head: { eventId: string; hash: string } | null;
  /** What is wrong, in plain words, when not ok. */
  problems: string[];
}

export async function verifyAudit(db: Queryable): Promise<ChainReport> {
  const problems: string[] = [];
  let prev = GENESIS;
  let sealed = 0;
  let head: ChainReport['head'] = null;
  let after = '0';
  for (;;) {
    const { rows } = await db.query<EventRow & { hash: string | null; sealed_id: string | null }>(
      `SELECT ${COLUMNS}, s.hash, s.event_id::text AS sealed_id
       FROM audit_events e LEFT JOIN audit_seals s ON s.event_id = e.id
       WHERE e.id > $1 AND e.id <= coalesce((SELECT max(event_id) FROM audit_seals), 0)
       ORDER BY e.id LIMIT 5000`,
      [after],
    );
    if (rows.length === 0) break;
    for (const e of rows) {
      after = e.id;
      if (!e.sealed_id) {
        problems.push(`Event ${e.id} is inside the sealed range but has no seal (added afterwards).`);
        continue;
      }
      const expected = chainHash(prev, e);
      if (expected !== e.hash) {
        problems.push(`Event ${e.id} does not match its seal (changed, or an event before it was removed).`);
        prev = e.hash!; // keep checking the rest against what was sealed
      } else prev = expected;
      sealed += 1;
      head = { eventId: e.id, hash: e.hash! };
    }
    if (problems.length > 20) break;
  }
  const orphan = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_seals s WHERE NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.id = s.event_id)`);
  if (orphan.rows[0]!.n) problems.push(`${orphan.rows[0]!.n} sealed events are missing.`);
  const pending = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE id > coalesce((SELECT max(event_id) FROM audit_seals), 0)`);
  return { ok: problems.length === 0, sealed, pending: pending.rows[0]!.n, head, problems };
}

import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { assertTeamAdmin, assertTeamMember } from '../core/teams.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { coerce, COLUMN_TYPES, LIMITS, type Column, type ColumnType, type Row } from '../runtime/values.js';

export { coerce, COLUMN_TYPES, LIMITS, type Column, type ColumnType, type Row } from '../runtime/values.js';

/**
 * Data tables: small tables a team keeps, that its Flows read and write with a table step
 * ("already handled ticket 123", a counter, a list of on-call people) and its members edit
 * in the portal. Rows are encrypted; a row is found by a keyed hash of its key.
 * Team admins create tables and change their columns; team members change rows.
 */

export interface DataTable { id: string; teamId: string; name: string; description: string | null; keyColumn: string; columns: Column[]; rowCount: number }

export const TABLE_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,59}$/;
const COLUMN_NAME = /^[a-z][a-z0-9_]{0,39}$/;

const columnSchema = z.object({ name: z.string().regex(COLUMN_NAME, 'lowercase letters, digits and _'), type: z.enum(COLUMN_TYPES) }).strict();
const tableBody = z
  .object({
    teamId: z.string().uuid(),
    name: z.string().regex(TABLE_NAME, 'a name of 1-60 letters, digits, spaces, _ or -'),
    description: z.string().max(300).optional(),
    keyColumn: z.string().regex(COLUMN_NAME),
    columns: z.array(columnSchema).max(LIMITS.columns),
  })
  .strict();

function badColumns(keyColumn: string, columns: Column[]): string | null {
  const names = columns.map((c) => c.name);
  if (new Set(names).size !== names.length) return 'column names must differ';
  if (names.includes(keyColumn)) return 'the key column is not repeated among the other columns';
  return null;
}

/**
 * The tables an approved module declares with their columns, created in its team when missing (the module's
 * approval is the decision; the reviewer saw the columns). A table that exists keeps its rows and gains the
 * columns it lacks. Returns the names created or extended.
 */
export async function createDeclaredTables(
  db: Queryable,
  teamId: string,
  tables: { name: string; purpose: string; keyColumn?: string | undefined; columns?: Column[] | undefined }[],
  actorId: string,
): Promise<string[]> {
  const done: string[] = [];
  for (const t of tables) {
    if (!t.keyColumn) continue;
    const columns = (t.columns ?? []).filter((c) => c.name !== t.keyColumn).slice(0, LIMITS.columns);
    const existing = (await db.query<{ id: string; key_column: string; columns: Column[] }>(`SELECT id, key_column, columns FROM data_tables WHERE team_id = $1 AND name = $2`, [teamId, t.name])).rows[0];
    if (existing) {
      const missing = columns.filter((c) => c.name !== existing.key_column && !existing.columns.some((e) => e.name === c.name));
      if (!missing.length) continue;
      await db.query(`UPDATE data_tables SET columns = $2 WHERE id = $1`, [existing.id, JSON.stringify([...existing.columns, ...missing].slice(0, LIMITS.columns))]);
      await audit(db, { actorId, action: 'table.columns_changed', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: existing.id });
      done.push(t.name);
      continue;
    }
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM data_tables WHERE team_id = $1`, [teamId])).rows[0]!.n;
    if (n >= LIMITS.tables) break;
    const r = await db.query<{ id: string }>(
      `INSERT INTO data_tables (team_id, name, description, key_column, columns, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (team_id, name) DO NOTHING RETURNING id`,
      [teamId, t.name, t.purpose.slice(0, 300), t.keyColumn, JSON.stringify(columns), actorId],
    );
    if (r.rows[0]) {
      await audit(db, { actorId, action: 'table.created', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: r.rows[0].id });
      done.push(t.name);
    }
  }
  return done;
}

/** Turn a value into the column's type; null clears it. */
export class Tables {
  constructor(private readonly db: Db, private readonly cipher: Cipher) {}

  // ------------------------------------------------------------ tables

  async list(actor: Member, teamId: string): Promise<DataTable[]> {
    await assertTeamMember(this.db, teamId, actor);
    return this.inTeam(this.db, teamId);
  }

  async inTeam(db: Queryable, teamId: string): Promise<DataTable[]> {
    const { rows } = await db.query<{ id: string; team_id: string; name: string; description: string | null; key_column: string; columns: Column[]; n: number }>(
      `SELECT t.*, (SELECT count(*)::int FROM data_rows r WHERE r.table_id = t.id) AS n FROM data_tables t WHERE t.team_id = $1 ORDER BY t.name`,
      [teamId],
    );
    return rows.map((r) => ({ id: r.id, teamId: r.team_id, name: r.name, description: r.description, keyColumn: r.key_column, columns: r.columns, rowCount: r.n }));
  }

  async byName(db: Queryable, teamId: string, name: string): Promise<DataTable | null> {
    return (await this.inTeam(db, teamId)).find((t) => t.name === name) ?? null;
  }

  async get(actor: Member, id: string): Promise<DataTable> {
    const t = await this.find(this.db, id);
    await assertTeamMember(this.db, t.teamId, actor);
    return t;
  }

  private async find(db: Queryable, id: string): Promise<DataTable> {
    const team = (await db.query<{ team_id: string }>(`SELECT team_id FROM data_tables WHERE id = $1`, [id])).rows[0];
    if (!team) throw notFound('table');
    return (await this.inTeam(db, team.team_id)).find((t) => t.id === id)!;
  }

  async create(actor: Member, body: unknown): Promise<DataTable> {
    const b = tableBody.safeParse(body);
    if (!b.success) throw badRequest('invalid_table', b.error.issues.map((i) => `${i.path.join('.') || 'table'}: ${i.message}`).join('; '));
    await assertTeamAdmin(this.db, b.data.teamId, actor);
    const problem = badColumns(b.data.keyColumn, b.data.columns);
    if (problem) throw badRequest('invalid_table', problem);
    const n = (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM data_tables WHERE team_id = $1`, [b.data.teamId])).rows[0]!.n;
    if (n >= LIMITS.tables) throw conflict('too_many_tables');
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO data_tables (team_id, name, description, key_column, columns, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (team_id, name) DO NOTHING RETURNING id`,
      [b.data.teamId, b.data.name.trim(), b.data.description ?? null, b.data.keyColumn, JSON.stringify(b.data.columns), actor.id],
    );
    if (!r.rows[0]) throw conflict('table_name_taken');
    await audit(this.db, { actorId: actor.id, action: 'table.created', subjectType: 'team', subjectId: b.data.teamId, outcome: 'ok', relatedId: r.rows[0].id });
    return this.find(this.db, r.rows[0].id);
  }

  /** Columns can be added, removed or retyped; values of a removed column are dropped from rows. */
  async setColumns(actor: Member, id: string, body: unknown): Promise<DataTable> {
    const t = await this.find(this.db, id);
    await assertTeamAdmin(this.db, t.teamId, actor);
    const b = z.object({ columns: z.array(columnSchema).max(LIMITS.columns), description: z.string().max(300).optional() }).strict().safeParse(body);
    if (!b.success) throw badRequest('invalid_table', b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const problem = badColumns(t.keyColumn, b.data.columns);
    if (problem) throw badRequest('invalid_table', problem);
    await this.db.query(`UPDATE data_tables SET columns = $2, description = COALESCE($3, description) WHERE id = $1`, [id, JSON.stringify(b.data.columns), b.data.description ?? null]);
    await audit(this.db, { actorId: actor.id, action: 'table.columns_changed', subjectType: 'team', subjectId: t.teamId, outcome: 'ok', relatedId: id });
    return this.find(this.db, id);
  }

  async remove(actor: Member, id: string): Promise<void> {
    const t = await this.find(this.db, id);
    await assertTeamAdmin(this.db, t.teamId, actor);
    await this.db.query(`DELETE FROM data_tables WHERE id = $1`, [id]);
    await audit(this.db, { actorId: actor.id, action: 'table.deleted', subjectType: 'team', subjectId: t.teamId, outcome: 'ok', relatedId: id });
  }

  // ------------------------------------------------------------ rows

  private decode(t: DataTable, r: { id: string; key_enc: string; values_enc: string; updated_at: Date; revision?: number }): Row & { _updatedAt: Date; _revision: number } {
    const key = this.cipher.decrypt(r.key_enc, `data-row:${r.id}:key`);
    const values = this.cipher.decryptJson<Row>(r.values_enc, `data-row:${r.id}:values`);
    // Only current columns: a removed column's values are not shown.
    const row: Row = { [t.keyColumn]: key };
    for (const c of t.columns) row[c.name] = values[c.name] ?? null;
    return Object.assign(row, { _updatedAt: r.updated_at, _revision: r.revision ?? 1 });
  }

  async rows(db: Queryable, t: DataTable, opts: { where?: { column: string; equals: unknown }; limit?: number } = {}): Promise<Row[]> {
    const { rows } = await db.query<{ id: string; key_enc: string; values_enc: string; updated_at: Date; revision: number }>(
      `SELECT id, key_enc, values_enc, updated_at, revision FROM data_rows WHERE table_id = $1 ORDER BY updated_at DESC`,
      [t.id],
    );
    let out = rows.map((r) => this.decode(t, r));
    if (opts.where) {
      const col = opts.where.column;
      const type = col === t.keyColumn ? 'text' : t.columns.find((c) => c.name === col)?.type;
      if (!type) throw badRequest('unknown_column', col);
      const want = coerce(type, opts.where.equals, col);
      out = out.filter((r) => r[col] === want);
    }
    return out.slice(0, Math.min(opts.limit ?? 100, LIMITS.list)).map(({ _updatedAt, _revision, ...r }) => ({ ...r, updatedAt: _updatedAt, revision: _revision }));
  }

  private hash(t: DataTable, key: string): string {
    return this.cipher.lookupHash(`${t.id}:${key}`);
  }

  private checkKey(key: unknown): string {
    const k = key === null || key === undefined ? '' : String(key);
    if (!k || k.length > LIMITS.keyLength) throw badRequest('invalid_key', `a key of 1-${LIMITS.keyLength} characters`);
    return k;
  }

  async getRow(db: Queryable, t: DataTable, key: unknown): Promise<Row | null> {
    const k = this.checkKey(key);
    const r = (await db.query<{ id: string; key_enc: string; values_enc: string; updated_at: Date; revision: number }>(
      `SELECT id, key_enc, values_enc, updated_at, revision FROM data_rows WHERE table_id = $1 AND key_hash = $2`,
      [t.id, this.hash(t, k)],
    )).rows[0];
    if (!r) return null;
    const { _updatedAt, _revision, ...row } = this.decode(t, r);
    // The revision a Flow reads here is what it passes back as "ifRevision" when it writes.
    return { ...row, updatedAt: _updatedAt, revision: _revision };
  }

  /** Create the row or change the given columns of it (others stay). */
  async putRow(
    db: Queryable,
    t: DataTable,
    key: unknown,
    values: Record<string, unknown>,
    by: { memberId?: string; runId?: string },
    /** Write only if the row is still the one that was read ("ifRevision"); 0 means "only if there is no row yet". */
    ifRevision?: number,
  ): Promise<{ row: Row; created: boolean }> {
    const k = this.checkKey(key);
    const clean: Row = {};
    for (const [name, v] of Object.entries(values ?? {})) {
      if (name === t.keyColumn) continue;
      const c = t.columns.find((x) => x.name === name);
      if (!c) throw badRequest('unknown_column', `${t.name} has no column "${name}"`);
      clean[name] = coerce(c.type, v, name);
    }
    const hash = this.hash(t, k);
    // Lock the table's rows for this key: concurrent runs changing the same row take turns.
    const found = (await db.query<{ id: string; values_enc: string; revision: number }>(
      `SELECT id, values_enc, revision FROM data_rows WHERE table_id = $1 AND key_hash = $2 FOR UPDATE`,
      [t.id, hash],
    )).rows[0];
    if (found) {
      // Someone changed the row between the read and this write: the caller decides what to do, nothing is lost.
      if (ifRevision !== undefined && ifRevision !== found.revision) {
        throw new AppError('row_changed', 409, `${t.name}: the row "${k}" is at revision ${found.revision}, not ${ifRevision}: read it again`);
      }
      // Nothing to change (increment only makes sure the row is there): leave it exactly as it is, revision too.
      if (!Object.keys(clean).length) return { row: (await this.getRow(db, t, k))!, created: false };
      const merged = { ...this.cipher.decryptJson<Row>(found.values_enc, `data-row:${found.id}:values`), ...clean };
      this.checkSize(merged);
      await db.query(`UPDATE data_rows SET values_enc = $2, updated_at = now(), updated_by = $3, updated_run = $4, revision = revision + 1 WHERE id = $1`, [
        found.id, this.cipher.encryptJson(merged, `data-row:${found.id}:values`), by.memberId ?? null, by.runId ?? null,
      ]);
      return { row: (await this.getRow(db, t, k))!, created: false };
    }
    // No row: only a write that expected none (0) or expected nothing at all may make one.
    if (ifRevision !== undefined && ifRevision !== 0) throw new AppError('row_changed', 409, `${t.name}: the row "${k}" is gone: read it again`);
    const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM data_rows WHERE table_id = $1`, [t.id])).rows[0]!.n;
    if (count >= LIMITS.rows) throw conflict('table_full');
    this.checkSize(clean);
    const id = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
    const inserted = await db.query(
      `INSERT INTO data_rows (id, table_id, key_hash, key_enc, values_enc, updated_by, updated_run) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (table_id, key_hash) DO NOTHING`,
      [id, t.id, hash, this.cipher.encrypt(k, `data-row:${id}:key`), this.cipher.encryptJson(clean, `data-row:${id}:values`), by.memberId ?? null, by.runId ?? null],
    );
    // Someone else made it a moment ago: change theirs instead (or refuse, when this write expected no row).
    if (!inserted.rowCount) return this.putRow(db, t, k, values, by, ifRevision);
    return { row: (await this.getRow(db, t, k))!, created: true };
  }

  async deleteRow(db: Queryable, t: DataTable, key: unknown): Promise<boolean> {
    const k = this.checkKey(key);
    const r = await db.query(`DELETE FROM data_rows WHERE table_id = $1 AND key_hash = $2`, [t.id, this.hash(t, k)]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Hold a key for one run, until it ends or `hours` pass (whichever is first). Of runs claiming the same key at the
   * same time exactly one gets it (the conflict is decided by the primary key); the holder may claim again; a claim
   * whose run ended or whose hours passed goes to the next run.
   */
  async claim(db: Queryable, t: DataTable, key: unknown, hours: number, runId: string): Promise<{ claimed: boolean; until: string | null }> {
    const k = this.checkKey(key);
    const r = await db.query<{ until: Date }>(
      `INSERT INTO data_claims (table_id, key_hash, run_id, until) VALUES ($1, $2, $3, now() + make_interval(hours => $4))
       ON CONFLICT (table_id, key_hash) DO UPDATE SET run_id = EXCLUDED.run_id, until = EXCLUDED.until
         WHERE data_claims.until < now() OR data_claims.run_id = EXCLUDED.run_id
            OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = data_claims.run_id AND r.status IN ('running', 'waiting', 'paused'))
       RETURNING until`,
      [t.id, this.hash(t, k), runId, hours],
    );
    return r.rows[0] ? { claimed: true, until: r.rows[0].until.toISOString() } : { claimed: false, until: null };
  }

  /** Add to a number column (creating the row at 0 first), atomically. */
  async increment(db: Queryable, t: DataTable, key: unknown, column: string, by: unknown, who: { memberId?: string; runId?: string }): Promise<{ value: number; row: Row }> {
    const c = t.columns.find((x) => x.name === column);
    if (!c || c.type !== 'number') throw badRequest('invalid_column', `"${column}" is not a number column of ${t.name}`);
    const step = coerce('number', by ?? 1, 'by') as number;
    const k = this.checkKey(key);
    await this.putRow(db, t, k, {}, who); // make sure it exists
    const r = (await db.query<{ id: string; values_enc: string }>(`SELECT id, values_enc FROM data_rows WHERE table_id = $1 AND key_hash = $2 FOR UPDATE`, [t.id, this.hash(t, k)])).rows[0]!;
    const values = this.cipher.decryptJson<Row>(r.values_enc, `data-row:${r.id}:values`);
    const value = (typeof values[column] === 'number' ? (values[column] as number) : 0) + step;
    await db.query(`UPDATE data_rows SET values_enc = $2, updated_at = now(), updated_by = $3, updated_run = $4, revision = revision + 1 WHERE id = $1`, [
      r.id, this.cipher.encryptJson({ ...values, [column]: value }, `data-row:${r.id}:values`), who.memberId ?? null, who.runId ?? null,
    ]);
    return { value, row: (await this.getRow(db, t, k))! };
  }

  private checkSize(values: Row): void {
    if (JSON.stringify(values).length > LIMITS.rowBytes) throw badRequest('row_too_large', `a row holds at most ${LIMITS.rowBytes / 1000} KB`);
  }

  // ------------------------------------------------------------ portal edits (team members)

  async portalRows(actor: Member, id: string, q: { column?: string; equals?: string; limit?: number }): Promise<{ table: DataTable; rows: Row[] }> {
    const t = await this.get(actor, id);
    return { table: t, rows: await this.rows(this.db, t, { ...(q.column ? { where: { column: q.column, equals: q.equals ?? '' } } : {}), limit: q.limit ?? LIMITS.list }) };
  }

  async portalPut(actor: Member, id: string, body: unknown): Promise<Row> {
    const b = z.object({ key: z.string(), values: z.record(z.string(), z.unknown()) }).strict().safeParse(body);
    if (!b.success) throw badRequest('invalid_row');
    const t = await this.get(actor, id);
    const r = await withTx(this.db, (tx) => this.putRow(tx, t, b.data.key, b.data.values, { memberId: actor.id }));
    await audit(this.db, { actorId: actor.id, action: r.created ? 'table.row_added' : 'table.row_changed', subjectType: 'team', subjectId: t.teamId, outcome: 'ok', relatedId: id });
    return r.row;
  }

  async portalDelete(actor: Member, id: string, key: string): Promise<void> {
    const t = await this.get(actor, id);
    if (!(await this.deleteRow(this.db, t, key))) throw notFound('row');
    await audit(this.db, { actorId: actor.id, action: 'table.row_deleted', subjectType: 'team', subjectId: t.teamId, outcome: 'ok', relatedId: id });
  }
}

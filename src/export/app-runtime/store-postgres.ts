import pg from 'pg';
import { isActive, type RunRecord, type Sealer, type Store } from './store.js';

/**
 * State in Postgres: three tables the app creates if they are missing (no migrations to run).
 * Run data is sealed; status, Flow and times stay readable so lists are one query.
 */
/** The tables' prefix before "dty": an app that ran with it keeps its data (renamed once, below). */
const OLD = 'mlm';
const RENAME_OLD = `
DO $$ BEGIN
  IF to_regclass('${OLD}_runs') IS NOT NULL AND to_regclass('dty_runs') IS NULL THEN
    ALTER TABLE ${OLD}_runs RENAME TO dty_runs;
    ALTER INDEX IF EXISTS ${OLD}_runs_list RENAME TO dty_runs_list;
    ALTER INDEX IF EXISTS ${OLD}_runs_active RENAME TO dty_runs_active;
  END IF;
  IF to_regclass('${OLD}_rows') IS NOT NULL AND to_regclass('dty_rows') IS NULL THEN ALTER TABLE ${OLD}_rows RENAME TO dty_rows; END IF;
  IF to_regclass('${OLD}_marks') IS NOT NULL AND to_regclass('dty_marks') IS NULL THEN ALTER TABLE ${OLD}_marks RENAME TO dty_marks; END IF;
END $$;`;
const SCHEMA = `${RENAME_OLD}
CREATE TABLE IF NOT EXISTS dty_runs (
  id text PRIMARY KEY, flow text NOT NULL, top boolean NOT NULL, active boolean NOT NULL,
  created_at timestamptz NOT NULL, expires_at timestamptz, data text NOT NULL);
CREATE INDEX IF NOT EXISTS dty_runs_list ON dty_runs (top, created_at DESC);
CREATE INDEX IF NOT EXISTS dty_runs_active ON dty_runs (active) WHERE active;
CREATE TABLE IF NOT EXISTS dty_rows (tbl text NOT NULL, key text NOT NULL, data text NOT NULL, PRIMARY KEY (tbl, key));
CREATE TABLE IF NOT EXISTS dty_marks (name text PRIMARY KEY, until timestamptz NOT NULL);`;

export class PostgresStore implements Store {
  get unreadable() {
    return this.sealer.unreadable;
  }
  readonly kind = 'postgres' as const;
  private constructor(
    private readonly pool: pg.Pool,
    private readonly sealer: Sealer,
  ) {}

  static async open(url: string, sealer: Sealer): Promise<PostgresStore> {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    pool.on('error', () => undefined);
    await pool.query(SCHEMA);
    return new PostgresStore(pool, sealer);
  }

  private open = (rows: { id: string; data: string }[]) => rows.map((r) => this.sealer.tryOpen<RunRecord>(r.data, `run:${r.id}`)).filter((r): r is RunRecord => r !== null);

  async getRun(id: string) {
    return this.open((await this.pool.query<{ id: string; data: string }>(`SELECT id, data FROM dty_runs WHERE id = $1`, [id])).rows)[0] ?? null;
  }
  async putRun(run: RunRecord) {
    await this.pool.query(
      `INSERT INTO dty_runs (id, flow, top, active, created_at, expires_at, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET active = EXCLUDED.active, expires_at = EXCLUDED.expires_at, data = EXCLUDED.data`,
      [run.id, run.flow, !run.parent, isActive(run), run.createdAt, run.expiresAt, this.sealer.seal(run, `run:${run.id}`)],
    );
  }
  async listRuns(o: { flow?: string; limit: number }) {
    const { rows } = await this.pool.query<{ id: string; data: string }>(
      `SELECT id, data FROM dty_runs WHERE top AND ($1::text IS NULL OR flow = $1) ORDER BY created_at DESC LIMIT $2`,
      [o.flow ?? null, o.limit],
    );
    return this.open(rows);
  }
  async activeRuns() {
    return this.open((await this.pool.query<{ id: string; data: string }>(`SELECT id, data FROM dty_runs WHERE active`)).rows);
  }
  async tableGet(table: string, key: string) {
    const row = (await this.pool.query<{ data: string }>(`SELECT data FROM dty_rows WHERE tbl = $1 AND key = $2`, [table, key])).rows[0];
    return row ? this.sealer.tryOpen<Record<string, unknown>>(row.data, `tbl:${table}:${key}`) : null;
  }
  async tablePut(table: string, key: string, row: Record<string, unknown>) {
    await this.pool.query(`INSERT INTO dty_rows (tbl, key, data) VALUES ($1, $2, $3) ON CONFLICT (tbl, key) DO UPDATE SET data = EXCLUDED.data`, [
      table,
      key,
      this.sealer.seal(row, `tbl:${table}:${key}`),
    ]);
  }
  async tableDelete(table: string, key: string) {
    return ((await this.pool.query(`DELETE FROM dty_rows WHERE tbl = $1 AND key = $2`, [table, key])).rowCount ?? 0) > 0;
  }
  async tableRows(table: string) {
    const { rows } = await this.pool.query<{ key: string; data: string }>(`SELECT key, data FROM dty_rows WHERE tbl = $1 ORDER BY key`, [table]);
    return rows.flatMap((r) => {
      const row = this.sealer.tryOpen<Record<string, unknown>>(r.data, `tbl:${table}:${r.key}`);
      return row ? [{ key: r.key, row }] : [];
    });
  }
  async mark(name: string, ttlSeconds: number) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO dty_marks (name, until) VALUES ($1, now() + make_interval(secs => $2))
       ON CONFLICT (name) DO UPDATE SET until = EXCLUDED.until WHERE dty_marks.until <= now()`,
      [name, ttlSeconds],
    );
    return (rowCount ?? 0) > 0;
  }
  async sweep(now: Date) {
    await this.pool.query(`DELETE FROM dty_marks WHERE until <= $1`, [now]);
    return (await this.pool.query(`DELETE FROM dty_runs WHERE expires_at <= $1`, [now])).rowCount ?? 0;
  }
  async close() {
    await this.pool.end();
  }
}

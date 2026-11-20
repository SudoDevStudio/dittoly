import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MIGRATIONS_DIR } from '../paths.js';
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

/**
 * `max` is the connection pool size. The embedded database (local install) uses 1:
 * PGlite has a single backend, and one client connection keeps its protocol
 * stream from interleaving. Code must therefore never wait on a second
 * connection while holding a transaction; pass the transaction instead.
 */
export function createDb(databaseUrl: string, max = Number(process.env.DITTOLY_DB_POOL_MAX ?? 10)): Db {
  return new pg.Pool({ connectionString: databaseUrl, max });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const migrationsDir = MIGRATIONS_DIR;

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    await withTx(db, async (tx) => {
      // Serialize concurrent migrators.
      await tx.query('SELECT pg_advisory_xact_lock(4242)');
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) return;
      await tx.query(await readFile(path.join(migrationsDir, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    });
  }
  return applied;
}

/** Migration files this server has that the database has not applied (readiness). */
export async function pendingMigrations(db: Queryable): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  return files.filter((f) => !applied.has(f)).sort();
}

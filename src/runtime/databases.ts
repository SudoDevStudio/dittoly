import type { MongoOp } from './mongo.js';
import type { Dialect } from './sql.js';
import { resolveChecked, type EgressPolicy, type Resolver } from './egress.js';
import { TransportError, type Login, type Target, type Transports } from './protocols.js';

/**
 * Database connections for fixed module queries and MongoDB operations. The broker has already checked the query,
 * its parameters and the action's effect; this connects (one connection per call, to an
 * address the egress policy allows, with TLS verifying the server's name), runs the one
 * statement with bound parameters, and stops at the row and size limits.
 *
 * Reads run in a transaction that is always rolled back, and in Postgres and MySQL that
 * transaction is READ ONLY, so the database itself refuses changes.
 */

export interface DbRequest {
  /** The manifest's id for the query (for logs and sandbox tests). */
  queryId: string;
  tls: boolean;
  /** Extra CA certificates (PEM) to trust, e.g. Supabase's. */
  ca?: string | undefined;
  login: Login;
  database: string;
  /** SQL with the dialect's own placeholders ($1, ?, @p1). */
  text: string;
  values: (string | number | boolean | null)[];
  readOnly: boolean;
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
}

export interface DbResult {
  rows: Record<string, unknown>[];
  /** Rows changed by a write; rows returned by a read. */
  rowCount: number;
  /** More rows matched than maxRows. */
  truncated: boolean;
}

export interface MongoRequest {
  queryId: string;
  /** mongodb+srv:// (Atlas): the members come from DNS; otherwise one host or a replica set seed. */
  srv: boolean;
  tls: boolean;
  ca?: string | undefined;
  login: Login;
  authSource: string;
  database: string;
  collection: string;
  op: MongoOp;
  filter?: Record<string, unknown> | undefined;
  projection?: Record<string, unknown> | undefined;
  sort?: Record<string, unknown> | undefined;
  pipeline?: Record<string, unknown>[] | undefined;
  document?: Record<string, unknown> | undefined;
  update?: Record<string, unknown> | undefined;
  upsert?: boolean | undefined;
  readOnly: boolean;
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
}

/** Values the module can read as JSON: dates as ISO text, binary as base64, big numbers as text. */
export function plain(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export class Rows {
  rows: Record<string, unknown>[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  add(row: Record<string, unknown>) {
    const p = plain(row) as Record<string, unknown>;
    this.bytes += Buffer.byteLength(JSON.stringify(p));
    if (this.bytes > this.maxBytes) throw new TransportError('response_too_large', false);
    this.rows.push(p);
  }
}

/** Database errors become stable codes; the server's message (which can quote data) is never passed on. */
export function dbError(err: unknown, dialect: Dialect): TransportError {
  if (err instanceof TransportError) return err;
  const e = err as { code?: unknown; number?: unknown; errno?: unknown; message?: unknown };
  const code = String(e.code ?? '');
  const message = String(e.message ?? '');
  if (/timeout|ETIMEDOUT/i.test(code) || code === '57014' || /timeout|timed out/i.test(message)) return new TransportError('db_timeout', true);
  if (code === '28P01' || code === 'ER_ACCESS_DENIED_ERROR' || e.number === 18456 || code === 'ELOGIN') return new TransportError('db_login_failed', false);
  if (/certificate|self[- ]signed|altnames|SSL|TLS/i.test(message) || /CERT|TLS|SSL/.test(code)) return new TransportError('db_tls_failed', false);
  if (code === '25006' || code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION') return new TransportError('db_read_only', false);
  if (code === '23505' || code === 'ER_DUP_ENTRY' || e.number === 2627 || e.number === 2601) return new TransportError('db_duplicate', false);
  if (/^23/.test(code) || code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2' || e.number === 547) return new TransportError('db_constraint', false);
  if (code === '42501' || code === 'ER_TABLEACCESS_DENIED_ERROR' || e.number === 229) return new TransportError('db_permission_denied', false);
  if (code === '40001' || code === '40P01' || code === 'ER_LOCK_DEADLOCK' || e.number === 1205) return new TransportError('db_conflict', true);
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|ESOCKET|EPIPE/.test(code) || /ECONNREFUSED|ECONNRESET/.test(message)) return new TransportError('db_unreachable', true);
  return new TransportError(`${dialect}_error`, false);
}

/** A driver for one SQL dialect (db-postgres.ts, db-mysql.ts, db-mssql.ts). `address` is the checked address of the host. */
export type SqlDriver = (t: Target, r: DbRequest, c: { address: string; policy: EgressPolicy; resolve?: Resolver | undefined }) => Promise<DbResult>;

/** Database queries through the drivers given; a dialect without a driver is refused. */
export function sqlQueries(drivers: Partial<Record<Dialect, SqlDriver>>, policy: EgressPolicy, resolve?: Resolver): Transports['db'] {
  return async (dialect, t, r) => {
    const driver = drivers[dialect];
    if (!driver) throw new TransportError(`${dialect}_unavailable`, false);
    const { address } = await resolveChecked(t.hostname, t.hostKeys, policy, resolve);
    try {
      return await driver(t, r, { address, policy, resolve });
    } catch (err) {
      throw dbError(err, dialect);
    }
  };
}

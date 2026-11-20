import type { ObjectId } from 'mongodb';
import { isIP } from 'node:net';
import { Rows, type DbResult, type MongoRequest } from './databases.js';
import { EgressDeniedError, resolveChecked, type EgressPolicy, type Resolver } from './egress.js';
import { TransportError, type Target, type TransportMaker } from './protocols.js';
import { startRelay } from './socks-relay.js';

/** MongoDB operations (and Atlas, through mongodb+srv). */

/** { $oid } and { $date } (from parameters or the template) become BSON values. */
function toBson(v: unknown, ObjectId: new (hex: string) => ObjectId): unknown {
  if (Array.isArray(v)) return v.map((x) => toBson(x, ObjectId));
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    const o = v as Record<string, unknown>;
    if (keys.length === 1 && typeof o.$oid === 'string' && /^[0-9a-f]{24}$/i.test(o.$oid)) return new ObjectId(o.$oid);
    if (keys.length === 1 && typeof o.$date === 'string' && !Number.isNaN(Date.parse(o.$date))) return new Date(o.$date);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, toBson(x, ObjectId)]));
  }
  return v;
}

/** BSON values the module can read as JSON. */
function fromBson(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v && typeof v === 'object') {
    const t = (v as { _bsontype?: string })._bsontype;
    if (t === 'ObjectId') return (v as ObjectId).toHexString();
    if (t === 'Binary') return Buffer.from((v as { buffer: Uint8Array }).buffer).toString('base64');
    if (t === 'Decimal128' || t === 'Long' || t === 'Double' || t === 'Int32' || t === 'Timestamp' || t === 'UUID') return String(v);
    if (t) return String(v);
    if (Array.isArray(v)) return v.map(fromBson);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromBson(x)]));
  }
  if (typeof v === 'bigint') return v.toString();
  return v;
}

function mongoError(err: unknown): TransportError {
  if (err instanceof TransportError) return err;
  const e = err as { code?: unknown; codeName?: unknown; name?: unknown; message?: unknown };
  const name = String(e.name ?? '');
  const message = String(e.message ?? '');
  if (e.code === 50 || e.codeName === 'MaxTimeMSExpired' || /timed out|timeout/i.test(message)) return new TransportError('db_timeout', true);
  if (e.code === 18 || e.codeName === 'AuthenticationFailed' || /Authentication failed/i.test(message)) return new TransportError('db_login_failed', false);
  if (e.code === 13 || e.codeName === 'Unauthorized') return new TransportError('db_permission_denied', false);
  if (e.code === 11000) return new TransportError('db_duplicate', false);
  if (e.code === 121) return new TransportError('db_constraint', false);
  if (e.code === 112 || e.codeName === 'WriteConflict') return new TransportError('db_conflict', true);
  if (/certificate|self[- ]signed|altnames|SSL|TLS/i.test(message)) return new TransportError('db_tls_failed', false);
  if (name === 'MongoServerSelectionError' || name === 'MongoNetworkError' || name === 'MongoNetworkTimeoutError') return new TransportError('db_unreachable', true);
  return new TransportError('mongodb_error', false);
}

/** Run one checked MongoDB operation. Every connection the driver makes goes through the relay. */
export async function runMongoOperation(t: Target, r: MongoRequest, policy: EgressPolicy, resolve?: Resolver): Promise<DbResult> {
  if (!r.srv) await resolveChecked(t.hostname, t.hostKeys, policy, resolve);
  const relay = await startRelay(t.hostname, t.port, t.hostKeys, policy, { ...(resolve ? { resolve } : {}), timeoutMs: r.timeoutMs + 5_000 });
  const host = isIP(t.hostname) === 6 ? `[${t.hostname}]` : t.hostname;
  const uri = r.srv ? `mongodb+srv://${host}/` : `mongodb://${host}:${t.port}/`;
  const { MongoClient, ObjectId } = await import('mongodb');
  const bson = (v: unknown) => toBson(v, ObjectId);
  const client = new MongoClient(uri, {
    auth: { username: r.login.username, password: r.login.password },
    authSource: r.authSource,
    tls: r.tls,
    ...(r.ca ? { ca: r.ca } : {}),
    proxyHost: '127.0.0.1',
    proxyPort: relay.port,
    proxyUsername: relay.username,
    proxyPassword: relay.password,
    serverSelectionTimeoutMS: r.timeoutMs,
    connectTimeoutMS: r.timeoutMs,
    socketTimeoutMS: r.timeoutMs + 1_000,
    maxPoolSize: 2,
    // A write that may have reached the server is not repeated (like every module write).
    retryWrites: false,
    retryReads: true,
    appName: 'dittoly',
    ...(r.srv ? {} : { directConnection: false }),
  });
  try {
    await client.connect();
    const coll = client.db(r.database).collection(r.collection);
    const maxTimeMS = r.timeoutMs;
    const out = new Rows(r.maxBytes);
    const filter = bson(r.filter ?? {}) as Record<string, unknown>;
    switch (r.op) {
      case 'find':
      case 'findOne': {
        const limit = r.op === 'findOne' ? 1 : r.maxRows;
        const cursor = coll.find(filter, { projection: r.projection, sort: r.sort as Record<string, 1 | -1> | undefined, limit: limit + 1, maxTimeMS });
        const docs = await cursor.toArray();
        for (const d of docs.slice(0, limit)) out.add(fromBson(d) as Record<string, unknown>);
        return { rows: out.rows, rowCount: out.rows.length, truncated: docs.length > limit };
      }
      case 'countDocuments': {
        const n = await coll.countDocuments(filter, { maxTimeMS });
        return { rows: [{ count: n }], rowCount: n, truncated: false };
      }
      case 'aggregate': {
        const pipeline = [...((bson(r.pipeline ?? []) as Record<string, unknown>[]) ?? []), { $limit: r.maxRows + 1 }];
        const docs = await coll.aggregate(pipeline, { maxTimeMS }).toArray();
        for (const d of docs.slice(0, r.maxRows)) out.add(fromBson(d) as Record<string, unknown>);
        return { rows: out.rows, rowCount: out.rows.length, truncated: docs.length > r.maxRows };
      }
      case 'insertOne': {
        const res = await coll.insertOne(bson(r.document ?? {}) as Record<string, unknown>);
        return { rows: [{ insertedId: fromBson(res.insertedId) }], rowCount: 1, truncated: false };
      }
      case 'updateOne':
      case 'updateMany': {
        const update = bson(r.update ?? {}) as Record<string, unknown>;
        const opts = { upsert: r.upsert === true, maxTimeMS };
        const res = r.op === 'updateOne' ? await coll.updateOne(filter, update, opts) : await coll.updateMany(filter, update, opts);
        return { rows: res.upsertedId ? [{ upsertedId: fromBson(res.upsertedId) }] : [], rowCount: res.modifiedCount + res.upsertedCount, truncated: false };
      }
      case 'deleteOne':
      case 'deleteMany': {
        const res = r.op === 'deleteOne' ? await coll.deleteOne(filter, { maxTimeMS }) : await coll.deleteMany(filter, { maxTimeMS });
        return { rows: [], rowCount: res.deletedCount, truncated: false };
      }
    }
  } catch (err) {
    if (relay.denied.length) throw new EgressDeniedError();
    throw mongoError(err);
  } finally {
    await client.close(true).catch(() => undefined);
    await relay.close();
  }
}

export const mongo: TransportMaker<'mongo'> = (policy) => (t, r) => runMongoOperation(t, r, policy);

import { MongoClient } from 'mongodb';
import { SocksClient } from 'socks';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMongoOperation, checkMongoParams, fillTemplate, type MongoOperation } from '../src/modules/mongo.js';
import { parseManifest, resolveManifest, reviewSummary, type Manifest } from '../src/modules/manifest.js';
import { Broker } from '../src/sandbox/broker.js';
import type { MongoRequest } from '../src/runtime/databases.js';
import { runMongoOperation } from '../src/runtime/transports.js';
import { sameDeployment, startRelay } from '../src/runtime/socks-relay.js';
import { makeWorld, type World } from './helpers.js';

/** MongoDB modules: fixed operations whose templates take single values only; every connection goes through the relay. */

const op = (o: Partial<MongoOperation>): MongoOperation => ({ id: 'q', effect: 'read', collection: 'orders', op: 'find', params: {}, maxRows: 100, ...o });
const problems = (o: Partial<MongoOperation>) => checkMongoOperation(op(o)).problems;

describe('the operation check', () => {
  it('accepts fixed reads and writes with placeholders', () => {
    expect(problems({ filter: { status: { $param: 's' }, total: { $gte: { $param: 'min' } } }, projection: { _id: 1, status: 1 }, sort: { placed: -1 } })).toEqual([]);
    expect(problems({ op: 'aggregate', pipeline: [{ $match: { status: { $param: 's' } } }, { $group: { _id: '$customer', n: { $sum: 1 } } }, { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'c' } }] })).toEqual([]);
    expect(problems({ effect: 'write', op: 'updateOne', filter: { _id: { $param: 'id' } }, update: { $set: { status: 'shipped' }, $currentDate: { updated: true } } })).toEqual([]);
    expect(problems({ effect: 'write', op: 'insertOne', document: { order: { $param: 'id' }, note: { $param: 'n' } } })).toEqual([]);
    expect(checkMongoOperation(op({ filter: { a: { $param: 'x' }, b: { $in: [{ $param: 'y' }, { $param: 'x' }] } } })).params).toEqual(['x', 'y', 'x']);
  });

  it('refuses code, writes elsewhere, and placeholders that could become operators or patterns', () => {
    expect(problems({ filter: { $where: 'this.a == 1' } })).toContain('$where is not allowed');
    expect(problems({ op: 'aggregate', pipeline: [{ $match: {} }, { $out: 'copy' }] })).toContain('$out is not allowed');
    expect(problems({ op: 'aggregate', pipeline: [{ $merge: { into: 'x' } }] })).toContain('$merge is not allowed');
    expect(problems({ op: 'aggregate', pipeline: [{ $group: { _id: null, x: { $accumulator: {} } } }] })).toContain('$accumulator is not allowed');
    expect(problems({ filter: { $expr: { $function: { body: 'return 1', args: [], lang: 'js' } } } })).toContain('$function is not allowed');
    expect(problems({ op: 'aggregate', pipeline: [{ $currentOp: {} }] })).toContain('$currentOp is not allowed');
    expect(problems({ op: 'aggregate', pipeline: [{ $lookup: { from: { $param: 'c' }, as: 'x' } }] })).toContain('$lookup must name its collection literally');
    expect(problems({ filter: { name: { $regex: { $param: 'p' } } } })[0]).toMatch(/regular expression/);
    expect(problems({ op: 'aggregate', pipeline: [{ $match: {}, $limit: 1 }] })[0]).toMatch(/one stage/);
    expect(problems({ effect: 'write', op: 'updateOne', filter: { a: 1 }, update: { status: 'x' } })[0]).toMatch(/only update operators/);
    expect(problems({ effect: 'write', op: 'deleteMany' })).toContain('deleteMany needs a filter');
    expect(problems({ effect: 'write', op: 'updateMany', filter: {}, update: { $set: { a: 1 } } })).toContain('updateMany needs a filter');
    expect(problems({ effect: 'write', op: 'find' })[0]).toMatch(/a write operation must be/);
    expect(problems({ op: 'deleteOne' })[0]).toMatch(/a read operation must be/);
    expect(problems({ effect: 'write', op: 'insertOne', document: { $set: { a: 1 } } })[0]).toMatch(/cannot start with "\$"/);
    expect(problems({ sort: { a: 'asc' } })).toContain('sort.a must be 1 or -1');
  });

  it('values are single values of the declared type; in a pipeline a string cannot be a field path', () => {
    const p = { s: { type: 'string' as const }, id: { type: 'objectId' as const }, at: { type: 'timestamp' as const, nullable: true } };
    expect(checkMongoParams(p, { s: 'new', id: '65a1b2c3d4e5f60718293a4b' }, false)).toEqual({ ok: true, values: { s: 'new', id: { $oid: '65a1b2c3d4e5f60718293a4b' }, at: null } });
    expect(checkMongoParams(p, { s: { $gt: '' }, id: '65a1b2c3d4e5f60718293a4b' }, false)).toEqual({ ok: false, error: 'db_bad_param_type' });
    expect(checkMongoParams(p, { s: ['a'], id: '65a1b2c3d4e5f60718293a4b' }, false)).toEqual({ ok: false, error: 'db_bad_param_type' });
    expect(checkMongoParams(p, { s: 'x', id: 'not-an-id' }, false)).toEqual({ ok: false, error: 'db_bad_param_type' });
    expect(checkMongoParams(p, { s: '$owner', id: '65a1b2c3d4e5f60718293a4b' }, false)).toMatchObject({ ok: true });
    expect(checkMongoParams(p, { s: '$owner', id: '65a1b2c3d4e5f60718293a4b' }, true)).toEqual({ ok: false, error: 'db_bad_param_type' });
    expect(checkMongoParams(p, { s: 'x', id: '65a1b2c3d4e5f60718293a4b', $where: '1' }, false)).toEqual({ ok: false, error: 'db_unknown_param' });
    expect(fillTemplate({ a: { $param: 's' }, b: [{ $param: 's' }], c: 'lit' }, { s: 'v' })).toEqual({ a: 'v', b: ['v'], c: 'lit' });
  });
});

describe('the relay', () => {
  it('only connects to the endpoint\'s own deployment', () => {
    expect(sameDeployment('cluster0.abcde.mongodb.net', 'cluster0-shard-00-01.abcde.mongodb.net')).toBe(true);
    expect(sameDeployment('cluster0.abcde.mongodb.net', 'CLUSTER0.abcde.mongodb.net.')).toBe(true);
    expect(sameDeployment('cluster0.abcde.mongodb.net', 'evil.mongodb.net')).toBe(false);
    expect(sameDeployment('cluster0.abcde.mongodb.net', 'abcde.mongodb.net.evil.com')).toBe(false);
    expect(sameDeployment('cluster0.abcde.mongodb.net', '10.0.0.5')).toBe(false);
    // Members share the endpoint's parent domain (never a bare public suffix).
    expect(sameDeployment('db.example.com', 'db2.example.com')).toBe(true);
    expect(sameDeployment('db.example.com', 'example.org')).toBe(false);
    expect(sameDeployment('example.com', 'x.example.com')).toBe(true);
    expect(sameDeployment('127.0.0.1', '127.0.0.1')).toBe(true);
  });

  let echo: Server;
  let echoPort = 0;
  beforeAll(async () => {
    echo = createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    echoPort = (echo.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => echo.close(() => r())));

  it('needs its one-time password, and applies the address and name rules', async () => {
    const keys = [`127.0.0.1:${echoPort}`];
    const relay = await startRelay('127.0.0.1', echoPort, keys, { internalHosts: [], loopbackHosts: keys });
    const via = (host: string, port: number, password = relay.password) =>
      SocksClient.createConnection({ command: 'connect', destination: { host, port }, proxy: { host: '127.0.0.1', port: relay.port, type: 5, userId: relay.username, password }, timeout: 3000 });
    const c = await via('127.0.0.1', echoPort);
    c.socket.write('ping');
    expect(String(await new Promise((r) => c.socket.once('data', r)))).toBe('ping');
    c.socket.destroy();
    await expect(via('127.0.0.1', echoPort, 'guess')).rejects.toThrow();
    await expect(via('169.254.169.254', 27017)).rejects.toThrow();
    await expect(via('10.0.0.5', echoPort)).rejects.toThrow();
    expect(relay.denied).toEqual(['169.254.169.254:27017', `10.0.0.5:${echoPort}`]);
    await relay.close();

    // Loopback refused when an admin has not allowed the host, even for the endpoint itself.
    const strict = await startRelay('127.0.0.1', echoPort, keys, { internalHosts: [], loopbackHosts: [] });
    await expect(SocksClient.createConnection({ command: 'connect', destination: { host: '127.0.0.1', port: echoPort }, proxy: { host: '127.0.0.1', port: strict.port, type: 5, userId: strict.username, password: strict.password }, timeout: 3000 })).rejects.toThrow();
    expect(strict.denied).toEqual([`127.0.0.1:${echoPort}`]);
    await strict.close();
  });
});

const mongoManifest = () => ({
  name: 'orders-mongo',
  version: '1.0.0',
  title: 'Orders (MongoDB)',
  description: 'Reads and updates orders.',
  hosts: [],
  settings: [{ id: 'cluster', type: 'host', label: 'Atlas cluster', pattern: '**.mongodb.net', default: 'cluster0.abcde.mongodb.net' }],
  credentials: [{ id: 'db_login', service: 'orders-mongo', label: 'Database user', hosts: ['{{settings.cluster}}'], placement: { type: 'basic' } }],
  endpoints: [
    {
      id: 'orders',
      protocol: 'mongodb',
      host: '{{settings.cluster}}',
      srv: true,
      database: 'shop',
      credential: 'db_login',
      operations: [
        { id: 'by_status', effect: 'read', collection: 'orders', op: 'find', filter: { status: { $param: 'status' } }, projection: { _id: 0, number: 1, status: 1 }, sort: { number: 1 }, params: { status: { type: 'string' } }, maxRows: 20 },
        { id: 'ship', effect: 'write', collection: 'orders', op: 'updateOne', filter: { number: { $param: 'number' } }, update: { $set: { status: 'shipped' } }, params: { number: { type: 'integer' } } },
      ],
    },
  ],
  actions: [
    { name: 'list_orders', title: 'List orders', description: 'Orders by status.', effect: 'read', credentials: ['db_login'], input: { type: 'object', properties: { status: { type: 'string', enum: ['new', 'shipped'] } }, required: ['status'], additionalProperties: false }, output: { type: 'object' } },
    { name: 'ship_order', title: 'Ship order', description: 'Marks an order shipped.', effect: 'write', credentials: ['db_login'], input: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: false }, output: { type: 'object' } },
  ],
});

describe('the manifest and broker', () => {
  it('shows each operation for review and runs only those, with values filled in', async () => {
    const parsed = parseManifest(mongoManifest());
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    const m = (parsed as { manifest: Manifest }).manifest;
    const summary = reviewSummary(m);
    expect(summary).toContain('ONLY these 2 fixed operations on the MongoDB database "shop" at the {{settings.cluster}} deployment (mongodb+srv');
    expect(summary).toContain('- ship (CHANGES data, up to 100 documents; number integer): orders.updateOne({"filter":{"number":{"$param":"number"}},"update":{"$set":{"status":"shipped"}}})');

    const bad = mongoManifest();
    (bad.endpoints[0] as any).operations[0].filter = { $where: 'sleep(1000)', status: { $param: 'status' } };
    expect((parseManifest(bad) as { issues: string[] }).issues).toContain('(root): operation by_status: $where is not allowed');

    const seen: MongoRequest[] = [];
    const broker = (action: string) =>
      new Broker({
        manifest: resolveManifest(m, {}, { useDefaults: true }).manifest,
        action,
        resolveSecret: async () => 'app:pw',
        transports: { mongo: async (_t, r) => (seen.push(r), { rows: [{ number: 1, status: 'new' }], rowCount: 1, truncated: false }) },
      });
    const b = broker('list_orders');
    expect(await b.call('db.query', { endpoint: 'orders', query: 'by_status', params: { status: 'new' } })).toMatchObject({ ok: true });
    expect(seen[0]).toMatchObject({ srv: true, database: 'shop', collection: 'orders', op: 'find', filter: { status: 'new' }, readOnly: true, maxRows: 20, login: { username: 'app', password: 'pw' } });
    expect(await b.call('db.query', { endpoint: 'orders', query: 'by_status', params: { status: { $ne: null } } })).toMatchObject({ ok: false, error: 'db_bad_param_type' });
    expect(await b.call('db.query', { endpoint: 'orders', query: 'ship', params: { number: 1 } })).toMatchObject({ ok: false, error: 'effect_read_cannot_write', violation: true });
    expect(await b.call('db.query', { endpoint: 'orders', query: 'drop', params: {} })).toMatchObject({ ok: false, error: 'db_query_denied', violation: true });
    const w = broker('ship_order');
    expect(await w.call('db.query', { endpoint: 'orders', query: 'ship', params: { number: 3 } })).toMatchObject({ ok: true });
    expect(seen[1]).toMatchObject({ op: 'updateOne', filter: { number: 3 }, update: { $set: { status: 'shipped' } }, readOnly: false });
    expect(w.writeSent).toBe(true);
  });
});

describe('module review', () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
  });
  afterAll(async () => {
    await w.db.end();
  });
  it('sandbox tests answer operations with canned documents', async () => {
    const code = `export const actions = {
  async list_orders(input, ctx) {
    const r = await ctx.db.query({ endpoint: 'orders', query: 'by_status', params: { status: input.status } });
    return { orders: r.rows, more: r.truncated };
  },
  async ship_order(input, ctx) {
    const r = await ctx.db.query({ endpoint: 'orders', query: 'ship', params: { number: input.number } });
    if (r.rowCount !== 1) throw new ctx.ActionError('order_not_found');
    return { shipped: true };
  },
};`;
    const tests = [
      { name: 'lists', action: 'list_orders', input: { status: 'new' }, calls: [{ protocol: 'mongodb', query: 'by_status', rows: [{ number: 1, status: 'new' }] }] },
      { name: 'ships', action: 'ship_order', input: { number: 1 }, calls: [{ protocol: 'mongodb', query: 'ship', rowCount: 1 }] },
      { name: 'missing', action: 'ship_order', input: { number: 2 }, calls: [{ protocol: 'mongodb', query: 'ship', rowCount: 0 }], expectOk: false },
      { name: 'refuses bad input', action: 'ship_order', input: { number: { $gt: 0 } }, expectOk: false },
    ];
    const d = await w.app.modules.createDraft({ manifest: mongoManifest(), code, tests, origin: 'seed' } as any, w.alice);
    expect(d.validationReport!.passed, JSON.stringify(d.validationReport)).toBe(true);
    expect(d.validationReport!.tests[0]!.requests).toEqual(['MONGODB cluster0.abcde.mongodb.net/shop orders.find by_status']);
  });
});

// A real server: in CI (a service container) or locally with TEST_MONGO_URL=mongodb://root:pw@127.0.0.1:27018
const url = process.env.TEST_MONGO_URL;
describe.skipIf(!url)('a real MongoDB server', () => {
  const u = new URL(url ?? 'mongodb://x');
  const target = { hostname: u.hostname, port: Number(u.port || 27017), hostKeys: [`${u.hostname}:${u.port || 27017}`] };
  const policy = { internalHosts: [], loopbackHosts: target.hostKeys };
  const base = { queryId: 'q', srv: false, tls: false, login: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }, authSource: 'admin', database: 'dittoly_test', collection: 'orders', maxBytes: 2_000_000, timeoutMs: 10_000 };
  let admin: MongoClient;
  beforeAll(async () => {
    admin = new MongoClient(url!, { serverSelectionTimeoutMS: 60_000 });
    await admin.connect();
    const c = admin.db('dittoly_test').collection('orders');
    await c.deleteMany({});
    await c.insertMany(Array.from({ length: 30 }, (_, i) => ({ number: i + 1, status: 'new', placed: new Date('2026-10-01T00:00:00Z') })));
    await c.createIndex({ number: 1 }, { unique: true });
  }, 70_000);
  afterAll(async () => {
    await admin?.db('dittoly_test').dropDatabase();
    await admin?.close();
  });

  it('reads stop at the limit; values never become operators', async () => {
    const r = await runMongoOperation(target, { ...base, op: 'find', filter: { status: 'new' }, projection: { _id: 0, number: 1, placed: 1 }, sort: { number: 1 }, readOnly: true, maxRows: 5 }, policy);
    expect(r.rows).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(r.rows[0]).toEqual({ number: 1, placed: '2026-10-01T00:00:00.000Z' });
    // The only way a value gets in is through a checked placeholder: an operator-looking string is just text.
    const filter = fillTemplate({ status: { $param: 's' } }, (checkMongoParams({ s: { type: 'string' } }, { s: '{"$ne": null}' }, false) as any).values);
    expect((await runMongoOperation(target, { ...base, op: 'find', filter, readOnly: true, maxRows: 100 }, policy)).rows).toEqual([]);
    const agg = await runMongoOperation(target, { ...base, op: 'aggregate', pipeline: [{ $match: { status: 'new' } }, { $group: { _id: '$status', n: { $sum: 1 } } }], readOnly: true, maxRows: 10 }, policy);
    expect(agg.rows).toEqual([{ _id: 'new', n: 30 }]);
    expect((await runMongoOperation(target, { ...base, op: 'countDocuments', filter: { number: { $lte: 3 } }, readOnly: true, maxRows: 1 }, policy)).rows).toEqual([{ count: 3 }]);
  });

  it('writes, ids and duplicate errors', async () => {
    expect(await runMongoOperation(target, { ...base, op: 'updateOne', filter: { number: 2 }, update: { $set: { status: 'shipped' } }, readOnly: false, maxRows: 1 }, policy)).toMatchObject({ rowCount: 1 });
    const ins = await runMongoOperation(target, { ...base, op: 'insertOne', document: { number: 100, status: 'new' }, readOnly: false, maxRows: 1 }, policy);
    expect(ins.rows[0]!.insertedId).toMatch(/^[0-9a-f]{24}$/);
    const byId = await runMongoOperation(target, { ...base, op: 'findOne', filter: { _id: { $oid: ins.rows[0]!.insertedId as string } }, projection: { _id: 0, number: 1 }, readOnly: true, maxRows: 1 }, policy);
    expect(byId.rows).toEqual([{ number: 100 }]);
    await expect(runMongoOperation(target, { ...base, op: 'insertOne', document: { number: 100 }, readOnly: false, maxRows: 1 }, policy)).rejects.toMatchObject({ code: 'db_duplicate' });
    expect(await runMongoOperation(target, { ...base, op: 'deleteOne', filter: { number: 100 }, readOnly: false, maxRows: 1 }, policy)).toMatchObject({ rowCount: 1 });
  });

  it('wrong passwords and refused addresses are codes', async () => {
    await expect(runMongoOperation(target, { ...base, login: { username: 'root', password: 'wrong' }, op: 'find', readOnly: true, maxRows: 1 }, policy)).rejects.toMatchObject({ code: 'db_login_failed' });
    await expect(runMongoOperation(target, { ...base, op: 'find', readOnly: true, maxRows: 1, timeoutMs: 3_000 }, { internalHosts: [], loopbackHosts: [] })).rejects.toMatchObject({ code: 'EGRESS_DENIED_IP' });
  });
});

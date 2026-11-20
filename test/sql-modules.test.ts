import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest, resolveManifest, reviewSummary, checkSettingValues, type Manifest } from '../src/modules/manifest.js';
import { bindSql, checkParams, checkSql } from '../src/modules/sql.js';
import { owaspChecks } from '../src/modules/validate.js';
import { Broker } from '../src/sandbox/broker.js';
import { runDbQuery } from '../src/runtime/transports.js';
import { makeWorld, TEST_DB_URL, type World } from './helpers.js';

/** Database modules: fixed, reviewed queries with bound parameters; reads that cannot write. */

const ok = (sql: string, dialect: 'postgres' | 'mysql' | 'mssql' = 'postgres', effect: 'read' | 'write' = 'read') => checkSql(sql, dialect, effect).problems;

describe('the query check', () => {
  it('accepts plain reads and writes with :name parameters', () => {
    expect(ok('SELECT id, status FROM orders WHERE id = :id AND created_at > now() - interval \'1 day\'')).toEqual([]);
    expect(ok('WITH recent AS (SELECT id FROM orders WHERE total > :min) SELECT count(*)::int AS n FROM recent;')).toEqual([]);
    expect(ok("SELECT data->>'name' AS name FROM docs WHERE data @> :filter::jsonb AND tags ? 'x'")).toEqual([]);
    expect(ok('SELECT `id` FROM `orders` WHERE `status` = :status LIMIT 10', 'mysql')).toEqual([]);
    expect(ok("SELECT TOP (10) [id], N'é' AS x FROM [dbo].[orders] WHERE [status] = :status", 'mssql')).toEqual([]);
    expect(ok("UPDATE orders SET status = 'shipped', updated_at = now() WHERE id = :id", 'postgres', 'write')).toEqual([]);
    expect(ok('UPDATE [dbo].[orders] SET status = :s WHERE id = :id', 'mssql', 'write')).toEqual([]);
    expect(ok('INSERT INTO notes (order_id, body) VALUES (:id, :body) ON CONFLICT (order_id) DO UPDATE SET body = EXCLUDED.body RETURNING id', 'postgres', 'write')).toEqual([]);
    expect(ok('INSERT INTO notes (order_id, body) VALUES (:id, :body) ON DUPLICATE KEY UPDATE body = VALUES(body)', 'mysql', 'write')).toEqual([]);
    expect(ok('DELETE FROM sessions WHERE expires_at < :now', 'mysql', 'write')).toEqual([]);
    // Words inside strings and quoted names are data, not SQL.
    expect(ok(`SELECT 'DROP TABLE x; --' AS a, "exec" FROM t WHERE b = 'it''s'`)).toEqual([]);
  });

  it('refuses stacked statements, comments and anything a value could hide in', () => {
    expect(ok('SELECT 1; DROP TABLE orders')).toContain('only one statement is allowed');
    expect(ok('SELECT 1 -- hi')).toContain('comments are not allowed');
    expect(ok('SELECT 1 /* x */')).toContain('comments are not allowed');
    expect(ok('SELECT 1 # x', 'mysql')).toContain('comments are not allowed');
    expect(ok('SELECT $$a$$')[0]).toMatch(/dollar-quoted/);
    expect(ok('SELECT * FROM t WHERE id = $1')[0]).toMatch(/:name/);
    expect(ok('SELECT * FROM t WHERE id = ?', 'mysql')[0]).toMatch(/:name/);
    expect(ok("SELECT E'\\x27'")[0]).toMatch(/escape strings/);
    expect(ok("SELECT 'a\\' OR 1=1 '", 'mysql')).toContain('backslashes in strings are not allowed');
    expect(ok("SELECT 'C:\\temp'")).toContain('backslashes in strings are not allowed');
    expect(ok('SELECT "x"', 'mysql')).toContain('double-quoted strings are not allowed in MySQL; use single quotes');
    expect(ok('SELECT 0x41', 'mysql')).toContain('hex literals are not allowed');
    expect(ok("SELECT 'open")).toContain('unterminated string');
    expect(ok('SELECT @@version', 'mssql')[0]).toMatch(/variables/);
    // SQL Server runs statements written one after another without ";".
    expect(ok('SELECT 1 EXEC xp_cmdshell :c', 'mssql')).toContain('EXEC is not allowed');
    expect(ok('SELECT 1 BEGIN TRAN', 'mssql')).toContain('BEGIN is not allowed');
    expect(ok('UPDATE t SET a = 1 WHERE id = :id DELETE FROM t WHERE 1 = 1', 'mssql', 'write')).toContain('a write query makes one change (one INSERT, UPDATE or DELETE)');
  });

  it('keeps reads to reading and writes to one bounded change', () => {
    expect(ok('DELETE FROM t WHERE id = :id')).toContain('a read query must start with SELECT or WITH');
    expect(ok('WITH x AS (DELETE FROM t WHERE id = :id RETURNING *) SELECT * FROM x')).toContain('a read query cannot use DELETE');
    expect(ok('SELECT * INTO backup FROM t', 'mssql')).toContain('INTO is only allowed in INSERT INTO');
    expect(ok('SELECT * FROM t FOR UPDATE')).toContain('a read query cannot lock rows');
    expect(ok('UPDATE t SET a = 1', 'postgres', 'write')).toContain('UPDATE needs a WHERE clause');
    expect(ok('DELETE FROM t', 'mysql', 'write')).toContain('DELETE needs a WHERE clause');
    expect(ok('SELECT 1', 'postgres', 'write')).toContain('a write query must start with INSERT, UPDATE or DELETE');
    expect(ok('DROP TABLE t', 'postgres', 'write')).toContain('DROP is not allowed');
    expect(ok("SELECT 1 FROM t WHERE a = 1 SET x = 1", 'mssql')).toContain('SET is only allowed in UPDATE ... SET');
  });

  it('refuses functions that sleep, read files or run other SQL', () => {
    expect(ok('SELECT pg_sleep(10)')).toContain('pg_sleep() is not allowed');
    expect(ok("SELECT pg_read_file('/etc/passwd')")).toContain('pg_read_file() is not allowed');
    expect(ok("SELECT query_to_xml('select 1', true, true, '')")).toContain('query_to_xml() is not allowed');
    expect(ok("SELECT * FROM dblink('x', 'y') AS t(a int)")).toContain('dblink is not allowed');
    expect(ok('SELECT SLEEP(5)', 'mysql')).toContain('SLEEP() is not allowed');
    expect(ok("SELECT LOAD_FILE('/etc/passwd')", 'mysql')).toContain('LOAD_FILE() is not allowed');
    expect(ok("SELECT 1 FROM t WHERE x = sp_executesql", 'mssql')).toContain('sp_executesql is not allowed');
  });
});

describe('binding parameters', () => {
  it('rewrites only placeholders, per dialect, and never pastes values', () => {
    const v = { id: 7, s: "x' OR '1'='1" };
    expect(bindSql("SELECT ':id', a::text FROM t WHERE id = :id AND s = :s OR id = :id;", 'postgres', v)).toEqual({ text: "SELECT ':id', a::text FROM t WHERE id = $1 AND s = $2 OR id = $1", values: [7, v.s] });
    expect(bindSql('SELECT `:id` FROM t WHERE id = :id AND s = :s OR id = :id', 'mysql', v)).toEqual({ text: 'SELECT `:id` FROM t WHERE id = ? AND s = ? OR id = ?', values: [7, v.s, 7] });
    expect(bindSql('SELECT [:id] FROM t WHERE id = :id AND s = :s', 'mssql', v)).toEqual({ text: 'SELECT [:id] FROM t WHERE id = @p1 AND s = @p2', values: [7, v.s] });
  });

  it('takes declared scalars only', () => {
    const declared = { id: { type: 'integer' as const }, note: { type: 'string' as const, nullable: true }, at: { type: 'timestamp' as const } };
    expect(checkParams(declared, { id: 1, at: '2026-10-17T10:00:00Z' })).toEqual({ ok: true, values: { id: 1, note: null, at: '2026-10-17T10:00:00Z' } });
    expect(checkParams(declared, { id: '1', at: '2026-10-17' })).toEqual({ ok: false, error: 'db_bad_param_type' });
    expect(checkParams(declared, { id: [1, 2], at: '2026-10-17' })).toEqual({ ok: false, error: 'db_bad_param_type' });
    expect(checkParams(declared, { id: 1, at: '2026-10-17', note: { $gt: '' } })).toEqual({ ok: false, error: 'db_bad_param_type' });
    expect(checkParams(declared, { id: 1, at: 'yesterday' })).toEqual({ ok: false, error: 'db_bad_param_type' });
    expect(checkParams(declared, { at: '2026-10-17' })).toEqual({ ok: false, error: 'db_missing_param' });
    expect(checkParams(declared, { id: 1, at: '2026-10-17', table: 'users' })).toEqual({ ok: false, error: 'db_unknown_param' });
  });
});

const dbManifest = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'shop-db',
  version: '1.0.0',
  title: 'Shop database',
  description: 'Reads and updates orders.',
  hosts: [],
  settings: [
    { id: 'db_host', type: 'host', label: 'Database server', pattern: '*.example.com', default: 'db.example.com' },
    { id: 'db_name', type: 'text', label: 'Database name', default: 'shop' },
    { id: 'db_ca', type: 'certificate', label: 'Database CA certificate' },
  ],
  credentials: [{ id: 'db_login', service: 'shop-db', label: 'Database login', hosts: ['{{settings.db_host}}'], placement: { type: 'basic' } }],
  endpoints: [
    {
      id: 'shop',
      protocol: 'postgres',
      host: '{{settings.db_host}}',
      database: '{{settings.db_name}}',
      ca: '{{settings.db_ca}}',
      credential: 'db_login',
      queries: [
        { id: 'find_order', effect: 'read', sql: 'SELECT id, status FROM orders WHERE id = :order_id', params: { order_id: { type: 'integer' } }, maxRows: 1 },
        { id: 'ship', effect: 'write', sql: "UPDATE orders SET status = 'shipped' WHERE id = :order_id", params: { order_id: { type: 'integer' } } },
      ],
    },
  ],
  actions: [
    { name: 'get_order', title: 'Get order', description: 'Finds an order.', effect: 'read', credentials: ['db_login'], input: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false }, output: { type: 'object' } },
    { name: 'ship_order', title: 'Ship order', description: 'Marks an order shipped.', effect: 'write', credentials: ['db_login'], input: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false }, output: { type: 'object' } },
  ],
  ...over,
});

describe('the manifest', () => {
  it('checks every query, its parameters and its settings, and shows the exact SQL for review', () => {
    const r = parseManifest(dbManifest());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const summary = reviewSummary((r as { manifest: Manifest }).manifest);
    expect(summary).toContain('ONLY these 2 fixed queries on the PostgreSQL database "{{settings.db_name}}" at {{settings.db_host}} over TLS, trusting the CA certificate in {{settings.db_ca}}');
    expect(summary).toContain("ship (CHANGES data, up to 100 rows; :order_id integer): UPDATE orders SET status = 'shipped' WHERE id = :order_id");
    expect(summary).toContain('find_order (reads, in a read-only transaction, up to 1 rows; :order_id integer)');

    const bad = dbManifest();
    (bad.endpoints as any)[0].queries = [{ id: 'q', effect: 'read', sql: 'SELECT * FROM t WHERE a = :a AND b = :b; DROP TABLE t', params: { a: { type: 'string' }, c: { type: 'string' } } }];
    const issues = (parseManifest(bad) as { issues: string[] }).issues;
    expect(issues.some((i) => i.includes('query q: only one statement is allowed'))).toBe(true);
    const bad2 = dbManifest();
    (bad2.endpoints as any)[0].queries = [{ id: 'q', effect: 'read', sql: 'SELECT * FROM t WHERE a = :a AND b = :b', params: { a: { type: 'string' }, c: { type: 'string' } } }];
    const issues2 = (parseManifest(bad2) as { issues: string[] }).issues;
    expect(issues2).toContain('(root): query q: parameter :b is not declared in params');
    expect(issues2).toContain('(root): query q: param c is not used in the SQL');
    // A database needs a username:password login.
    const bad3 = dbManifest({ credentials: [{ id: 'db_login', service: 'shop-db', label: 'x', hosts: ['{{settings.db_host}}'], placement: { type: 'bearer' } }] });
    expect((parseManifest(bad3) as { issues: string[] }).issues.join()).toContain('needs a "basic" (username:password) credential');
  });

  it('a certificate setting takes PEM certificates only; the CA replaces its setting at run time', () => {
    const m = (parseManifest(dbManifest()) as { manifest: Manifest }).manifest;
    expect(checkSettingValues(m, { db_ca: 'not a cert' })[0]).toMatch(/PEM/);
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ==\n-----END CERTIFICATE-----\n';
    expect(checkSettingValues(m, { db_ca: pem })).toEqual([]);
    const e = resolveManifest(m, { db_host: 'pg.example.com', db_ca: pem }).manifest.endpoints[0] as any;
    expect(e).toMatchObject({ host: 'pg.example.com', database: 'shop', ca: pem });
    expect((resolveManifest(m, { db_host: 'pg.example.com' }).manifest.endpoints[0] as any).ca).toBeUndefined();
  });
});

describe('the broker', () => {
  const manifest = () => resolveManifest((parseManifest(dbManifest()) as { manifest: Manifest }).manifest, {}, { useDefaults: true }).manifest;
  const seen: any[] = [];
  const broker = (action: string) =>
    new Broker({
      manifest: manifest(),
      action,
      resolveSecret: async () => 'app:s3cret',
      transports: { db: async (dialect, target, r) => (seen.push({ dialect, host: target.hostname, ...r }), { rows: [{ id: 1, status: 'new' }], rowCount: 1, truncated: false }) },
    });

  it('runs only declared queries, with checked values bound, and the member\'s login', async () => {
    const b = broker('get_order');
    expect(await b.call('db.query', { endpoint: 'shop', query: 'find_order', params: { order_id: 1 } })).toEqual({ ok: true, result: { rows: [{ id: 1, status: 'new' }], rowCount: 1, truncated: false } });
    expect(seen.at(-1)).toMatchObject({ dialect: 'postgres', host: 'db.example.com', database: 'shop', text: 'SELECT id, status FROM orders WHERE id = $1', values: [1], readOnly: true, maxRows: 1, login: { username: 'app', password: 's3cret' }, tls: true });
    expect(b.writeSent).toBe(false);
    expect(await b.call('db.query', { endpoint: 'shop', query: 'drop_all', params: {} })).toMatchObject({ ok: false, error: 'db_query_denied', violation: true });
    expect(await b.call('db.query', { endpoint: 'shop', query: 'find_order', params: { order_id: '1 OR 1=1' } })).toMatchObject({ ok: false, error: 'db_bad_param_type', violation: false });
    expect(await b.call('db.query', { endpoint: 'shop', sql: 'SELECT * FROM users', query: 'find_order', params: { order_id: 1, sql: 'x' } })).toMatchObject({ ok: false, error: 'db_unknown_param' });
    // A read action cannot run a query that changes data.
    expect(await b.call('db.query', { endpoint: 'shop', query: 'ship', params: { order_id: 1 } })).toMatchObject({ ok: false, error: 'effect_read_cannot_write', violation: true });
    const w = broker('ship_order');
    expect(await w.call('db.query', { endpoint: 'shop', query: 'ship', params: { order_id: 1 } })).toMatchObject({ ok: true });
    expect(w.writeSent).toBe(true);
    expect(seen.at(-1)).toMatchObject({ readOnly: false, maxRows: 100 });
  });
});

describe('a real PostgreSQL server', () => {
  const admin = new pg.Client({ connectionString: TEST_DB_URL });
  const u = new URL(TEST_DB_URL);
  const target = { hostname: u.hostname, port: Number(u.port), hostKeys: [`${u.hostname}:${u.port}`] };
  const policy = { internalHosts: [], loopbackHosts: target.hostKeys };
  const base = { queryId: 'q', tls: false, login: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }, database: u.pathname.slice(1), maxBytes: 2_000_000, timeoutMs: 5_000 };
  beforeAll(async () => {
    await admin.connect();
    await admin.query('DROP SEQUENCE IF EXISTS sqlmod_seq; CREATE SEQUENCE sqlmod_seq');
    await admin.query('DROP TABLE IF EXISTS sqlmod_orders; CREATE TABLE sqlmod_orders (id int PRIMARY KEY, status text NOT NULL, placed timestamptz NOT NULL DEFAULT now())');
    await admin.query(`INSERT INTO sqlmod_orders (id, status) SELECT g, 'new' FROM generate_series(1, 30) g`);
  });
  afterAll(async () => {
    await admin.query('DROP TABLE IF EXISTS sqlmod_orders; DROP SEQUENCE IF EXISTS sqlmod_seq');
    await admin.end();
  });

  it('reads stop at the row limit, and values are data, not SQL', async () => {
    const all = bindSql('SELECT id, status, placed FROM sqlmod_orders WHERE status = :s ORDER BY id', 'postgres', { s: 'new' });
    const r = await runDbQuery('postgres', target, { ...base, ...all, readOnly: true, maxRows: 5 }, policy);
    expect(r.rows.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
    expect(r.truncated).toBe(true);
    expect(typeof r.rows[0]!.placed).toBe('string');
    const evil = bindSql('SELECT id FROM sqlmod_orders WHERE status = :s', 'postgres', { s: "new' OR '1'='1" });
    expect((await runDbQuery('postgres', target, { ...base, ...evil, readOnly: true, maxRows: 100 }, policy)).rows).toEqual([]);
  });

  it('a read cannot change data even if a write slipped past the checks', async () => {
    // A function that writes: the read-only transaction refuses it.
    await expect(runDbQuery('postgres', target, { ...base, text: "SELECT nextval('sqlmod_seq') AS n", values: [], readOnly: true, maxRows: 1 }, policy)).rejects.toMatchObject({ code: 'db_read_only' });
    // A data-changing statement: refused before it runs.
    await expect(runDbQuery('postgres', target, { ...base, text: "WITH x AS (UPDATE sqlmod_orders SET status = 'x' WHERE id = 1 RETURNING id) SELECT id FROM x", values: [], readOnly: true, maxRows: 1 }, policy)).rejects.toBeTruthy();
    await expect(runDbQuery('postgres', target, { ...base, text: "UPDATE sqlmod_orders SET status = 'x' WHERE id = 1 RETURNING id", values: [], readOnly: true, maxRows: 1 }, policy)).rejects.toBeTruthy();
    expect((await admin.query('SELECT status FROM sqlmod_orders WHERE id = 1')).rows[0].status).toBe('new');
  });

  it('writes change data and report how many rows', async () => {
    const q = bindSql("UPDATE sqlmod_orders SET status = 'shipped' WHERE id = :id", 'postgres', { id: 2 });
    expect(await runDbQuery('postgres', target, { ...base, ...q, readOnly: false, maxRows: 100 }, policy)).toEqual({ rows: [], rowCount: 1, truncated: false });
    const dup = bindSql('INSERT INTO sqlmod_orders (id, status) VALUES (:id, :s)', 'postgres', { id: 2, s: 'new' });
    await expect(runDbQuery('postgres', target, { ...base, ...dup, readOnly: false, maxRows: 100 }, policy)).rejects.toMatchObject({ code: 'db_duplicate' });
  });

  it('the address check applies: loopback is refused unless an admin allowed the host', async () => {
    const q = bindSql('SELECT 1 AS one', 'postgres', {});
    await expect(runDbQuery('postgres', target, { ...base, ...q, readOnly: true, maxRows: 1 }, { internalHosts: [], loopbackHosts: [] })).rejects.toMatchObject({ code: 'EGRESS_DENIED_IP' });
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

  const code = `export const actions = {
  async get_order(input, ctx) {
    const r = await ctx.db.query({ endpoint: 'shop', query: 'find_order', params: { order_id: input.id } });
    if (r.rows.length === 0) throw new ctx.ActionError('order_not_found');
    return r.rows[0];
  },
  async ship_order(input, ctx) {
    const r = await ctx.db.query({ endpoint: 'shop', query: 'ship', params: { order_id: input.id } });
    return { shipped: r.rowCount === 1 };
  },
};`;
  const tests = [
    { name: 'finds an order', action: 'get_order', input: { id: 7 }, calls: [{ protocol: 'postgres', query: 'find_order', rows: [{ id: 7, status: 'new' }] }] },
    { name: 'missing order', action: 'get_order', input: { id: 8 }, calls: [{ protocol: 'postgres', rows: [] }], expectOk: false },
    { name: 'ships', action: 'ship_order', input: { id: 7 }, calls: [{ protocol: 'postgres', query: 'ship', rowCount: 1 }] },
    { name: 'refuses a bad id', action: 'ship_order', input: { id: 'x' }, expectOk: false },
  ];

  it('sandbox tests answer queries from canned rows, and the OWASP checks pass', async () => {
    const d = await w.app.modules.createDraft({ manifest: dbManifest(), code, tests, origin: 'seed' } as any, w.alice);
    const report = d.validationReport!;
    expect(report.passed, JSON.stringify(report)).toBe(true);
    expect(report.tests[0]!.requests).toEqual(['SQL postgres db.example.com/shop find_order (1 bound value)']);
    expect(report.checks.filter((c) => c.name.startsWith('OWASP')).map((c) => c.name)).toHaveLength(11);
    expect(report.checks.filter((c) => c.name.startsWith('OWASP') && !c.passed)).toEqual([]);
  });

  it('a hard-coded secret fails the review; risky code only warns', async () => {
    const leaky = code.replace("query: 'find_order'", "query: 'find_order', note: 'ghp_" + 'a'.repeat(36) + "'");
    const d = await w.app.modules.createDraft({ manifest: { ...dbManifest(), version: '1.0.1' }, code: leaky, tests, origin: 'seed' } as any, w.alice);
    expect(d.validationReport!.passed).toBe(false);
    expect(d.validationReport!.checks.find((c) => c.name.startsWith('OWASP A04: Cryptographic Failures (hard'))).toMatchObject({ passed: false, details: ['contains a GitHub token; use a declared credential'] });

    const m = (parseManifest(dbManifest()) as { manifest: Manifest }).manifest;
    const warn = owaspChecks(m, "try { console.log(input) } catch {}\nconst u = 'https://x/' + input.id;", []);
    expect(warn.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      'OWASP A05: Injection',
      'OWASP A06: Insecure Design',
      'OWASP A09: Security Logging and Alerting Failures',
      'OWASP A10: Mishandling of Exceptional Conditions',
    ]);
    expect(warn.filter((c) => !c.passed).every((c) => c.advisory)).toBe(true);
  });
});

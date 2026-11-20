import { describe, expect, it } from 'vitest';
import { bindSql, type Dialect } from '../src/modules/sql.js';
import type { DbRequest } from '../src/runtime/databases.js';
import { runDbQuery } from '../src/runtime/transports.js';

/**
 * MySQL/MariaDB and SQL Server, for real: in CI (service containers) or locally with
 * TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:13306/shop and TEST_MSSQL_URL=mssql://sa:<password>@127.0.0.1:14330/master.
 */

const servers: [Dialect, string | undefined][] = [
  ['mysql', process.env.TEST_MYSQL_URL],
  ['mssql', process.env.TEST_MSSQL_URL],
];

for (const [dialect, url] of servers) {
  describe.skipIf(!url)(`a real ${dialect} server`, () => {
    const u = new URL(url ?? 'x://x');
    const target = { hostname: u.hostname, port: Number(u.port), hostKeys: [`${u.hostname}:${u.port}`] };
    const policy = { internalHosts: [], loopbackHosts: target.hostKeys };
    const base = { queryId: 'q', tls: false, login: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }, database: u.pathname.slice(1), maxBytes: 2_000_000, timeoutMs: 10_000 };
    const run = (text: string, values: DbRequest['values'], readOnly: boolean, maxRows = 5, over: Partial<DbRequest> = {}) =>
      runDbQuery(dialect, target, { ...base, text, values, readOnly, maxRows, ...over }, policy);
    const sql = (text: string, v: Record<string, string | number>) => bindSql(text, dialect, v);
    const table = dialect === 'mysql' ? 'sqlmod_orders' : 'dbo.sqlmod_orders';

    it('sets up (waiting for the server to start)', async () => {
      for (let i = 0; ; i++) {
        try {
          await run('SELECT 1 AS one', [], true);
          break;
        } catch (err) {
          if (i > 60) throw err;
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      if (dialect === 'mysql') {
        await run('DROP TABLE IF EXISTS sqlmod_orders', [], false);
        await run('CREATE TABLE sqlmod_orders (id int PRIMARY KEY, status varchar(50) NOT NULL) ENGINE=InnoDB', [], false);
        for (let i = 1; i <= 30; i++) await run('INSERT INTO sqlmod_orders (id, status) VALUES (?, ?)', [i, 'new'], false);
      } else {
        await run("IF OBJECT_ID('dbo.sqlmod_orders') IS NOT NULL DROP TABLE dbo.sqlmod_orders; CREATE TABLE dbo.sqlmod_orders (id int PRIMARY KEY, status nvarchar(50) NOT NULL)", [], false);
        await run("INSERT INTO dbo.sqlmod_orders (id, status) SELECT TOP 30 ROW_NUMBER() OVER (ORDER BY (SELECT 1)), 'new' FROM sys.all_objects", [], false);
      }
    }, 150_000);

    it('reads stop at the row limit; values are data, not SQL', async () => {
      const q = sql(`SELECT id, status FROM ${table} WHERE status = :s ORDER BY id`, { s: 'new' });
      const r = await run(q.text, q.values, true, 5);
      expect(r.rows.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
      expect(r.truncated).toBe(true);
      const evil = sql(`SELECT id FROM ${table} WHERE status = :s`, { s: "new' OR '1'='1" });
      expect((await run(evil.text, evil.values, true, 100)).rows).toEqual([]);
    });

    it('a write inside a read is refused or undone', async () => {
      const w = `UPDATE ${table} SET status = 'x' WHERE id = 3`;
      if (dialect === 'mysql') await expect(run(w, [], true)).rejects.toMatchObject({ code: 'db_read_only' });
      else await run(w, [], true); // SQL Server: the read's transaction is rolled back
      expect((await run(`SELECT status FROM ${table} WHERE id = 3`, [], true)).rows).toEqual([{ status: 'new' }]);
    });

    it('writes report rows changed; errors are codes', async () => {
      const q = sql(`UPDATE ${table} SET status = 'shipped' WHERE id = :id`, { id: 2 });
      expect(await run(q.text, q.values, false)).toMatchObject({ rowCount: 1 });
      const dup = sql(`INSERT INTO ${table} (id, status) VALUES (:id, :s)`, { id: 2, s: 'dup' });
      await expect(run(dup.text, dup.values, false)).rejects.toMatchObject({ code: 'db_duplicate' });
      await expect(run('SELECT 1', [], true, 1, { login: { username: base.login.username, password: 'wrong' } })).rejects.toMatchObject({ code: 'db_login_failed' });
      // The test server's certificate is self-signed: verification refuses it.
      if (dialect === 'mssql') await expect(run('SELECT 1', [], true, 1, { tls: true })).rejects.toMatchObject({ code: 'db_tls_failed' });
    });
  });
}

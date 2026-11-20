import { connect as netConnect } from 'node:net';
import { Rows, type SqlDriver } from './databases.js';
import { guardedLookup } from './egress.js';

/** MySQL and MariaDB queries. */

export const mysql: SqlDriver = async (t, r, { policy, resolve }) => {
  const { default: mysql } = await import('mysql2');
  const conn = mysql.createConnection({
    // The driver checks the certificate against "host" only when it is a name, so it gets the
    // name, and the socket below resolves it with the same address check as everything else.
    host: t.hostname,
    port: t.port,
    stream: () => netConnect({ host: t.hostname, port: t.port, lookup: guardedLookup(t.hostKeys, policy, resolve), autoSelectFamily: true }),
    user: r.login.username,
    password: r.login.password,
    database: r.database,
    ssl: r.tls ? { rejectUnauthorized: true, verifyIdentity: true, ...(r.ca ? { ca: r.ca } : {}) } : undefined,
    connectTimeout: r.timeoutMs,
    // One statement per call; no LOCAL INFILE; dates and big numbers as text.
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    flags: ['-LOCAL_FILES', '-MULTI_STATEMENTS'],
  });
  conn.on('error', () => undefined);
  const run = (sql: string, values: unknown[] = []) =>
    new Promise<unknown>((resolve, reject) => conn.query({ sql, values, timeout: r.timeoutMs }, (err, res) => (err ? reject(err) : resolve(res))));
  try {
    if (!r.readOnly) {
      const res = (await run(r.text, r.values)) as { affectedRows?: number } | Record<string, unknown>[];
      if (Array.isArray(res)) {
        const out = new Rows(r.maxBytes);
        for (const row of res.slice(0, r.maxRows)) out.add(row);
        return { rows: out.rows, rowCount: res.length, truncated: res.length > r.maxRows };
      }
      return { rows: [], rowCount: res.affectedRows ?? 0, truncated: false };
    }
    await run('START TRANSACTION READ ONLY');
    const out = new Rows(r.maxBytes);
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      const q = conn.query({ sql: r.text, values: r.values, timeout: r.timeoutMs });
      let done = false;
      q.on('result', (row) => {
        if (done) return;
        if (out.rows.length >= r.maxRows) {
          // Enough: drop the connection instead of reading the rest.
          truncated = done = true;
          conn.destroy();
          resolve();
          return;
        }
        try {
          out.add(row as Record<string, unknown>);
        } catch (err) {
          done = true;
          conn.destroy();
          reject(err);
        }
      });
      q.on('error', (err) => {
        if (!done) {
          done = true;
          reject(err);
        }
      });
      q.on('end', () => {
        if (!done) {
          done = true;
          resolve();
        }
      });
    });
    if (!truncated) await run('ROLLBACK').catch(() => undefined);
    return { rows: out.rows, rowCount: out.rows.length, truncated };
  } finally {
    conn.destroy();
  }
};

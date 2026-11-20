import type MssqlNs from 'mssql';
import { Rows, type SqlDriver } from './databases.js';

/** SQL Server queries. */

export const sqlServer: SqlDriver = async (t, r, { address }) => {
  const { default: mssql } = await import('mssql');
  const pool = new mssql.ConnectionPool({
    server: address,
    port: t.port,
    user: r.login.username,
    password: r.login.password,
    database: r.database,
    connectionTimeout: r.timeoutMs,
    requestTimeout: r.timeoutMs,
    pool: { max: 1, min: 0 },
    options: {
      encrypt: r.tls,
      trustServerCertificate: false,
      // The certificate is checked against the declared name, not the address connected to.
      serverName: t.hostname,
      ...(r.ca ? { cryptoCredentialsDetails: { ca: r.ca } } : {}),
      appName: 'dittoly',
    },
  });
  pool.on('error', () => undefined);
  await pool.connect();
  try {
    const out = new Rows(r.maxBytes);
    let tx: MssqlNs.Transaction | null = null;
    if (r.readOnly) {
      // SQL Server has no read-only transaction: the query checks keep reads to SELECT, and the transaction is always rolled back.
      tx = new mssql.Transaction(pool);
      await tx.begin();
    }
    try {
      const request = tx ? new mssql.Request(tx) : new mssql.Request(pool);
      r.values.forEach((v, i) => request.input(`p${i + 1}`, v));
      request.stream = true;
      let truncated = false;
      let rowsAffected = 0;
      // After a cancel the request still finishes ("done"); the transaction can only be rolled back then.
      await new Promise<void>((resolve, reject) => {
        let stopped = false;
        let failure: unknown = null;
        request.on('row', (row: Record<string, unknown>) => {
          if (stopped) return;
          if (out.rows.length >= r.maxRows) {
            truncated = stopped = true;
            request.cancel();
            return;
          }
          try {
            out.add(row);
          } catch (err) {
            failure = err;
            stopped = true;
            request.cancel();
          }
        });
        request.on('rowsaffected', (n: number) => (rowsAffected += n));
        request.on('error', (err: unknown) => {
          // The cancel itself reports an error; that is the expected end of a stopped read.
          if (!stopped && failure === null) failure = err;
        });
        request.on('done', () => (failure !== null ? reject(failure) : resolve()));
        void request.query(r.text);
      });
      return { rows: out.rows, rowCount: r.readOnly ? out.rows.length : rowsAffected, truncated };
    } finally {
      if (tx) await tx.rollback().catch(() => undefined);
    }
  } finally {
    await pool.close().catch(() => undefined);
  }
};

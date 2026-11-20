import { Rows, type SqlDriver } from './databases.js';

/** PostgreSQL (and Supabase) queries. */

export const postgres: SqlDriver = async (t, r, { address }) => {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: address,
    port: t.port,
    user: r.login.username,
    password: r.login.password,
    database: r.database,
    // host here is what the certificate is checked against (we connect to the checked address).
    ssl: r.tls ? { host: t.hostname, servername: t.hostname, rejectUnauthorized: true, ...(r.ca ? { ca: r.ca } : {}) } : false,
    connectionTimeoutMillis: r.timeoutMs,
    statement_timeout: r.timeoutMs,
    query_timeout: r.timeoutMs + 1_000,
    application_name: 'dittoly',
  });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const out = new Rows(r.maxBytes);
    if (r.readOnly) {
      await client.query('BEGIN READ ONLY');
      try {
        // A cursor, so the database stops at the limit instead of sending every row.
        await client.query(`DECLARE dittoly_rows NO SCROLL CURSOR FOR ${r.text}`, r.values);
        const res = await client.query(`FETCH ${r.maxRows + 1} FROM dittoly_rows`);
        for (const row of res.rows.slice(0, r.maxRows)) out.add(row);
        return { rows: out.rows, rowCount: out.rows.length, truncated: res.rows.length > r.maxRows };
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    }
    const res = await client.query(r.text, r.values);
    for (const row of res.rows.slice(0, r.maxRows)) out.add(row);
    return { rows: out.rows, rowCount: res.rowCount ?? 0, truncated: res.rows.length > r.maxRows };
  } finally {
    await client.end().catch(() => undefined);
  }
};

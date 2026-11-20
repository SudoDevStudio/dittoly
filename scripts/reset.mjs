// `npm run reset`: a fresh start for the install that uses PostgreSQL (DATABASE_URL in .env).
// Deletes EVERYTHING in that database: modules, Flows, runs, plans, the account and all stored credentials.
// Creates the database when it does not exist yet (a fresh PostgreSQL has only the one its container was started
// with). The .env file (master key, AI settings) is kept. Then `npm start` sets everything up again.
// Dittoly must be stopped first. `--yes` skips the question (for scripts).
import { createInterface } from 'node:readline/promises';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('reset: DATABASE_URL is not set (it is read from .env). For the single-user launcher, delete its data folder instead (~/.dittoly).');
  process.exit(1);
}
const target = new URL(url);
const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
if (!/^[A-Za-z0-9_-]{1,63}$/.test(name)) {
  console.error(`reset: the database name in DATABASE_URL is not one this command can use: "${name}"`);
  process.exit(1);
}
const where = `${target.hostname}:${target.port || 5432}/${name}`;

if (!process.argv.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`This deletes EVERYTHING in ${where}: modules, Flows, runs, plans, your account and every stored credential.\nIt cannot be undone. Stop Dittoly first. Your .env file is kept.`);
  const answer = (await rl.question('Type "reset" to go on: ')).trim();
  rl.close();
  if (answer !== 'reset') {
    console.log('Nothing was changed.');
    process.exit(0);
  }
}

// Through the server's own "postgres" database: the target is dropped and made again, so it works whether it exists or not.
const admin = new URL(url);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
try {
  await client.connect();
} catch (err) {
  console.error(`reset: cannot reach PostgreSQL at ${target.hostname}:${target.port || 5432} (${err.code ?? err.message}). Start it first: npm run services:up`);
  process.exit(1);
}
try {
  const others = await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
  if (others.rows[0].n > 0) {
    console.error(`reset: ${others.rows[0].n} connection(s) are using "${name}". Stop Dittoly (Ctrl+C where npm start runs), then run this again.`);
    process.exit(1);
  }
  await client.query(`DROP DATABASE IF EXISTS "${name}"`);
  await client.query(`CREATE DATABASE "${name}"`);
  console.log(`Done: "${name}" is empty. Now run: npm start`);
} finally {
  await client.end();
}

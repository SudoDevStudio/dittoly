// A fresh start for a Dittoly that runs against PostgreSQL (`npx dittoly run --reset` asks first and calls this).
//
// Removes what `dittoly cleanup` removes on the single-user install — modules, Flows and Super Flows with their
// runs, schedules, approvals and tests, apps, plans, data tables, the audit log, AI usage history, git sync, and
// what the sandboxes left on this computer — and keeps the account, teams, stored credentials (personal and team),
// the master key and the settings. The lists are WIPE_TABLES and KEEP_TABLES in src/local/cleanup.ts.
//
//   node --env-file-if-exists=.env --import tsx src/cli/reset.ts --preview   what would go, as JSON
//   node --env-file-if-exists=.env --import tsx src/cli/reset.ts --yes       do it
//
// Dittoly must be stopped: a running server would keep writing into tables that are being emptied.
import { createDb } from '../db/db.js';
import { cleanupDb, cleanupPreview } from '../local/cleanup.js';

const preview = process.argv.includes('--preview');
const yes = process.argv.includes('--yes');
const url = process.env.DATABASE_URL;

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (!url) {
  out({ error: 'no_database', message: 'DATABASE_URL is not set (it is in .env after the first run).' });
  process.exit(1);
}
if (!preview && !yes) {
  process.stderr.write('usage: reset.ts --preview | --yes\n');
  process.exit(1);
}

const db = createDb(url, 1);
try {
  // Nothing to reset before the first start has created the tables.
  const ready = (await db.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0]!.t;
  if (!ready) {
    out({ empty: true });
    process.exit(0);
  }
  // Any other connection to this database is a Dittoly that is still running (or something else using it).
  const others = Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      )
    ).rows[0]!.n,
  );
  if (others > 0) {
    out({ error: 'in_use', message: `Dittoly (or something else) is still connected to the database (${others} connection(s)). Stop it first.` });
    process.exit(2);
  }
  if (preview) {
    out(await cleanupPreview(db));
  } else {
    const done = await cleanupDb(db);
    out({ done: true, ...done });
  }
} finally {
  await db.end();
}

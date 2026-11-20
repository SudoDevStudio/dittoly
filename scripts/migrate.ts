import { createDb, migrate } from '../src/db/db.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
const db = createDb(url);
const applied = await migrate(db);
process.stdout.write(applied.length ? `applied: ${applied.join(', ')}\n` : 'up to date\n');
await db.end();

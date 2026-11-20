// Creates the first admin and prints their API token once.
// Usage: npm run bootstrap -- <handle>   (Docker image: node dist/src/cli/bootstrap.js <handle>)
import { loadConfig } from '../config.js';
import { createDb, migrate } from '../db/db.js';
import { createMember } from '../core/members.js';

const handle = process.argv[2];
if (!handle) {
  process.stderr.write('usage: npm run bootstrap -- <handle>\n');
  process.exit(1);
}
const config = loadConfig();
const db = createDb(config.databaseUrl);
await migrate(db);
const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM members');
if (Number(rows[0]!.n) > 0) {
  process.stderr.write('members already exist; create more through POST /members\n');
  process.exit(1);
}
// In local mode the one member is admin and approver at once.
const { member, token } = await createMember(db, handle, 'admin', null);
process.stdout.write(`member ${member.id} (${member.handle}, admin)\ntoken: ${token}\n`);
await db.end();

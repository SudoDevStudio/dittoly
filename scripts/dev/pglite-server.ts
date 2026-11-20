// Dev tool: run the embedded Postgres on a fixed port, e.g. to run the test suite against it:
//   npx tsx scripts/dev/pglite-server.ts 5434 &
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/postgres npx vitest run
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startEmbeddedPostgres } from '../../src/local/pglite.js';

const port = Number(process.argv[2] ?? 5434);
const dir = process.argv[3] ?? mkdtempSync(path.join(tmpdir(), 'dty-pglite-'));
const pg = await startEmbeddedPostgres(dir, { port });
process.stdout.write(`${pg.url} (data in ${dir})\n`);

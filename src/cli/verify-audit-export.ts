// Checks audit events exported from a SIEM against their audit-chain hashes, without Dittoly:
//   npm run audit:verify-export -- export.ndjson        (from source)
//   node dist/src/cli/verify-audit-export.js export.ndjson   (Docker image)
// Exit code 0 when every event follows from the one before, 1 otherwise.
import { readFile } from 'node:fs/promises';
import { eventsFromExport, verifyStreamed } from '../governance/audit-stream.js';

const file = process.argv[2];
if (!file) {
  process.stderr.write('dittoly: give the exported file (JSON lines or a JSON array)\n');
  process.exit(1);
}
const events = eventsFromExport(await readFile(file, 'utf8'));
const result = verifyStreamed(events);
if (!events.length) {
  process.stderr.write('dittoly: no Dittoly audit events found in that file\n');
  process.exit(1);
}
const ids = events.map((e) => BigInt(e.id)).sort((a, b) => (a < b ? -1 : 1));
process.stdout.write(`${result.checked} events checked (ids ${ids[0]} to ${ids[ids.length - 1]}).\n`);
for (const p of result.problems) process.stdout.write(`  ${p}\n`);
process.stdout.write(result.ok ? 'The chain is intact.\n' : 'The chain is broken: see above.\n');
process.exitCode = result.ok ? 0 : 1;

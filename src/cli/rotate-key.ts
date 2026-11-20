// Re-encrypts every stored secret with a new master key (shared server).
// Stop every Dittoly process first and let the webhook queue drain.
//   DITTOLY_NEW_MASTER_KEY=<new key> node dist/src/cli/rotate-key.js   (Docker image)
//   DITTOLY_NEW_MASTER_KEY=<new key> npm run rotate-key                 (from source)
// Then set DITTOLY_MASTER_KEY to the new key and start Dittoly again.
import { ConfigError, loadConfig } from '../config.js';
import { rotateMasterKey } from '../core/rekey.js';
import { createDb, migrate } from '../db/db.js';

const config = loadConfig();
const newKey = Buffer.from(process.env.DITTOLY_NEW_MASTER_KEY ?? '', 'base64');
if (newKey.length !== 32) {
  process.stderr.write('dittoly: set DITTOLY_NEW_MASTER_KEY to 32 random bytes, base64 (openssl rand -base64 32)\n');
  process.exit(1);
}
const db = createDb(config.databaseUrl, 1);
try {
  await migrate(db);
  const { values } = await rotateMasterKey(db, config.masterKey, newKey);
  process.stdout.write(`${values} stored values re-encrypted. Now set DITTOLY_MASTER_KEY to the new key and start Dittoly.\n`);
} catch (err) {
  process.stderr.write(`dittoly: ${err instanceof ConfigError || err instanceof Error ? err.message : 'failed'}\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}

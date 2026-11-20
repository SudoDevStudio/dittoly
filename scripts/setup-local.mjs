import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const defaults = {
  DITTOLY_MODE: 'local',
  DITTOLY_SANDBOX: 'process',
  DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/dittoly',
  DITTOLY_AMQP_URL: 'amqp://dittoly:dittoly@127.0.0.1:5672',
  HOST: '127.0.0.1',
  PORT: '8080',
  DITTOLY_PUBLIC_URL: 'http://localhost:8080',
  DITTOLY_AI_PROVIDER: 'none',
};

/** Prepare personal host settings without replacing an existing encryption key. */
export async function setupLocalEnv(file = path.resolve('.env')) {
  let source;
  try { source = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  }
  const current = parseEnv(source);
  const existingKey = current.DITTOLY_MASTER_KEY?.trim() || process.env.DITTOLY_MASTER_KEY?.trim();
  const key = existingKey || randomBytes(32).toString('base64');
  if (Buffer.from(key, 'base64').length !== 32) throw new Error('DITTOLY_MASTER_KEY must be 32 bytes, base64 encoded; the existing .env was not changed.');
  const updates = { DITTOLY_MASTER_KEY: key };
  for (const [name, value] of Object.entries(defaults)) {
    if (!current[name]?.trim()) updates[name] = value;
  }
  if (!current.DITTOLY_PUBLIC_URL?.trim()) updates.DITTOLY_PUBLIC_URL = `http://localhost:${current.PORT?.trim() || defaults.PORT}`;
  updates.DITTOLY_MODE = 'local';
  updates.DITTOLY_SANDBOX = 'process';
  if (current.DATABASE_URL) {
    try {
      const database = new URL(current.DATABASE_URL);
      if (database.pathname === '/dittoly' && database.username === 'postgres' &&
          ['postgres', 'localhost', '127.0.0.1'].includes(database.hostname) &&
          (!database.port || database.port === '5432')) {
        database.hostname = '127.0.0.1';
        database.port = '5433';
        updates.DATABASE_URL = database.href;
      }
    } catch { /* Leave custom connection strings for the database driver to validate. */ }
  }
  if (current.DITTOLY_AMQP_URL === 'amqp://dittoly:dittoly@rabbitmq:5672') updates.DITTOLY_AMQP_URL = defaults.DITTOLY_AMQP_URL;
  if (current.HOST === '0.0.0.0') updates.HOST = defaults.HOST;
  for (const [name, value] of Object.entries(updates)) {
    const line = `${name}=${JSON.stringify(value)}`;
    const expression = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'gm');
    if (expression.test(source)) source = source.replace(expression, () => line);
    else source = `${source.trimEnd()}\n${line}\n`;
  }
  await writeFile(file, source, { mode: 0o600 });
  await chmod(file, 0o600);
  return { createdKey: !existingKey };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { createdKey } = await setupLocalEnv();
    process.stdout.write(
      `.env is ready for local mode. ${createdKey ? 'A new encryption key was generated in .env; keep a copy, it cannot be recovered.' : 'Your existing encryption key is preserved.'}\n` +
        'Next: npm run services:up, npm run build, then npm start.\n',
    );
  } catch (error) {
    process.stderr.write(`Local setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

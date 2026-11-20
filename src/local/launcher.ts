import { defaultHome } from '../home.js';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, NO_AI } from '../config.js';
import { setLogLevel } from '../core/log.js';
import { createDb, migrate } from '../db/db.js';
import { serve } from '../serve.js';
import type { Member } from '../core/members.js';
import { MAINTENANCE_COMMANDS, runMaintenance } from './commands.js';
import { lock, MaintenanceError, settlePendingKey } from './maintenance.js';
import { startEmbeddedPostgres } from './pglite.js';
import { localSignInUrl, prepareLocalSignIn } from './sign-in.js';

/**
 * Single-user local install: `dittoly` (or `npm run local`).
 *
 * - Everything lives in one directory (default ~/.dittoly): the embedded
 *   Postgres data (PGlite) and the master key that encrypts your credentials.
 * - You are the only member, and admin and approver at once.
 * - It listens on 127.0.0.1 only and prints a one-time sign-in link; each
 *   start issues a new link and invalidates the previous one.
 * - The Claude and Codex CLIs are allowed here (and only here).
 */

const HELP = `Usage: dittoly [options]                  start Dittoly
       dittoly backup [file] [--home <dir>]  write a passphrase-encrypted backup (Dittoly must be stopped)
       dittoly restore <file> [--home <dir>] restore a backup into an empty data directory
       dittoly rotate-key [--home <dir>]     re-encrypt all stored secrets with a new master key
       dittoly cleanup [--home <dir>] [--yes] delete modules, Flows, runs, apps, plans, data tables, git sync and history,
                                              and sandbox leftovers and pulled images; keeps account, credentials, settings

  --home <dir>       data directory (default: $DITTOLY_HOME or ~/.dittoly)
  --port <port>      port on 127.0.0.1 (default: 8484)
  --ai <provider>    claude-cli | codex-cli | anthropic | openai | ollama | none
                     (default: $DITTOLY_AI_PROVIDER or none)
  -h, --help         show this help
`;

function masterKey(home: string): string {
  const file = path.join(home, 'master.key');
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return readFileSync(file, 'utf8').trim();
}

function localHandle(): string {
  const raw = (() => {
    try {
      return userInfo().username;
    } catch {
      return 'me';
    }
  })();
  const h = raw.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 30);
  return h.length >= 2 ? h : 'me';
}

export async function launch(argv = process.argv.slice(2)): Promise<{ url: string; signIn: string; noAi: boolean; app: Awaited<ReturnType<typeof serve>>["app"]; member: Member; stop: () => Promise<void> }> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      home: { type: 'string' },
      port: { type: 'string' },
      ai: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (positionals.length) throw new ConfigError(`unknown command '${positionals[0]}' (see --help)`);
  // A personal install only needs to hear about problems.
  setLogLevel((process.env.DITTOLY_LOG_LEVEL as 'info' | 'warn' | undefined) ?? 'warn');
  const home = path.resolve(values.home ?? defaultHome());
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const release = lock(home);
  await settlePendingKey(home);

  // Unix socket where the platform has one; Windows falls back to a loopback port.
  const pg = await startEmbeddedPostgres(
    path.join(home, 'pgdata'),
    process.platform === 'win32' ? { port: 0 } : { socketDir: path.join(home, 'run') },
  );
  const config = loadConfig({
    ...process.env,
    DITTOLY_MODE: 'local',
    DATABASE_URL: pg.url,
    DITTOLY_MASTER_KEY: masterKey(home),
    DITTOLY_AI_PROVIDER: values.ai ?? process.env.DITTOLY_AI_PROVIDER ?? 'none',
    DITTOLY_SANDBOX: 'process',
    HOST: '127.0.0.1',
    PORT: values.port ?? process.env.PORT ?? '8484',
  });
  // One connection: PGlite has a single backend.
  const db = createDb(config.databaseUrl, 1);
  await migrate(db);

  const { member: me, token } = await prepareLocalSignIn(db, localHandle());

  const running = await serve(config, db);
  const signIn = localSignInUrl(running.url, token);
  return {
    url: running.url,
    signIn,
    /** True when nothing can be drafted from a description, so the launcher can say so once. */
    noAi: config.aiProvider === 'none',
    /** For tests: the app and the one member. */
    app: running.app,
    member: me,
    stop: async () => {
      await running.stop();
      await pg.stop();
      release();
    },
  };
}

// Run when executed directly (bin/dittoly.mjs or `npm run local`).
if (process.argv[1] && /launcher\.(ts|js)$/.test(process.argv[1]) && MAINTENANCE_COMMANDS.has(process.argv[2] ?? '')) {
  runMaintenance(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(err instanceof MaintenanceError ? `dittoly: ${err.message}\n` : `dittoly: failed (${(err as Error).message})\n`);
    process.exit(1);
  });
} else if (process.argv[1] && /launcher\.(ts|js)$/.test(process.argv[1])) {
  launch()
    .then(({ url, signIn, noAi, stop }) => {
      process.stdout.write(`\nDittoly is running at ${url}\n${noAi ? `\n${NO_AI}` : ''}\nOpen this link to sign in (valid until the next start):\n\n  ${signIn}\n\n`);
      const shutdown = async () => {
        await stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      process.stderr.write(
        err instanceof ConfigError || err instanceof MaintenanceError ? `dittoly: ${err.message}\n` : `dittoly: failed to start (${(err as Error).name})\n`,
      );
      process.exit(1);
    });
}

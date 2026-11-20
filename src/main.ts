import { ConfigError, isWildcardHost, loadConfig, NO_AI } from './config.js';
import { errorType, log } from './core/log.js';
import { createDb, migrate } from './db/db.js';
import { localSignInUrl, prepareLocalSignIn } from './local/sign-in.js';
import { checkDatabase, PreflightError, rabbitReachable } from './preflight.js';
import { serve } from './serve.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv.slice(2));
  const db = createDb(config.databaseUrl);
  await checkDatabase(db, config);
  if (config.amqpUrl) {
    const problem = await rabbitReachable(config.amqpUrl);
    if (problem) {
      process.stderr.write(
        `dittoly: warning: ${problem}. Webhook deliveries are refused with 503 until it is reachable` +
          `${config.mode === 'local' ? ' (start it with `npm run services:up`)' : ''}.\n`,
      );
    }
  }
  let signIn: string | undefined;
  if (config.mode === 'local') {
    await migrate(db);
    const { token } = await prepareLocalSignIn(db);
    signIn = localSignInUrl(config.publicUrl, token);
  }
  const running = await serve(config, db);
  if (isWildcardHost(config.host)) {
    const set = process.env.DITTOLY_PUBLIC_URL?.trim().replace(/\/+$/, '');
    process.stdout.write(`\nListening on every network address, port ${config.port}. Open ${config.publicUrl} on this computer, your phone or another device on the same network.\n`);
    if (set && set !== config.publicUrl) process.stdout.write(`(DITTOLY_PUBLIC_URL is ${set}, which other devices cannot open, so links and QR codes use ${config.publicUrl}.)\n`);
    else if (set && /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(`${set}/`)) process.stdout.write(`Note: links and QR codes use DITTOLY_PUBLIC_URL=${set}, which phones and other devices cannot open. To reach Dittoly from them, start with \`npm start -- --host=0.0.0.0\` or set DITTOLY_PUBLIC_URL to this computer's network address (with single sign-on, also the redirect URI registered with your identity provider).\n`);
    if (config.mode === 'local') {
      process.stdout.write('Note: this single-person install is now reachable from other machines on the network. The sign-in link below is the key: do not share it.\n');
    }
  }
  if (config.aiProvider === 'none') process.stdout.write(`\n${NO_AI}`);
  if (signIn) {
    process.stdout.write(`\nOpen this link to sign in (valid until the next start):\n\n  ${signIn}\n\n`);
  }
  const shutdown = async () => {
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err instanceof ConfigError || err instanceof PreflightError) {
    // Configuration messages name settings, never values.
    process.stderr.write(`dittoly: ${err.message}\n`);
  } else {
    log.error('startup_failed', { errorType: errorType(err) });
  }
  process.exit(1);
});

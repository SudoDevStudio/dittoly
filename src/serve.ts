import { buildApp, type App } from './app.js';
import { buildServer } from './api/server.js';
import type { Config } from './config.js';
import { errorType, log } from './core/log.js';
import { migrate, type Db } from './db/db.js';
import { heartbeat } from './engine/sandbox-housekeeping.js';

/** Migrate, build, start the worker and maintenance loop, and listen. Shared by `npm start` and the local launcher. */
export async function serve(config: Config, db: Db): Promise<{ app: App; url: string; stop: () => Promise<void> }> {
  await migrate(db);
  const app = buildApp(config, db);
  const server = buildServer(app);
  // An admin's choice of the organization's AI model takes precedence over DITTOLY_AI_MODEL.
  await app.orgAi?.refresh();
  // Known as this installation's sandbox owner before any step makes a container (sandbox-housekeeping.ts).
  await heartbeat(db);
  app.worker.start();
  // A new organization AI model: approved Flows with AI steps stay on theirs and are checked with the new one.
  app.modelChanges.detect().then(
    (n) => n && log.info('model_change_checks_queued', {}),
    (err) => log.warn('model_change_detect_failed', { errorType: errorType(err) }),
  );
  // Module drafts tested before refusal tests could pass by the input schema get a fresh report.
  app.modules.recheckRefusalTests().then(
    (n) => n && log.info('module_tests_rechecked', {}),
    (err) => log.warn('module_recheck_failed', { errorType: errorType(err) }),
  );
  app.webhookQueue?.consume((content) => app.webhooks.handleQueued(content));
  // Schedules and delegation reminders/expiry; errors are logged and retried on the next pass.
  const maintenance = setInterval(() => {
    app.maintenance().catch((err) => log.error('maintenance_failed', { errorType: errorType(err) }));
  }, 30_000);
  // Telegram is polled (one server per bot); WhatsApp arrives at /channels/whatsapp.
  app.telegram?.start();
  await server.listen({ host: config.host, port: config.port });
  log.info('started', { mode: config.mode, port: config.port });
  return {
    app,
    url: `http://${config.host}:${config.port}`,
    stop: async () => {
      clearInterval(maintenance);
      await app.telegram?.stop();
      await server.close();
      await app.live.closeAll();
      await app.apps.stopAll();
      await app.worker.stop();
      await app.webhookQueue?.close();
      await db.end();
    },
  };
}

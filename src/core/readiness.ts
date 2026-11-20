import type { App } from '../app.js';
import { pendingMigrations } from '../db/db.js';

/**
 * Readiness (GET /ready), apart from liveness (GET /health: the process answers). Only states, never details:
 * - database: a query answers within the time limit;
 * - migrations: every migration this server has is applied ("unknown" when the database is down);
 * - worker: the background worker runs;
 * - webhookQueue: "not_configured" without RabbitMQ (not a failure), else whether the broker takes messages.
 */
export type Readiness = {
  ready: boolean;
  checks: {
    database: 'ok' | 'down';
    migrations: 'ok' | 'pending' | 'unknown';
    worker: 'ok' | 'stopped';
    webhookQueue: 'not_configured' | 'ok' | 'down';
  };
};

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

export async function readiness(app: App, timeoutMs = 2000): Promise<Readiness> {
  const database = await within(app.db.query('SELECT 1'), timeoutMs).then(() => 'ok' as const, () => 'down' as const);
  const migrations =
    database === 'ok' ? await within(pendingMigrations(app.db), timeoutMs).then((p) => (p.length ? ('pending' as const) : ('ok' as const)), () => 'unknown' as const) : ('unknown' as const);
  const worker = app.worker.state();
  const webhookQueue = !app.webhookQueue ? ('not_configured' as const) : app.webhookQueue.connected() ? ('ok' as const) : ('down' as const);
  const ready = database === 'ok' && migrations === 'ok' && worker === 'ok' && webhookQueue !== 'down';
  return { ready, checks: { database, migrations, worker, webhookQueue } };
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db/db.js';
import { enqueue } from '../src/engine/jobs.js';
import type { WebhookQueue } from '../src/webhooks/queue.js';
import { makeWorld, testConfig, type World } from './helpers.js';

/**
 * Liveness (/health: the process answers) is separate from readiness (/ready: it can do its work). Readiness checks
 * the database, its migrations, the background worker and, only when one is configured, the webhook queue.
 * Admins see the background queue: what waits, runs and failed, and how long the oldest has waited.
 */
let w: World;
let api: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
});
afterAll(async () => {
  await w.app.worker.stop();
  await api.close();
  await w.db.end();
});

const ready = async (server = api) => {
  const r = await server.inject({ method: 'GET', url: '/ready' });
  return { status: r.statusCode, body: r.json() as { ready: boolean; checks: Record<string, string> } };
};

describe('readiness', () => {
  it('is ready once the worker runs; without a configured webhook queue that check says so, and is not a failure', async () => {
    expect(await ready()).toEqual({ status: 503, body: { ready: false, checks: { database: 'ok', migrations: 'ok', worker: 'stopped', webhookQueue: 'not_configured' } } });
    w.app.worker.start(20);
    expect(await ready()).toEqual({ status: 200, body: { ready: true, checks: { database: 'ok', migrations: 'ok', worker: 'ok', webhookQueue: 'not_configured' } } });
    expect((await api.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('a migration not applied makes it not ready', async () => {
    const last = (await w.db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`)).rows[0]!.name;
    await w.db.query(`DELETE FROM schema_migrations WHERE name = $1`, [last]);
    try {
      expect(await ready()).toMatchObject({ status: 503, body: { checks: { migrations: 'pending' } } });
    } finally {
      await w.db.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [last]);
    }
  });

  it('a configured webhook queue that is down makes it not ready; one that is up does not', async () => {
    const queue = (connected: boolean): WebhookQueue => ({ publish: async () => undefined, consume: () => undefined, close: async () => undefined, connected: () => connected });
    for (const [connected, status, state] of [[false, 503, 'down'], [true, 200, 'ok']] as const) {
      const app = buildApp(testConfig(), w.db, { webhookQueue: queue(connected) });
      app.worker.start(20);
      const server = buildServer(app);
      try {
        expect(await ready(server)).toMatchObject({ status, body: { checks: { webhookQueue: state } } });
      } finally {
        await app.worker.stop();
        await server.close();
      }
    }
  });

  it('when the database cannot be reached it is not ready, while /health still answers', async () => {
    const db = createDb('postgres://postgres@127.0.0.1:1/nowhere', 1);
    const app = buildApp(testConfig(), db, {});
    const server = buildServer(app);
    try {
      expect(await ready(server)).toMatchObject({ status: 503, body: { ready: false, checks: { database: 'down', migrations: 'unknown' } } });
      expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await server.close();
      await db.end();
    }
  });
});

describe('the background queue, for admins', () => {
  it('counts what waits, is scheduled, runs and failed, by kind, with the oldest wait', async () => {
    await w.app.worker.stop();
    await w.db.query(`DELETE FROM jobs`);
    await enqueue(w.db, 'deliver_notification', {}, new Date(Date.now() - 90_000));
    await enqueue(w.db, 'deliver_notification', {});
    await enqueue(w.db, 'git_import', {}, new Date(Date.now() + 3_600_000));
    await enqueue(w.db, 'advance', {});
    await w.db.query(`UPDATE jobs SET locked_until = now() + interval '5 minutes' WHERE kind = 'advance'`);
    await enqueue(w.db, 'plan_item', {});
    await w.db.query(`UPDATE jobs SET failed_at = now(), last_error = 'typeerror' WHERE kind = 'plan_item'`);

    const res = await api.inject({ method: 'GET', url: '/api/jobs/queue', headers: { authorization: `Bearer ${w.tokens.admin}` } });
    expect(res.statusCode).toBe(200);
    const q = res.json() as { waiting: number; scheduled: number; running: number; failed: number; oldestWaitSeconds: number | null; kinds: Record<string, unknown>[] };
    expect(q).toMatchObject({ waiting: 2, scheduled: 1, running: 1, failed: 1 });
    expect(q.oldestWaitSeconds).toBeGreaterThanOrEqual(89);
    // And the code sandboxes: none in use, no run waiting for one.
    expect((q as unknown as { sandboxes: unknown }).sandboxes).toEqual({ slots: 1, busy: 0, waiting: 0 });
    expect(q.kinds).toEqual(expect.arrayContaining([
      { kind: 'deliver_notification', waiting: 2, scheduled: 0, running: 0, failed: 0 },
      { kind: 'git_import', waiting: 0, scheduled: 1, running: 0, failed: 0 },
    ]));
    expect((await api.inject({ method: 'GET', url: '/api/jobs/queue', headers: { authorization: `Bearer ${w.tokens.alice}` } })).statusCode).toBe(403);
  });
});

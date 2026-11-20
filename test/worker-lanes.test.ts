import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { enqueue, laneKinds, Workers, type Job } from '../src/engine/jobs.js';
import { approveExampleModules, freshDb, makeWorld } from './helpers.js';

/**
 * Background work runs in lanes: quick work (notifications, git sync, undo, follow-ups of decisions) never waits
 * behind long work (runs with fix or browser steps, AI drafting), and runs go through a bounded number of slots.
 */
let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query(`DELETE FROM jobs`);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

describe('worker lanes', () => {
  it('a notification is delivered while a long run is still going', async () => {
    const done: Record<string, number> = {};
    let release!: () => void;
    const long = new Promise<void>((r) => (release = r));
    const workers = new Workers(db, async (job: Job) => {
      if (job.kind === 'advance') await long;
      done[job.kind] = Date.now();
    }, { runs: 1 });
    await enqueue(db, 'advance', { runId: 'r1' });
    await enqueue(db, 'deliver_notification', { notificationId: 'n1' });
    workers.start(10);
    try {
      await until(() => 'deliver_notification' in done);
      expect(done.advance).toBeUndefined();
    } finally {
      release();
      await until(() => 'advance' in done);
      await workers.stop();
    }
  });

  it('runs use as many slots as configured, and no more', async () => {
    let running = 0;
    let most = 0;
    const workers = new Workers(db, async () => {
      running++;
      most = Math.max(most, running);
      await sleep(150);
      running--;
    }, { runs: 2 });
    for (let i = 0; i < 6; i++) await enqueue(db, 'advance', { runId: `r${i}` });
    workers.start(10);
    try {
      await until(() => most === 2);
      const left = async () => (await db.query(`SELECT count(*)::int AS n FROM jobs`)).rows[0].n as number;
      const end = Date.now() + 5000;
      while ((await left()) > 0 && Date.now() < end) await sleep(20);
      expect(await left()).toBe(0);
      expect(most).toBe(2);
    } finally {
      await workers.stop();
    }
  });

  it('drain runs everything due in every lane (tests and the CLI)', async () => {
    const seen: string[] = [];
    const workers = new Workers(db, async (job) => void seen.push(job.kind), { runs: 1 });
    await enqueue(db, 'advance', {});
    await enqueue(db, 'git_import', {});
    await enqueue(db, 'plan_item', {});
    expect(await workers.drain()).toBe(3);
    expect(seen.sort()).toEqual(['advance', 'git_import', 'plan_item']);
  });

  it('plan drafting has its own slots: a long run never holds up the next draft, nor a long draft a run', async () => {
    const done: Record<string, number> = {};
    let release!: () => void;
    const long = new Promise<void>((r) => (release = r));
    const workers = new Workers(db, async (job: Job) => {
      if (job.kind === 'advance' || job.payload.slow) await long;
      done[`${job.kind}:${job.payload.id ?? ''}`] = Date.now();
    }, { runs: 1, drafts: 2 });
    await enqueue(db, 'advance', { runId: 'r1' });
    await enqueue(db, 'plan_item', { id: 'slow', slow: '1' });
    await enqueue(db, 'plan_item', { id: 'a' });
    await enqueue(db, 'plan_analyze', { id: 'b' });
    workers.start(10);
    try {
      // The run and one draft hold their lanes; the second drafting slot works through the rest.
      await until(() => 'plan_item:a' in done && 'plan_analyze:b' in done);
      expect(done['advance:']).toBeUndefined();
      expect(done['plan_item:slow']).toBeUndefined();
    } finally {
      release();
      await until(() => 'advance:' in done && 'plan_item:slow' in done);
      await workers.stop();
    }
    expect(laneKinds.drafting).toEqual(['plan_analyze', 'plan_item']);
  });

  it('a job given up is reported, so what waits on it can say so', async () => {
    const gaveUp: string[] = [];
    const workers = new Workers(db, async () => {
      throw new Error('boom');
    }, { runs: 1, maxJobAttempts: 1, leaseMs: 1, onExhausted: async (job) => void gaveUp.push(job.kind) });
    await enqueue(db, 'plan_item', { itemId: 'x' });
    await workers.drain(1); // attempt 1 fails; the lease (1 ms) runs out
    await sleep(10);
    await workers.drain(1); // attempt 2 is over the limit: given up
    expect(gaveUp).toEqual(['plan_item']);
    expect((await db.query(`SELECT failed_at FROM jobs`)).rows[0].failed_at).not.toBeNull();
  });

  it('which work is quick', () => {
    expect(laneKinds.quick).toEqual(expect.arrayContaining(['deliver_notification', 'git_export', 'git_export_all', 'git_import', 'reverse', 'module_decided', 'flow_decided']));
    expect(laneKinds.quick).not.toContain('advance');
  });

  it('run slots: 2 on a shared server, 1 on a local install, or DITTOLY_RUN_WORKERS', () => {
    const base = { DITTOLY_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), DATABASE_URL: 'postgres://x@127.0.0.1/x' };
    expect(loadConfig({ ...base, DITTOLY_MODE: 'local' }).runWorkers).toBe(1);
    expect(loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_AMQP_URL: 'amqp://x' }).runWorkers).toBe(2);
    expect(loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_RUN_WORKERS: '4' }).runWorkers).toBe(4);
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_RUN_WORKERS: '0' })).toThrow();
    expect(loadConfig({ ...base, DITTOLY_MODE: 'local' }).draftWorkers).toBe(2);
    expect(loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_DRAFT_WORKERS: '3' }).draftWorkers).toBe(3);
  });

  it('two run slots never execute the same step twice, even when the run is queued twice', async () => {
    const w = await makeWorld({ runWorkers: 2 });
    try {
      await approveExampleModules(w);
      await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice');
      const def = { inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C1', text: 'hi' } }] };
      const v = await w.app.flows.create('Post once', def, w.alice);
      await w.app.flows.decide(v.id, w.approver, 'approved');
      const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
      // The same run queued again, as a retry or a second trigger might.
      for (let i = 0; i < 3; i++) await enqueue(w.db, 'advance', { runId });
      w.app.worker.start(5);
      const end = Date.now() + 10_000;
      while ((await w.app.engine.runView(runId, w.alice)).status !== 'succeeded' && Date.now() < end) await sleep(20);
      expect((await w.app.engine.runView(runId, w.alice)).status).toBe('succeeded');
      expect(w.fake.calls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(1);
    } finally {
      await w.app.worker.stop();
      await w.db.end();
    }
  });
});

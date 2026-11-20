import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { claim, complete, enqueue, exhaustedJobs, extendLease, LeaseLost, retryJob, Worker, type Job } from '../src/engine/jobs.js';
import { createMember } from '../src/core/members.js';
import { freshDb } from './helpers.js';

/**
 * The durable job queue: a job belongs to the worker that claimed it until its lease ends. A worker whose lease
 * ran out cannot renew or finish a job someone else has taken since. A job that keeps failing is kept, not dropped.
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
const expire = () => db.query(`UPDATE jobs SET locked_until = now() - interval '1 second'`);
const rows = async () => (await db.query<{ id: string; attempts: number; failed_at: Date | null; last_error: string | null }>(`SELECT id, attempts, failed_at, last_error FROM jobs`)).rows;

describe('leases', () => {
  it('a worker whose lease ran out cannot renew or finish the job another worker took', async () => {
    await enqueue(db, 'noop', {});
    const a = (await claim(db, 60_000))!;
    await expire();
    const b = (await claim(db, 60_000))!;
    expect(b.id).toBe(a.id);
    expect(await extendLease(db, a, 60_000)).toBe(false);
    expect(await complete(db, a)).toBe(false);
    expect(await rows()).toHaveLength(1);
    // The current holder can.
    expect(await extendLease(db, b, 60_000)).toBe(true);
    expect(await complete(db, b)).toBe(true);
    expect(await rows()).toHaveLength(0);
  });

  it('a handler learns at its next heartbeat that it lost the job, and the worker leaves the job to its new holder', async () => {
    await enqueue(db, 'slow', {});
    let lost: unknown = null;
    let taken: Job | null = null;
    const w = new Worker(db, async (_job, heartbeat) => {
      // Meanwhile the lease runs out and another worker takes the job.
      await expire();
      taken = await claim(db, 60_000);
      try {
        await heartbeat();
      } catch (err) {
        lost = err;
        throw err;
      }
    });
    await w.runOnce();
    expect(lost).toBeInstanceOf(LeaseLost);
    expect(taken).not.toBeNull();
    const [row] = await rows();
    expect(row).toMatchObject({ failed_at: null, last_error: null });
    expect(await complete(db, taken!)).toBe(true);
  });
});

describe('jobs that keep failing', () => {
  it('are kept with the reason after the last attempt, not run again, and an admin can retry them (audited)', async () => {
    await enqueue(db, 'always_fails', { what: 'x' });
    let calls = 0;
    const w = new Worker(db, async () => {
      calls++;
      throw new TypeError('boom');
    }, 60_000, 3);
    for (let i = 0; i < 5; i++) {
      await w.runOnce();
      await expire();
    }
    expect(calls).toBe(3);
    const [row] = await rows();
    expect(row).toMatchObject({ attempts: 4, last_error: 'typeerror' });
    expect(row!.failed_at).toBeInstanceOf(Date);
    expect(await w.runOnce()).toBe(false);
    expect(await exhaustedJobs(db)).toEqual([expect.objectContaining({ id: row!.id, kind: 'always_fails', attempts: 4, lastError: 'typeerror' })]);

    const { member: admin } = await createMember(db, 'admin', 'admin', null);
    const { member: someone } = await createMember(db, 'someone', 'member', null);
    await expect(retryJob(db, someone, row!.id)).rejects.toMatchObject({ code: 'admin_only' });
    await expect(retryJob(db, admin, '999999')).rejects.toMatchObject({ code: 'job_not_found' });
    await retryJob(db, admin, row!.id);
    const audited = (await db.query(`SELECT action, subject_id FROM audit_events WHERE action = 'job.retried'`)).rows;
    expect(audited).toEqual([{ action: 'job.retried', subject_id: row!.id }]);
    expect(await exhaustedJobs(db)).toEqual([]);
    expect(await w.runOnce()).toBe(true);
    expect(calls).toBe(4);
  });

  it('a failure records its reason while attempts remain', async () => {
    await enqueue(db, 'fails_once', {});
    let n = 0;
    const w = new Worker(db, async () => {
      if (n++ === 0) throw new RangeError('first time');
    });
    await w.runOnce();
    expect((await rows())[0]).toMatchObject({ last_error: 'rangeerror', failed_at: null });
    await expire();
    await w.runOnce();
    expect(await rows()).toEqual([]);
  });
});

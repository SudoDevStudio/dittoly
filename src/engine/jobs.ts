import { withTx, type Db, type Queryable } from '../db/db.js';
import { audit } from '../core/audit.js';
import { forbidden, notFound } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import type { Member } from '../core/members.js';

/**
 * Durable job queue on Postgres. A claimed job is leased, not removed; it is
 * deleted only after its handler finishes. If the process dies mid-job the
 * lease expires and another worker picks it up (restart recovery).
 * Each claim has its own token: renewing or finishing a job needs it, so a worker
 * whose lease ran out cannot touch the job once another worker took it. A lease
 * cannot fence a remote API: steps whose outcome is unknown stay uncertain_outcome.
 * A job that keeps failing is kept (failed_at, last_error) until an admin retries it.
 */
export interface Job {
  id: string;
  kind: string;
  payload: Record<string, string>;
  attempts: number;
  /** This claim's token. */
  token: string;
  /** When it was due. */
  runAt: Date;
}

/** The job was taken by another worker after this one's lease ran out: stop working on it. */
export class LeaseLost extends Error {
  readonly code = 'job_lease_lost';
  constructor() {
    super('job_lease_lost');
  }
}

export async function enqueue(db: Queryable, kind: string, payload: Record<string, string>, runAt?: Date): Promise<void> {
  await db.query(`INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, $3)`, [kind, JSON.stringify(payload), runAt ?? new Date()]);
}

/** Which kinds a worker takes: only these, or all but these. With teamLimits, a team at its run limit waits. */
export interface KindFilter { only?: readonly string[]; except?: readonly string[]; teamLimits?: boolean }

const CLAIM = `UPDATE jobs SET locked_until = now() + ($1 || ' milliseconds')::interval, attempts = attempts + 1, lease_token = gen_random_uuid()
     WHERE id = (
       SELECT j.id FROM jobs j
       WHERE j.run_at <= now() AND (j.locked_until IS NULL OR j.locked_until < now()) AND j.failed_at IS NULL
         AND ($2::text[] IS NULL OR j.kind = ANY($2)) AND ($3::text[] IS NULL OR NOT (j.kind = ANY($3)))
         -- A run of a team that already has run_limit runs going waits; others go first.
         AND NOT ($4 AND j.kind = 'advance' AND EXISTS (
           SELECT 1 FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id JOIN teams t ON t.id = f.team_id
           WHERE r.id::text = j.payload->>'runId' AND t.run_limit IS NOT NULL
             AND t.run_limit <= (
               SELECT count(*) FROM jobs k
               JOIN runs r2 ON r2.id::text = k.payload->>'runId' JOIN flow_versions v2 ON v2.id = r2.flow_version_id JOIN flows f2 ON f2.id = v2.flow_id
               WHERE k.kind = 'advance' AND k.failed_at IS NULL AND k.locked_until >= now() AND f2.team_id = t.id)))
       ORDER BY j.run_at, j.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     RETURNING id, kind, payload, attempts, lease_token AS token, run_at AS "runAt"`;

export async function claim(db: Db, leaseMs: number, kinds: KindFilter = {}): Promise<Job | null> {
  const params = [String(leaseMs), kinds.only ?? null, kinds.except ?? null, kinds.teamLimits === true];
  if (!kinds.teamLimits) return (await db.query<Job>(CLAIM, params)).rows[0] ?? null;
  // Counting a team's running runs and claiming one more must not interleave: run-lane claims take turns.
  return withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(4243)');
    return (await tx.query<Job>(CLAIM, params)).rows[0] ?? null;
  });
}

/** Renew the lease; false when this claim no longer holds the job. */
export async function extendLease(db: Queryable, job: Job, leaseMs: number): Promise<boolean> {
  const r = await db.query(`UPDATE jobs SET locked_until = now() + ($3 || ' milliseconds')::interval WHERE id = $1 AND lease_token = $2`, [job.id, job.token, String(leaseMs)]);
  return r.rowCount === 1;
}

/** Remove a finished job; false when this claim no longer holds it. */
export async function complete(db: Queryable, job: Job): Promise<boolean> {
  const r = await db.query(`DELETE FROM jobs WHERE id = $1 AND lease_token = $2`, [job.id, job.token]);
  return r.rowCount === 1;
}

export interface QueueCounts { waiting: number; scheduled: number; running: number; failed: number }

/** The queue now: due and unclaimed (waiting), due later (scheduled), leased (running), failed every attempt. */
export async function queueStats(db: Queryable): Promise<QueueCounts & { oldestWaitSeconds: number | null; kinds: (QueueCounts & { kind: string })[] }> {
  const rows = (await db.query<QueueCounts & { kind: string; oldest: number | null }>(
    `SELECT kind,
       count(*) FILTER (WHERE failed_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now()))::int AS waiting,
       count(*) FILTER (WHERE failed_at IS NULL AND run_at > now() AND (locked_until IS NULL OR locked_until < now()))::int AS scheduled,
       count(*) FILTER (WHERE failed_at IS NULL AND locked_until >= now())::int AS running,
       count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS failed,
       extract(epoch FROM now() - min(run_at) FILTER (WHERE failed_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())))::float8 AS oldest
     FROM jobs GROUP BY kind ORDER BY kind`,
  )).rows;
  const sum = (k: keyof QueueCounts) => rows.reduce((n, r) => n + r[k], 0);
  const oldest = rows.map((r) => r.oldest).filter((x): x is number => x !== null);
  return {
    waiting: sum('waiting'),
    scheduled: sum('scheduled'),
    running: sum('running'),
    failed: sum('failed'),
    oldestWaitSeconds: oldest.length ? Math.floor(Math.max(...oldest)) : null,
    kinds: rows.map(({ kind, waiting, scheduled, running, failed }) => ({ kind, waiting, scheduled, running, failed })),
  };
}

/** Jobs that failed every attempt, newest first. */
export async function exhaustedJobs(db: Queryable, limit = 100): Promise<{ id: string; kind: string; attempts: number; lastError: string | null; failedAt: Date }[]> {
  return (await db.query<{ id: string; kind: string; attempts: number; lastError: string | null; failedAt: Date }>(
    `SELECT id::text, kind, attempts, last_error AS "lastError", failed_at AS "failedAt" FROM jobs WHERE failed_at IS NOT NULL ORDER BY failed_at DESC LIMIT $1`,
    [limit],
  )).rows;
}

/** An admin runs a job that failed every attempt once more, with fresh attempts. */
export async function retryJob(db: Queryable, actor: Member, id: string): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (!/^\d+$/.test(id)) throw notFound('job');
  const r = await db.query(`UPDATE jobs SET failed_at = NULL, last_error = NULL, attempts = 0, locked_until = NULL, lease_token = NULL, run_at = now() WHERE id = $1 AND failed_at IS NOT NULL`, [id]);
  if (!r.rowCount) throw notFound('job');
  await audit(db, { actorId: actor.id, action: 'job.retried', subjectType: 'job', subjectId: id, outcome: 'ok' });
}

export type JobHandler = (job: Job, heartbeat: () => Promise<void>) => Promise<void>;

export class Worker {
  private stopped = true;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly handler: JobHandler,
    private readonly leaseMs = 10 * 60_000,
    private readonly maxJobAttempts = 5,
    /** The kinds it takes, and how many it works on at once. */
    private readonly lane: KindFilter & { slots?: number } = {},
    /** Told when a job is given up, so what waits on it can say so instead of waiting forever. */
    private readonly onExhausted?: (job: Job) => Promise<void>,
  ) {}

  /** Process one due job. Returns false when none was due. */
  async runOnce(): Promise<boolean> {
    const job = await claim(this.db, this.leaseMs, this.lane);
    if (!job) return false;
    if (job.attempts > this.maxJobAttempts) {
      // A job that keeps failing (or crashing its worker) is kept for an admin, not retried forever.
      const r = await this.db.query(`UPDATE jobs SET failed_at = now(), locked_until = NULL WHERE id = $1 AND lease_token = $2`, [job.id, job.token]);
      if (r.rowCount) {
        log.error('job_exhausted', { jobId: job.id, jobKind: job.kind, attempt: job.attempts });
        await audit(this.db, { actorId: null, action: 'job.exhausted', subjectType: 'job', subjectId: job.id, outcome: 'failed', errorType: 'job_exhausted' });
        await this.onExhausted?.(job).catch((err: unknown) => log.warn('job_exhausted_hook_failed', { jobKind: job.kind, errorType: errorType(err) }));
      }
      return true;
    }
    const heartbeat = async () => {
      if (!(await extendLease(this.db, job, this.leaseMs))) throw new LeaseLost();
    };
    const started = Date.now();
    try {
      await this.handler(job, heartbeat);
      if (!(await complete(this.db, job))) log.warn('job_lease_lost', { jobId: job.id, jobKind: job.kind });
      // How long it waited after it was due, and how long it ran.
      log.info('job_done', { jobKind: job.kind, waitMs: Math.max(0, started - new Date(job.runAt).getTime()), durationMs: Date.now() - started });
    } catch (err) {
      // Leave the job leased; it becomes due again when the lease expires. Only its holder records why.
      log.error('job_failed', { jobId: job.id, jobKind: job.kind, errorType: errorType(err) });
      await this.db.query(`UPDATE jobs SET last_error = $3 WHERE id = $1 AND lease_token = $2`, [job.id, job.token, errorType(err).slice(0, 100)]).catch(() => undefined);
    }
    return true;
  }

  /** Run until no job is due right now. Used by tests and the CLI. */
  async drain(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  /** Readiness: stopped, or running (its loop is between jobs or inside one). */
  state(): 'ok' | 'stopped' {
    return this.stopped ? 'stopped' : 'ok';
  }

  start(pollMs = 500): void {
    if (!this.stopped) return;
    this.stopped = false;
    // One loop per slot: each claims its own job (SKIP LOCKED), so slots never take the same one.
    const loop = async () => {
      while (!this.stopped) {
        const worked = await this.runOnce().catch(() => false);
        if (!worked) await new Promise((r) => setTimeout(r, pollMs));
      }
    };
    this.loop = Promise.all(Array.from({ length: Math.max(1, this.lane.slots ?? 1) }, loop)).then(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

/**
 * Quick work: deliveries, git sync, undo, follow-ups of decisions. It has its own lane so it never waits behind
 * runs (a fix or browser step can take many minutes) or AI drafting. Every other kind is run work.
 */
export const laneKinds = {
  quick: ['deliver_notification', 'git_export', 'git_export_all', 'git_import', 'reverse', 'module_decided', 'flow_decided'],
  /** AI drafting for plans: minutes per item. Its own slots, so a long draft never holds up runs or the next item. */
  drafting: ['plan_analyze', 'plan_item'],
} as const;

/**
 * The server's workers: a quick lane (one slot), a drafting lane with `drafts` slots (default 2) and a run lane with
 * `runs` slots. Same interface as one Worker.
 * Each slot holds a database connection while it works; keep runs well below the pool size.
 */
export class Workers {
  private readonly lanes: Worker[];

  constructor(db: Db, handler: JobHandler, opts: { runs: number; drafts?: number; leaseMs?: number; maxJobAttempts?: number; onExhausted?: (job: Job) => Promise<void> }) {
    const lease = opts.leaseMs ?? 10 * 60_000;
    const attempts = opts.maxJobAttempts ?? 5;
    const gaveUp = opts.onExhausted;
    this.lanes = [
      new Worker(db, handler, lease, attempts, { only: laneKinds.quick, slots: 1 }, gaveUp),
      new Worker(db, handler, lease, attempts, { only: laneKinds.drafting, slots: opts.drafts ?? 2 }, gaveUp),
      new Worker(db, handler, lease, attempts, { except: [...laneKinds.quick, ...laneKinds.drafting], slots: opts.runs, teamLimits: true }, gaveUp),
    ];
  }

  async runOnce(): Promise<boolean> {
    for (const lane of this.lanes) if (await lane.runOnce()) return true;
    return false;
  }

  /** Run until nothing is due in any lane. Used by tests and the CLI. */
  async drain(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  state(): 'ok' | 'stopped' {
    return this.lanes.every((l) => l.state() === 'ok') ? 'ok' : 'stopped';
  }

  start(pollMs = 500): void {
    for (const lane of this.lanes) lane.start(pollMs);
  }

  async stop(): Promise<void> {
    await Promise.all(this.lanes.map((l) => l.stop()));
  }
}

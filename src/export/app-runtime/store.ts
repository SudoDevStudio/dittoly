import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Where an exported app keeps runs and table rows. Flows that never wait for a person and use no
 * table keep everything in memory: no disk, no database. Flows with sign-offs, forms, delays or
 * tables need state that outlives a restart, in the store STATE_URL names (Redis or Postgres).
 * Run data (inputs and step outputs) is encrypted with a key derived from APP_SECRET before it
 * leaves the process.
 */

export type RunStatus = 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'skipped' | 'failed' | 'not_run';

export interface StepRecord {
  id: string;
  status: StepStatus;
  attempts: number;
  errorType: string | null;
  output?: unknown;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  /** When a waiting delay or a retry continues. */
  resumeAt?: string | undefined;
  /** forEach items already done, so a retry never repeats them. */
  progress?: Record<string, unknown> | undefined;
  decision?: { decision: 'approved' | 'rejected'; at: string; valuesSha256?: string | null } | undefined;
  /** A step text an AI wrote could steer, waiting for a sign-off: exactly what it will do, and their hash (engine.ts). */
  signOff?: { values: unknown; sha256: string } | undefined;
  /** A flow step's child runs. */
  children?: { key: string; runId: string }[] | undefined;
}

export interface RunRecord {
  id: string;
  flow: string;
  status: RunStatus;
  waitReason: string | null;
  createdAt: string;
  finishedAt: string | null;
  inputs: unknown;
  steps: StepRecord[];
  /** Set on a child run of a Super Flow. */
  parent: { runId: string; stepId: string; key: string } | null;
  /** Waiting steps already announced to NOTIFY_*. */
  notified: string[];
  /** When a finished run is deleted. */
  expiresAt: string | null;
}

export interface Store {
  readonly kind: 'memory' | 'redis' | 'postgres';
  /** Records that could not be read (sealed with another APP_SECRET, or damaged): skipped. */
  readonly unreadable: number;
  getRun(id: string): Promise<RunRecord | null>;
  putRun(run: RunRecord): Promise<void>;
  /** Newest first; runs a Super Flow started are left out. */
  listRuns(o: { flow?: string; limit: number }): Promise<RunRecord[]>;
  /** Runs still going (running, waiting or paused), to pick up after a restart and for the inbox. */
  activeRuns(): Promise<RunRecord[]>;
  tableGet(table: string, key: string): Promise<Record<string, unknown> | null>;
  tablePut(table: string, key: string, row: Record<string, unknown>): Promise<void>;
  tableDelete(table: string, key: string): Promise<boolean>;
  tableRows(table: string): Promise<{ key: string; row: Record<string, unknown> }[]>;
  /** Set a mark once (webhook deliveries, schedule ticks): true the first time. */
  mark(name: string, ttlSeconds: number): Promise<boolean>;
  /** Delete finished runs past their expiry. */
  sweep(now: Date): Promise<number>;
  close(): Promise<void>;
}

/** AES-256-GCM with a key derived from APP_SECRET, for run data that leaves the process. */
export class Sealer {
  private readonly key: Buffer;
  constructor(secret: string) {
    // The key-derivation salt never changes: state sealed with it must still open.
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('6d6f64756c6f6f6d2d617070', 'hex'), Buffer.from('state'), 32));
  }
  seal(value: unknown, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  }
  /** Unreadable data (another APP_SECRET, damaged) is counted and skipped, never fatal. */
  unreadable = 0;
  tryOpen<T>(sealed: string, aad: string): T | null {
    try {
      return this.open<T>(sealed, aad);
    } catch {
      this.unreadable++;
      return null;
    }
  }
  open<T>(sealed: string, aad: string): T {
    const raw = Buffer.from(sealed, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as T;
  }
}

const ACTIVE = new Set<RunStatus>(['running', 'waiting', 'paused']);
export const isActive = (r: RunRecord) => ACTIVE.has(r.status);

/** In memory: for apps whose Flows keep nothing between restarts. At most `max` runs are kept. */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  readonly unreadable = 0;
  private readonly runs = new Map<string, RunRecord>();
  private readonly tables = new Map<string, Map<string, Record<string, unknown>>>();
  private readonly marks = new Map<string, number>();
  constructor(private readonly max = 1000) {}

  async getRun(id: string) {
    const r = this.runs.get(id);
    return r ? structuredClone(r) : null;
  }
  async putRun(run: RunRecord) {
    this.runs.delete(run.id);
    this.runs.set(run.id, structuredClone(run));
    // Oldest finished runs go first when there are too many.
    for (const [id, r] of this.runs) {
      if (this.runs.size <= this.max) break;
      if (!isActive(r)) this.runs.delete(id);
    }
  }
  async listRuns(o: { flow?: string; limit: number }) {
    return [...this.runs.values()]
      .filter((r) => !r.parent && (!o.flow || r.flow === o.flow))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, o.limit)
      .map((r) => structuredClone(r));
  }
  async activeRuns() {
    return [...this.runs.values()].filter(isActive).map((r) => structuredClone(r));
  }
  private table(name: string) {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }
  async tableGet(table: string, key: string) {
    const row = this.table(table).get(key);
    return row ? structuredClone(row) : null;
  }
  async tablePut(table: string, key: string, row: Record<string, unknown>) {
    this.table(table).set(key, structuredClone(row));
  }
  async tableDelete(table: string, key: string) {
    return this.table(table).delete(key);
  }
  async tableRows(table: string) {
    return [...this.table(table)].map(([key, row]) => ({ key, row: structuredClone(row) }));
  }
  async mark(name: string, ttlSeconds: number) {
    const now = Date.now();
    const until = this.marks.get(name);
    if (until && until > now) return false;
    this.marks.set(name, now + ttlSeconds * 1000);
    if (this.marks.size > 100_000) for (const [k, t] of this.marks) if (t <= now) this.marks.delete(k);
    return true;
  }
  async sweep(now: Date) {
    let n = 0;
    for (const [id, r] of this.runs) if (r.expiresAt && r.expiresAt <= now.toISOString()) (this.runs.delete(id), n++);
    return n;
  }
  async close() {}
}

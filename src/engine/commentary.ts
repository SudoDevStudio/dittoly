import type { Cipher } from '../core/crypto.js';
import type { Queryable } from '../db/db.js';

/**
 * What a run is doing, said line by line as it happens ("Step 2 (Find duplicates): calling the app",
 * "GET api.github.com/search/issues → 422: Validation Failed", "AI: searching the web"): the Live panel and the run
 * page show it as commentary. Lines are encrypted, written in small batches, and capped per run.
 */
export interface CommentLine {
  id: number;
  stepId: string | null;
  at: Date;
  text: string;
}

/** At most this many lines are kept per run; later ones are dropped. */
export const MAX_LINES = 400;
const FLUSH_MS = 500;

/** One line, as said: never markdown-cleaned, since paths and names keep their underscores. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 2000);

export const commentaryAad = (runId: string) => `run:${runId}:commentary`;

/** Says lines for one step of one run; `flush` writes what is pending (call it before the step ends). */
export interface Narrator {
  say(text: string): void;
  flush(): Promise<void>;
}

export function narrator(db: Queryable, cipher: Cipher, runId: string, stepId: string | null): Narrator {
  let pending: string[] = [];
  let last = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let room: number | null = null;
  const write = async () => {
    timer = null;
    const lines = pending;
    pending = [];
    if (!lines.length) return;
    if (room === null) {
      const n = (await db.query<{ n: string }>(`SELECT count(*) AS n FROM run_commentary WHERE run_id = $1`, [runId])).rows[0]?.n;
      room = MAX_LINES - Number(n ?? 0);
    }
    const kept = lines.slice(0, Math.max(0, room));
    room -= kept.length;
    if (!kept.length) return;
    const values = kept.map((_, i) => `($1, $2, clock_timestamp(), $${i + 3})`).join(', ');
    await db.query(`INSERT INTO run_commentary (run_id, step_id, at, text_enc) VALUES ${values}`, [
      runId,
      stepId,
      ...kept.map((t) => cipher.encryptJson(t, commentaryAad(runId))),
    ]);
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // Best-effort: commentary never fails the step.
    writing = writing.then(write).catch(() => undefined);
    return writing;
  };
  return {
    say(text) {
      const line = oneLine(text);
      if (!line || line === last) return;
      last = line;
      pending.push(line);
      if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
    },
    flush,
  };
}

/** A run's lines after `after` (an id), oldest first, at most `limit`. */
export async function commentaryOf(db: Queryable, cipher: Cipher, runId: string, opts: { after?: number; limit?: number } = {}): Promise<CommentLine[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60));
  type Row = { id: string; step_id: string | null; at: Date; text_enc: string };
  const { rows } = opts.after
    ? await db.query<Row>(`SELECT id, step_id, at, text_enc FROM run_commentary WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT $3`, [runId, opts.after, limit])
    : await db.query<Row>(`SELECT * FROM (SELECT id, step_id, at, text_enc FROM run_commentary WHERE run_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id`, [runId, limit]);
  return rows.map((r) => ({ id: Number(r.id), stepId: r.step_id, at: r.at, text: cipher.decryptJson<string>(r.text_enc, commentaryAad(runId)) }));
}

/** Writes one line at once (within a transaction, say), unless the run already has its fill. */
export async function sayNow(db: Queryable, cipher: Cipher, runId: string, stepId: string | null, text: string): Promise<void> {
  const line = oneLine(text);
  if (!line) return;
  await db.query(
    `INSERT INTO run_commentary (run_id, step_id, text_enc) SELECT $1, $2, $3 WHERE (SELECT count(*) FROM run_commentary WHERE run_id = $1) < $4`,
    [runId, stepId, cipher.encryptJson(line, commentaryAad(runId)), MAX_LINES],
  );
}

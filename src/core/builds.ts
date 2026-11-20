import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import type { Cipher } from './crypto.js';
import { withProgress, type Progress } from './progress.js';

/**
 * AI builds outside a plan (a module or Flow drafted from chat, a revision, an AI fix from a run, a self-fix): one
 * row while the AI works, with its step, percent and latest activity, deleted when it ends. Plans track their own
 * items (plan_items). The Builds page and the Live panel list both.
 */

export type BuildKind = 'module' | 'flow';
export type BuildSource = 'chat' | 'revise' | 'extend' | 'run_fix' | 'self_fix';

/** A row not updated for this long belongs to a server that stopped mid-build: not shown, deleted on the next look. */
const STALE_MINUTES = 30;
/** Activity is written at most this often; a new step is always written. */
const WRITE_MS = 1000;

const aad = (id: string, what: 'title' | 'detail') => `build:${id}:${what}`;

export interface BuildInfo {
  memberId: string | null;
  kind: BuildKind;
  source: BuildSource;
  /** What is being built, in a few words (the request). */
  title: string;
  /** Where the person follows it (a run, a module). */
  link?: string | null;
}

/**
 * Runs `fn` as a tracked build: its progress reports update the row (and go to `also` too, e.g. a run's commentary);
 * the row is deleted when `fn` ends either way. Tracking never fails the build.
 */
export async function tracked<T>(d: { db: Db; cipher: Cipher }, b: BuildInfo, fn: () => Promise<T>, also?: (p: Progress) => void): Promise<T> {
  let id: string | null = randomUUID();
  try {
    await d.db.query(`INSERT INTO ai_builds (id, member_id, kind, source, title_enc, link) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id,
      b.memberId,
      b.kind,
      b.source,
      d.cipher.encrypt(b.title.replace(/\s+/g, ' ').trim().slice(0, 160), aad(id, 'title')),
      b.link ?? null,
    ]);
  } catch {
    id = null;
  }
  let lastStep = '';
  let lastWrite = 0;
  let writing: Promise<unknown> = Promise.resolve();
  // A report that came too soon after the last write: written when the wait is over, so the latest is never lost.
  let pending: Progress | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = (p: Progress) => {
    if (!id) return;
    const rowId = id;
    lastStep = p.step;
    lastWrite = Date.now();
    writing = writing
      .then(() =>
        d.db.query(
          `UPDATE ai_builds SET step = $2, percent = $3, updated_at = now(),
             step_at = CASE WHEN step IS DISTINCT FROM $2 THEN now() ELSE step_at END,
             detail_enc = CASE WHEN $4::text IS NULL THEN detail_enc ELSE $4 END,
             detail_at = CASE WHEN $4::text IS NULL THEN detail_at ELSE now() END
           WHERE id = $1`,
          [rowId, p.step.slice(0, 80), Math.max(0, Math.min(100, Math.round(p.percent))), p.detail ? d.cipher.encrypt(p.detail.slice(0, 200), aad(rowId, 'detail')) : null],
        ),
      )
      .catch(() => undefined);
  };
  const report = (p: Progress) => {
    try {
      also?.(p);
    } catch {
      // Best-effort.
    }
    if (!id) return;
    const wait = WRITE_MS - (Date.now() - lastWrite);
    if (p.step !== lastStep || wait <= 0) {
      pending = null;
      write(p);
      return;
    }
    pending = p;
    timer ??= setTimeout(() => {
      timer = null;
      if (pending) write(pending);
      pending = null;
    }, wait);
  };
  try {
    return await withProgress(report, fn);
  } finally {
    if (timer) clearTimeout(timer);
    if (id) {
      const rowId = id;
      await writing;
      await d.db.query(`DELETE FROM ai_builds WHERE id = $1`, [rowId]).catch(() => undefined);
    }
  }
}

export interface BuildView {
  id: string;
  kind: BuildKind;
  source: BuildSource;
  title: string;
  by: string | null;
  link: string | null;
  startedAt: Date;
  progress: { step: string; percent: number; since: Date; detail: string | null; detailAt: Date | null } | null;
}

/** The builds going on now: the member's own, or everyone's (`all`). */
export async function currentBuilds(db: Queryable, cipher: Cipher, memberId: string, all: boolean): Promise<BuildView[]> {
  await db.query(`DELETE FROM ai_builds WHERE updated_at < now() - make_interval(mins => $1)`, [STALE_MINUTES]);
  const { rows } = await db.query<{ id: string; kind: BuildKind; source: BuildSource; title_enc: string; handle: string | null; link: string | null; started_at: Date; step: string | null; percent: number; step_at: Date; detail_enc: string | null; detail_at: Date | null }>(
    `SELECT b.id, b.kind, b.source, b.title_enc, m.handle, b.link, b.started_at, b.step, b.percent, b.step_at, b.detail_enc, b.detail_at
     FROM ai_builds b LEFT JOIN members m ON m.id = b.member_id
     WHERE ($2 OR b.member_id = $1) ORDER BY b.started_at DESC LIMIT 50`,
    [memberId, all],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    source: r.source,
    title: cipher.decrypt(r.title_enc, aad(r.id, 'title')),
    by: r.handle,
    link: r.link,
    startedAt: r.started_at,
    progress: r.step ? { step: r.step, percent: r.percent, since: r.step_at, detail: r.detail_enc ? cipher.decrypt(r.detail_enc, aad(r.id, 'detail')) : null, detailAt: r.detail_at } : null,
  }));
}

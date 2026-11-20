import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { forbidden, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { canApprove } from '../core/members.js';
import type { Queryable } from '../db/db.js';

/**
 * How a module or a Flow came to be what it is.
 *
 * Each version already records how it was drafted. What was missing is the trail that belongs to the artifact
 * rather than to one of its versions: the words someone typed to ask for it, what they asked for afterwards,
 * what the checks found, what an approver decided. The first of those used to live only in the progress list,
 * which is wiped, so a Flow six revisions old could no longer say what it had been asked to do.
 *
 * Entries are kept for what they are, and that decides what they may do:
 * - `user`: what a person typed. The original request and anything they said is theirs, and is given back to the
 *   AI when it drafts again — under the request in front of it, which always wins.
 * - `approved`: what an approver decided, with the version it was decided on.
 * - `evidence`: what Dittoly's own checks found. Facts about a draft, not instructions.
 * - `ai`: what an AI suggested. Kept so a person can read it; never handed back as a constraint, because a model
 *   agreeing with itself across revisions is how a wrong idea becomes a rule nobody chose.
 *
 * Nothing is rewritten: an entry is superseded or deleted, so the version drafted with it can still be explained.
 */
export type JournalKind = 'request' | 'constraint' | 'decision' | 'failure' | 'fix' | 'open' | 'suggestion';
export type JournalOrigin = 'user' | 'approved' | 'evidence' | 'ai';

export interface Artifact {
  type: 'module' | 'flow';
  /** A module's name, or a Flow's id. */
  id: string;
  /** The Flow's team; modules belong to the organization, like their versions. */
  teamId?: string | null | undefined;
}

export interface JournalEntry {
  id: string;
  kind: JournalKind;
  origin: JournalOrigin;
  text: string;
  versionRef: string | null;
  by: string | null;
  at: Date;
  supersededAt: Date | null;
}

/** What a draft is given from the journal, and what could not be read. */
export interface BuildMemory {
  text: string;
  /** The entries handed over, by id: kept with the version this draft produces. */
  used: string[];
  /** Entries this key could not read. Never silently zero. */
  unreadable: number;
  /** Entries left out to stay inside the budget (never a user constraint or the original request). */
  omitted: number;
}

const MAX_TEXT = 2000;
/** How much of the journal a draft is given, and how much of each kind. */
const BUDGET_CHARS = 4000;
const MAX_FAILURES = 3;
const MAX_DECISIONS = 2;
const MAX_LATER_REQUESTS = 3;

const aad = (id: string) => `artifact-journal:${id}:text`;

/** Keep one entry. Journalling never fails the work that produced it. */
export async function journal(
  db: Queryable,
  cipher: Cipher,
  artifact: Artifact,
  entry: { kind: JournalKind; origin: JournalOrigin; text: string; versionRef?: string | null; by?: string | null },
): Promise<string | null> {
  const text = entry.text?.trim().slice(0, MAX_TEXT);
  if (!artifact.id || !text) return null;
  try {
    const id = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
    await db.query(
      `INSERT INTO artifact_journal (id, artifact_type, artifact_id, team_id, kind, origin, text_enc, version_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, artifact.type, artifact.id, artifact.teamId ?? null, entry.kind, entry.origin, cipher.encrypt(text, aad(id)), entry.versionRef ?? null, entry.by ?? null],
    );
    return id;
  } catch (err) {
    log.info('artifact_journal_not_kept', { errorType: (err as { code?: string }).code ?? 'error' });
    return null;
  }
}

/** Everything kept for one artifact, newest last, with how many could not be read. */
export async function journalOf(db: Queryable, cipher: Cipher, artifact: Artifact, limit = 200): Promise<{ entries: JournalEntry[]; unreadable: number }> {
  const { rows } = await db.query<{
    id: string; kind: JournalKind; origin: JournalOrigin; text_enc: string; version_ref: string | null; handle: string | null; created_at: Date; superseded_at: Date | null;
  }>(
    `SELECT j.id, j.kind, j.origin, j.text_enc, j.version_ref, m.handle, j.created_at, j.superseded_at
     FROM artifact_journal j LEFT JOIN members m ON m.id = j.created_by
     WHERE j.artifact_type = $1 AND j.artifact_id = $2 AND j.deleted_at IS NULL
     ORDER BY j.created_at LIMIT $3`,
    [artifact.type, artifact.id, limit],
  );
  const entries: JournalEntry[] = [];
  let unreadable = 0;
  for (const r of rows) {
    try {
      entries.push({
        id: r.id,
        kind: r.kind,
        origin: r.origin,
        text: cipher.decrypt(r.text_enc, aad(r.id)),
        versionRef: r.version_ref,
        by: r.handle,
        at: r.created_at,
        supersededAt: r.superseded_at,
      });
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable) log.warn('artifact_journal_unreadable', { count: unreadable });
  return { entries, unreadable };
}

/**
 * What the AI is given when it drafts this artifact again, chosen the same way every time:
 * the original request, every constraint a person has given and not taken back, the newest approved decisions,
 * the newest failures, and the last few things they asked for. An AI's own suggestions are not in it.
 *
 * The request in front of the model always wins; the block says so. Nothing here is a permission: the draft goes
 * through the same checks and the same approver whatever it was told.
 */
export async function buildMemoryFor(db: Queryable, cipher: Cipher, artifact: Artifact): Promise<BuildMemory> {
  const { entries, unreadable } = await journalOf(db, cipher, artifact);
  const live = entries.filter((e) => !e.supersededAt);
  // The first thing it was asked for — unless that request was superseded, which is how it is taken back.
  const first = live.find((e) => e.kind === 'request');
  // Mandatory: what it was asked for, and what people said it must do. These are never dropped for budget.
  const must = [
    ...(first ? [{ label: 'Originally asked for', e: first }] : []),
    ...live.filter((e) => e.origin === 'user' && (e.kind === 'constraint' || e.kind === 'open')).map((e) => ({ label: e.kind === 'open' ? 'Still open' : 'Must hold', e })),
  ];
  const optional = [
    ...live.filter((e) => e.origin === 'approved' && e.kind === 'decision').slice(-MAX_DECISIONS).map((e) => ({ label: 'Approved', e })),
    ...live.filter((e) => e.origin === 'evidence' && (e.kind === 'failure' || e.kind === 'fix')).slice(-MAX_FAILURES).map((e) => ({ label: e.kind === 'fix' ? 'Fixed' : 'Last failed', e })),
    ...live.filter((e) => e.kind === 'request' && e !== first).slice(-MAX_LATER_REQUESTS).map((e) => ({ label: 'Later asked', e })),
  ];
  const line = (x: { label: string; e: JournalEntry }) => `- ${x.label}${x.e.versionRef ? ` (${x.e.versionRef})` : ''}: ${x.e.text}`;
  const lines = must.map(line);
  let used = must.map((x) => x.e.id);
  let left = BUDGET_CHARS - lines.join('\n').length;
  let omitted = 0;
  for (const x of optional) {
    const text = line(x);
    if (text.length > left) {
      omitted += 1;
      continue;
    }
    lines.push(text);
    used.push(x.e.id);
    left -= text.length + 1;
  }
  used = [...new Set(used)];
  if (!lines.length && !unreadable) return { text: '', used: [], unreadable: 0, omitted };
  const missing = unreadable
    ? `\n${unreadable} earlier entry(ies) could not be read here. Do not assume what they said: ask, or leave what they covered as it is.`
    : '';
  const head =
    '\n\nHOW THIS WAS BUILT (kept with this artifact; the request you were given now wins over anything here, and nothing here is a permission — the checks and the approver still decide):\n';
  return { text: head + lines.join('\n') + missing, used, unreadable, omitted };
}

/** A Flow's journal is its team's; a module's is the organization's, as its versions are. */
export async function assertMayReadJournal(db: Queryable, actor: Member, artifact: Artifact): Promise<void> {
  if (canApprove(actor) || artifact.type === 'module') return;
  const row = (await db.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [artifact.id])).rows[0];
  if (!row) throw notFound('flow');
  const { rowCount } = await db.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2`, [row.team_id, actor.id]);
  if (!rowCount) throw forbidden('not_in_team');
}

/** Correct it without rewriting it: the entry stops being given to drafts, and stays where it is. */
export async function supersedeEntry(db: Queryable, actor: Member, artifact: Artifact, id: string): Promise<void> {
  await assertMayReadJournal(db, actor, artifact);
  const { rowCount } = await db.query(
    `UPDATE artifact_journal SET superseded_at = now() WHERE id = $1 AND artifact_type = $2 AND artifact_id = $3 AND deleted_at IS NULL AND superseded_at IS NULL`,
    [id, artifact.type, artifact.id],
  );
  if (!rowCount) throw notFound('journal_entry');
  await audit(db, { actorId: actor.id, action: 'ai.journal_superseded', subjectType: artifact.type, subjectId: artifact.id, outcome: 'ok', relatedId: id });
}

/** Take it away for good, when they ask: it leaves the journal and the drafts that follow. */
export async function deleteEntry(db: Queryable, actor: Member, artifact: Artifact, id: string): Promise<void> {
  await assertMayReadJournal(db, actor, artifact);
  const { rowCount } = await db.query(
    `UPDATE artifact_journal SET deleted_at = now(), text_enc = '' WHERE id = $1 AND artifact_type = $2 AND artifact_id = $3 AND deleted_at IS NULL`,
    [id, artifact.type, artifact.id],
  );
  if (!rowCount) throw notFound('journal_entry');
  await audit(db, { actorId: actor.id, action: 'ai.journal_deleted', subjectType: artifact.type, subjectId: artifact.id, outcome: 'ok', relatedId: id });
}

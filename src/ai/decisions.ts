import { createHash } from 'node:crypto';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { forbidden, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { canApprove } from '../core/members.js';
import type { Queryable } from '../db/db.js';

/**
 * What a team has already told Dittoly, in their own words.
 *
 * Drafting asks what it cannot decide — which channel, which project, which branch — and the answers were kept
 * with the draft that asked. So the second Flow asked the same questions as the first, and the tenth still did.
 * These are those answers, kept for the team that gave them and handed to the next draft as what they already
 * said. They are not rules: a request that says otherwise wins, and nothing here can widen what a Flow may do —
 * every version still goes through its checks and its approver.
 *
 * Only what a person typed is kept. Nothing an AI inferred, nothing an app or a webhook sent.
 */
export interface TeamDecision {
  id: string;
  question: string;
  answer: string;
  /** The apps (module names) in play when it was answered; empty means it was about none of them. */
  about: string[];
  source: { type: 'flow' | 'module' | 'plan'; id: string | null };
  by: string | null;
  at: Date;
}

/** A team's answers as a draft gets them: what was used, and what could not be read. */
export interface DecisionsForDraft {
  text: string;
  /** The answers handed to this draft, by id — kept with the version it produces, never their words. */
  used: string[];
  /** Answers this key could not read. Never silently zero: a draft that is missing them must say so. */
  unreadable: number;
}

/** How many of a team's answers a draft is given, and how much of one is kept. */
const MAX_IN_PROMPT = 12;
const MAX_ANSWER = 300;
const MAX_QUESTION = 200;

const aad = (id: string) => `team-decision:${id}:qa`;
/** The same question asked again, however it was worded and punctuated, replaces its answer. */
const keyOf = (question: string) => createHash('sha256').update(question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).digest('hex').slice(0, 32);

/** Keep what a person answered while a draft was being made. Never what a model, an app or a webhook said. */
export async function rememberAnswers(
  db: Queryable,
  cipher: Cipher,
  where: {
    teamId: string | null | undefined;
    source: { type: 'flow' | 'module' | 'plan'; id: string | null };
    by: string | null;
    /** The apps this draft used, so the answer is offered again where those apps are, and not elsewhere. */
    about?: readonly string[];
  },
  answers: Record<string, string> | undefined,
): Promise<void> {
  if (!where.teamId || !answers) return;
  for (const [question, answer] of Object.entries(answers)) {
    const q = question.trim().slice(0, MAX_QUESTION);
    const a = answer.trim().slice(0, MAX_ANSWER);
    if (!q || !a) continue;
    try {
      const id = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      await db.query(`UPDATE team_decisions SET superseded_at = now() WHERE team_id = $1 AND question_key = $2 AND superseded_at IS NULL`, [where.teamId, keyOf(q)]);
      await db.query(
        `INSERT INTO team_decisions (id, team_id, question_key, question_enc, answer_enc, source_type, source_id, answered_by, about)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, where.teamId, keyOf(q), cipher.encrypt(q, aad(id)), cipher.encrypt(a, aad(id)), where.source.type, where.source.id, where.by, [...new Set((where.about ?? []).map((m) => m.toLowerCase()))]],
      );
    } catch (err) {
      // Remembering is a convenience: a draft never fails because of it.
      log.info('team_decision_not_kept', { errorType: (err as { code?: string }).code ?? 'error' });
    }
  }
}

/** A team's live answers, newest first. */
export async function teamDecisions(db: Queryable, cipher: Cipher, teamId: string, limit = 50): Promise<{ decisions: TeamDecision[]; unreadable: number }> {
  const { rows } = await db.query<{ id: string; question_enc: string; answer_enc: string; about: string[] | null; source_type: TeamDecision['source']['type']; source_id: string | null; handle: string | null; created_at: Date }>(
    `SELECT d.id, d.question_enc, d.answer_enc, d.about, d.source_type, d.source_id, m.handle, d.created_at
     FROM team_decisions d LEFT JOIN members m ON m.id = d.answered_by
     WHERE d.team_id = $1 AND d.superseded_at IS NULL ORDER BY d.created_at DESC LIMIT $2`,
    [teamId, limit],
  );
  const out: TeamDecision[] = [];
  let unreadable = 0;
  for (const r of rows) {
    try {
      out.push({
        id: r.id,
        question: cipher.decrypt(r.question_enc, aad(r.id)),
        answer: cipher.decrypt(r.answer_enc, aad(r.id)),
        about: r.about ?? [],
        source: { type: r.source_type, id: r.source_id },
        by: r.handle,
        at: r.created_at,
      });
    } catch {
      // Left out, but never silently: a draft missing an answer must say so, and the team must see it.
      unreadable += 1;
    }
  }
  if (unreadable) log.warn('team_decisions_unreadable', { count: unreadable });
  return { decisions: out, unreadable };
}

/**
 * The block a draft is given: what this team said, as they said it, with the request still in charge.
 *
 * Three things decide what is handed over, in this order:
 * - an answer given in THIS request wins, so the one remembered for that question is left out entirely;
 * - an answer about apps none of this request mentions is left out: "which project?" answered while building a
 *   Jira Flow is not an answer for a GitHub one;
 * - what is left is the newest few, each with the app and the draft it came from, so the model (and the person
 *   reading the draft afterwards) can tell where it came from.
 */
export async function decisionsForDraft(
  db: Queryable,
  cipher: Cipher,
  teamId: string | null | undefined,
  ctx: { request?: string; answeredNow?: Record<string, string> | undefined; about?: readonly string[] } = {},
): Promise<DecisionsForDraft> {
  if (!teamId) return { text: '', used: [], unreadable: 0 };
  const { decisions, unreadable } = await teamDecisions(db, cipher, teamId, MAX_IN_PROMPT * 4);
  const askedNow = new Set(Object.entries(ctx.answeredNow ?? {}).filter(([, a]) => a.trim()).map(([q]) => keyOf(q.trim().slice(0, MAX_QUESTION))));
  const said = `${ctx.request ?? ''} ${(ctx.about ?? []).join(' ')}`.toLowerCase();
  const live = decisions
    .filter((d) => !askedNow.has(keyOf(d.question)))
    .filter((d) => d.about.length === 0 || d.about.some((app) => said.includes(app)))
    .slice(0, MAX_IN_PROMPT);
  if (!live.length && !unreadable) return { text: '', used: [], unreadable: 0 };
  const lines = live.map((d) => `- ${d.question} ${d.answer}${d.about.length ? ` (about ${d.about.join(', ')})` : ''}`).join('\n');
  // A missing answer must not look like an answer nobody gave: say that some could not be read, so the model asks.
  const missing = unreadable
    ? `\n${unreadable} earlier answer(s) could not be read here. Do not assume what they were: ask again for anything you need from them.`
    : '';
  const head = live.length
    ? `\n\nWHAT THIS TEAM ALREADY ANSWERED (their own words, from earlier drafts; use it instead of asking again, unless THE PERSON WANTS says otherwise):\n${lines}`
    : '\n\nWHAT THIS TEAM ALREADY ANSWERED:';
  return { text: head + missing, used: live.map((d) => d.id), unreadable };
}

/** The text alone, for callers that keep no provenance. */
export async function decisionsText(db: Queryable, cipher: Cipher, teamId: string | null | undefined, ctx: Parameters<typeof decisionsForDraft>[3] = {}): Promise<string> {
  return (await decisionsForDraft(db, cipher, teamId, ctx)).text;
}

/** A team's own members may see and remove them; so may an admin or approver. */
export async function assertMaySeeDecisions(db: Queryable, actor: Member, teamId: string): Promise<void> {
  if (canApprove(actor)) return;
  const { rowCount } = await db.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2`, [teamId, actor.id]);
  if (!rowCount) throw forbidden('not_in_team');
}

export async function forgetDecision(db: Queryable, actor: Member, teamId: string, id: string): Promise<void> {
  await assertMaySeeDecisions(db, actor, teamId);
  const { rowCount } = await db.query(`UPDATE team_decisions SET superseded_at = now() WHERE id = $1 AND team_id = $2 AND superseded_at IS NULL`, [id, teamId]);
  if (!rowCount) throw notFound('decision');
  await audit(db, { actorId: actor.id, action: 'ai.team_decision_forgotten', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: id });
}

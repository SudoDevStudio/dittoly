import { z } from 'zod';
import { audit } from '../core/audit.js';
import { forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';
import { EFFORTS, type Effort } from '../runtime/ai.js';

/**
 * Which model drafts what. The organization has one model for everything (src/ai/org-model.ts), which is the
 * right default and the wrong answer often enough: a Flow that keeps coming back wrong wants the bigger model,
 * a module nobody argues about can have the cheap one, and the only way to find out is to try. So whoever drafts
 * a Flow, a Super Flow, a module or a plan can choose the model for it, the choice stays with that thing until
 * someone changes it, and a member's own choice is the default for whatever they start next.
 *
 * It decides who writes the draft, nothing else: a run's AI steps follow the model its Flow was approved with
 * (src/ai/model-changes.ts), which is a separate question with separate approvals.
 */
export const SUBJECTS = ['flow', 'module', 'plan', 'member'] as const;
export type DraftSubjectType = (typeof SUBJECTS)[number];
export interface DraftSubject {
  type: DraftSubjectType;
  id: string;
}

export interface DraftModel {
  provider?: string | undefined;
  model: string;
  effort?: Effort | undefined;
}

export const draftModelBody = z
  .object({
    provider: z.string().min(1).max(40).optional(),
    model: z.string().trim().min(1).max(200).regex(/^[\w.:\/@-]+$/, 'a model name, e.g. claude-opus-5-5'),
    effort: z.enum(EFFORTS).optional(),
  })
  .strict()
  .nullable();

/** The choice stored for one subject, if any. */
export async function storedDraftModel(db: Queryable, subject: DraftSubject): Promise<(DraftModel & { by: string | null; at: Date }) | null> {
  const r = (
    await db.query<{ provider: string | null; model: string; effort: string | null; at: Date; handle: string | null }>(
      `SELECT d.provider, d.model, d.effort, d.set_at AS at, m.handle FROM draft_models d LEFT JOIN members m ON m.id = d.set_by
       WHERE d.subject_type = $1 AND d.subject_id = $2`,
      [subject.type, subject.id],
    )
  ).rows[0];
  if (!r) return null;
  return {
    ...(r.provider ? { provider: r.provider } : {}),
    model: r.model,
    ...(EFFORTS.includes(r.effort as Effort) ? { effort: r.effort as Effort } : {}),
    by: r.handle,
    at: r.at,
  };
}

/**
 * The model to draft this subject with: its own choice, else the member's, else none (the organization's).
 * `memberId` absent (a job with nobody behind it): the subject's choice alone.
 */
export async function draftModelFor(db: Queryable, subject: DraftSubject, memberId?: string | undefined): Promise<DraftModel | null> {
  const own = await storedDraftModel(db, subject);
  if (own) return { ...(own.provider ? { provider: own.provider } : {}), model: own.model, ...(own.effort ? { effort: own.effort } : {}) };
  if (!memberId) return null;
  const mine = await storedDraftModel(db, { type: 'member', id: memberId });
  return mine ? { ...(mine.provider ? { provider: mine.provider } : {}), model: mine.model, ...(mine.effort ? { effort: mine.effort } : {}) } : null;
}

/** Whoever may draft this thing may choose its model: a Flow's owner, a module's author, a plan's, and any member for their own. */
async function assertMayChoose(db: Queryable, actor: Member, subject: DraftSubject): Promise<void> {
  if (actor.role === 'admin') return;
  if (subject.type === 'member') {
    if (subject.id !== actor.id) throw forbidden();
    return;
  }
  if (subject.type === 'flow') {
    const f = (await db.query<{ created_by: string }>(`SELECT created_by FROM flows WHERE id = $1`, [subject.id])).rows[0];
    if (!f) throw notFound('flow');
    if (f.created_by !== actor.id) throw forbidden();
    return;
  }
  if (subject.type === 'plan') {
    const p = (await db.query<{ created_by: string }>(`SELECT created_by FROM plans WHERE id = $1`, [subject.id])).rows[0];
    if (!p) throw notFound('plan');
    if (p.created_by !== actor.id) throw forbidden();
    return;
  }
  // A module: whoever wrote a version of it (anyone may draft a new version of an approved module).
  const m = (await db.query(`SELECT 1 FROM module_versions WHERE name = $1 AND created_by = $2 LIMIT 1`, [subject.id, actor.id])).rowCount;
  if (!m) throw forbidden();
}

/** Choose (or, with null, go back to the organization's model). */
export async function setDraftModel(db: Queryable, actor: Member, subject: DraftSubject, choice: DraftModel | null): Promise<void> {
  await assertMayChoose(db, actor, subject);
  if (!choice) {
    await db.query(`DELETE FROM draft_models WHERE subject_type = $1 AND subject_id = $2`, [subject.type, subject.id]);
  } else {
    await db.query(
      `INSERT INTO draft_models (subject_type, subject_id, provider, model, effort, set_by, set_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (subject_type, subject_id) DO UPDATE SET provider = $3, model = $4, effort = $5, set_by = $6, set_at = now()`,
      [subject.type, subject.id, choice.provider ?? null, choice.model, choice.effort ?? null, actor.id],
    );
  }
  await audit(db, {
    actorId: actor.id,
    action: choice ? 'ai.draft_model_set' : 'ai.draft_model_cleared',
    subjectType: subject.type === 'member' ? 'member' : subject.type,
    subjectId: subject.id,
    outcome: 'ok',
    ...(choice ? { relatedId: `${choice.provider ? `${choice.provider}:` : ''}${choice.model}`.slice(0, 200) } : {}),
  });
}

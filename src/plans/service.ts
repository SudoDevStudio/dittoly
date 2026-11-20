import { z } from 'zod';
import { extractText } from 'unpdf';
import { answersSchema, type MissingCapability } from '../ai/classify.js';
import { analyzePlan, parsePlan, type PlanAnalysis } from '../ai/plan.js';
import { chatPlan, chatText, type ChatMessage, type ChatTurn } from '../ai/plan-chat.js';
import { HomeChats } from './chats.js';
import { AiError, rawExcerpt, type AiProvider } from '../ai/provider.js';
import { withAiContext } from '../ai/metering.js';
import { draftModelFor } from '../ai/draft-model.js';
import { audit } from '../core/audit.js';
import { sha256Hex, type Cipher } from '../core/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import { getMember, type Member } from '../core/members.js';
import { notify } from '../core/notify.js';
import { getAiInstructions } from '../core/org-settings.js';
import { assertTeamMember } from '../core/teams.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { enqueue, laneKinds, type Job } from '../engine/jobs.js';
import { withProgress, type Progress } from '../core/progress.js';
import { withDocsKey } from '../ai/docs-cache.js';
import { notDraftedError, type FlowChat } from '../flows/chat.js';
import type { FlowPart } from '../ai/generate-flow.js';
import type { ModuleChat } from '../modules/chat.js';
import type { ModuleRegistry, ModuleVersion } from '../modules/registry.js';

/** Largest PDF accepted. */
export const PLAN_PDF_LIMIT = 10 * 1024 * 1024;
/** Extracted text kept per plan. */
const TEXT_LIMIT = 200_000;
/** Fewer letters and digits than this, and the PDF is taken to be scanned images. */
const MIN_TEXT = 20;

export type PlanStatus = 'reading' | 'needs_answers' | 'drafting' | 'waiting' | 'done' | 'failed' | 'cancelled';
type ModuleItemStatus = 'queued' | 'drafting' | 'in_review' | 'approved' | 'rejected' | 'needs_attention' | 'needs_answers' | 'failed' | 'cancelled';
/** split: one Flow could not do it; its parts are Flows of the plan, run by a Super Flow. */
type FlowItemStatus = 'waiting' | 'queued' | 'drafting' | 'drafted' | 'approved' | 'rejected' | 'blocked' | 'needs_answers' | 'failed' | 'cancelled' | 'split';

/** Items that have not finished: Cancel stops them (a draft the AI is writing is discarded when it ends). */
const CANCELLABLE = ['queued', 'drafting', 'waiting', 'blocked', 'needs_answers'];

interface PlanRow {
  id: string;
  created_by: string;
  team_id: string | null;
  title: string;
  file_name: string;
  status: PlanStatus;
  error: string | null;
  pages: number;
  pdf_bytes: number;
  pdf_sha256: string;
  analysis_enc: string | null;
  answers_enc: string | null;
  error_detail_enc: string | null;
  /** What the AI answered, when it could not be read at all. */
  error_raw_enc: string | null;
  created_at: Date;
  updated_at: Date;
}

/** AI errors worth trying again later: the service was busy, unreachable or failed on its side. */
const TRANSIENT = new Set(['ai_rate_limited', 'ai_unreachable', 'ai_api_error', 'ai_timeout']);
/** Times a plan adds the modules a Flow turns out to need before the Flow fails with the AI's reason. */
const MAX_NEED_ROUNDS = 2;
/** How long to wait before each new try of a plan item after such an error. */
const RETRY_DELAYS = [30_000, 120_000, 300_000];

interface ItemRow {
  id: string;
  plan_id: string;
  position: number;
  kind: 'module' | 'flow' | 'existing' | 'superflow';
  key: string;
  title: string;
  request_enc: string;
  needs: string[];
  status: ModuleItemStatus | FlowItemStatus;
  error: string | null;
  module_name: string | null;
  module_version_id: string | null;
  flow_id: string | null;
  flow_version_id: string | null;
  /** Why drafting stopped, in words (validation problems, where the AI's answer broke). */
  detail_enc: string | null;
  /** What the AI answered, when it could not be read at all: without it nobody can tell why it broke. */
  raw_enc: string | null;
  /** While drafting: the step the AI is on and how far it has come (0-100). */
  progress_step: string | null;
  progress_percent: number | null;
  /** When the current step started, and what the AI is doing within it (its latest activity, and when). */
  progress_at: Date | null;
  progress_detail_enc: string | null;
  progress_detail_at: Date | null;
  /** What the AI needs to know before it can draft this item. */
  questions_enc: string | null;
  /** The person's answers to those questions, and anything they added. */
  answers_enc: string | null;
  notes_enc: string | null;
  /**
   * extends:<module>: the next version of that approved module (migration 073); clones:<module>: a new module that
   * starts from it; from:<flow id>@<version>: a new Flow that starts from a copy of that approved Flow; null: new.
   */
  based_on: string | null;
}

type Question = { id: string; question: string; options: string[] };

const PLAN_COLS = 'id, created_by, team_id, title, file_name, status, error, pages, pdf_bytes, pdf_sha256, analysis_enc, answers_enc, error_detail_enc, error_raw_enc, created_at, updated_at';

const aad = {
  pdf: (id: string) => `plan:${id}:pdf`,
  text: (id: string) => `plan:${id}:text`,
  analysis: (id: string) => `plan:${id}:analysis`,
  answers: (id: string) => `plan:${id}:answers`,
  errorDetail: (id: string) => `plan:${id}:error-detail`,
  errorRaw: (id: string) => `plan:${id}:error-raw`,
  request: (id: string) => `plan-item:${id}:request`,
  detail: (id: string) => `plan-item:${id}:detail`,
  raw: (id: string) => `plan-item:${id}:raw`,
  questions: (id: string) => `plan-item:${id}:questions`,
  itemAnswers: (id: string) => `plan-item:${id}:answers`,
  notes: (id: string) => `plan-item:${id}:notes`,
  activity: (id: string) => `plan-item:${id}:activity`,
};

/** Notes and answers a person adds to an item: plain text, bounded. */
export const itemHelpBody = z
  .object({
    answers: answersSchema.optional(),
    notes: z.string().trim().max(4000).optional(),
  })
  .strict();

/** A message the person can act on, for the codes a plan can stop on. */
const NO_TEXT =
  'This PDF has no text to read: it looks like scanned pages. Export it again from the original document (Word, Google Docs...), or run text recognition (OCR) on it first.';

/**
 * Plans: a PDF describing what someone wants automated. The organization's AI
 * reads its text, asks what it cannot decide, and lists the modules to build
 * and the Flows to draft. Modules are drafted and sent for admin review right
 * away; each Flow is drafted when every module it needs is approved. Nothing
 * here approves or runs anything.
 */
export class Plans {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly ai: AiProvider | null,
    private readonly modules: ModuleRegistry,
    private readonly moduleChat: ModuleChat,
    private readonly flowChat: FlowChat,
  ) {
    this.chats = new HomeChats(db, cipher);
  }

  /** Home chats kept for their owner and team (src/plans/chats.ts). */
  readonly chats: HomeChats;

  // ------------------------------------------------------------------ people

  // ---------------------------------------------------------------- the home chat

  /** What the planner may reuse for this member: the approved actions, their usable approved Flows, the org's instructions. */
  private async planInputs(member: Member) {
    const catalog = (await this.flowChat.catalog({ newest: true })).map((a) => `- ${a.module} ${a.action} (${a.effect}): ${a.title}. ${a.description}`).join('\n');
    const instructions = await getAiInstructions(this.db);
    const flows = (await this.flowChat.flowCatalog(member)).map((f) => ({ flow: f.flow, name: f.name, version: f.version, description: f.description }));
    return { catalog, flows, instructions: [instructions.modules, instructions.flows].filter(Boolean).join('\n\n') || undefined };
  }

  /**
   * One turn of the home chat: the person's message is added to the chat (a new one when `chatId` is not given), the
   * AI answers with its reply and whole current plan, and both are kept (src/plans/chats.ts) so the chat can be opened
   * again by its owner and their team until it expires. Nothing is built here.
   */
  async chat(actor: Member, input: { chatId?: string | undefined; message: string; teamId?: string | undefined }): Promise<ChatTurn & { chatId: string }> {
    if (!this.ai) throw new AppError('ai_provider_not_configured', 503);
    if (input.teamId) await assertTeamMember(this.db, input.teamId, actor);
    const messages: ChatMessage[] = [...(await this.chats.history(input.chatId, actor)), { role: 'user', text: input.message }];
    const ai = this.ai;
    let turn: ChatTurn;
    try {
      const draftModel = await draftModelFor(this.db, { type: 'member', id: actor.id }, actor.id);
      turn = await withAiContext(
        { memberId: actor.id, ...(input.teamId ? { teamId: input.teamId } : {}), purpose: 'plan', ...(draftModel ? { draftModel } : {}) },
        async () => chatPlan(ai, { messages, ...(await this.planInputs(actor)) }),
      );
    } catch (err) {
      if (err instanceof AiError) throw new AppError(err.code, 502, err.detail, err.raw);
      throw err;
    }
    const chatId = await this.chats.save(actor, { chatId: input.chatId, teamId: input.teamId, messages: [...messages, { role: 'assistant', text: turn.reply }], plan: turn.plan });
    return { chatId, ...turn };
  }

  /**
   * "Build it" in a home chat: its latest plan becomes a plan here and drafting starts at once, as for a PDF plan after
   * its questions: modules are drafted and reviewed, each Flow is drafted once its modules are approved. The stored plan
   * is checked again like the AI's own answer (reused Flows must be approved ones this member can use); open questions
   * are decided as the plan assumed. Anyone who may open the chat may build it; the plan is theirs.
   */
  async fromChat(actor: Member, input: { chatId: string }) {
    if (!this.ai) throw new AppError('ai_provider_not_configured', 503);
    const chat = await this.chats.get(input.chatId, actor);
    if (chat.teamId) await assertTeamMember(this.db, chat.teamId, actor);
    const parsed = parsePlan({ planJson: JSON.stringify(chat.plan ?? null) }, (await this.planInputs(actor)).flows);
    if ('error' in parsed) throw badRequest('plan_nothing_to_build', 'The chat has no plan to build yet.');
    const analysis: PlanAnalysis = { ...parsed.plan, questions: [] };
    if (!analysis.modules.length && !analysis.flows.length && !analysis.superFlow) throw badRequest('plan_nothing_to_build', 'The plan has nothing to build yet.');
    const transcript = chatText(chat.messages);
    const title = (analysis.title || chat.title || 'Plan from the chat').slice(0, 120);
    const id = await withTx(this.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO plans (created_by, team_id, title, file_name, status, pages, pdf_sha256, pdf_bytes, pdf_enc, text_enc)
         VALUES ($1, $2, $3, 'chat', 'drafting', 0, $4, 0, '', '') RETURNING id`,
        [actor.id, chat.teamId, title, sha256Hex(transcript)],
      );
      const planId = rows[0]!.id;
      await tx.query(`UPDATE plans SET text_enc = $2 WHERE id = $1`, [planId, this.cipher.encrypt(transcript, aad.text(planId))]);
      await this.beginDrafting(tx, planId, analysis);
      await audit(tx, { actorId: actor.id, action: 'plan.created_from_chat', subjectType: 'plan', subjectId: planId, outcome: 'ok', relatedId: input.chatId });
      return planId;
    });
    await this.chats.markBuilt(input.chatId, id);
    await this.settle(id);
    return this.get(id, actor);
  }

  async upload(actor: Member, input: { fileName: string; pdf: Buffer; title?: string | undefined; teamId?: string | undefined }) {
    if (!this.ai) throw new AppError('ai_provider_not_configured', 503);
    if (input.pdf.length === 0 || input.pdf.length > PLAN_PDF_LIMIT) throw badRequest('pdf_too_large', 'The PDF must be at most 10 MB.');
    if (input.pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('not_a_pdf', 'The file is not a PDF.');
    if (input.teamId) await assertTeamMember(this.db, input.teamId, actor);
    let text: string;
    let pages: number;
    try {
      // unpdf takes ownership of the bytes it is given, so it gets a copy.
      const out = await extractText(new Uint8Array(input.pdf), { mergePages: true });
      text = out.text;
      pages = out.totalPages;
    } catch (err) {
      log.warn('plan_pdf_unreadable', { errorType: errorType(err) });
      throw badRequest('pdf_unreadable', 'The PDF could not be read. It may be damaged or password-protected.');
    }
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length < MIN_TEXT) throw new AppError('pdf_has_no_text', 422, NO_TEXT);
    const fileName = input.fileName.replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'plan.pdf';
    const title = (input.title?.trim() || fileName.replace(/\.pdf$/i, '')).slice(0, 120);
    const id = await withTx(this.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO plans (created_by, team_id, title, file_name, status, pages, pdf_sha256, pdf_bytes, pdf_enc, text_enc)
         VALUES ($1, $2, $3, $4, 'reading', $5, $6, $7, '', '') RETURNING id`,
        [actor.id, input.teamId ?? null, title, fileName, pages, sha256Hex(input.pdf), input.pdf.length],
      );
      const planId = rows[0]!.id;
      // The associated data binds each value to its plan, so the id has to exist first.
      await tx.query(`UPDATE plans SET pdf_enc = $2, text_enc = $3 WHERE id = $1`, [
        planId,
        this.cipher.encrypt(input.pdf.toString('base64'), aad.pdf(planId)),
        this.cipher.encrypt(text.slice(0, TEXT_LIMIT), aad.text(planId)),
      ]);
      await enqueue(tx, 'plan_analyze', { planId });
      await audit(tx, { actorId: actor.id, action: 'plan.uploaded', subjectType: 'plan', subjectId: planId, outcome: 'ok' });
      return planId;
    });
    return this.get(id, actor);
  }

  /** Your plans; admins see everyone's (they review what plans draft). */
  async list(actor: Member) {
    const { rows } = await this.db.query<PlanRow & { handle: string; items: number; open: number }>(
      `SELECT p.id, p.title, p.file_name, p.status, p.error, p.pages, p.created_at, p.updated_at, m.handle,
              (SELECT count(*)::int FROM plan_items i WHERE i.plan_id = p.id) AS items,
              (SELECT count(*)::int FROM plan_items i WHERE i.plan_id = p.id AND i.status NOT IN ('approved', 'drafted')) AS open
       FROM plans p JOIN members m ON m.id = p.created_by
       WHERE p.created_by = $1 OR $2
       ORDER BY p.created_at DESC LIMIT 200`,
      [actor.id, actor.role === 'admin'],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      fileName: r.file_name,
      status: r.status,
      error: r.error,
      pages: r.pages,
      createdBy: r.handle,
      items: r.items,
      open: r.open,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * What the AI is building for this person now (their plans' items being drafted, waiting or just drafted in the
   * last half hour), for the live build panel: step, percent and, once drafted, the module or Flow version to show.
   */
  async live(actor: Member, opts: { all?: boolean; activeOnly?: boolean } = {}) {
    const { rows } = await this.db.query<Pick<ItemRow, 'id' | 'plan_id' | 'kind' | 'title' | 'status' | 'progress_step' | 'progress_percent' | 'progress_at' | 'progress_detail_enc' | 'progress_detail_at' | 'module_version_id' | 'flow_version_id'> & { plan_title: string; updated_at: Date; handle: string | null }>(
      `SELECT i.id, i.plan_id, p.title AS plan_title, i.kind, i.title, i.status, i.progress_step, i.progress_percent, i.progress_at, i.progress_detail_enc, i.progress_detail_at, i.module_version_id, i.flow_version_id, i.updated_at, m.handle
       FROM plan_items i JOIN plans p ON p.id = i.plan_id LEFT JOIN members m ON m.id = p.created_by
       WHERE ($2 OR p.created_by = $1) AND i.kind <> 'existing'
         AND (i.status IN ('queued', 'drafting') OR (NOT $3 AND i.updated_at > now() - interval '30 minutes'))
       ORDER BY i.updated_at DESC LIMIT 50`,
      [actor.id, opts.all === true, opts.activeOnly === true],
    );
    return rows.map((r) => ({
      itemId: r.id,
      planId: r.plan_id,
      planTitle: r.plan_title,
      kind: r.kind,
      title: r.title,
      status: r.status,
      progress: this.progressOf(r),
      moduleVersionId: r.module_version_id,
      flowVersionId: r.flow_version_id,
      updatedAt: r.updated_at,
      by: r.handle,
    }));
  }

  async get(id: string, actor: Member) {
    const plan = await this.load(this.db, id, actor);
    const analysis = this.analysis(plan);
    const items = await this.items(this.db, id);
    const by = (await this.db.query<{ handle: string }>(`SELECT handle FROM members WHERE id = $1`, [plan.created_by])).rows[0]?.handle ?? null;
    const queue = await this.queueOf(items.filter((i) => i.status === 'queued').map((i) => i.id));
    // A plan built from a home chat goes back to that chat (while it is kept), not to a PDF it does not have.
    const chatId = plan.file_name === 'chat' && plan.pdf_bytes === 0
      ? ((await this.db.query<{ id: string }>(`SELECT id FROM home_chats WHERE plan_id = $1 AND expires_at > now() ORDER BY updated_at DESC LIMIT 1`, [id])).rows[0]?.id ?? null)
      : null;
    return {
      id: plan.id,
      title: plan.title,
      fileName: plan.file_name,
      status: plan.status,
      error: plan.error,
      errorDetail: plan.error_detail_enc ? this.cipher.decrypt(plan.error_detail_enc, aad.errorDetail(plan.id)) : null,
      aiRaw: plan.error_raw_enc ? this.cipher.decrypt(plan.error_raw_enc, aad.errorRaw(plan.id)) : null,
      pages: plan.pages,
      pdfBytes: plan.pdf_bytes,
      pdfSha256: plan.pdf_sha256,
      fromChat: plan.file_name === 'chat' && plan.pdf_bytes === 0,
      chatId,
      teamId: plan.team_id,
      createdBy: by,
      mine: plan.created_by === actor.id,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      summary: analysis?.summary ?? null,
      questions: plan.status === 'needs_answers' ? (analysis?.questions ?? []) : [],
      answers: this.answers(plan) ?? null,
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        key: i.key,
        title: i.title,
        request: this.cipher.decrypt(i.request_enc, aad.request(i.id)),
        needs: i.needs,
        status: i.status,
        error: i.error,
        moduleName: i.module_name,
        basedOn: i.based_on,
        moduleVersionId: i.module_version_id,
        flowId: i.flow_id,
        flowVersionId: i.flow_version_id,
        detail: i.detail_enc ? this.cipher.decrypt(i.detail_enc, aad.detail(i.id)) : null,
        aiRaw: i.raw_enc ? this.cipher.decrypt(i.raw_enc, aad.raw(i.id)) : null,
        questions: i.status === 'needs_answers' && i.questions_enc ? (this.cipher.decryptJson(i.questions_enc, aad.questions(i.id)) as Question[]) : [],
        notes: i.notes_enc ? this.cipher.decrypt(i.notes_enc, aad.notes(i.id)) : null,
        progress: this.progressOf(i),
        queue: queue.get(i.id) ?? null,
      })),
    };
  }

  /** While drafting: the step, how far, since when, and what the AI is doing within it right now. */
  private progressOf(i: Pick<ItemRow, 'id' | 'status' | 'progress_step' | 'progress_percent' | 'progress_at' | 'progress_detail_enc' | 'progress_detail_at'>) {
    if (i.status !== 'drafting' || !i.progress_step) return null;
    let detail: string | null = null;
    try {
      detail = i.progress_detail_enc ? this.cipher.decrypt(i.progress_detail_enc, aad.activity(i.id)) : null;
    } catch {
      // Only a hint of what the AI is doing.
    }
    return { step: i.progress_step, percent: i.progress_percent ?? 0, since: i.progress_at, detail, detailAt: detail ? i.progress_detail_at : null };
  }

  async pdf(id: string, actor: Member): Promise<{ fileName: string; data: Buffer }> {
    const plan = await this.load(this.db, id, actor);
    const { rows } = await this.db.query<{ pdf_enc: string }>(`SELECT pdf_enc FROM plans WHERE id = $1`, [id]);
    // A plan built from the home chat has no document.
    if (!rows[0]?.pdf_enc) throw notFound('pdf');
    return { fileName: plan.file_name, data: Buffer.from(this.cipher.decrypt(rows[0]!.pdf_enc, aad.pdf(id)), 'base64') };
  }

  /** Answers (even none) let the AI finish the breakdown; then drafting starts. */
  async answer(id: string, actor: Member, answers: Record<string, string>) {
    await withTx(this.db, async (tx) => {
      const plan = await this.load(tx, id, actor, true);
      if (plan.created_by !== actor.id) throw forbidden('only_the_uploader_answers');
      if (plan.status !== 'needs_answers') throw conflict('plan_not_waiting_for_answers');
      await tx.query(`UPDATE plans SET answers_enc = $2, status = 'reading', updated_at = now() WHERE id = $1`, [id, this.cipher.encryptJson(answers, aad.answers(id))]);
      await enqueue(tx, 'plan_analyze', { planId: id });
    });
    return this.get(id, actor);
  }

  /**
   * Draft a module or Flow again: after drafting failed, or once the person answered what the AI
   * asked. Their answers and notes go to the AI with the item's request, now and on later tries.
   */
  async retryItem(id: string, itemId: string, actor: Member, help: z.infer<typeof itemHelpBody> = {}) {
    await withTx(this.db, async (tx) => {
      const plan = await this.load(tx, id, actor, true);
      if (plan.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
      const item = (await tx.query<ItemRow>(`SELECT * FROM plan_items WHERE id = $1 AND plan_id = $2 FOR UPDATE`, [itemId, id])).rows[0];
      if (!item || !['failed', 'needs_answers', 'cancelled'].includes(item.status)) throw conflict('plan_item_not_failed');
      const answers = { ...(item.answers_enc ? (this.cipher.decryptJson(item.answers_enc, aad.itemAnswers(itemId)) as Record<string, string>) : {}), ...(help.answers ?? {}) };
      // A cancelled Flow waits for its modules again; anything else is drafted now.
      const waits = item.status === 'cancelled' && item.kind !== 'module';
      await tx.query(
        `UPDATE plan_items SET status = $5, error = NULL, detail_enc = NULL, questions_enc = NULL, answers_enc = $3, notes_enc = COALESCE($4, notes_enc), updated_at = now() WHERE id = $1 AND plan_id = $2`,
        [itemId, id, Object.keys(answers).length ? this.cipher.encryptJson(answers, aad.itemAnswers(itemId)) : null, help.notes ? this.cipher.encrypt(help.notes, aad.notes(itemId)) : null, waits ? 'waiting' : 'queued'],
      );
      await tx.query(`UPDATE plans SET status = 'drafting', error = NULL, updated_at = now() WHERE id = $1`, [id]);
      if (!waits) await enqueue(tx, 'plan_item', { itemId });
    });
    // Flows blocked by this item wait for it again.
    await this.settle(id);
    return this.get(id, actor);
  }

  /** Removes the details the person added to an item (they did not help); the next try drafts without them. */
  async clearNotes(id: string, itemId: string, actor: Member) {
    await withTx(this.db, async (tx) => {
      const plan = await this.load(tx, id, actor, true);
      if (plan.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
      const { rowCount } = await tx.query(`UPDATE plan_items SET notes_enc = NULL, updated_at = now() WHERE id = $1 AND plan_id = $2`, [itemId, id]);
      if (!rowCount) throw notFound('plan_item');
    });
    return this.get(id, actor);
  }

  /** Stops one module or Flow that has not finished. A draft the AI is writing is discarded when it ends. */
  async cancelItem(id: string, itemId: string, actor: Member) {
    await withTx(this.db, async (tx) => {
      const plan = await this.load(tx, id, actor, true);
      if (plan.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
      const { rowCount } = await tx.query(
        `UPDATE plan_items SET status = 'cancelled', error = NULL, updated_at = now() WHERE id = $1 AND plan_id = $2 AND status = ANY($3)`,
        [itemId, id, CANCELLABLE],
      );
      if (!rowCount) throw conflict('plan_item_not_cancellable');
      await audit(tx, { actorId: actor.id, action: 'plan.item_cancelled', subjectType: 'plan', subjectId: id, outcome: 'ok' });
    });
    await this.settle(id);
    return this.get(id, actor);
  }

  /** Stops the whole plan: reading it, its questions, and every module and Flow not yet finished. */
  async cancel(id: string, actor: Member) {
    await withTx(this.db, async (tx) => {
      const plan = await this.load(tx, id, actor, true);
      if (plan.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
      if (['done', 'failed', 'cancelled'].includes(plan.status)) throw conflict('plan_not_cancellable');
      await tx.query(`UPDATE plan_items SET status = 'cancelled', error = NULL, updated_at = now() WHERE plan_id = $1 AND status = ANY($2)`, [id, CANCELLABLE]);
      await tx.query(`UPDATE plans SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
      await audit(tx, { actorId: actor.id, action: 'plan.cancelled', subjectType: 'plan', subjectId: id, outcome: 'ok' });
    });
    return this.get(id, actor);
  }

  /** Read the plan again (after it failed). */
  async retry(id: string, actor: Member) {
    await withTx(this.db, async (tx) => {
      const plan = await this.load(tx, id, actor, true);
      if (plan.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
      // A plan cancelled before anything was drafted is read again; one with drafts resumes item by item.
      const drafted = plan.status === 'cancelled' && (await tx.query(`SELECT 1 FROM plan_items WHERE plan_id = $1 LIMIT 1`, [id])).rowCount;
      if (!(plan.status === 'failed' || (plan.status === 'cancelled' && !drafted))) throw conflict('plan_not_failed');
      await tx.query(`UPDATE plans SET status = 'reading', error = NULL, error_detail_enc = NULL, updated_at = now() WHERE id = $1`, [id]);
      await enqueue(tx, 'plan_analyze', { planId: id });
    });
    return this.get(id, actor);
  }

  /** Deletes the plan and its PDF. Modules and Flows it drafted stay. */
  async remove(id: string, actor: Member): Promise<void> {
    const plan = await this.load(this.db, id, actor);
    if (plan.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
    await this.db.query(`DELETE FROM plans WHERE id = $1`, [id]);
    await audit(this.db, { actorId: actor.id, action: 'plan.deleted', subjectType: 'plan', subjectId: id, outcome: 'ok' });
  }

  // ------------------------------------------------------------------ jobs

  async handleJob(job: Job, heartbeat: () => Promise<void>): Promise<void> {
    // Drafting can take minutes; keep the job's lease while it does.
    const timer = setInterval(() => void heartbeat().catch(() => undefined), 60_000);
    try {
      // AI use while drafting counts for the person who uploaded the plan, in the plan's team.
      const owner = (await this.db.query<{ created_by: string; team_id: string | null }>(
        `SELECT p.created_by, p.team_id FROM plans p WHERE p.id = $1 OR p.id = (SELECT plan_id FROM plan_items WHERE id = $2)`,
        [job.payload.planId ?? null, job.payload.itemId ?? null],
      )).rows[0];
      // The plan's own model where it has one, else the member's who uploaded it (src/ai/draft-model.ts).
      const planId = job.payload.planId ?? (job.payload.itemId ? (await this.db.query<{ plan_id: string }>(`SELECT plan_id FROM plan_items WHERE id = $1`, [job.payload.itemId])).rows[0]?.plan_id : undefined);
      const draftModel = planId ? await draftModelFor(this.db, { type: 'plan', id: planId }, owner?.created_by) : null;
      const ctx = { memberId: owner?.created_by, teamId: owner?.team_id ?? undefined, purpose: 'plan' as const, ...(draftModel ? { draftModel } : {}) };
      if (job.kind === 'plan_analyze' && job.payload.planId) await withAiContext(ctx, () => this.analyze(job.payload.planId!));
      else if (job.kind === 'plan_item' && job.payload.itemId) await withAiContext(ctx, () => this.draftItem(job.payload.itemId!, Number(job.payload.tries ?? 0) || 0));
      else if (job.kind === 'module_decided' && job.payload.moduleVersionId) await this.moduleDecided(job.payload.moduleVersionId);
      else if (job.kind === 'flow_decided' && job.payload.flowVersionId) await this.flowDecided(job.payload.flowVersionId);
    } finally {
      clearInterval(timer);
    }
  }

  private async analyze(planId: string): Promise<void> {
    const plan = (await this.db.query<PlanRow & { text_enc: string }>(`SELECT ${PLAN_COLS}, text_enc FROM plans WHERE id = $1`, [planId])).rows[0];
    if (!plan || plan.status !== 'reading') return;
    if (!this.ai) return this.fail(plan, 'ai_provider_not_configured');
    const answers = this.answers(plan);
    let analysis: PlanAnalysis;
    try {
      const catalog = await this.flowChat.catalog({ newest: true });
      const brief = catalog.map((a) => `- ${a.module} ${a.action} (${a.effect}): ${a.title}. ${a.description}`).join('\n');
      const instructions = await getAiInstructions(this.db);
      const both = [instructions.modules, instructions.flows].filter(Boolean).join('\n\n') || undefined;
      // Approved Flows the uploader can use: the planner reuses them instead of rebuilding them.
      const uploader = await getMember(this.db, plan.created_by);
      const flows = uploader ? (await this.flowChat.flowCatalog(uploader)).map((f) => ({ flow: f.flow, name: f.name, version: f.version, description: f.description })) : [];
      analysis = await analyzePlan(this.ai, { text: this.cipher.decrypt(plan.text_enc, aad.text(planId)), catalog: brief, flows, instructions: both, answers });
    } catch (err) {
      return this.fail(
        plan,
        err instanceof AiError || err instanceof AppError ? (err as { code: string }).code : 'plan_analysis_failed',
        err instanceof AiError ? err.detail : undefined,
        err instanceof AiError ? err.raw : undefined,
      );
    }
    await withTx(this.db, async (tx) => {
      const locked = (await tx.query<{ status: string }>(`SELECT status FROM plans WHERE id = $1 FOR UPDATE`, [planId])).rows[0];
      if (locked?.status !== 'reading') return;
      const analysisEnc = this.cipher.encryptJson(analysis, aad.analysis(planId));
      if (analysis.questions.length > 0 && answers === undefined) {
        await tx.query(`UPDATE plans SET analysis_enc = $2, status = 'needs_answers', updated_at = now() WHERE id = $1`, [planId, analysisEnc]);
        await notify(tx, plan.created_by, 'plan_needs_answers', { planId });
        return;
      }
      if (analysis.modules.length === 0 && analysis.flows.length === 0 && !analysis.superFlow) {
        await tx.query(`UPDATE plans SET analysis_enc = $2, status = 'failed', error = 'plan_nothing_to_build', updated_at = now() WHERE id = $1`, [planId, analysisEnc]);
        await notify(tx, plan.created_by, 'plan_failed', { planId });
        return;
      }
      await this.beginDrafting(tx, planId, analysis);
    });
    await this.settle(planId);
  }

  /** The plan's breakdown is decided: store it and queue its modules; Flows wait for what they need (settle). */
  private async beginDrafting(tx: Queryable, planId: string, analysis: PlanAnalysis): Promise<void> {
    {
      const analysisEnc = this.cipher.encryptJson(analysis, aad.analysis(planId));
      await tx.query(`UPDATE plans SET analysis_enc = $2, status = 'drafting', updated_at = now() WHERE id = $1`, [planId, analysisEnc]);
      let position = 0;
      for (const m of analysis.modules) {
        await this.insertItem(tx, planId, position++, 'module', m.key, m.title, m.request, [], 'queued', m.clones ? `clones:${m.clones}` : m.extends ? `extends:${m.extends}` : null);
      }
      for (const f of analysis.flows) await this.insertItem(tx, planId, position++, 'flow', f.key, f.title, f.request, f.needs, 'waiting', f.from ? `from:${f.from.flow}@${f.from.version}` : null);
      for (const x of analysis.reuse) {
        const id = await this.insertItem(tx, planId, position++, 'existing', x.key, x.title, x.why || 'Already does this part of the plan.', [], 'approved');
        const v = (await tx.query<{ id: string }>(`SELECT id FROM flow_versions WHERE flow_id = $1 AND version = $2`, [x.flow, x.version])).rows[0];
        await tx.query(`UPDATE plan_items SET flow_id = $2, flow_version_id = $3 WHERE id = $1`, [id, x.flow, v?.id ?? null]);
      }
      if (analysis.superFlow) {
        await this.insertItem(tx, planId, position++, 'superflow', 'super_flow', analysis.superFlow.title, analysis.superFlow.request, analysis.superFlow.uses, 'waiting');
      }
    }
  }

  private async insertItem(tx: Queryable, planId: string, position: number, kind: ItemRow['kind'], key: string, title: string, request: string, needs: string[], status: string, basedOn: string | null = null): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO plan_items (plan_id, position, kind, key, title, request_enc, needs, status, based_on) VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8) RETURNING id`,
      [planId, position, kind, key, title, needs, status, basedOn],
    );
    const id = rows[0]!.id;
    await tx.query(`UPDATE plan_items SET request_enc = $2 WHERE id = $1`, [id, this.cipher.encrypt(request, aad.request(id))]);
    if (status === 'queued') await enqueue(tx, 'plan_item', { itemId: id });
    return id;
  }

  private async draftItem(itemId: string, tries = 0): Promise<void> {
    // A job runs again only after its lease ran out, so an item still "drafting" was left by a stopped worker.
    const item = (await this.db.query<ItemRow>(
      `UPDATE plan_items SET status = 'drafting', updated_at = now() WHERE id = $1 AND status IN ('queued', 'drafting') RETURNING *`,
      [itemId],
    )).rows[0];
    if (!item) return;
    const plan = (await this.db.query<PlanRow>(`SELECT ${PLAN_COLS} FROM plans WHERE id = $1`, [item.plan_id])).rows[0]!;
    const actor = await getMember(this.db, plan.created_by);
    const disabled = (await this.db.query<{ disabled: boolean }>(`SELECT disabled FROM members WHERE id = $1`, [plan.created_by])).rows[0]?.disabled;
    if (!actor || disabled) {
      await this.setItem(item.id, { status: 'failed', error: 'uploader_disabled' });
      return this.settle(plan.id);
    }
    const notes = item.notes_enc ? this.cipher.decrypt(item.notes_enc, aad.notes(item.id)) : '';
    const request = `${this.cipher.decrypt(item.request_enc, aad.request(item.id))}\n\n(Part of the plan "${plan.title}".)${notes ? `\n\nMore details from the person:\n${notes}` : ''}`;
    // Answers given on the plan apply to everything drafted from it, with those given for this item.
    const answers = { ...(this.answers(plan) ?? {}), ...(item.answers_enc ? (this.cipher.decryptJson(item.answers_enc, aad.itemAnswers(item.id)) as Record<string, string>) : {}) };
    // The AI asks only what those answers leave open.
    const ask = async (questions: Question[]) => {
      const { rowCount } = await this.db.query(`UPDATE plan_items SET status = 'needs_answers', questions_enc = $2, updated_at = now() WHERE id = $1 AND status = 'drafting'`, [item.id, this.cipher.encryptJson(questions, aad.questions(item.id))]);
      if (rowCount) await notify(this.db, plan.created_by, 'plan_needs_attention', { planId: plan.id });
    };
    // Each step the AI reaches is kept (never going back), and what the AI is doing within it (a web search, a
    // thought). At most one write every two seconds; the latest of each is written when that wait ends, never lost.
    let shown = -1;
    let step: Progress | undefined;
    let detail: string | undefined;
    let at = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keep = () => {
      timer = undefined;
      at = Date.now();
      const p = step;
      const enc = detail !== undefined ? this.cipher.encrypt(detail, aad.activity(item.id)) : null;
      step = undefined;
      detail = undefined;
      // One write: a new step starts its clock and drops the last step's activity; an activity keeps the step.
      void this.db
        .query(
          `UPDATE plan_items SET
             progress_step = COALESCE($2, progress_step), progress_percent = COALESCE($3::smallint, progress_percent),
             progress_at = CASE WHEN $2::text IS NULL THEN progress_at ELSE now() END,
             progress_detail_enc = CASE WHEN $4::text IS NOT NULL THEN $4 WHEN $2::text IS NOT NULL THEN NULL ELSE progress_detail_enc END,
             progress_detail_at = CASE WHEN $4::text IS NOT NULL THEN now() WHEN $2::text IS NOT NULL THEN NULL ELSE progress_detail_at END
           WHERE id = $1 AND status = 'drafting'`,
          [item.id, p?.step ?? null, p?.percent ?? null, enc],
        )
        .catch(() => undefined);
    };
    const report = (p: Progress) => {
      if (p.detail !== undefined) detail = p.detail;
      else if (p.percent > shown) {
        shown = p.percent;
        step = { step: p.step, percent: p.percent };
        detail = undefined;
      } else return;
      timer ??= setTimeout(keep, Math.max(0, 2000 - (Date.now() - at)));
    };
    await this.db.query(`UPDATE plan_items SET progress_step = 'starting', progress_percent = 1, progress_at = now(), progress_detail_enc = NULL, progress_detail_at = NULL WHERE id = $1`, [item.id]);
    try {
      // The docs the AI finds are kept for this item: its retries read them instead of searching again.
      await withProgress(report, () => withDocsKey(`plan-item:${item.id}`, () => this.drafted(plan, item, actor, request, answers, ask)));
    } catch (err) {
      await this.draftFailed(plan, item, tries, err);
      return;
    } finally {
      if (timer) clearTimeout(timer);
      await this.db.query(`UPDATE plan_items SET progress_step = NULL, progress_percent = NULL, progress_at = NULL, progress_detail_enc = NULL, progress_detail_at = NULL WHERE id = $1`, [item.id]);
    }
    await this.settle(plan.id);
  }

  /** Drafts the item; returns once it is stored (or the AI asked, or the Flow waits for modules the plan now builds). */
  private async drafted(plan: PlanRow, item: ItemRow, actor: Member, request: string, answers: Record<string, string>, ask: (q: Question[]) => Promise<void>): Promise<void> {
    if (item.kind === 'module') {
      const extend = item.based_on?.match(/^extends:(.+)$/)?.[1];
      const clone = item.based_on?.match(/^clones:(.+)$/)?.[1];
      // The next version of the approved module, written from its manifest and code, keeping every action. Or a new
      // module that starts from one (a clone), named after this item; the original is left as it is.
      let draft: ModuleVersion | null = clone
        ? await this.moduleChat.clone(clone, request.slice(0, 4000), actor, item.key.replace(/_/g, '-')).catch((err: unknown) => {
            if (err instanceof AppError && (err.code === 'module_not_approved' || err.code === 'module_not_found')) return null;
            throw err;
          })
        : extend
        ? await this.moduleChat.extend(extend, request.slice(0, 2000), actor).catch((err: unknown) => {
            if (err instanceof AppError && (err.code === 'module_not_approved' || err.code === 'module_not_found')) return null;
            throw err;
          })
        : null;
      if (!draft) {
        const out = await this.moduleChat.generate(request, actor, undefined, answers);
        if (!('draft' in out)) return ask(out.questions.questions);
        draft = out.draft;
      }
      // Cancelled while the AI was writing it: the draft stays a draft and is not sent for review.
      if (draft.validationReport?.passed) {
        if (await this.setItem(item.id, { status: 'in_review', module_name: draft.name, module_version_id: draft.id }, true)) await this.modules.submit(draft.id, actor);
      } else if (await this.setItem(item.id, { status: 'needs_attention', error: 'validation_failed', module_name: draft.name, module_version_id: draft.id }, true)) {
        await notify(this.db, plan.created_by, 'plan_needs_attention', { planId: plan.id });
      }
    } else {
      let text = `${request}${await this.modulesBuiltFor(item)}`;
      if (item.kind === 'superflow') {
        // Name the exact Flows and versions to connect: each was approved on its own.
        const all = await this.items(this.db, plan.id);
        const lines = [];
        for (const key of item.needs) {
          const it = all.find((x) => x.key === key && (x.kind === 'flow' || x.kind === 'existing'));
          const v = it?.flow_version_id ? (await this.db.query<{ version: number; name: string }>(`SELECT v.version, f.name FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE v.id = $1`, [it.flow_version_id])).rows[0] : null;
          if (it && v) lines.push(`- "${v.name}" flow ${it.flow_id} version ${v.version}`);
        }
        text = `Build a Super Flow that runs these approved Flows with flow steps (pinned to exactly these versions):\n${lines.join('\n')}\n\n${request}`;
      }
      // A new Flow that starts from a copy of an approved one (which stays as it is).
      const from = item.based_on?.match(/^from:([0-9a-f-]{36})@(\d+)$/);
      const out = await this.flowChat.draft(text, actor, answers, plan.team_id ?? undefined, undefined, undefined, from ? { flowId: from[1]!, version: Number(from[2]) } : undefined);
      if ('cannotDraft' in out) {
        // The Flow needs actions no approved module has: the plan builds them (adding to the module the AI named)
        // and the Flow waits for them, instead of stopping for the person to do it by hand. Once per Flow.
        if (item.kind === 'flow' && (await this.addMissingModules(plan, item, out.cannotDraft.missing))) return;
        // More than one Flow can do: the parts become Flows of the plan, and a Super Flow runs them together.
        if (item.kind === 'flow' && out.cannotDraft.split?.length && (await this.splitFlow(plan, item, out.cannotDraft.reason, out.cannotDraft.split))) return;
        throw notDraftedError(out.cannotDraft);
      }
      if (!('version' in out)) return ask(out.questions.questions);
      // Cancelled while the AI was writing it: the item stays cancelled; the Flow it made is linked so it can be found.
      if (!(await this.setItem(item.id, { status: 'drafted', flow_id: out.version.flowId, flow_version_id: out.version.id }, true))) {
        await this.setItem(item.id, { flow_id: out.version.flowId, flow_version_id: out.version.id });
      }
    }
  }

  /** A busy AI is tried again later; anything else fails the item with what went wrong. */
  private async draftFailed(plan: PlanRow, item: ItemRow, tries: number, err: unknown): Promise<void> {
    const code = err instanceof AppError || err instanceof AiError ? (err as { code: string }).code : 'drafting_failed';
    // A busy, unreachable or failing AI service is tried again later (three times, waiting longer each time).
    if (TRANSIENT.has(code) && tries < RETRY_DELAYS.length) {
      log.info('plan_item_retry', { attempt: tries + 1, errorType: code });
      const { rowCount } = await this.db.query(`UPDATE plan_items SET status = 'queued', updated_at = now() WHERE id = $1 AND status = 'drafting'`, [item.id]);
      if (rowCount) await enqueue(this.db, 'plan_item', { itemId: item.id, tries: String(tries + 1) }, new Date(Date.now() + RETRY_DELAYS[tries]!));
      return;
    }
    // The specifics (validation problems, where the AI's answer broke) are shown with the item.
    const detail = err instanceof AppError && err.message !== code ? err.message : err instanceof AiError ? err.detail : undefined;
    // An answer that could not be read is kept as it came: the words alone never say where it broke.
    const raw = err instanceof AiError || err instanceof AppError ? err.raw : undefined;
    log.warn('plan_item_failed', { errorType: errorType(err) });
    if (
      await this.setItem(
        item.id,
        {
          status: 'failed',
          error: code,
          detail_enc: detail ? this.cipher.encrypt(detail.slice(0, 2000), aad.detail(item.id)) : null,
          raw_enc: raw ? this.cipher.encrypt(rawExcerpt(raw), aad.raw(item.id)) : null,
        },
        true,
      )
    ) {
      await notify(this.db, plan.created_by, 'plan_needs_attention', { planId: plan.id });
    }
    await this.settle(plan.id);
  }

  /**
   * A plan's Flow that one Flow cannot do (two starts, a wait of days, separate owners, too many steps): its parts become
   * Flows of the plan with the same modules, and a Super Flow runs them (the plan's own, which then runs the parts in
   * its place, or a new one). The Flow itself is marked split. Once per Flow: a part is never split again.
   */
  private async splitFlow(plan: PlanRow, flow: ItemRow, reason: string, parts: FlowPart[]): Promise<boolean> {
    if (flow.key.includes('_part_')) return false;
    return withTx(this.db, async (tx) => {
      const items = await this.items(tx, plan.id);
      const current = items.find((i) => i.id === flow.id);
      if (!current || current.status !== 'drafting') return false;
      let position = Math.max(...items.map((i) => i.position)) + 1;
      const keys: string[] = [];
      for (const [n, part] of parts.entries()) {
        const key = `${flow.key.slice(0, 32)}_part_${n + 1}`;
        await this.insertItem(tx, plan.id, position++, 'flow', key, part.title, part.request, flow.needs, 'waiting');
        keys.push(key);
      }
      const order = parts.map((p, n) => `${n + 1}. ${p.title}`).join('\n');
      const sup = items.find((i) => i.kind === 'superflow' && i.needs.includes(flow.key));
      if (sup) {
        await tx.query(`UPDATE plan_items SET needs = $2, updated_at = now() WHERE id = $1`, [sup.id, sup.needs.flatMap((k) => (k === flow.key ? keys : [k]))]);
      } else {
        const request = `${this.cipher.decrypt(flow.request_enc, aad.request(flow.id))}\n\nOne Flow could not do all of it (${reason.slice(0, 500)}), so it is built as these Flows; run them in this order, each passing on what the next needs:\n${order}`;
        await this.insertItem(tx, plan.id, position++, 'superflow', `${flow.key.slice(0, 32)}_super`, `${flow.title} (Super Flow)`.slice(0, 120), request.slice(0, 4000), keys, 'waiting');
      }
      await tx.query(`UPDATE plan_items SET status = 'split', error = NULL, detail_enc = NULL, updated_at = now() WHERE id = $1`, [flow.id]);
      log.info('plan_flow_split', { count: keys.length });
      return true;
    });
  }

  /**
   * The modules this plan built for this Flow, named with the version and actions they ended up with. Without this,
   * a Flow drafted again after its modules were approved does not know they exist: the AI asks for the same missing
   * capability a second time and the Flow fails, although what it needs is right there in the catalog.
   */
  private async modulesBuiltFor(item: ItemRow): Promise<string> {
    if (item.kind !== 'flow' || !item.needs.length) return '';
    const built = (await this.items(this.db, item.plan_id)).filter((i) => i.kind === 'module' && item.needs.includes(i.key) && i.module_name);
    if (!built.length) return '';
    // The newest approved version of each, as the drafting catalog sees it (list() is ordered by name and creation).
    const approved = await this.modules.list();
    const newest = new Map(approved.filter((m) => m.status === 'approved' && !m.archived).map((m) => [m.name, m]));
    const lines: string[] = [];
    for (const name of new Set(built.map((i) => i.module_name!))) {
      const mv = newest.get(name);
      if (mv) lines.push(`- ${name}@${mv.version} ("${mv.manifest.title}"): ${mv.manifest.actions.map((a) => `${a.name} (${a.title})`).join(', ')}`);
    }
    if (!lines.length) return '';
    return (
      `\n\nBUILT FOR THIS FLOW (approved while it waited; they are in the catalog, use them and report none of them as missing):\n${lines.join('\n')}`
    );
  }

  /**
   * A plan's Flow that cannot be drafted because approved modules lack what it needs: the missing parts become module
   * items of the plan (the next version of the module the AI named, or a new module), the Flow needs them and waits.
   * Two rounds per Flow at most, never the same part twice (its added items are keyed after it); returns whether
   * anything was added.
   */
  private async addMissingModules(plan: PlanRow, flow: ItemRow, missing: MissingCapability[]): Promise<boolean> {
    const prefix = `${flow.key}_needs_`.slice(0, 50);
    return withTx(this.db, async (tx) => {
      const items = await this.items(tx, plan.id);
      const added = items.filter((i) => i.key.startsWith(prefix));
      // Two rounds at most (the first can show that one more part is needed), and never the same part again.
      const rounds = new Set(added.map((i) => i.key.slice(prefix.length).split('_')[0])).size;
      if (rounds >= MAX_NEED_ROUNDS) return false;
      const seen = added.map((i) => i.title.toLowerCase());
      const wanted = missing.filter((m) => m.capability && m.moduleRequest && !seen.some((t) => t.includes(m.capability.toLowerCase()))).slice(0, 3);
      if (!wanted.length) return false;
      const current = items.find((i) => i.id === flow.id);
      if (!current || current.status !== 'drafting') return false;
      let position = Math.max(...items.map((i) => i.position)) + 1;
      // One item per module to add to (all its missing actions together), one per new module.
      const groups = new Map<string, MissingCapability[]>();
      for (const m of wanted) {
        const k = m.module && /^[a-z][a-z0-9-]{1,39}$/.test(m.module) ? `extends:${m.module}` : `new:${m.capability}`;
        groups.set(k, [...(groups.get(k) ?? []), m]);
      }
      const keys: string[] = [];
      for (const [k, ms] of groups) {
        const key = `${prefix}${rounds + 1}_${keys.length + 1}`;
        const module = k.startsWith('extends:') ? k.slice('extends:'.length) : null;
        const title = module ? `Add to ${module}: ${ms.map((m) => m.capability).join(', ')}` : ms[0]!.capability;
        await this.insertItem(tx, plan.id, position++, 'module', key, title.slice(0, 120), ms.map((m) => m.moduleRequest).join('\n\n').slice(0, 4000), [], 'queued', module ? `extends:${module}` : null);
        keys.push(key);
      }
      await tx.query(`UPDATE plan_items SET needs = $2, status = 'waiting', error = NULL, detail_enc = NULL, updated_at = now() WHERE id = $1`, [flow.id, [...new Set([...flow.needs, ...keys])]]);
      log.info('plan_flow_needs_added', { count: keys.length });
      return true;
    });
  }

  /** Any version of a plan's module being decided (revisions keep the module's name). */
  private async moduleDecided(moduleVersionId: string): Promise<void> {
    const mv = await this.modules.get(this.db, moduleVersionId);
    if (!mv || (mv.status !== 'approved' && mv.status !== 'rejected')) return;
    const { rows } = await this.db.query<ItemRow>(
      `SELECT * FROM plan_items WHERE kind = 'module' AND module_name = $1 AND status IN ('in_review', 'needs_attention', 'rejected', 'failed')`,
      [mv.name],
    );
    for (const item of rows) {
      if (mv.status === 'approved') {
        await this.setItem(item.id, { status: 'approved', error: null, module_version_id: mv.id });
      } else if (item.module_version_id === mv.id) {
        await this.setItem(item.id, { status: 'rejected', error: 'module_rejected' });
        const owner = (await this.db.query<{ created_by: string }>(`SELECT created_by FROM plans WHERE id = $1`, [item.plan_id])).rows[0];
        if (owner) await notify(this.db, owner.created_by, 'plan_needs_attention', { planId: item.plan_id });
      }
    }
    for (const planId of new Set(rows.map((r) => r.plan_id))) await this.settle(planId);
  }

  /** A plan's Flow was approved or rejected (any version of it: revisions keep the Flow). */
  private async flowDecided(flowVersionId: string): Promise<void> {
    const v = (await this.db.query<{ flow_id: string; status: string }>(`SELECT flow_id, status FROM flow_versions WHERE id = $1`, [flowVersionId])).rows[0];
    if (!v || (v.status !== 'approved' && v.status !== 'rejected')) return;
    const { rows } = await this.db.query<ItemRow>(
      `SELECT * FROM plan_items WHERE kind IN ('flow', 'superflow') AND flow_id = $1 AND status IN ('drafted', 'approved', 'rejected')`,
      [v.flow_id],
    );
    for (const item of rows) {
      if (v.status === 'approved') await this.setItem(item.id, { status: 'approved', error: null, flow_version_id: flowVersionId });
      else if (item.flow_version_id === flowVersionId) await this.setItem(item.id, { status: 'rejected', error: 'flow_rejected' });
    }
    for (const planId of new Set(rows.map((r) => r.plan_id))) await this.settle(planId);
  }

  /** Start Flows whose modules are all approved, and work out where the plan stands. */
  private async settle(planId: string): Promise<void> {
    await withTx(this.db, async (tx) => {
      const plan = (await tx.query<PlanRow>(`SELECT ${PLAN_COLS} FROM plans WHERE id = $1 FOR UPDATE`, [planId])).rows[0];
      if (!plan || !['drafting', 'waiting'].includes(plan.status)) return;
      const items = await this.items(tx, planId);
      const modules = new Map(items.filter((i) => i.kind === 'module').map((i) => [i.key, i.status]));
      for (const f of items.filter((i) => i.kind === 'flow' && (i.status === 'waiting' || i.status === 'blocked'))) {
        const needs = f.needs.map((k) => modules.get(k));
        if (needs.every((s) => s === 'approved')) {
          f.status = 'queued';
          await tx.query(`UPDATE plan_items SET status = 'queued', error = NULL, updated_at = now() WHERE id = $1`, [f.id]);
          await enqueue(tx, 'plan_item', { itemId: f.id });
        } else {
          const stuck = needs.find((s) => s === 'rejected' || s === 'failed' || s === 'needs_attention' || s === 'cancelled');
          const status: FlowItemStatus = stuck ? 'blocked' : 'waiting';
          // Says why: needs_module_failed, _rejected, _needs_attention or _cancelled.
          const error = stuck ? `needs_module_${stuck}` : null;
          if (f.status !== status || f.error !== error) {
            f.status = status;
            await tx.query(`UPDATE plan_items SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [f.id, status, error]);
          }
        }
      }
      // A Super Flow waits until every Flow it runs (new or reused) is approved.
      const flowStatus = new Map(items.filter((i) => i.kind === 'flow' || i.kind === 'existing').map((i) => [i.key, i.status]));
      for (const s of items.filter((i) => i.kind === 'superflow' && (i.status === 'waiting' || i.status === 'blocked'))) {
        const needs = s.needs.map((k) => flowStatus.get(k));
        if (needs.every((x) => x === 'approved')) {
          s.status = 'queued';
          await tx.query(`UPDATE plan_items SET status = 'queued', error = NULL, updated_at = now() WHERE id = $1`, [s.id]);
          await enqueue(tx, 'plan_item', { itemId: s.id });
        } else {
          const stuck = needs.some((x) => x === 'rejected' || x === 'failed' || x === 'blocked' || x === 'cancelled');
          const status: FlowItemStatus = stuck ? 'blocked' : 'waiting';
          const error = stuck ? 'flow_not_approved' : null;
          if (s.status !== status || s.error !== error) {
            s.status = status;
            await tx.query(`UPDATE plan_items SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [s.id, status, error]);
          }
        }
      }
      const done = items.every((i) => i.status === 'approved' || i.status === 'drafted' || i.status === 'split');
      const busy = items.some((i) => i.status === 'queued' || i.status === 'drafting');
      const next: PlanStatus = done ? 'done' : busy ? 'drafting' : 'waiting';
      if (next === plan.status) return;
      await tx.query(`UPDATE plans SET status = $2, updated_at = now() WHERE id = $1`, [planId, next]);
      if (next === 'done') await notify(tx, plan.created_by, 'plan_ready', { planId });
    });
  }

  /**
   * The worker gave up on a drafting job (it crashed or stopped its worker every attempt). What waited on it is marked
   * failed with a retry button, so nothing shows "queued" or "drafting" forever.
   */
  async jobGaveUp(job: { kind: string; payload: Record<string, string> }): Promise<void> {
    if (job.kind === 'plan_analyze' && job.payload.planId) {
      const plan = (await this.db.query<PlanRow>(`SELECT ${PLAN_COLS} FROM plans WHERE id = $1`, [job.payload.planId])).rows[0];
      if (plan) await this.fail(plan, 'drafting_stopped');
      return;
    }
    if (job.kind !== 'plan_item' || !job.payload.itemId) return;
    const item = (await this.db.query<{ plan_id: string; created_by: string }>(
      `UPDATE plan_items i SET status = 'failed', error = 'drafting_stopped', updated_at = now() FROM plans p
       WHERE i.id = $1 AND p.id = i.plan_id AND i.status IN ('queued', 'drafting') RETURNING i.plan_id, p.created_by`,
      [job.payload.itemId],
    )).rows[0];
    if (!item) return;
    await notify(this.db, item.created_by, 'plan_needs_attention', { planId: item.plan_id });
    await this.settle(item.plan_id);
  }

  /**
   * Where each queued item stands: how many drafts go first (across the server, in the drafting lane), or when a
   * retry after a busy AI is due. So "queued" always says what it waits for.
   */
  private async queueOf(itemIds: string[]): Promise<Map<string, { ahead: number; retryAt: string | null }>> {
    const out = new Map<string, { ahead: number; retryAt: string | null }>();
    if (!itemIds.length) return out;
    const { rows } = await this.db.query<{ item: string; run_at: Date; ahead: number; due: boolean }>(
      `SELECT j.payload->>'itemId' AS item, j.run_at, j.run_at <= now() AS due,
         (SELECT count(*)::int FROM jobs k WHERE k.kind = ANY($2) AND k.failed_at IS NULL AND k.id <> j.id
            AND (k.locked_until >= now() OR (k.run_at <= now() AND (k.run_at, k.id) < (j.run_at, j.id)))) AS ahead
       FROM jobs j WHERE j.kind = 'plan_item' AND j.failed_at IS NULL AND j.payload->>'itemId' = ANY($1)`,
      [itemIds, [...laneKinds.drafting]],
    );
    for (const r of rows) out.set(r.item, { ahead: r.ahead, retryAt: r.due ? null : new Date(r.run_at).toISOString() });
    return out;
  }

  // ------------------------------------------------------------------ helpers

  private async fail(plan: PlanRow, code: string, detail?: string, raw?: string): Promise<void> {
    log.warn('plan_failed', { errorType: code });
    const detailEnc = detail ? this.cipher.encrypt(detail.slice(0, 2000), aad.errorDetail(plan.id)) : null;
    const rawEnc = raw ? this.cipher.encrypt(rawExcerpt(raw), aad.errorRaw(plan.id)) : null;
    await withTx(this.db, async (tx) => {
      const { rowCount } = await tx.query(`UPDATE plans SET status = 'failed', error = $2, error_detail_enc = $3, error_raw_enc = $4, updated_at = now() WHERE id = $1 AND status = 'reading'`, [plan.id, code, detailEnc, rawEnc]);
      if (rowCount) await notify(tx, plan.created_by, 'plan_failed', { planId: plan.id });
    });
  }

  /** With `whileDrafting`, only if the item is still being drafted (not cancelled meanwhile); says whether it changed. */
  private async setItem(id: string, fields: Partial<Pick<ItemRow, 'status' | 'error' | 'detail_enc' | 'raw_enc' | 'module_name' | 'module_version_id' | 'flow_id' | 'flow_version_id'>>, whileDrafting = false): Promise<boolean> {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    const { rowCount } = await this.db.query(
      `UPDATE plan_items SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1${whileDrafting ? ` AND status = 'drafting'` : ''}`,
      [id, ...keys.map((k) => fields[k] ?? null)],
    );
    return (rowCount ?? 0) > 0;
  }

  private async load(db: Queryable, id: string, actor: Member, lock = false): Promise<PlanRow> {
    const plan = (await db.query<PlanRow>(`SELECT ${PLAN_COLS} FROM plans WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    // Someone else's plan reads as missing, not forbidden.
    if (!plan || (plan.created_by !== actor.id && actor.role !== 'admin')) throw notFound('plan');
    return plan;
  }

  private items(db: Queryable, planId: string): Promise<ItemRow[]> {
    return db.query<ItemRow>(`SELECT * FROM plan_items WHERE plan_id = $1 ORDER BY position`, [planId]).then((r) => r.rows);
  }

  private analysis(plan: PlanRow): PlanAnalysis | null {
    return plan.analysis_enc ? this.cipher.decryptJson<PlanAnalysis>(plan.analysis_enc, aad.analysis(plan.id)) : null;
  }

  private answers(plan: PlanRow): Record<string, string> | undefined {
    return plan.answers_enc ? this.cipher.decryptJson<Record<string, string>>(plan.answers_enc, aad.answers(plan.id)) : undefined;
  }
}

import { z } from 'zod';
import { audit } from '../core/audit.js';
import { badRequest, forbidden } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';
import { currentAiContext } from './metering.js';
import { modelId } from './models.js';
import type { AiProvider, JsonRequest } from './provider.js';
import { EFFORTS, type Effort } from '../runtime/ai.js';

/**
 * The organization's AI model, changed without a restart. DITTOLY_AI_PROVIDER and
 * DITTOLY_AI_MODEL set where a server starts; an admin's choice on the Admin page (stored in
 * org_settings) takes precedence over them until it is removed. The admin picks among the
 * providers the server has: DITTOLY_AI_PROVIDER and those listed in DITTOLY_AI_PROVIDERS.
 *
 * Changing the model is what DITTOLY_AI_MODEL plus a restart did: approved Flows follow it (unless
 * an approver locked one to a model) and are checked with the new one (model-changes.ts), which
 * the caller starts right away. Other servers of the organization pick the choice up on their next
 * maintenance pass.
 */

const KEY = 'ai_model_choice';

export const choiceBody = z
  .object({
    /** A provider the server has; default: the one in use now. */
    provider: z.string().min(1).max(40).optional(),
    model: z.string().trim().min(1).max(200).regex(/^[\w.:\/@-]+$/, 'a model name, e.g. claude-opus-5-5'),
    /** How hard the model works on new drafts and AI steps; absent: the model's default. */
    effort: z.enum(EFFORTS).optional(),
  })
  .strict()
  .nullable();

interface Choice { provider: string; model: string; effort?: Effort }

export class OrgAi implements AiProvider {
  private cur: { provider: string; model: string | undefined; effort?: Effort | undefined };
  private choice: (Choice & { by: string | null; at: Date }) | null = null;

  /**
   * @param providers the providers the server has, by id (each already metered); the first is DITTOLY_AI_PROVIDER.
   * @param configuredModel DITTOLY_AI_MODEL, for the first provider.
   */
  constructor(
    private readonly db: Queryable,
    private readonly providers: Map<string, AiProvider>,
    readonly configuredModel: string | undefined,
  ) {
    this.cur = { provider: [...providers.keys()][0]!, model: configuredModel };
  }

  get id() {
    return this.providers.get(this.cur.provider)!.id;
  }

  /** The organization's model now, as a pin ("provider:model"). */
  get model(): string {
    return modelId(this.cur.provider, this.cur.model);
  }

  /** The model name in use (null: the provider's own default). */
  get modelName(): string | null {
    return this.cur.model ?? null;
  }

  /**
   * The models a provider the server has offers, for the admin's picker: asked at most every 10 minutes,
   * waiting at most 10 seconds. listed is false when the provider cannot list them or did not answer.
   */
  async models(provider: string): Promise<{ models: string[]; listed: boolean }> {
    const p = this.providers.get(provider);
    if (!p?.listModels) return { models: [], listed: false };
    const hit = this.modelCache.get(provider);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    let value: { models: string[]; listed: boolean };
    try {
      const models = await Promise.race([p.listModels(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000).unref())]);
      value = { models: [...new Set(models)].slice(0, 200), listed: true };
    } catch {
      // Not cached: the next look asks again.
      return { models: [], listed: false };
    }
    // An empty list is asked again next time (e.g. a model just pulled on an Ollama server).
    if (value.models.length) this.modelCache.set(provider, { at: Date.now(), value });
    return value;
  }
  private readonly modelCache = new Map<string, { at: number; value: { models: string[]; listed: boolean } }>();

  /** A provider the server has, asked as is (a pinned model passes its own model). */
  forProvider(id: string): AiProvider | null {
    return this.providers.get(id) ?? null;
  }

  /** The effort chosen for new work (null: the model's default). */
  get effort(): Effort | null {
    return this.cur.effort ?? null;
  }

  /**
   * New drafts and AI steps: the organization's model and effort. A Flow locked to a model, or a run started
   * with one, goes to that model through forProvider instead (at the model's default effort).
   */
  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    // What this draft chose (a Flow's, module's, plan's or the member's own model), where anything did.
    const chosen = currentAiContext()?.draftModel;
    const providerId = chosen?.provider && this.providers.has(chosen.provider) ? chosen.provider : this.cur.provider;
    const p = this.providers.get(providerId)!;
    // A request that names its own model (a Flow version's pinned model) still wins: it was approved that way.
    const want = chosen?.model ?? this.cur.model;
    const wantEffort = (chosen?.effort as Effort | undefined) ?? this.cur.effort;
    const model = req.model || !want ? {} : { model: want };
    const effort = req.effort || !wantEffort ? {} : { effort: wantEffort };
    return p.generateJson({ ...req, ...model, ...effort });
  }

  /** Apply the stored choice (at startup and on each maintenance pass). A provider the server no longer has is ignored. */
  async refresh(): Promise<void> {
    const row = (await this.db.query<{ value: Choice; updated_by: string | null; updated_at: Date; handle: string | null }>(
      `SELECT s.value, s.updated_by, s.updated_at, m.handle FROM org_settings s LEFT JOIN members m ON m.id = s.updated_by WHERE s.key = $1`,
      [KEY],
    )).rows[0];
    const first = [...this.providers.keys()][0]!;
    if (row && this.providers.has(row.value.provider)) {
      this.choice = { ...row.value, by: row.handle, at: row.updated_at };
      this.cur = { provider: row.value.provider, model: row.value.model, effort: EFFORTS.includes(row.value.effort as Effort) ? row.value.effort : undefined };
    } else {
      this.choice = null;
      this.cur = { provider: first, model: this.configuredModel };
    }
  }

  /** For the Admin page: the model now, where it comes from, and what can be chosen. */
  view() {
    const first = [...this.providers.keys()][0]!;
    return {
      model: this.model,
      provider: this.cur.provider,
      modelName: this.modelName,
      effort: this.effort,
      /** Whether an admin's choice is in force (else the server's configuration). */
      chosen: this.choice ? { by: this.choice.by, at: this.choice.at } : null,
      configured: modelId(first, this.configuredModel),
      providers: [...this.providers.keys()],
    };
  }

  /** An admin chooses the model (and provider), or removes the choice (null) to go back to the configuration. Audited. */
  async choose(actor: Member, body: z.infer<typeof choiceBody>): Promise<{ from: string; to: string }> {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const from = this.model;
    if (body === null) {
      await this.db.query(`DELETE FROM org_settings WHERE key = $1`, [KEY]);
      await audit(this.db, { actorId: actor.id, action: 'ai.model_choice_removed', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
    } else {
      const provider = body.provider ?? this.cur.provider;
      if (!this.providers.has(provider)) throw badRequest('ai_provider_not_configured', `this server has ${[...this.providers.keys()].join(', ')}`);
      await this.db.query(
        `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [KEY, JSON.stringify({ provider, model: body.model, ...(body.effort ? { effort: body.effort } : {}) }), actor.id],
      );
      await audit(this.db, { actorId: actor.id, action: 'ai.model_chosen', subjectType: 'org', subjectId: KEY, outcome: 'ok', relatedId: `${modelId(provider, body.model)}${body.effort ? `:effort-${body.effort}` : ''}`.slice(0, 80) });
    }
    await this.refresh();
    return { from, to: this.model };
  }
}

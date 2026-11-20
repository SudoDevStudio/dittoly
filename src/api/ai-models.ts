import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { getDefaultRunCap, setDefaultRunCap } from '../ai/costs.js';
import { decisionBody } from '../ai/model-changes.js';
import { splitModel } from '../ai/models.js';
import { choiceBody } from '../ai/org-model.js';
import { draftModelBody, draftModelFor, setDraftModel, storedDraftModel, SUBJECTS } from '../ai/draft-model.js';
import { badRequest, conflict, forbidden } from '../core/errors.js';
import { costCapSchema } from '../flows/definition.js';
import { me, parse, uuid } from './http.js';

/** A subject whose drafting model can be chosen: a Flow (or Super Flow), a module (by name), a plan, or a member. */
const subjectParams = z.object({ type: z.enum(SUBJECTS), id: z.string().min(1).max(200) }).strict();

/** Model changes (pinned models and their checks) and per-run AI cost caps. */
export function registerAiModelRoutes(api: FastifyInstance, app: App): void {
  // Approvers: Flows waiting to switch to the organization's new model, and Flows whose model is gone.
  api.get('/model-changes', async (req) => app.modelChanges.list(me(req)));
  api.post<{ Params: { id: string } }>('/model-changes/:id/decision', async (req, reply) => {
    await app.modelChanges.decide(me(req), parse(uuid, req.params.id), parse(decisionBody, req.body));
    return reply.status(204).send();
  });
  // Approvers: lock an approved version to one model, or unlock it (model null) so it follows the organization's.
  api.put<{ Params: { versionId: string } }>('/flow-versions/:versionId/model-lock', async (req, reply) => {
    const body = parse(z.object({ model: z.string().max(250).nullable() }).strict(), req.body);
    await app.modelChanges.lock(me(req), parse(uuid, req.params.versionId), body.model);
    return reply.status(204).send();
  });
  // Everyone: the models a run can be started with ("provider:model"), the organization's first.
  api.get('/ai/run-models', async () => {
    if (!app.orgAi) return { organization: null, models: [] };
    const view = app.orgAi.view();
    const priced = (await app.db.query<{ provider: string; model: string }>(`SELECT provider, model FROM ai_prices ORDER BY provider, model`)).rows;
    const models = [view.model];
    for (const p of view.providers) {
      const listed = await app.orgAi.models(p);
      for (const m of [...listed.models, ...priced.filter((r) => r.provider === p).map((r) => r.model)]) models.push(`${p}:${m}`);
    }
    return { organization: view.model, models: [...new Set(models)].slice(0, 300) };
  });
  api.post<{ Params: { versionId: string } }>('/flow-versions/:versionId/model-check', async (req, reply) =>
    reply.status(202).send(await app.modelChanges.recheck(me(req), parse(uuid, req.params.versionId))),
  );

  // A run waiting at its cost cap: its owner or an approver of its team allows more.
  api.post<{ Params: { id: string } }>('/runs/:id/allow-spend', async (req, reply) => {
    const body = parse(z.object({ tokens: z.number().int().min(1).max(1e10).optional(), amount: z.number().min(0.0001).max(1_000_000).optional() }).strict(), req.body);
    await app.engine.allowMoreSpend(parse(uuid, req.params.id), me(req), body);
    return reply.status(202).send();
  });

  // The organization's AI model (and provider): everyone sees which one is in use; admins change it without a restart.
  // A change starts the model-change checks at once.
  api.get('/ai/model', async (req) => {
    if (!app.orgAi) throw conflict('organization_ai_not_configured');
    const view = app.orgAi.view();
    if (me(req).role !== 'admin') return { provider: view.provider, model: view.model, modelName: view.modelName, effort: view.effort };
    // Models priced in the organization's price table, as suggestions for the admin's picker.
    const { rows } = await app.db.query<{ provider: string; model: string }>(`SELECT provider, model FROM ai_prices ORDER BY provider, model`);
    const known: Record<string, string[]> = {};
    for (const r of rows) if (view.providers.includes(r.provider)) (known[r.provider] ??= []).push(r.model);
    return { ...view, known };
  });
  // Admins: the models to pick from for one provider: what the provider lists, the price table's, and the ones in use.
  // Everyone who drafts may see the models to pick from: a model name is not a secret, and the picker needs them.
  api.get<{ Querystring: { provider?: string } }>('/ai/models', async (req) => {
    me(req);
    if (!app.orgAi) throw conflict('organization_ai_not_configured');
    const view = app.orgAi.view();
    const provider = parse(z.string().min(1).max(40).optional(), req.query.provider) ?? view.provider;
    if (!view.providers.includes(provider)) throw badRequest('ai_provider_not_configured');
    const listed = await app.orgAi.models(provider);
    const priced = (await app.db.query<{ model: string }>(`SELECT model FROM ai_prices WHERE provider = $1 ORDER BY model`, [provider])).rows.map((r) => r.model);
    const inUse = [view.model, view.configured].map(splitModel).filter((m) => m.provider === provider && m.model !== 'default').map((m) => m.model);
    return { provider, listed: listed.listed, models: [...new Set([...inUse, ...listed.models, ...priced])] };
  });
  /**
   * Which model drafts one Flow, Super Flow, module or plan — or whatever this member starts next ("member").
   * Whoever may draft it may choose; with a null choice it goes back to the organization's model.
   */
  api.get<{ Params: { type: string; id: string } }>('/ai/draft-model/:type/:id', async (req) => {
    const subject = parse(subjectParams, { type: req.params.type, id: req.params.id === 'me' ? me(req).id : req.params.id });
    return { chosen: await storedDraftModel(app.db, subject), inUse: await draftModelFor(app.db, subject, me(req).id), organization: app.orgAi?.view().model ?? null };
  });
  api.put<{ Params: { type: string; id: string } }>('/ai/draft-model/:type/:id', async (req, reply) => {
    const subject = parse(subjectParams, { type: req.params.type, id: req.params.id === 'me' ? me(req).id : req.params.id });
    const body = parse(z.object({ choice: draftModelBody }).strict(), req.body);
    await setDraftModel(app.db, me(req), subject, body.choice);
    return reply.status(204).send();
  });

  api.put('/ai/model', async (req) => {
    if (!app.orgAi) throw conflict('organization_ai_not_configured');
    const body = parse(z.object({ choice: choiceBody }).strict(), req.body);
    const { from, to } = await app.orgAi.choose(me(req), body.choice);
    const checks = from === to ? 0 : await app.modelChanges.detect();
    return { ...app.orgAi.view(), checks };
  });

  // The organization's default cap per run, for Flows without their own.
  api.get('/ai/run-cap', async () => ({ cap: await getDefaultRunCap(app.db) }));
  api.put('/ai/run-cap', async (req) => {
    const body = parse(z.object({ cap: costCapSchema.nullable() }).strict(), req.body);
    return { cap: await setDefaultRunCap(app.db, me(req), body.cap) };
  });
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { AiError, type AiProvider, type JsonRequest } from '../src/ai/provider.js';
import { makeWorld, type World } from './helpers.js';

/**
 * Changing the organization's AI model without a restart: an admin's choice on the Admin page
 * takes precedence over DITTOLY_AI_MODEL, starts the model-change checks at once, and is audited.
 * Approved Flows follow it (model, provider and effort) unless an approver locked one to a model.
 */
class Fake implements AiProvider {
  readonly calls: (string | undefined)[] = [];
  readonly efforts: (string | undefined)[] = [];
  /** Set for a provider that can list its models. */
  listModels?: () => Promise<string[]>;
  constructor(readonly id: 'mock' | 'openai', private readonly known: string[], lists = false) {
    if (lists) this.listModels = async () => [...this.known, 'm3'];
  }
  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    this.calls.push(req.model);
    this.efforts.push(req.effort);
    if (req.model && !this.known.includes(req.model)) throw new AiError('ai_model_not_found');
    req.onUsage?.({ inputTokens: 10, outputTokens: 5, model: req.model ?? 'default' });
    return { text: 'The printer is broken.' };
  }
}

const mock = new Fake('mock', ['m1', 'm2'], true);
const openai = new Fake('openai', ['gpt-x']);
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const put = (token: string, choice: unknown) => api.inject({ method: 'PUT', url: '/api/ai/model', headers: auth(token), payload: { choice } });
const definition = {
  inputs: { type: 'object', properties: { ticket: { type: 'string' } } },
  steps: [{ id: 'summarize', type: 'ai', ai: 'organization', instruction: 'Summarize the ticket.', input: { ticket: '{{ inputs.ticket }}' }, output: 'text' }],
};
let versionId = '';

async function run() {
  const id = await w.app.engine.startRun(versionId, w.alice.id, { ticket: 'T-1: printer broken' });
  await w.app.worker.drain();
  return w.app.engine.runView(id, w.alice);
}

beforeAll(async () => {
  w = await makeWorld({ aiProvider: 'mock', aiModel: 'm1' }, { ai: mock, aiProviders: [openai] });
  api = buildServer(w.app);
  const v = await w.app.flows.create('Ticket summary', definition, w.alice);
  versionId = (await w.app.flows.decide(v.id, w.approver, 'approved')).id;
  expect(await w.app.modelChanges.detect()).toBe(0); // the first model seen
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('choosing the organization model', () => {
  it('everyone sees which model is in use (the top bar); only admins change it', async () => {
    const seen = await api.inject({ method: 'GET', url: '/api/ai/model', headers: auth(w.tokens.approver) });
    expect(seen.json()).toEqual({ model: 'mock:m1', provider: 'mock', modelName: 'm1', effort: null });
    expect((await put(w.tokens.approver, { model: 'm2' })).statusCode).toBe(403);
    // Admins also get the providers and, as suggestions, the models priced for them.
    await api.inject({ method: 'PUT', url: '/api/ai/prices', headers: auth(w.tokens.admin), payload: { provider: 'openai', model: 'gpt-x', inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' } });
    const view = (await api.inject({ method: 'GET', url: '/api/ai/model', headers: auth(w.tokens.admin) })).json();
    expect(view).toEqual({ model: 'mock:m1', provider: 'mock', modelName: 'm1', effort: null, chosen: null, configured: 'mock:m1', providers: ['mock', 'openai'], known: { openai: ['gpt-x'] } });
    expect((await put(w.tokens.admin, { provider: 'anthropic', model: 'x' })).json().error).toBe('ai_provider_not_configured');
    expect((await put(w.tokens.admin, { model: 'not a model' })).statusCode).toBe(400);
  });

  it('lists the models to pick from: what the provider offers, the price table and the one in use', async () => {
    const models = (provider?: string, token = w.tokens.admin) => api.inject({ method: 'GET', url: `/api/ai/models${provider ? `?provider=${provider}` : ''}`, headers: auth(token) });
    // Everyone who drafts may see the list: they pick the model for their own Flow or module (src/ai/draft-model.ts).
    expect((await models(undefined, w.tokens.approver)).json()).toMatchObject({ provider: 'mock' });
    expect((await models()).json()).toEqual({ provider: 'mock', listed: true, models: ['m1', 'm2', 'm3'] });
    // A provider that cannot list its models: the price table's (gpt-x, priced above) still show.
    expect((await models('openai')).json()).toEqual({ provider: 'openai', listed: false, models: ['gpt-x'] });
    expect((await models('anthropic')).json().error).toBe('ai_provider_not_configured');
  });

  it('effort: chosen with the model, used by new work and by approved Flows that follow the model', async () => {
    expect((await put(w.tokens.admin, { model: 'm1', effort: 'easy' })).statusCode).toBe(400);
    const r = await put(w.tokens.admin, { model: 'm1', effort: 'low' });
    expect(r.json()).toMatchObject({ model: 'mock:m1', effort: 'low', checks: 0 }); // same model: nothing to check
    expect((await api.inject({ method: 'GET', url: '/api/ai/model', headers: auth(w.tokens.alice) })).json()).toEqual({ model: 'mock:m1', provider: 'mock', modelName: 'm1', effort: 'low' });
    // New work (a draft, an AI step not yet pinned) gets it; a caller's own effort wins.
    await w.app.orgAi!.generateJson({ system: 's', prompt: 'p', schema: {} });
    expect(mock.efforts.at(-1)).toBe('low');
    await w.app.orgAi!.generateJson({ system: 's', prompt: 'p', schema: {}, effort: 'max' });
    expect(mock.efforts.at(-1)).toBe('max');
    // The approved Flow follows the organization's model, effort included.
    expect((await run()).status).toBe('succeeded');
    expect(mock.efforts.at(-1)).toBe('low');
    const audited = await w.db.query(`SELECT related_id FROM audit_events WHERE action = 'ai.model_chosen' ORDER BY id DESC LIMIT 1`);
    expect(audited.rows).toEqual([{ related_id: 'mock:m1:effort-low' }]);
    // The same model without an effort: back to the model's default.
    expect((await put(w.tokens.admin, { model: 'm1' })).json()).toMatchObject({ effort: null });
    expect(w.app.orgAi!.effort).toBeNull();
  });

  it('a new model applies at once, approved Flows included, starts their checks, and is audited', async () => {
    const r = await put(w.tokens.admin, { model: 'm2' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ model: 'mock:m2', modelName: 'm2', chosen: { by: 'admin' }, configured: 'mock:m1', checks: 1 });
    expect(w.app.aiModel).toBe('mock:m2');
    const audited = await w.db.query(`SELECT related_id FROM audit_events WHERE action = 'ai.model_chosen' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, [w.admin.id]);
    expect(audited.rows).toEqual([{ related_id: 'mock:m2' }]);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'ai.model_changed'`)).rowCount).toBe(1);
    const checks = (await w.db.query(`SELECT from_model, to_model FROM model_change_checks WHERE flow_version_id = $1`, [versionId])).rows;
    expect(checks).toEqual([{ from_model: 'mock:m1', to_model: 'mock:m2' }]);
    await w.app.worker.drain();
    expect((await w.app.modelChanges.list(w.approver)).waiting).toMatchObject([{ versionId, toModel: 'mock:m2' }]);

    // The approved Flow runs with m2 at once, as does new work (a draft's pending version, any call).
    expect((await run()).status).toBe('succeeded');
    expect(mock.calls.at(-1)).toBe('m2');
    await w.app.ai!.generateJson({ system: 's', prompt: 'p', schema: {} });
    expect(mock.calls.at(-1)).toBe('m2');
    const pending = await w.app.flows.create('Another summary', definition, w.alice);
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${pending.id}/review`, headers: auth(w.tokens.approver) })).json();
    expect(review.aiModel).toBe('mock:m2');
  });

  it('switches the provider too when the server has several, approved Flows included', async () => {
    const r = (await put(w.tokens.admin, { provider: 'openai', model: 'gpt-x' })).json();
    expect(r).toMatchObject({ model: 'openai:gpt-x', provider: 'openai', checks: 1 });
    await w.app.ai!.generateJson({ system: 's', prompt: 'p', schema: {} });
    expect(openai.calls.at(-1)).toBe('gpt-x');
    // The check with the new provider runs (in the background) against it.
    await w.app.worker.drain();
    expect((await w.app.modelChanges.list(w.approver)).waiting).toMatchObject([{ versionId, fromModel: 'mock:m1', toModel: 'openai:gpt-x' }]);
    // The approved Flow follows to the new provider.
    const before = mock.calls.length;
    expect((await run()).status).toBe('succeeded');
    expect(openai.calls.at(-1)).toBe('gpt-x');
    expect(mock.calls.length).toBe(before);
  });

  it('takes precedence over DITTOLY_AI_MODEL on the other servers (and after a restart)', async () => {
    const other = buildApp(w.app.config, w.db, { runner: w.app.runner, ai: mock, aiProviders: [openai], actionTimeoutMs: 10_000 });
    expect(other.aiModel).toBe('mock:m1');
    await other.orgAi!.refresh();
    expect(other.aiModel).toBe('openai:gpt-x');
  });

  it('removing the choice goes back to the server configuration', async () => {
    const r = (await put(w.tokens.admin, null)).json();
    expect(r).toMatchObject({ model: 'mock:m1', chosen: null });
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'ai.model_choice_removed'`)).rowCount).toBe(1);
    expect((await w.db.query(`SELECT 1 FROM org_settings WHERE key = 'ai_model_choice'`)).rowCount).toBe(0);
  });
});

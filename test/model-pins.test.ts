import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { compareSample, fieldDiffs, similarity, textSimilarity } from '../src/ai/model-changes.js';
import { AiError, type AiProvider, type JsonRequest } from '../src/ai/provider.js';
import type { Config } from '../src/config.js';
import { makeWorld, type World } from './helpers.js';

/**
 * Which model a Flow runs with, and the model-change check. Flows follow the organization's model unless an approver
 * locks one; a run may be started with its own model; a model that is gone falls back to the organization's. A fake
 * organization AI answers per model: each model has its own way of summarizing, and unknown models are "not found".
 */
class PerModel implements AiProvider {
  readonly id = 'mock' as const;
  readonly calls: { model: string | undefined; purpose: string }[] = [];
  readonly known = new Set(['m1', 'm2', 'm3']);
  answer: Record<string, (prompt: string) => string> = {
    m1: () => 'The printer is broken.',
    m2: () => 'the printer is BROKEN',
    m3: (p) => `Call facilities about ${p.length} things`,
  };

  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    const model = req.model ?? 'm1';
    this.calls.push({ model: req.model, purpose: 'step' });
    if (!this.known.has(model)) throw new AiError('ai_model_not_found');
    const text = this.answer[model]!(req.prompt);
    req.onUsage?.({ inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: 10, model });
    return { text };
  }
}

const ai = new PerModel();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const apps: App[] = [];

const definition = {
  inputs: { type: 'object', properties: { ticket: { type: 'string' } }, required: ['ticket'] },
  steps: [{ id: 'summarize', type: 'ai', ai: 'organization', instruction: 'Summarize the ticket in one sentence.', input: { ticket: '{{ inputs.ticket }}' }, output: 'text' }],
};

/** The same server after an admin changed DITTOLY_AI_MODEL and restarted it. */
function withModel(model: string): App {
  const config: Config = { ...w.app.config, aiModel: model };
  const app = buildApp(config, w.db, { runner: w.app.runner, ai, actionTimeoutMs: 10_000 });
  apps.push(app);
  return app;
}

async function run(app: App, versionId: string) {
  const id = await app.engine.startRun(versionId, w.alice.id, { ticket: 'T-1: the printer on floor 2 is broken' });
  await app.worker.drain();
  return app.engine.runView(id, w.alice);
}

const lastModel = () => ai.calls.at(-1)?.model;

beforeAll(async () => {
  w = await makeWorld({ aiProvider: 'mock', aiModel: 'm1' }, { ai });
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('comparing answers', () => {
  it('compares text loosely, and numbers, booleans and choices exactly', () => {
    expect(textSimilarity('The printer is broken.', 'the PRINTER is broken')).toBe(1);
    expect(textSimilarity('The printer is broken', 'Call facilities')).toBe(0);
    expect(similarity({ ok: true, n: 3, label: 'high' }, { ok: true, n: 3, label: 'high' })).toBe(1);
    expect(similarity({ ok: true, n: 3 }, { ok: false, n: 3 })).toBe(0.5);
    expect(similarity([1, 2], [1, 2, 3])).toBeCloseTo(2 / 3);
    expect(fieldDiffs({ ok: true, text: 'a b c' }, { ok: false, text: 'a b c' })).toEqual([{ path: 'output.ok', similarity: 0, expected: 'true', got: 'false' }]);
    expect(compareSample({ text: 'x y' }, [{ text: 'x y' }, { text: 'x y' }, { text: 'z' }])).toEqual({ agreement: 0.67, consistency: 0.33 });
  });
});

describe('model pinning and model-change checks', () => {
  let versionId = '';
  let flowId = '';

  it('pins the model a version is approved with and shows it on the review page', async () => {
    const v = await w.app.flows.create('Ticket summary', definition, w.alice);
    flowId = v.flowId;
    // A pending version shows the model it would get.
    let review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.approver) })).json();
    expect(review.aiModel).toBe('mock:m1');
    await w.app.flows.decide(v.id, w.approver, 'approved');
    versionId = v.id;
    review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.approver) })).json();
    expect(review.aiModel).toBe('mock:m1');
    expect(review.modelPins).toMatchObject({ organizationModel: 'mock:m1', history: [], check: null });
    await w.app.flowTests.save(w.alice, flowId, { name: 'printer', case: { inputs: { ticket: 'T-1: printer broken' }, answers: { summarize: { output: { text: 'The printer is broken' } } } } });
    const r = await run(w.app, versionId);
    expect(r.status).toBe('succeeded');
    expect(lastModel()).toBe('m1');
    // The first model the server sees is remembered; nothing to check yet.
    expect(await w.app.modelChanges.detect()).toBe(0);
  });

  it('follows the organization model at once when it changes, and checks the new one in the background', async () => {
    const m2 = withModel('m2');
    expect(await m2.modelChanges.detect()).toBe(1);
    expect(await m2.modelChanges.detect()).toBe(0);
    await m2.worker.drain();
    const list = await m2.modelChanges.list(w.approver);
    expect(list.currentModel).toBe('mock:m2');
    expect(list.waiting).toHaveLength(1);
    const check = list.waiting[0]!;
    expect(check).toMatchObject({ flowId, fromModel: 'mock:m1', toModel: 'mock:m2', status: 'passed' });
    expect(check.summary!.steps[0]).toMatchObject({ stepId: 'summarize', status: 'passed', samples: 2, calls: 6, failedCalls: 0, agreement: 1, consistency: 1 });
    // The test case and the recent run (its data is still kept) were both asked again.
    expect(check.details[0]!.samples.map((s) => s.source)).toEqual(['test', 'run']);
    expect(check.tokens.input).toBeGreaterThan(0);
    // Its tokens count against the Flow's team.
    const used = (await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE purpose = 'check' AND team_id IS NOT NULL AND model = 'm2'`)).rows[0]!.n;
    expect(used).toBe(6);
    // Runs follow the organization's model at once; nothing waits on the check.
    const r = await run(m2, versionId);
    expect(r.status).toBe('succeeded');
    expect(lastModel()).toBe('m2');
    // Approvers are told.
    const told = await w.db.query(`SELECT 1 FROM notifications WHERE member_id = $1 AND kind = 'model_change_checked'`, [w.approver.id]);
    expect(told.rowCount).toBeGreaterThan(0);
  });

  it('an approver accepts the checked model: recorded with who and when, and no new version', async () => {
    const m2 = apps[0]!;
    const checkId = (await m2.modelChanges.list(w.approver)).waiting[0]!.checkId;
    const m2api = buildServer(m2);
    try {
      // Members (even the Flow's owner) cannot switch it.
      expect((await m2api.inject({ method: 'POST', url: `/api/model-changes/${checkId}/decision`, headers: auth(w.tokens.alice), payload: { decision: 'accept' } })).statusCode).toBe(403);
      expect((await m2api.inject({ method: 'GET', url: '/api/model-changes', headers: auth(w.tokens.bob) })).statusCode).toBe(403);
      expect((await m2api.inject({ method: 'POST', url: `/api/model-changes/${checkId}/decision`, headers: auth(w.tokens.approver), payload: { decision: 'accept' } })).statusCode).toBe(204);
      expect((await m2api.inject({ method: 'POST', url: `/api/model-changes/${checkId}/decision`, headers: auth(w.tokens.approver), payload: { decision: 'accept' } })).json()).toEqual({ error: 'already_decided' });
      const review = (await m2api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: auth(w.tokens.approver) })).json();
      expect(review.aiModel).toBe('mock:m2');
      expect(review.modelPins.history).toEqual([expect.objectContaining({ from: 'mock:m1', to: 'mock:m2', by: 'approver', reason: null, check: 'passed' })]);
    } finally {
      await m2api.close();
    }
    expect((await w.app.flows.versions(flowId)).map((v) => v.version)).toEqual([1]);
    const audited = await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'flow.model_switched' AND actor_id = $1 AND subject_id = $2`, [w.approver.id, versionId]);
    expect(audited.rowCount).toBe(1);
    expect((await m2.modelChanges.list(w.approver)).waiting).toEqual([]);
    await run(m2, versionId);
    expect(lastModel()).toBe('m2');
  });

  it('shows differences per field, and accepts a switch despite them only with a reason, which is recorded and audited', async () => {
    const m3 = withModel('m3');
    expect(await m3.modelChanges.detect()).toBe(1);
    await m3.worker.drain();
    const check = (await m3.modelChanges.list(w.approver)).waiting[0]!;
    expect(check.status).toBe('differs');
    expect(check.summary!.steps[0]!.agreement).toBeLessThan(0.8);
    // A test's values are shown; a run's only by path (its data stays under the retention rules).
    const [fromTest, fromRun] = check.details[0]!.samples;
    expect(fromTest!.diffs).toEqual([expect.objectContaining({ path: 'output.text', expected: 'The printer is broken' })]);
    expect(fromRun!.diffs[0]).toEqual({ path: 'output.text', similarity: expect.any(Number) });
    await expect(m3.modelChanges.decide(w.approver, check.checkId, { decision: 'accept' })).rejects.toMatchObject({ code: 'reason_required' });
    await m3.modelChanges.decide(w.approver, check.checkId, { decision: 'accept', reason: 'Wording differs; the meaning is what the next step needs.' });
    const pin = (await w.db.query(`SELECT from_model, to_model, reason FROM flow_model_pins WHERE flow_version_id = $1 ORDER BY decided_at DESC LIMIT 1`, [versionId])).rows[0];
    expect(pin).toEqual({ from_model: 'mock:m2', to_model: 'mock:m3', reason: 'Wording differs; the meaning is what the next step needs.' });
    const audited = await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'flow.model_switched_despite_differences' AND subject_id = $1`, [versionId]);
    expect(audited.rowCount).toBe(1);
  });

  it('fails the check when the new model cannot answer; keeping the old model locks the Flow to it', async () => {
    const gone = withModel('gone');
    expect(await gone.modelChanges.detect()).toBe(1);
    await gone.worker.drain();
    const check = (await gone.modelChanges.list(w.approver)).waiting[0]!;
    expect(check.status).toBe('failed');
    expect(Object.keys(check.summary!.steps[0]!.errors)).toEqual(['pinned_model_unavailable']);
    await gone.modelChanges.decide(w.approver, check.checkId, { decision: 'keep' });
    expect((await gone.modelChanges.list(w.approver)).waiting).toEqual([]);
    expect((await w.app.flows.getVersion(w.db, versionId))!).toMatchObject({ aiModel: 'mock:m3', modelLocked: true });
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'flow.model_kept' AND subject_id = $1`, [versionId])).rowCount).toBe(1);
    // Runs go on with the locked model, whatever the organization uses now.
    expect((await run(gone, versionId)).status).toBe('succeeded');
    expect(lastModel()).toBe('m3');
  });

  it("falls back to the organization's model when the locked one is gone, says so, and tells approvers", async () => {
    const m2 = apps[0]!;
    ai.known.delete('m3');
    const r = await run(m2, versionId);
    expect(r.status).toBe('succeeded');
    expect(lastModel()).toBe('m2');
    expect(r.commentary.map((l: { text: string }) => l.text)).toContain("The model mock:m3 is not available: using the organization's model mock:m2 instead");
    await new Promise((res) => setTimeout(res, 50));
    const told = await w.db.query(`SELECT 1 FROM notifications WHERE member_id = $1 AND kind = 'pinned_model_unavailable'`, [w.approver.id]);
    expect(told.rowCount).toBe(1);
    ai.known.add('m3');
  });

  it("respects the team's AI budget: the check is skipped with a clear status", async () => {
    const m2 = withModel('m2');
    const team = await w.app.flows.teamOfVersion(w.db, versionId);
    await w.db.query(`INSERT INTO ai_budgets (team_id, monthly_tokens) VALUES ($1, 1000)`, [team]);
    await w.db.query(`INSERT INTO ai_usage (team_id, purpose, key_owner, provider, model, input_tokens, output_tokens) VALUES ($1, 'other', 'organization', 'mock', 'm1', 5000, 0)`, [team]);
    const before = ai.calls.length;
    expect(await m2.modelChanges.detect()).toBe(1);
    await m2.worker.drain();
    const check = (await m2.modelChanges.list(w.approver)).waiting[0]!;
    expect(check.status).toBe('skipped_budget');
    expect(check.summary!.note).toMatch(/budget/);
    expect(ai.calls.length).toBe(before);
    await w.db.query(`DELETE FROM ai_budgets WHERE team_id = $1`, [team]);
    // Run again once the budget allows it.
    const { checkId } = await m2.modelChanges.recheck(w.approver, versionId);
    await m2.worker.drain();
    const again = (await m2.modelChanges.list(w.approver)).waiting[0]!;
    expect(again.checkId).toBe(checkId);
    expect(again.status).not.toBe('skipped_budget');
  });

  it('approvers lock and unlock a Flow; a run may pick its own model unless the Flow is locked', async () => {
    const m2 = apps[0]!;
    const m2api = buildServer(m2);
    try {
      const lock = (token: string, model: string | null) => m2api.inject({ method: 'PUT', url: `/api/flow-versions/${versionId}/model-lock`, headers: auth(token), payload: { model } });
      const start = (model?: string) => m2api.inject({ method: 'POST', url: `/api/flow-versions/${versionId}/runs`, headers: auth(w.tokens.alice), payload: { inputs: { ticket: 'T-2' }, ...(model ? { model } : {}) } });
      // Locked (to m3, above): a run cannot pick another model.
      expect((await start('mock:m1')).json().error).toBe('flow_model_locked');
      expect((await lock(w.tokens.alice, null)).statusCode).toBe(403);
      expect((await lock(w.tokens.approver, 'nope:x')).json().error).toBe('ai_provider_not_configured');
      expect((await lock(w.tokens.approver, null)).statusCode).toBe(204);
      expect((await w.app.flows.getVersion(w.db, versionId))!.modelLocked).toBe(false);
      // Unlocked: it follows the organization's model (m2)...
      await run(m2, versionId);
      expect(lastModel()).toBe('m2');
      // ...and a run may be started with another one, shown on the run.
      const started = await start('mock:m1');
      expect(started.statusCode).toBe(202);
      await m2.worker.drain();
      expect(lastModel()).toBe('m1');
      expect((await m2.engine.runView(started.json().runId, w.alice)).aiModel).toBe('mock:m1');
      expect((await start('not a model')).json().error).toBe('invalid_model');
      // Everyone sees the models a run can pick, the organization's first.
      const models = (await m2api.inject({ method: 'GET', url: '/api/ai/run-models', headers: auth(w.tokens.alice) })).json();
      expect(models.organization).toBe('mock:m2');
      expect(models.models[0]).toBe('mock:m2');
      // Locking again: kept in the version's model history and audited.
      expect((await lock(w.tokens.approver, 'mock:m1')).statusCode).toBe(204);
      await run(m2, versionId);
      expect(lastModel()).toBe('m1');
      const history = (await m2.modelChanges.pinView(versionId)).history.slice(-2).map((h) => h.to);
      expect(history).toEqual(['organization', 'mock:m1']);
      expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action IN ('flow.model_locked', 'flow.model_unlocked') AND subject_id = $1`, [versionId])).rowCount).toBe(2);
    } finally {
      await m2api.close();
    }
  });
});

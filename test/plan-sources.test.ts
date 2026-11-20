import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePlan, planContext } from '../src/ai/plan.js';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * Everything a plan needs is built in Dittoly by its AI: a module an approved one lacks an action of becomes that
 * module's next version (written from its code), a draft whose own tests fail goes back to the AI with what failed,
 * and a busy AI service is tried again later. Nothing ready-made is offered to the planner.
 */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const slack = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  api = buildServer(w.app);
  await approveExampleModules(w);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const plan = (p: Record<string, unknown>) => ({ title: 'P', summary: 'S', questions: [], modules: [], flows: [], reuse: [], superFlow: null, ...p });
/** A home chat whose plan is `p`, built: returns the plan's id. */
async function build(p: Record<string, unknown>): Promise<string> {
  ai.enqueue({ reply: 'Planned.', planJson: JSON.stringify(plan(p)) });
  const { chatId } = (await api.inject({ method: 'POST', url: '/api/chat/plan', headers: auth(w.tokens.alice), payload: { message: 'go' } })).json();
  const res = await api.inject({ method: 'POST', url: '/api/plans/from-chat', headers: auth(w.tokens.alice), payload: { chatId } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}
const items = async (id: string) => (await api.inject({ method: 'GET', url: `/api/plans/${id}`, headers: auth(w.tokens.alice) })).json().items;

describe('the planner', () => {
  it('is offered nothing ready-made: only the approved actions and Flows', () => {
    const text = planContext({ catalog: '- slack@1.0.0 post_message (write): Post. Posts.' });
    expect(text).not.toMatch(/READY-MADE|github-review|template/i);
  });

  it('keeps a module to extend by its name; ready-made fields are ignored', () => {
    const out = parsePlan({
      planJson: JSON.stringify(plan({
        modules: [
          { key: 'review', title: 'R', request: 'r', example: 'github-review' },
          { key: 'more', title: 'M', request: 'm', extends: 'slack@1.0.0' },
        ],
        flows: [{ key: 'pr', title: 'PR', request: 'p', needs: ['review'], template: 'github-pr-review' }],
      })),
    });
    if ('error' in out) throw new Error(out.error);
    expect(out.plan.modules).toEqual([
      { key: 'review', title: 'R', request: 'r' },
      { key: 'more', title: 'M', request: 'm', extends: 'slack' },
    ]);
    expect(out.plan.flows).toEqual([{ key: 'pr', title: 'PR', request: 'p', needs: ['review'] }]);
  });
});

describe('a plan builds on approved modules', () => {
  it('a module to extend becomes its next version, written from its current manifest and code', async () => {
    const manifest = JSON.parse(await readFile(path.join(slack, 'manifest.json'), 'utf8'));
    const code = await readFile(path.join(slack, 'module.mjs'), 'utf8');
    const id = await build({ modules: [{ key: 'more_slack', title: 'Slack: more', request: 'Add an action that deletes a message.', extends: 'slack' }] });
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, version: '1.0.1' }), code, testsJson: await readFile(path.join(slack, 'tests.json'), 'utf8') });
    await w.app.worker.drain();
    const it = await items(id);
    expect(it[0]).toMatchObject({ status: 'in_review', moduleName: 'slack', basedOn: 'extends:slack' });
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain('Revise the module "slack"');
    expect(prompt).toContain('Keep every existing action');
    expect(prompt).toContain('slack.com/api/chat.postMessage');
  }, 60_000);

  it('a Flow that needs actions an approved module lacks: the plan adds them to that module, and the Flow waits', async () => {
    const manifest = JSON.parse(await readFile(path.join(slack, 'manifest.json'), 'utf8'));
    const code = await readFile(path.join(slack, 'module.mjs'), 'utf8');
    const id = await build({ flows: [{ key: 'pins', title: 'Pin release notes', request: 'Post the notes to #release and pin them.', needs: [] }] });
    // The check before drafting finds what is missing; the AI then declines to draft without it.
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Posts and pins.', category: 'web_api', protocols: ['rest'], questions: [], missing: [{ capability: 'Pin a message', moduleRequest: 'Add an action that pins a message in a channel (write).', module: 'slack' }] }) });
    ai.enqueue({ name: 'Pin release notes', definitionJson: '', explanation: 'Slack cannot pin messages yet.' });
    // The module item it adds is drafted at once: the next version of slack, from its code.
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, version: '1.0.2' }), code, testsJson: await readFile(path.join(slack, 'tests.json'), 'utf8') });
    await w.app.worker.drain();
    const it = await items(id);
    expect(it.map((i: { kind: string; key: string; status: string; basedOn: string | null }) => [i.kind, i.key, i.status, i.basedOn])).toEqual([
      ['flow', 'pins', 'waiting', null],
      ['module', 'pins_needs_1_1', 'in_review', 'extends:slack'],
    ]);
    expect(it[0].needs).toEqual(['pins_needs_1_1']);
    expect(it[1].title).toBe('Add to slack: Pin a message');
    expect(ai.requests.at(-1)!.prompt).toContain('Revise the module "slack"');
  }, 60_000);

  it('the Flow drafter can name a missing part itself; a second round is added, then the Flow fails with its reason', async () => {
    const manifest = JSON.parse(await readFile(path.join(slack, 'manifest.json'), 'utf8'));
    const code = await readFile(path.join(slack, 'module.mjs'), 'utf8');
    const tests = await readFile(path.join(slack, 'tests.json'), 'utf8');
    const id = await build({ flows: [{ key: 'filter', title: 'Post only new notes', request: 'Post the notes unless already posted.', needs: [] }] });
    const declines = (capability: string) => ({ name: 'Post only new notes', definitionJson: 'null', explanation: `Needs ${capability}.`, missingJson: JSON.stringify([{ capability, moduleRequest: `An action that does: ${capability} (read, calls no app).` }]) });
    // Round 1: the check finds nothing missing; the drafter itself names a part. A new module is drafted for it.
    ai.enqueue(declines('Filter already posted notes'));
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, name: 'notes-filter', title: 'Notes filter' }), code, testsJson: tests });
    await w.app.worker.drain();
    let it = await items(id);
    const flow = it.find((i: { key: string }) => i.key === 'filter');
    expect(flow).toMatchObject({ status: 'waiting', needs: ['filter_needs_1_1'] });
    expect(it.find((i: { key: string }) => i.key === 'filter_needs_1_1')).toMatchObject({ title: 'Filter already posted notes', status: 'in_review', basedOn: null });
    // Approved: the Flow is drafted again and names one more part (round 2).
    await w.app.modules.decide(it.find((i: { key: string }) => i.key === 'filter_needs_1_1').moduleVersionId, w.admin, 'approved');
    ai.enqueue(declines('Normalize note text'));
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, name: 'notes-normal', title: 'Notes normal' }), code, testsJson: tests });
    await w.app.worker.drain();
    it = await items(id);
    expect(it.find((i: { key: string }) => i.key === 'filter').needs).toEqual(['filter_needs_1_1', 'filter_needs_2_1']);
    // After two rounds a third decline fails the Flow with the AI's reason.
    await w.app.modules.decide(it.find((i: { key: string }) => i.key === 'filter_needs_2_1').moduleVersionId, w.admin, 'approved');
    ai.enqueue(declines('Something else'));
    await w.app.worker.drain();
    it = await items(id);
    expect(it.find((i: { key: string }) => i.key === 'filter')).toMatchObject({ status: 'failed', error: 'flow_not_drafted' });
    expect(it.filter((i: { key: string }) => i.key.startsWith('filter_needs_'))).toHaveLength(2);
  }, 90_000);

  it('details the person added can be removed, so the next try drafts without them', async () => {
    const id = await build({ flows: [{ key: 'gone', title: 'Gone', request: 'Do it.', needs: [] }] });
    ai.enqueue({ name: 'Gone', definitionJson: 'null', explanation: 'Cannot.', missingJson: '[]' });
    await w.app.worker.drain();
    let it = await items(id);
    expect(it[0].status).toBe('failed');
    ai.enqueue({ name: 'Gone', definitionJson: 'null', explanation: 'Still cannot.', missingJson: '[]' });
    await api.inject({ method: 'POST', url: `/api/plans/${id}/items/${it[0].id}/retry`, headers: auth(w.tokens.alice), payload: { notes: 'Use the moon API.' } });
    await w.app.worker.drain();
    it = await items(id);
    expect(it[0].notes).toBe('Use the moon API.');
    const res = await api.inject({ method: 'DELETE', url: `/api/plans/${id}/items/${it[0].id}/notes`, headers: auth(w.tokens.alice) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items[0].notes).toBeNull();
    // Someone else's plan reads as missing.
    expect((await api.inject({ method: 'DELETE', url: `/api/plans/${id}/items/${it[0].id}/notes`, headers: auth(w.tokens.bob) })).statusCode).toBe(404);
  });

  it('a busy AI service does not fail the item: it is tried again later', async () => {
    const id = await build({ modules: [{ key: 'chat_thing', title: 'Chat thing', request: 'Slack: post a message (write).' }] });
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Posts to Slack.', category: 'web_api', protocols: ['rest'], questions: [] }) });
    ai.fail('ai_rate_limited');
    await w.app.worker.drain();
    const it = await items(id);
    expect(it[0]).toMatchObject({ status: 'queued', error: null });
    const job = (await w.db.query(`SELECT payload, run_at > now() AS later FROM jobs WHERE kind = 'plan_item' AND payload->>'itemId' = $1 AND failed_at IS NULL ORDER BY id DESC LIMIT 1`, [it[0].id])).rows[0];
    expect(job).toMatchObject({ payload: { tries: '1' }, later: true });
  });
});

describe('a draft whose own tests fail', () => {
  it('goes back to the AI with what failed, and the fixed draft is the one stored', async () => {
    const manifest = JSON.parse(await readFile(path.join(slack, 'manifest.json'), 'utf8'));
    const code = await readFile(path.join(slack, 'module.mjs'), 'utf8');
    const tests = await readFile(path.join(slack, 'tests.json'), 'utf8');
    const m = { ...manifest, name: 'slack-again', title: 'Slack again' };
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Posts to Slack.', category: 'web_api', protocols: ['rest'], questions: [] }) });
    // The first draft's post_message always fails: its test that expects it to post fails.
    ai.enqueue({ manifestJson: JSON.stringify(m), code: code.replace('async post_message(input, ctx) {', "async post_message(input, ctx) {\n    throw new ctx.ActionError('broken', { retryable: false });"), testsJson: tests });
    ai.enqueue({ manifestJson: JSON.stringify(m), code, testsJson: tests });
    const out = await w.app.moduleChat.generate('Slack: post a message to a channel (write).', w.alice);
    if (!('draft' in out)) throw new Error('asked questions');
    expect(out.draft.validationReport?.passed, JSON.stringify(out.draft.validationReport)).toBe(true);
    expect(out.draft.source ?? out.draft.code).not.toContain('broken');
    expect(ai.requests.at(-1)!.prompt).toContain('The sandbox validation failed');
    // Only the fixed draft was stored.
    expect((await w.db.query(`SELECT count(*)::int AS n FROM module_versions WHERE name = 'slack-again'`)).rows[0].n).toBe(1);
  }, 60_000);
});

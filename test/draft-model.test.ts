import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { draftModelFor, setDraftModel } from '../src/ai/draft-model.js';
import { makeWorld, type World } from './helpers.js';

/**
 * The organization has one model, and that is the right default and the wrong answer often enough. Whoever
 * drafts a Flow, a module or a plan picks the model for it; the choice stays with that thing, and what the
 * version records afterwards is the model that actually answered.
 */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('which model drafts what', () => {
  it('falls back from the thing, to the member, to the organization', async () => {
    const flow = await w.app.flows.create('Anything', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'wait', type: 'delay', seconds: 1 }] }, w.alice);
    expect(await draftModelFor(w.db, { type: 'flow', id: flow.flowId }, w.alice.id)).toBe(null);

    await setDraftModel(w.db, w.alice, { type: 'member', id: w.alice.id }, { model: 'cheap-one' });
    expect(await draftModelFor(w.db, { type: 'flow', id: flow.flowId }, w.alice.id)).toMatchObject({ model: 'cheap-one' });

    await setDraftModel(w.db, w.alice, { type: 'flow', id: flow.flowId }, { model: 'the-big-one', effort: 'high' });
    expect(await draftModelFor(w.db, { type: 'flow', id: flow.flowId }, w.alice.id)).toMatchObject({ model: 'the-big-one', effort: 'high' });

    // Back to the organization's for this Flow: the member's choice is still theirs for the next new thing.
    await setDraftModel(w.db, w.alice, { type: 'flow', id: flow.flowId }, null);
    expect(await draftModelFor(w.db, { type: 'flow', id: flow.flowId }, w.alice.id)).toMatchObject({ model: 'cheap-one' });
  });

  it('is for the people who draft it, not everyone', async () => {
    const flow = await w.app.flows.create('Bob may not', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'wait', type: 'delay', seconds: 1 }] }, w.alice);
    await expect(setDraftModel(w.db, w.bob, { type: 'flow', id: flow.flowId }, { model: 'x' })).rejects.toMatchObject({ httpStatus: 403 });
    // Their own default is their own business, and an admin may set anyone's thing.
    await setDraftModel(w.db, w.bob, { type: 'member', id: w.bob.id }, { model: 'bobs-model' });
    await setDraftModel(w.db, w.admin, { type: 'flow', id: flow.flowId }, { model: 'admins-choice' });
    expect(await draftModelFor(w.db, { type: 'flow', id: flow.flowId })).toMatchObject({ model: 'admins-choice' });
  });

  it('asks that model when the module is drafted again, and the version records what answered', async () => {
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { version: string };
    const mv = await w.app.modules.createDraft(
      {
        manifest,
        code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
        tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
        origin: 'seed',
      },
      w.alice,
    );
    await setDraftModel(w.db, w.alice, { type: 'module', id: 'slack' }, { model: 'slack-model', effort: 'low' });
    ai.enqueue({
      manifestJson: JSON.stringify({ ...manifest, version: '1.0.1' }),
      code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
      testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8'),
    });
    const before = ai.requests.length;
    await w.app.moduleChat.revise(mv.id, 'tidy it', w.alice);
    expect(ai.requests.length).toBeGreaterThan(before);
    // The provider was asked for that model, at that effort.
    expect(ai.requests.at(-1)).toMatchObject({ model: 'slack-model', effort: 'low' });
  });

  it('is chosen through the API by whoever may draft it, and read back', async () => {
    const flow = await w.app.flows.create('Through the API', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'wait', type: 'delay', seconds: 1 }] }, w.alice);
    const put = await api.inject({ method: 'PUT', url: `/api/ai/draft-model/flow/${flow.flowId}`, headers: auth(w.tokens.alice), payload: { choice: { model: 'picked-in-the-ui' } } });
    expect(put.statusCode, put.body).toBe(204);
    const got = await api.inject({ method: 'GET', url: `/api/ai/draft-model/flow/${flow.flowId}`, headers: auth(w.tokens.alice) });
    expect(got.json()).toMatchObject({ chosen: { model: 'picked-in-the-ui' }, inUse: { model: 'picked-in-the-ui' } });
    const refused = await api.inject({ method: 'PUT', url: `/api/ai/draft-model/flow/${flow.flowId}`, headers: auth(w.tokens.bob), payload: { choice: { model: 'no' } } });
    expect(refused.statusCode).toBe(403);
  });
});

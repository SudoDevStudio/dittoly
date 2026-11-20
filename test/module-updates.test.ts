import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { moduleUpdates, semverCmp } from '../src/flows/module-updates.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * A Flow keeps the module versions it was approved with, which is the point — but when a newer one is approved,
 * its owner should be able to move it in one press instead of asking the AI to write the Flow again.
 */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

/** The slack fixture again at `version`, approved; `needsThread` makes post_message ask for one more field. */
async function approvedSlack(version: string, needsThread = false) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
    version: string;
    actions: { name: string; input: { properties: Record<string, unknown>; required: string[] } }[];
  };
  manifest.version = version;
  const tests = JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')) as { action: string; input: Record<string, unknown> }[];
  if (needsThread) {
    const post = manifest.actions.find((a) => a.name === 'post_message')!;
    post.input.properties.thread = { type: 'string', minLength: 1 };
    post.input.required = [...post.input.required, 'thread'];
    for (const t of tests) if (t.action === 'post_message') t.input.thread = 'T-1';
  }
  const mv = await w.app.modules.createDraft(
    {
      manifest,
      code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
      tests,
      origin: 'seed',
    },
    w.alice,
  );
  await w.app.modules.submit(mv.id, w.alice);
  await w.app.modules.decide(mv.id, w.admin, 'approved');
  return mv;
}

const def = (ref: string) => ({
  inputs: { type: 'object', properties: {} },
  steps: [{ id: 'tell', title: 'Tell the team', type: 'action', module: ref, action: 'post_message', input: { channel: '#team', text: 'hi' } }],
});

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  api = buildServer(w.app);
  await approveExampleModules(w);
}, 60_000);
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('moving a Flow to a newer module', () => {
  it('compares versions as numbers, not as text', () => {
    expect(semverCmp('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(semverCmp('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(semverCmp('2.0.0', '2.0.0')).toBe(0);
  });

  it('says which module has a newer approved version, and moves it on one press', async () => {
    const v = await w.app.flows.create('Tell the team', def('slack@1.0.0'), w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    await w.app.flowTests.save(w.alice, v.flowId, { name: 'posts', case: { answers: { tell: { output: { ts: '1' } } }, expect: { status: 'succeeded' } } });
    // Nothing newer yet.
    expect(await moduleUpdates(w.db, v.definition)).toEqual([]);

    await approvedSlack('1.3.0');
    expect(await moduleUpdates(w.db, v.definition)).toEqual([{ module: 'slack', pinned: '1.0.0', latest: '1.3.0' }]);

    // Someone who is neither the owner nor an admin cannot move it.
    const refused = await api.inject({ method: 'POST', url: `/api/flows/${v.flowId}/update-modules`, headers: auth(w.tokens.bob), payload: {} });
    expect(refused.statusCode).toBe(403);

    const res = await api.inject({ method: 'POST', url: `/api/flows/${v.flowId}/update-modules`, headers: auth(w.tokens.alice), payload: {} });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ version: 2, updated: [{ module: 'slack', pinned: '1.0.0', latest: '1.3.0' }], tests: { total: 1, passed: 1 } });

    // A new version to approve; the approved one still runs the version it was approved with.
    const versions = await w.app.flows.versions(v.flowId);
    expect(versions.at(-1)).toMatchObject({ version: 2, status: 'pending' });
    expect(JSON.stringify(versions.at(-1)!.definition)).toContain('slack@1.3.0');
    expect(JSON.stringify(versions.find((x) => x.version === 1)!.definition)).toContain('slack@1.0.0');
  });

  it('refuses when there is nothing to move', async () => {
    const v = await w.app.flows.create('Nothing newer', def('slack@1.3.0'), w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const res = await api.inject({ method: 'POST', url: `/api/flows/${v.flowId}/update-modules`, headers: auth(w.tokens.alice), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_module_updates');
  });

  it('has the AI draft the steps again when the newer module takes something else', async () => {
    const v = await w.app.flows.create('Tell them twice', def('slack@1.3.0'), w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    await w.app.flowTests.save(w.alice, v.flowId, { name: 'posts', case: { answers: { tell: { output: { ts: '1' } } }, expect: { status: 'succeeded' } } });
    await approvedSlack('2.0.0', true);

    // What the AI answers when Dittoly asks it to fit the Flow to the newer module.
    ai.enqueue({
      name: 'Tell them twice',
      definitionJson: JSON.stringify({
        inputs: { type: 'object', properties: {} },
        steps: [{ id: 'tell', title: 'Tell the team', type: 'action', module: 'slack@2.0.0', action: 'post_message', input: { channel: '#team', text: 'hi', thread: 'T-1' } }],
      }),
      explanation: 'Sends the thread the newer module needs.',
      missingJson: '[]',
      splitJson: '[]',
      sourcesJson: '[]',
      notesMd: '',
      testsJson: '[]',
    });
    const res = await api.inject({ method: 'POST', url: `/api/flows/${v.flowId}/update-modules`, headers: auth(w.tokens.alice), payload: {} });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ redrafted: true, tests: { total: 1, passed: 1 } });
    const latest = (await w.app.flows.versions(v.flowId)).at(-1)!;
    expect(JSON.stringify(latest.definition)).toContain('"thread":"T-1"');
    expect(JSON.stringify(latest.definition)).toContain('slack@2.0.0');
  });

  it('proposes nothing when even the AI cannot make the examples pass', async () => {
    const v = await w.app.flows.create('Tell them thrice', def('slack@1.3.0'), w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    await w.app.flowTests.save(w.alice, v.flowId, { name: 'posts', case: { answers: { tell: { output: { ts: '1' } } }, expect: { status: 'succeeded' } } });
    await approvedSlack('3.0.0', true);
    // The AI answers with the same Flow it was given: still missing what the newer module asks for.
    ai.enqueue({
      name: 'Tell them thrice',
      definitionJson: JSON.stringify(def('slack@3.0.0')),
      explanation: 'Unchanged.',
      missingJson: '[]',
      splitJson: '[]',
      sourcesJson: '[]',
      notesMd: '',
      testsJson: '[]',
    });
    const res = await api.inject({ method: 'POST', url: `/api/flows/${v.flowId}/update-modules`, headers: auth(w.tokens.alice), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('flow_needs_changes');
    // Nothing was proposed: the Flow still has only its approved version.
    expect((await w.app.flows.versions(v.flowId)).length).toBe(1);
  });

  it('drafts the whole Flow again on one press, on the newest modules', async () => {
    const v = await w.app.flows.create('Tell them once more', def('slack@1.3.0'), w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    ai.enqueue({
      name: 'Tell them once more',
      definitionJson: JSON.stringify({
        inputs: { type: 'object', properties: {} },
        steps: [
          { id: 'ok', type: 'approval' },
          { id: 'tell', title: 'Tell the team', type: 'action', module: 'slack@3.0.0', action: 'post_message', input: { channel: '#team', text: 'hi', thread: 'T-1' } },
        ],
      }),
      explanation: 'Moved to the newest module and put a sign-off before it posts.',
      missingJson: '[]',
      splitJson: '[]',
      sourcesJson: '[]',
      notesMd: '',
      testsJson: '[]',
    });
    const res = await api.inject({ method: 'POST', url: `/api/flows/${v.flowId}/redraft`, headers: auth(w.tokens.alice), payload: {} });
    expect(res.statusCode, res.body).toBe(201);
    // It was told which modules to move to, and what a reviewer would send back.
    const asked = ai.requests.at(-1)!.prompt;
    expect(asked).toContain('slack 1.3.0');
    expect(asked).toContain('sign-off');
    const latest = (await w.app.flows.versions(v.flowId)).at(-1)!;
    expect(latest).toMatchObject({ version: 2, status: 'pending' });
    expect(JSON.stringify(latest.definition)).toContain('slack@3.0.0');

    // Not for anyone else.
    expect((await api.inject({ method: 'POST', url: `/api/flows/${v.flowId}/redraft`, headers: auth(w.tokens.bob), payload: {} })).statusCode).toBe(403);
  });
});

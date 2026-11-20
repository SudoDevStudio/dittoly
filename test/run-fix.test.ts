import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { MockProvider } from '../src/ai/provider.js';
import { sentOf } from '../src/runtime/broker.js';
import { approveExampleModules, makeWorld, runStatus, type World } from './helpers.js';

/**
 * "Have the AI fix <module>" on a stopped run: what the AI does shows in the run's commentary (the Live panel), and
 * once an admin approves the fixed module, the run's Flow gets a new version that uses it; once that is approved,
 * the run continues on it.
 */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const slack = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
const slackAnswer = async () => ({
  manifestJson: await readFile(path.join(slack, 'manifest.json'), 'utf8'),
  code: await readFile(path.join(slack, 'module.mjs'), 'utf8'),
  testsJson: await readFile(path.join(slack, 'tests.json'), 'utf8'),
});

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  api = buildServer(w.app);
  await approveExampleModules(w);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('the AI fixes a module from a stopped run', () => {
  it('narrates the fix, then proposes the Flow on the approved fix, and the run continues on it', async () => {
    const v = await w.app.flows.create('Tell the team', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'tell', title: 'Tell the team', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text: 'hi' } }] }, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    // No Slack credential yet: the step fails and the run stops.
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).status).toBe('paused');
    const slackId = (await w.db.query<{ id: string }>(`SELECT id FROM module_versions WHERE name = 'slack' AND version = '1.0.0'`)).rows[0]!.id;

    // Only someone who may see the run asks for it.
    ai.enqueue(await slackAnswer());
    expect((await api.inject({ method: 'POST', url: `/api/modules/${slackId}/revise`, headers: auth(w.tokens.bob), payload: { feedback: 'fix it', forRun: runId } })).statusCode).toBe(403);
    const res = await api.inject({ method: 'POST', url: `/api/modules/${slackId}/revise`, headers: auth(w.tokens.alice), payload: { feedback: 'fix it', forRun: runId } });
    expect(res.statusCode, res.body).toBe(201);
    const fixed = res.json() as { id: string; ref: string };
    const said = (await runStatus(w, runId, w.alice)).commentary.map((l: { text: string }) => l.text);
    expect(said).toContain('The AI is drafting a fixed version of slack (slack@1.0.0)');
    expect(said.some((t: string) => t.startsWith(`Fixed version ${fixed.ref} drafted`))).toBe(true);

    // Approved by an admin: the run's Flow gets a version on the fix, for an approver.
    await w.app.modules.submit(fixed.id, w.alice);
    await w.app.modules.decide(fixed.id, w.admin, 'approved');
    await w.app.worker.drain();
    const versions = await w.app.flows.versions(v.flowId);
    const proposed = versions.at(-1)!;
    expect(proposed).toMatchObject({ version: 2, status: 'pending' });
    expect(JSON.stringify(proposed.definition)).toContain(fixed.ref);

    // Approved too: the stopped run is offered to continue on it.
    await w.app.flows.decide(proposed.id, w.approver, 'approved');
    const next = (await runStatus(w, runId, w.alice)).nextSteps!;
    expect(next.fixes[0]).toMatchObject({ kind: 'continue', label: 'Continue on version 2' });
  });
});

describe('a fixed module the Flow no longer fits', () => {
  it('drafts the Flow again instead of pinning it and failing the same way', async () => {
    // The Flow sends what slack@1.0.0 takes, and carries an example of a good run.
    const def = (ref: string, extra: Record<string, unknown> = {}) => ({
      inputs: { type: 'object', properties: {} },
      steps: [{ id: 'tell', title: 'Tell the team', type: 'action', module: ref, action: 'post_message', input: { channel: '#team', text: 'hi', ...extra } }],
    });
    const v = await w.app.flows.create('Tell the team again', def('slack@1.0.0'), w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    await w.app.flowTests.save(w.alice, v.flowId, { name: 'posts', case: { answers: { tell: { output: { ts: '1' } } }, expect: { status: 'succeeded' } } });
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).status).toBe('paused');

    // The fixed module takes a thread id as well, so the Flow as it stands no longer fits it.
    const manifest = JSON.parse(await readFile(path.join(slack, 'manifest.json'), 'utf8')) as {
      version: string;
      actions: { name: string; input: { properties: Record<string, unknown>; required: string[] } }[];
    };
    manifest.version = '1.1.0';
    const post = manifest.actions.find((a) => a.name === 'post_message')!;
    post.input.properties.thread = { type: 'string', minLength: 1 };
    post.input.required = [...post.input.required, 'thread'];
    const tests = JSON.parse(await readFile(path.join(slack, 'tests.json'), 'utf8')) as { action: string; input: Record<string, unknown> }[];
    for (const t of tests) if (t.action === 'post_message') t.input.thread = 'T-1';
    ai.enqueue({ ...(await slackAnswer()), manifestJson: JSON.stringify(manifest), testsJson: JSON.stringify(tests) });
    const slackId = (await w.db.query<{ id: string }>(`SELECT id FROM module_versions WHERE name = 'slack' AND version = '1.0.0'`)).rows[0]!.id;
    const res = await api.inject({ method: 'POST', url: `/api/modules/${slackId}/revise`, headers: auth(w.tokens.alice), payload: { feedback: 'take a thread id', forRun: runId } });
    expect(res.statusCode, res.body).toBe(201);
    const fixed = res.json() as { id: string; ref: string };

    // What the AI answers when Dittoly asks it to fit the Flow to the fixed module.
    ai.enqueue({
      name: 'Tell the team again',
      definitionJson: JSON.stringify(def(fixed.ref, { thread: 'T-1' })),
      explanation: 'Sends the thread the fixed module now needs.',
      missingJson: '[]',
      splitJson: '[]',
      sourcesJson: '[]',
      notesMd: '',
      testsJson: '[]',
    });
    await w.app.modules.submit(fixed.id, w.alice);
    await w.app.modules.decide(fixed.id, w.admin, 'approved');
    await w.app.worker.drain();

    const proposed = (await w.app.flows.versions(v.flowId)).at(-1)!;
    expect(proposed).toMatchObject({ version: 2, status: 'pending' });
    const review = await w.app.flows.review(proposed.id);
    expect(review.generation?.fix).toMatchObject({ module: 'slack', toVersion: '1.1.0', redrafted: true });
    // Not a bare re-pin: the step carries what the fixed module asks for, and the Flow's example passes again.
    expect(JSON.stringify(proposed.definition)).toContain('"thread":"T-1"');
    expect((await w.app.flowTests.results(w.alice, proposed.id)).passed).toBe(1);
    // And the run that asked for the fix is told, on its own page.
    const said = (await runStatus(w, runId, w.alice)).commentary.map((l: { text: string }) => l.text).join('\n');
    expect(said).toContain('Version 2 of this Flow was drafted for the fixed module');
  });
});

describe('what a refused call sent', () => {
  it('says the query and the body, shortened', () => {
    expect(sentOf(new URL('https://api.github.com/search/issues?q=is%3Apr+repo%3Aacme%2Fapp'), undefined)).toBe(' · sent query: q=is:pr repo:acme/app');
    expect(sentOf(new URL('https://x.test/a'), '{"text":"hi"}')).toBe(' · sent body: {"text":"hi"}');
    expect(sentOf(new URL('https://x.test/a'), new Uint8Array(12))).toBe(' · sent body: (12 bytes)');
    expect(sentOf(new URL('https://x.test/a'), 'x'.repeat(2000)).length).toBeLessThan(1030);
    expect(sentOf(new URL('https://x.test/a'), undefined)).toBe('');
  });
});

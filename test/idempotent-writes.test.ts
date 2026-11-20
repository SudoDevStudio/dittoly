import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifestChanges } from '../src/modules/diff.js';
import { manifestSchema, reviewSummary } from '../src/modules/manifest.js';
import { approveExampleModules, makeWorld, runStatus, type World } from './helpers.js';

/**
 * A write whose answer was lost (or whose worker died mid-call) stops with uncertain_outcome: Dittoly cannot know
 * whether the change reached the app. A write its module marks idempotent finds what an earlier call made, so Dittoly
 * repeats it instead. The error-to-fix publish actions are marked so (see error-to-fix-e2e "every publish answer is lost").
 */

const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
let w: World;
let manifest: Record<string, any>;
const flows: Record<string, string> = {};

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice');
  manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  // The same Slack module, its post marked idempotent (as if the module found its earlier message).
  const idem = { ...manifest, name: 'slack-idem', actions: manifest.actions.map((a: any) => (a.name === 'post_message' ? { ...a, idempotent: true } : a)) };
  const mv = await w.app.modules.createDraft({ manifest: idem, code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')), origin: 'seed' }, w.alice);
  expect(mv.validationReport?.passed).toBe(true);
  await w.app.modules.submit(mv.id, w.alice);
  await w.app.modules.decide(mv.id, w.admin, 'approved');
  for (const mod of ['slack', 'slack-idem']) {
    const def = { inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', type: 'action', module: `${mod}@1.0.0`, action: 'post_message', input: { channel: 'C-idem', text: 'hello' } }] };
    const v = await w.app.flows.create(`Post with ${mod}`, def, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    flows[mod] = v.id;
  }
});
afterAll(async () => w.db.end());

describe('a lost answer', () => {
  it('stops a plain write as uncertain_outcome, never repeating it', async () => {
    w.fake.failNext['POST slack.com'] = ['network'];
    const runId = await w.app.engine.startRun(flows.slack!, w.alice.id, {});
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).steps[0]).toMatchObject({ status: 'failed', errorType: 'uncertain_outcome', attempts: 1 });
  });

  it('repeats a write its module marks idempotent', async () => {
    w.fake.failNext['POST slack.com'] = ['network'];
    const runId = await w.app.engine.startRun(flows['slack-idem']!, w.alice.id, {});
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });
});

describe('a worker that died during the call', () => {
  async function crashed(versionId: string) {
    const runId = await w.app.engine.startRun(versionId, w.alice.id, {});
    // As if a worker took the step, sent the call and died: the step is running, its lease over, the job queued again.
    await w.db.query(`DELETE FROM jobs`);
    await w.db.query(`UPDATE run_steps SET status = 'running', attempts = 1, lease_until = now() - interval '1 second' WHERE run_id = $1`, [runId]);
    await w.db.query(`INSERT INTO jobs (kind, payload) VALUES ('advance', $1)`, [JSON.stringify({ runId })]);
    await w.app.worker.drain();
    return (await runStatus(w, runId, w.alice)).steps[0];
  }

  it('leaves a plain write uncertain', async () => {
    expect(await crashed(flows.slack!)).toMatchObject({ status: 'failed', errorType: 'uncertain_outcome' });
  });

  it('runs an idempotent write again', async () => {
    expect(await crashed(flows['slack-idem']!)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });
});

describe('the manifest', () => {
  it('only write actions are marked idempotent; reviewers see it, and a change to it shows in the version diff', () => {
    const read = { ...manifest, actions: [{ ...manifest.actions[0], effect: 'read', idempotent: true, undo: undefined }] };
    expect(manifestSchema.safeParse(read).success).toBe(false);
    const after = manifestSchema.parse({ ...manifest, actions: manifest.actions.map((a: any) => (a.name === 'post_message' ? { ...a, idempotent: true } : a)) });
    expect(reviewSummary(after)).toContain('Dittoly repeats it when its answer is lost');
    expect(manifestChanges(manifestSchema.parse(manifest), after)).toEqual(expect.arrayContaining([expect.stringContaining('is now repeated when its answer is lost')]));
  });
});

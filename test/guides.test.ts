import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { draftFlow } from '../src/ai/generate-flow.js';
import { flowGuide, moduleGuide } from '../src/core/guides.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * MODULE.md and FLOW.md: Dittoly writes the reference from what was approved; the builder adds short notes, which
 * reach the next builder (the Flow drafter reads module notes; the Super Flow drafter reads Flow notes).
 */
const ai = new MockProvider();
let w: World;
beforeAll(async () => {
  w = await makeWorld({}, { ai });
});
afterAll(async () => {
  await w.db.end();
});
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

describe('MODULE.md and FLOW.md', () => {
  it('a module guide lists each action with what it reads or changes, its input and output, and the notes', async () => {
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const md = moduleGuide(manifest, { version: '1.0.0', notes: 'Post first; delete needs the ts it returned.' });
    expect(md).toContain('# Slack (slack@1.0.0)');
    expect(md).toContain('### post_message (write: changes data)');
    expect(md).toContain('- Input: channel (string, required), text (string, required)');
    expect(md).toContain('## Notes from the builder\nPost first; delete needs the ts it returned.');
  });

  it('a Super Flow guide is the whole process: every Flow it runs and the modules under each', () => {
    const md = flowGuide(
      { description: 'Release day.', inputs: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] }, steps: [{ id: 'notes', type: 'flow', runs: [{ id: 'a', flow: 'f1', version: 2, input: {} }] }] },
      { name: 'Release day', version: 1, children: [{ id: 'f1', name: 'Post notes', version: 2, description: 'Posts the notes.', modules: ['slack@1.0.0'] }] },
    );
    expect(md).toContain('# Release day (v1): Super Flow');
    expect(md).toContain('Inputs: tag (string, required)');
    expect(md).toContain('1. runs Post notes (at the same time) [notes]');
    expect(md).toContain('- Post notes v2: Posts the notes. Modules: slack@1.0.0.');
  });

  it('notes the builders write are kept, shown on review, and handed to the next builder', async () => {
    await approveExampleModules(w);
    // The module's notes, as its builder would have written them.
    const slack = (await w.app.modules.list()).find((m) => m.name === 'slack' && m.status === 'approved')!;
    await w.db.query(`UPDATE module_versions SET generation = jsonb_build_object('notes', 'Use post_message; keep its ts to delete it later.') WHERE id = $1`, [slack.id]);
    expect((await w.app.modules.review(slack.id)).guide).toContain('Use post_message; keep its ts to delete it later.');

    // The Flow drafter reads them in its catalog, once per module.
    const catalog = await w.app.flowChat.catalog({ newest: true });
    const def = { description: 'Posts a note.', inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', type: 'action', module: `slack@${slack.version}`, action: 'post_message', input: { channel: 'C1', text: 'hi' } }] };
    const provider = new MockProvider([{ name: 'Post a note', definitionJson: JSON.stringify(def), explanation: 'Posts.', missingJson: '[]', splitJson: '[]', sourcesJson: '[]', notesMd: 'Needs no input; returns the message ts.' }]);
    const drafted = await draftFlow(provider, 'Post a note', catalog);
    expect(provider.requests[0]!.prompt.match(/slack@1\.0\.0 notes \(MODULE\.md\): Use post_message/g)).toHaveLength(1);
    expect(drafted.notes).toBe('Needs no input; returns the message ts.');

    // A Flow keeps its notes; its FLOW.md shows them and marks the write.
    const v = await w.app.flows.create('Post a note', def, w.alice, { instructions: null, notes: drafted.notes! });
    const review = await w.app.flows.review(v.id);
    expect(review.guide).toContain('1. slack@1.0.0 post_message (write) [post]');
    expect(review.guide).toContain('## Changes data in\n- slack@1.0.0 post_message');
    expect(review.guide).toContain('Needs no input; returns the message ts.');
    await w.app.flows.decide(v.id, w.approver, 'approved');
    // The Super Flow drafter reads the Flow's notes.
    expect((await w.app.flowChat.flowCatalog(w.alice)).find((f) => f.flow === v.flowId)).toMatchObject({ notes: 'Needs no input; returns the message ts.' });
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { draftedByLabel } from '../src/modules/registry.js';
import { makeWorld, type World } from './helpers.js';

/**
 * Every version an AI wrote says which AI wrote it, and how hard it was told to think — "anthropic:opus-5:medium".
 * Without it, two models' work is indistinguishable a week later, and no comparison of them means anything.
 */
let w: World;
let ai: MockProvider;
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

beforeAll(async () => {
  ai = new MockProvider();
  w = await makeWorld({}, { ai });
});
afterAll(async () => {
  await w.db.end();
});

describe('the AI behind a draft', () => {
  it('reads as one label, and says nothing when nothing is known', () => {
    expect(draftedByLabel({ provider: 'anthropic', model: 'claude-opus-5', effort: 'medium' })).toBe('anthropic:claude-opus-5:medium');
    expect(draftedByLabel({ provider: 'ollama', model: 'gemma4:26b' })).toBe('ollama:gemma4:26b');
    // "default" names no model: two drafts a release apart would read the same.
    expect(draftedByLabel({ provider: 'openai', model: null })).toBe('openai:unknown');
    expect(draftedByLabel(null)).toBe(null);
  });

  it('is kept with a Flow the AI drafted', async () => {
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
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');

    ai.enqueue({ classificationJson: JSON.stringify({ summary: '', category: 'web_api', protocols: [], questions: [] }) });
    ai.enqueue({
      name: 'Tell the channel',
      definitionJson: JSON.stringify({
        description: 'Tells the channel.',
        inputs: { type: 'object', properties: { text: { type: 'string', description: 'What to say', examples: ['hello'] } }, required: ['text'] },
        steps: [{ id: 'tell', type: 'action', module: `slack@${mv.version}`, action: 'post_message', input: { channel: 'C1', text: '{{ inputs.text }}' } }],
      }),
      explanation: 'Posts it.',
      missingJson: '[]',
      splitJson: '[]',
      sourcesJson: '[]',
      notesMd: '',
      testsJson: '[]',
    });
    const out = await w.app.flowChat.draft('Tell the channel what I type.', w.alice);
    expect('version' in out).toBe(true);
    if (!('version' in out)) return;

    const review = await w.app.flows.review(out.version.id);
    expect(review.generation?.by).toMatchObject({ provider: 'mock', model: 'mock' });
    expect(draftedByLabel(review.generation?.by)).toBe('mock:mock');
  });
});

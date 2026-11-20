import { describe, expect, it } from 'vitest';
import { draftFlow, type CatalogAction } from '../src/ai/generate-flow.js';
import { generateModule } from '../src/ai/generate-module.js';
import { MockProvider } from '../src/ai/provider.js';
import { runAiStep } from '../src/engine/builtin.js';
import { looseJson } from '../src/runtime/ai.js';
import type { AiStep } from '../src/runtime/types.js';

/**
 * Small local models (the ones an organization runs itself) write correct JSON with the usual slips: a ```json
 * fence around it, a comma before a closing bracket. Dittoly reads those everywhere a model writes JSON, so one
 * stray fence never costs a whole draft, a whole plan or a step of a run.
 */
const catalog: CatalogAction[] = [
  {
    module: 'slack@1.0.0',
    moduleTitle: 'Slack',
    action: 'post_message',
    title: 'Post a message',
    description: 'Posts a message to a channel.',
    effect: 'write',
    input: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] },
    output: { type: 'object', properties: { ts: { type: 'string' } } },
  },
];
const definition = {
  description: 'Posts a note.',
  inputs: { type: 'object', properties: {} },
  steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C1', text: 'hi' } }],
};

describe('JSON as a model writes it', () => {
  it('reads a fence and a trailing comma, and still fails on an answer that is really broken', () => {
    expect(looseJson('```json\n{"a": [1, 2,], "b": "x,]"}\n```')).toEqual({ a: [1, 2], b: 'x,]' });
    expect(looseJson('{"a": "say \\"hi\\",}", }')).toEqual({ a: 'say "hi",}' });
    expect(() => looseJson('{"a": ')).toThrow();
  });

  it('a Flow wrapped in a fence is drafted, not thrown away', async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(definition, null, 1)}\n\`\`\``;
    const ai = new MockProvider([{ name: 'Post a note', definitionJson: fenced, explanation: 'Posts.', missingJson: '[]', splitJson: '[]', sourcesJson: '[]' }]);
    const drafted = await draftFlow(ai, 'Post a note', catalog);
    expect(drafted.definition).toEqual(definition);
  });

  it('a module whose manifest has a trailing comma is drafted too', async () => {
    const ai = new MockProvider([
      {
        manifestJson: '{"name": "x", "version": "1.0.0", "title": "X", "description": "X.", "hosts": ["api.example.com"], "credentials": [], "actions": [],}',
        code: 'export const actions = {};',
        testsJson: '[]',
      },
    ]);
    const out = await generateModule(ai, 'Build X.');
    expect(out.manifest).toMatchObject({ name: 'x', version: '1.0.0' });
  });

  it("an AI step's answer is read the same way inside a run", async () => {
    const step = { id: 'triage', type: 'ai', ai: 'organization', instruction: 'Triage it.', output: 'json', schema: { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] } } as unknown as AiStep;
    const ai = new MockProvider([{ resultJson: '```json\n{"real": true,}\n```' }]);
    await expect(runAiStep(step, {}, ai)).resolves.toEqual({ data: { real: true } });
  });
});

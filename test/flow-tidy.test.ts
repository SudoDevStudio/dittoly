import { describe, expect, it } from 'vitest';
import { draftFlow, type CatalogAction } from '../src/ai/generate-flow.js';
import { MockProvider } from '../src/ai/provider.js';
import { parseFlowDefinition } from '../src/flows/definition.js';
import { tidyDefinition } from '../src/flows/tidy.js';

/**
 * A model that leaves a step unnamed costs a whole draft, although there is one obvious correction: nothing can be
 * referring to a name that was never written. So the names are filled in, after the model and before the checks,
 * the way a manifest's small slips are fixed. Names the model did write are never touched: steps, the run form and
 * the templates refer to each other by them.
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

describe('a Flow a model left unnamed', () => {
  it('names each step after what it does, and keeps the names the model did write', () => {
    const tidied = tidyDefinition({
      steps: [
        { type: 'action', module: 'jira@1.1.0', action: 'search_issues', input: {} },
        { id: 'tell', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: {} },
        { type: 'approval' },
        { type: 'action', module: 'jira@1.1.0', action: 'search_issues', input: {} },
      ],
    }) as { steps: { id: string }[] };
    expect(tidied.steps.map((s) => s.id)).toEqual(['search_issues', 'tell', 'approval', 'search_issues_2']);
  });

  it('never takes a name a later step already uses, and names a Super Flow’s children too', () => {
    const tidied = tidyDefinition({
      steps: [
        { type: 'action', module: 'slack@1.0.0', action: 'post_message', input: {} },
        { id: 'post_message', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: {} },
        { type: 'flow', runs: [{ flow: 'f1', version: 1, input: {} }, { id: 'second', flow: 'f2', version: 2, input: {} }] },
      ],
    }) as { steps: { id: string; runs?: { id: string }[] }[] };
    expect(tidied.steps[0]!.id).toBe('post_message_2');
    expect(tidied.steps[1]!.id).toBe('post_message');
    expect(tidied.steps[2]!.runs!.map((r) => r.id)).toEqual(['flow_1', 'second']);
  });

  it('leaves anything it does not understand alone', () => {
    expect(tidyDefinition({ steps: 'not a list' })).toEqual({ steps: 'not a list' });
    expect(tidyDefinition(null)).toBe(null);
    const good = { steps: [{ id: 'a', type: 'delay', seconds: 1 }] };
    expect(tidyDefinition(good)).toEqual(good);
  });

  it('a draft whose steps have no ids passes the Flow checks instead of being thrown away', async () => {
    const ai = new MockProvider([
      {
        name: 'Post a note',
        definitionJson: JSON.stringify({
          description: 'Posts a note.',
          inputs: { type: 'object', properties: {} },
          steps: [{ type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C1', text: 'hi' } }],
        }),
        explanation: 'Posts.',
        missingJson: '[]',
        splitJson: '[]',
        sourcesJson: '[]',
      },
    ]);
    const drafted = await draftFlow(ai, 'Post a note', catalog);
    const parsed = parseFlowDefinition(drafted.definition);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.definition.steps[0]!.id).toBe('post_message');
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { parseFlowDefinition } from '../src/flows/definition.js';
import { playTest } from '../src/flows/tests.js';
import type { ModuleVersion } from '../src/modules/registry.js';
import { makeWorld, type World } from './helpers.js';

/**
 * A Flow that passes every check can still do the wrong thing: tell the customer instead of the account manager.
 * So the AI writes examples with the draft, they are kept as the Flow's own tests, and they are played before
 * anyone reviews it — against what each step WOULD send, not only against what it answers.
 */
let w: World;
let ai: MockProvider;
let ref: string;
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

const definition = (channel: string, moduleRef: string) => ({
  description: 'Tells someone that an invoice is overdue.',
  inputs: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'The account manager’s channel', examples: ['C-dana'] },
      customer: { type: 'string', description: 'The customer’s channel', examples: ['C-acme'] },
    },
    required: ['owner', 'customer'],
  },
  steps: [{ id: 'tell', type: 'action', module: moduleRef, action: 'post_message', input: { channel, text: 'An invoice is overdue.' } }],
});

/** The example the AI writes with it: the account manager is told, and that is checked on what the step sends. */
const example = {
  name: 'The account manager is told, not the customer',
  case: {
    inputs: { owner: 'C-dana', customer: 'C-acme' },
    answers: { tell: { output: { ts: '1700000000.1' } } },
    decisions: {},
    expect: { status: 'succeeded' as const, values: [{ path: 'steps.tell.input.channel', equals: 'C-dana' }] },
  },
};

beforeAll(async () => {
  ai = new MockProvider();
  w = await makeWorld({}, { ai });
  const mv = await w.app.modules.createDraft(
    {
      manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
      code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
      tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
      origin: 'seed',
    },
    w.alice,
  );
  await w.app.modules.submit(mv.id, w.alice);
  await w.app.modules.decide(mv.id, w.admin, 'approved');
  ref = `slack@${mv.version}`;
});
afterAll(async () => {
  await w.db.end();
});

/** The pinned module, as the player needs it. */
async function modules(): Promise<Map<string, ModuleVersion>> {
  const mv = (await w.app.modules.list()).find((m) => m.status === 'approved' && m.name === 'slack')!;
  return new Map([[ref, (await w.app.modules.get(w.db, mv.id))!]]);
}

describe('an example played against what a step would send', () => {
  it('passes when the Flow tells the account manager, and names the customer when it does not', async () => {
    const mods = await modules();
    const right = parseFlowDefinition(definition('{{ inputs.owner }}', ref));
    const wrong = parseFlowDefinition(definition('{{ inputs.customer }}', ref));
    expect(right.ok && wrong.ok).toBe(true);
    if (!right.ok || !wrong.ok) return;

    // Both Flows are valid and both runs succeed: only the example tells them apart.
    expect(playTest(right.definition, mods, example.case).problems).toEqual([]);
    const caught = playTest(wrong.definition, mods, example.case);
    expect(caught.status).toBe('succeeded');
    expect(caught.problems).toEqual(['steps.tell.input.channel is "C-acme", expected "C-dana"']);
  });

  it('a Flow drafted with its examples keeps them as the Flow’s own tests, played against the version', async () => {
    ai.enqueue({ classificationJson: JSON.stringify({ summary: '', category: 'web_api', protocols: [], questions: [] }) });
    ai.enqueue({
      name: 'Tell about the invoice',
      definitionJson: JSON.stringify(definition('{{ inputs.owner }}', ref)),
      explanation: 'Tells the account manager.',
      missingJson: '[]',
      splitJson: '[]',
      sourcesJson: '[]',
      notesMd: '',
      testsJson: JSON.stringify([example]),
    });
    const out = await w.app.flowChat.draft('Tell the account manager when an invoice is overdue.', w.alice);
    expect('version' in out).toBe(true);
    if (!('version' in out)) return;

    const kept = await w.app.flowTests.list(w.alice, out.version.flowId);
    expect(kept.map((t) => t.name)).toEqual(['The account manager is told, not the customer']);
    const results = await w.app.flowTests.results(w.alice, out.version.id);
    expect(results).toMatchObject({ total: 1, passed: 1 });
  });
});

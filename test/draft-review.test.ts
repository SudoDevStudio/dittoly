import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { makeWorld, type World } from './helpers.js';

/**
 * What Dittoly's review finds is handed back to the AI while it drafts, not left for a person to find at review:
 * a module whose own security checks complain is sent back once, and a draft that answers fewer findings than the
 * one it would replace is thrown away.
 */
const ai = new MockProvider();
let w: World;
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

beforeAll(async () => {
  w = await makeWorld({}, { ai });
});
afterAll(async () => {
  await w.db.end();
});
beforeEach(() => {
  process.env.DITTOLY_AI_DRAFT_REVIEW = 'on';
});
afterEach(() => {
  process.env.DITTOLY_AI_DRAFT_REVIEW = 'off';
});

/** The fixture module, with Math.random() where an id is made: OWASP A04 (weak randomness) sees it. */
async function answer({ weak, version }: { weak: boolean; version: string }) {
  const code = await readFile(path.join(dir, 'module.mjs'), 'utf8');
  const manifest = (await readFile(path.join(dir, 'manifest.json'), 'utf8')).replace('"1.0.0"', `"${version}"`);
  return {
    manifestJson: manifest,
    testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8'),
    code: weak ? code.replace('export const actions', 'const nonce = () => Math.random().toString(36);\nexport const actions') : code,
  };
}

/** A Flow draft that writes with nobody signing off, and the same Flow with the sign-off and a guard. */
function flowAnswer(mv: string, safe: boolean) {
  const write = { id: 'tell', type: 'action', module: mv, action: 'post_message', input: { channel: 'C1', text: '{{ inputs.text }}' }, ...(safe ? { when: { notEmpty: 'steps.look.output.row' } } : {}) };
  const steps = safe
    ? [{ id: 'look', type: 'table', table: 'told', op: 'get', key: '{{ inputs.text }}' }, { id: 'ok', type: 'approval' }, write]
    : [write];
  return {
    name: 'Tell the channel',
    definitionJson: JSON.stringify({
      description: 'Tells the channel.',
      inputs: { type: 'object', properties: { text: { type: 'string', description: 'What to say', examples: ['hello'] } }, required: ['text'] },
      ...(safe ? { tables: [{ name: 'told', keyColumn: 'text', purpose: 'What it already told the channel about.', columns: [{ name: 'text', type: 'text' }] }] } : {}),
      steps,
    }),
    explanation: 'Posts it.',
    missingJson: '[]',
    splitJson: '[]',
    sourcesJson: '[]',
    notesMd: '',
    testsJson: '[]',
  };
}

describe('the drafting-time review round', () => {
  it('sends a module with security findings back to the AI, and keeps the answer that has fewer', async () => {
    ai.enqueue(await answer({ weak: true, version: '2.0.0' }));
    ai.enqueue(await answer({ weak: false, version: '2.0.0' }));
    const before = ai.requests.length;
    const out = await w.app.moduleChat.generate('Post release notes to a Slack channel', w.alice);
    if (!('draft' in out)) throw new Error('no draft');
    const draft = out.draft;
    // Two calls: the draft, then the round that carried the findings.
    expect(ai.requests.length).toBe(before + 2);
    expect(ai.requests.at(-1)!.prompt).toContain('weak randomness');
    expect(draft.code).not.toContain('Math.random');
    const findings = (draft.validationReport?.checks ?? []).filter((c) => !c.passed && c.advisory).map((c) => c.name);
    expect(findings.join(', ')).not.toContain('weak randomness');
  });

  it('tells the AI what an approver would send back about a Flow, and keeps the safer answer', async () => {
    const mv = await w.app.modules.createDraft(
      {
        manifest: JSON.parse((await readFile(path.join(dir, 'manifest.json'), 'utf8')).replace('"1.0.0"', '"4.0.0"')),
        code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
        tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
        origin: 'seed',
      },
      w.alice,
    );
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
    const ref = `slack@${mv.version}`;
    ai.enqueue(flowAnswer(ref, false));
    ai.enqueue(flowAnswer(ref, true));
    const before = ai.requests.length;
    const out = await w.app.flowChat.draft('Tell the channel what I type.', w.alice);
    expect(ai.requests.length).toBe(before + 2);
    expect(ai.requests.at(-1)!.prompt).toContain('before anybody signs off');
    if (!('version' in out)) throw new Error('not drafted');
    expect(out.version.definition.steps.some((s) => s.type === 'approval')).toBe(true);
  });

  it('keeps the first draft when the answer to the findings is no better', async () => {
    ai.enqueue(await answer({ weak: true, version: '3.0.0' }));
    ai.enqueue(await answer({ weak: true, version: '3.0.0' }));
    const out = await w.app.moduleChat.generate('Post release notes to a Slack channel', w.alice);
    if (!('draft' in out)) throw new Error('no draft');
    const draft = out.draft;
    expect(draft.code).toContain('Math.random');
  });
});

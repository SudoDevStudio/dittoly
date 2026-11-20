import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { compileFlow } from '../src/export/codegen/compile.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/** A Flow's instructions: guidance every AI step of it follows, approved with the version. */
const orgAi = new MockProvider();
let w: World;
beforeAll(async () => {
  w = await makeWorld({}, { ai: orgAi });
});
afterAll(async () => {
  await w.db.end();
});

const RULES = 'Write in a friendly tone. Skip videos shorter than a minute.';
const def = (instructions?: string) => ({
  ...(instructions !== undefined ? { instructions } : {}),
  inputs: { type: 'object', properties: { channel: { type: 'string' } } },
  steps: [
    { id: 'pick', type: 'ai', ai: 'organization', instruction: 'Pick the video to share.', input: { c: '{{ inputs.channel }}' } },
    { id: 'word', type: 'ai', ai: 'organization', instruction: 'Write the post.', input: { v: '{{ steps.pick.output.text }}' } },
  ],
});

describe('Flow instructions', () => {
  it('come before each AI step\'s own instruction when it runs', async () => {
    const v = await w.app.flows.create('Share videos', def(RULES), w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    orgAi.enqueue({ text: 'video 1' });
    orgAi.enqueue({ text: 'New video!' });
    const before = orgAi.requests.length;
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { channel: 'UC1' });
    await w.app.worker.drain();
    expect(await runStatus(w, runId, w.alice)).toMatchObject({ status: 'succeeded' });
    const prompts = orgAi.requests.slice(before).map((r) => r.prompt);
    expect(prompts).toHaveLength(2);
    for (const [p, own] of [[prompts[0]!, 'Pick the video to share.'], [prompts[1]!, 'Write the post.']] as const) {
      expect(p).toContain(`FLOW INSTRUCTIONS (from the people who approved this Flow; follow them in this step):\n${RULES}\n\nTHIS STEP:\n${own}`);
    }
  });

  it('are shown to the approver, and a Flow without them runs its steps as before', async () => {
    const v = await w.app.flows.create('Share videos (plain)', def(), w.alice);
    expect((await w.app.flows.review(v.id)).summary).not.toContain('Instructions every AI step follows');
    const withRules = await w.app.flows.create('Share videos (rules)', def(RULES), w.alice);
    expect((await w.app.flows.review(withRules.id)).summary).toContain(`Instructions every AI step follows: "${RULES}"`);

    await w.app.flows.decide(v.id, w.approver, 'approved');
    orgAi.enqueue({ text: 'video 1' });
    orgAi.enqueue({ text: 'New video!' });
    const before = orgAi.requests.length;
    await w.app.engine.startRun(v.id, w.alice.id, { channel: 'UC1' });
    await w.app.worker.drain();
    expect(orgAi.requests.slice(before).every((r) => !r.prompt.includes('FLOW INSTRUCTIONS'))).toBe(true);
  });

  it('are part of the approved version: changing them is a new version that needs approval', async () => {
    const v1 = await w.app.flows.create('Share videos (versions)', def(RULES), w.alice);
    await w.app.flows.decide(v1.id, w.approver, 'approved');
    const v2 = await w.app.flows.update(v1.flowId, def('Write formally.'), w.alice);
    expect(v2).toMatchObject({ version: 2, status: 'pending' });
    await expect(w.app.engine.startRun(v2.id, w.alice.id, { channel: 'UC1' })).rejects.toMatchObject({ code: 'flow_version_not_approved' });
  });

  it('empty or too long instructions are refused', async () => {
    await expect(w.app.flows.create('Blank', def('   '), w.alice)).rejects.toMatchObject({ code: 'invalid_flow' });
    await expect(w.app.flows.create('Long', def('x'.repeat(4001)), w.alice)).rejects.toMatchObject({ code: 'invalid_flow' });
  });

  it('an exported app\'s AI steps follow them too', () => {
    const src = compileFlow({ key: 'k', name: 'Share videos', description: '', version: 1, access: 'token', exposed: true, definition: def(RULES) }, () => 'child', './lib.js');
    expect(src).toContain('FLOW INSTRUCTIONS');
    expect(src).toContain(RULES);
  });
});

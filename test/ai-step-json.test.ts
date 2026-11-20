import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { compileFlow } from '../src/export/codegen/compile.js';
import { approveExampleModules, makeWorld, runStatus, type World } from './helpers.js';

/**
 * An AI step with output "json": its answer is data in the shape its schema sets, so a later step can run once per
 * item of a list the AI returned (e.g. review findings to post one by one).
 */
const orgAi = new MockProvider();
const posted: unknown[] = [];
const slack = (async (url: string | URL | Request, init?: RequestInit) => {
  posted.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: `1.${posted.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
let w: World;
beforeAll(async () => {
  w = await makeWorld({}, { ai: orgAi, fetchImpl: slack });
  await approveExampleModules(w);
  await w.app.vault.put(w.alice.id, 'slack', 'xoxb-test');
});
afterAll(async () => {
  await w.db.end();
});

const schema = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', maxItems: 10, items: { type: 'object', required: ['line', 'body'], properties: { line: { type: 'integer' }, body: { type: 'string' } } } } } };
const def = (s: Record<string, unknown> = { output: 'json', schema }) => ({
  steps: [
    { id: 'review', type: 'ai', ai: 'organization', instruction: 'Review it.', input: {}, ...s },
    { id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', forEach: '{{ steps.review.output.data.findings }}', input: { channel: 'C1', text: 'Line {{ item.line }}: {{ item.body }}' } },
  ],
});

describe('AI step with output "json"', () => {
  it('a later step runs once per item of the list the AI returned', async () => {
    const v = await w.app.flows.create('Review findings', def(), w.alice);
    // The AI's answer feeds a write: the approver accepts that path once, so runs do not stop for a sign-off.
    await w.app.flows.decide(v.id, w.approver, 'approved', { accept: [{ sink: 'post', reason: 'Posts findings to our own channel.' }] });
    orgAi.enqueue({ resultJson: JSON.stringify({ findings: [{ line: 3, body: 'Off by one.' }, { line: 9, body: 'Unused.' }] }) });
    const before = orgAi.requests.length;
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.status, JSON.stringify(r.steps)).toBe('succeeded');
    expect(orgAi.requests.slice(before)).toHaveLength(1);
    expect(posted).toEqual([{ channel: 'C1', text: 'Line 3: Off by one.' }, { channel: 'C1', text: 'Line 9: Unused.' }]);
    expect((await w.app.flows.review(v.id)).summary).toContain('answer as data in a fixed shape');
  });

  it('is refused when saved without a schema, with a schema on another output, or with a schema that is not one', async () => {
    await expect(w.app.flows.create('No schema', def({ output: 'json' }), w.alice)).rejects.toThrow(/output "json" needs a JSON Schema/);
    await expect(w.app.flows.create('Schema on text', def({ output: 'text', schema }), w.alice)).rejects.toThrow(/only an ai step with output "json" has a schema/);
    await expect(w.app.flows.create('Bad schema', def({ output: 'json', schema: { type: 'nonsense' } }), w.alice)).rejects.toThrow(/not a valid JSON Schema/);
  });

  it('keeps its schema in an exported app', async () => {
    const v = await w.app.flows.create('Review findings (export)', def(), w.alice);
    const code = compileFlow({ key: 'k', name: 'x', description: '', version: 1, access: 'token', exposed: true, definition: v.definition } as never, () => 'child', './lib.js');
    expect(code).toContain('"output":"json"');
    expect(code).toContain('"findings"');
  });
});

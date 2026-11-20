import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, giveAllCredentials, makeWorld, runStatus, type World } from './helpers.js';

/**
 * Super Flows: a Flow whose flow steps run other approved Flows as child runs,
 * at the same time, as the same person, pinned to one version each.
 */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const notify = (channel: string) => ({
  description: `Posts to ${channel}.`,
  inputs: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] },
  steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel, text: '{{ inputs.text }}' } }],
});

async function approved(name: string, def: unknown) {
  const v = await w.app.flows.create(name, def, w.alice);
  return w.app.flows.decide(v.id, w.approver, 'approved');
}

let slackA: { flowId: string; id: string };
let slackB: { flowId: string; id: string };
const superDef = () => ({
  inputs: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  steps: [
    {
      id: 'both',
      type: 'flow',
      title: 'Tell both channels',
      runs: [
        { id: 'a', flow: slackA.flowId, version: 1, input: { text: '{{ inputs.msg }}' } },
        { id: 'b', flow: slackB.flowId, version: 1, input: { text: 'Also: {{ inputs.msg }}' } },
      ],
    },
    { id: 'after', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-log', text: 'posted {{ steps.both.output.a.steps.post.ts }}' } },
  ],
});

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  slackA = await approved('Notify A', notify('C-a'));
  slackB = await approved('Notify B', notify('C-b'));
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('Super Flows', () => {
  it('runs its Flows at the same time as the same person, waits for them, and passes their outputs on', async () => {
    const v = await w.app.flows.create('Announce everywhere', superDef(), w.alice);
    const review = await w.app.flows.review(v.id);
    expect(review.summary).toContain('1. Tell both channels: RUNS 2 Flows at the same time: "Notify A" v1, "Notify B" v1 as the person running this one');
    expect(review.flows).toEqual([
      expect.objectContaining({ flowId: slackA.flowId, name: 'Notify A', version: 1, status: 'approved' }),
      expect.objectContaining({ flowId: slackB.flowId, name: 'Notify B', version: 1, status: 'approved' }),
    ]);
    await w.app.flows.decide(v.id, w.approver, 'approved');

    w.fake.messages.length = 0;
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { msg: 'Release 2.4 is out' });
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('succeeded');
    expect(w.fake.messages.map((m) => [m.channel, m.text])).toEqual(
      expect.arrayContaining([['C-a', 'Release 2.4 is out'], ['C-b', 'Also: Release 2.4 is out'], ['C-log', 'posted 1700000000.000100']]),
    );
    // The log message came after both children: it used a child's output.
    expect(w.fake.messages.at(-1)!.channel).toBe('C-log');
    const step = run.steps.find((s) => s.id === 'both')!;
    expect(step.output).toMatchObject({ a: { status: 'succeeded', steps: { post: { ts: '1700000000.000100' } } }, b: { status: 'succeeded' } });

    // Child runs link both ways and belong to the same person.
    const view = await w.app.engine.runView(runId, w.alice);
    const kids = view.steps.find((s) => s.id === 'both')!.children!;
    expect(kids.map((k) => [k.key, k.flowName, k.version, k.status])).toEqual([['a', 'Notify A', 1, 'succeeded'], ['b', 'Notify B', 1, 'succeeded']]);
    const child = await w.app.engine.runView(kids[0]!.runId, w.alice);
    expect(child).toMatchObject({ runAs: w.alice.id, parent: { runId, flowName: 'Announce everywhere' } });
  });

  it('checks child inputs and versions when drafted, and needs every child approved', async () => {
    const def = superDef();
    delete (def.steps[0] as { runs: { input: Record<string, unknown> }[] }).runs[0]!.input.text;
    await expect(w.app.flows.create('Broken', def, w.alice)).rejects.toMatchObject({ code: 'invalid_flow', message: expect.stringContaining('missing input "text" required by Flow "Notify A"') });
    const unknown = superDef();
    (unknown.steps[0] as { runs: { version: number }[] }).runs[1]!.version = 9;
    await expect(w.app.flows.create('Unknown', unknown, w.alice)).rejects.toMatchObject({ code: 'unknown_flow' });

    const pending = await w.app.flows.create('Notify C', notify('C-c'), w.alice);
    const withPending = { ...superDef(), steps: [{ id: 'one', type: 'flow', runs: [{ id: 'c', flow: pending.flowId, version: 1, input: { text: 'x' } }] }] };
    const sv = await w.app.flows.create('Waits for C', withPending, w.alice);
    expect((await w.app.flows.review(sv.id)).summary).toContain('"Notify C" v1 (pending, not approved)');
    await expect(w.app.flows.decide(sv.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'child_flows_not_approved' });
    // Bob is not in a team that sees... everyone is in the default team here, so he may build on them too.
    expect((await api.inject({ method: 'GET', url: `/api/flow-versions/${sv.id}/review`, headers: auth(w.tokens.bob) })).statusCode).toBe(200);
  });

  it('a failed child pauses the Super Flow; retrying starts the children again', async () => {
    const v = await approved('Announce (retry)', superDef());
    w.fake.failNext['POST slack.com/api/chat.postMessage'] = [400];
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { msg: 'try' });
    await w.app.worker.drain();
    // One child failed and paused; the Super Flow still waits for it.
    let view = await w.app.engine.runView(runId, w.alice);
    expect(view.status).toBe('waiting');
    const kids = view.steps.find((s) => s.id === 'both')!.children!;
    const paused = kids.find((k) => k.status === 'paused')!;
    expect(paused).toBeTruthy();
    // The person gives up on that child: the Super Flow's step fails and the run pauses.
    await w.app.engine.cancel(paused.runId, w.alice);
    await w.app.worker.drain();
    view = await w.app.engine.runView(runId, w.alice);
    expect(view.status).toBe('paused');
    expect(view.steps.find((s) => s.id === 'both')).toMatchObject({ status: 'failed', errorType: 'child_flow_failed' });

    await w.app.engine.retry(runId, w.alice);
    await w.app.worker.drain();
    view = await w.app.engine.runView(runId, w.alice);
    expect(view.status).toBe('succeeded');
    expect(view.steps.find((s) => s.id === 'both')!.children!.map((k) => k.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('cancelling a Super Flow cancels the Flows it started', async () => {
    const gated = await approved('Needs sign-off', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'gate', type: 'approval' }] });
    const v = await approved('Wrapper', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'inner', type: 'flow', runs: [{ id: 'g', flow: gated.flowId, version: 1, input: {} }] }] });
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    const child = (await w.app.engine.runView(runId, w.alice)).steps[0]!.children![0]!;
    expect(child.status).toBe('waiting');
    await w.app.engine.cancel(runId, w.alice);
    expect((await w.app.engine.runView(child.runId, w.alice)).status).toBe('cancelled');
  });

  it('stops when a Flow it runs is replaced, and offers the newer version as an upgrade', async () => {
    const a = await approved('Notify D', notify('C-d'));
    const v = await approved('Uses D', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'd', type: 'flow', runs: [{ id: 'd', flow: a.flowId, version: 1, input: { text: 'hi' } }] }] });
    const v2 = await w.app.flows.update(a.flowId, notify('C-d2'), w.alice);
    await expect(w.app.engine.startRun(v.id, w.alice.id, {})).rejects.toMatchObject({ code: 'child_flow_not_approved' });
    await w.app.flows.decide(v2.id, w.approver, 'approved');
    expect(await w.app.marketplace.upgradesFor(v.id)).toEqual([expect.objectContaining({ kind: 'flow', module: 'Notify D', pinned: 'v1', latest: 'v2' })]);
  });

  it('the AI drafts a Super Flow from the approved Flows the person can use', async () => {
    const def = superDef();
    ai.enqueue({ name: 'Announce', definitionJson: JSON.stringify(def), explanation: 'Runs both notify Flows, then logs.' });
    const res = await api.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'Tell channel A and B at once, then log it', answers: {} } });
    expect(res.statusCode).toBe(201);
    expect(res.json().flows).toHaveLength(2);
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain('APPROVED FLOWS (run them with a flow step):');
    expect(prompt).toContain(`- "Notify A" flow ${slackA.flowId} version 1: Posts to C-a.`);
    expect(ai.requests.at(-1)!.system).toContain('"type": "flow"');
  });
});

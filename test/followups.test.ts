import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, giveAllCredentials, makeWorld, runStatus, type World } from './helpers.js';

/** Follow-up Flows: when a member's run of one Flow finishes, another starts as that member. */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const listFlow = {
  inputs: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
  steps: [{ id: 'mrs', type: 'action', module: 'gitlab@1.0.0', action: 'list_merge_requests', input: { project: '{{ inputs.project }}' } }],
};
const mergeFirst = {
  inputs: { type: 'object', properties: { project: { type: 'string' }, iid: { type: 'integer' } }, required: ['project', 'iid'] },
  steps: [{ id: 'merge', type: 'action', module: 'gitlab@1.0.0', action: 'merge_merge_request', input: { project: '{{ inputs.project }}', iid: '{{ inputs.iid }}' } }],
};

async function approved(name: string, def: object) {
  const v = await w.app.flows.create(name, def, w.alice);
  return w.app.flows.decide(v.id, w.approver, 'approved');
}

const runsOf = async (versionId: string) =>
  (await w.db.query<{ id: string; run_as: string; followup_of: string | null }>(`SELECT id, run_as, followup_of FROM runs WHERE flow_version_id = $1 ORDER BY created_at`, [versionId])).rows;

beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  await giveAllCredentials(w, w.bob);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('follow-up Flows', () => {
  it('start after the owner\'s own run finishes, with inputs from that run; other members\' runs do not start them', async () => {
    const source = await approved('List MRs', listFlow);
    const target = await approved('Merge first', mergeFirst);
    const post = (token: string, body: object) => api.inject({ method: 'POST', url: '/api/followups', headers: auth(token), payload: body });

    const bad = await post(w.tokens.alice, { sourceFlowId: source.flowId, targetVersionId: target.id, inputs: { project: '{{ secrets.gitlab }}', iid: 1 } });
    expect(bad.json()).toMatchObject({ error: 'invalid_followup' });
    expect((await post(w.tokens.alice, { sourceFlowId: source.flowId, targetVersionId: target.id, inputs: { project: 'x' } })).json().detail).toMatch(/iid is required/);
    expect((await post(w.tokens.alice, { sourceFlowId: target.flowId, targetVersionId: target.id, inputs: { project: 'x', iid: 1 } })).json().detail).toMatch(/cannot follow itself/);

    const created = await post(w.tokens.alice, {
      sourceFlowId: source.flowId,
      targetVersionId: target.id,
      on: 'succeeded',
      inputs: { project: '{{ inputs.project }}', iid: '{{ steps.mrs.output.mergeRequests.0.iid }}' },
    });
    expect(created.statusCode).toBe(201);

    // Bob's run of the same Flow does not start Alice's follow-up.
    await w.app.engine.startRun(source.id, w.bob.id, { project: 'acme/app' });
    await w.app.worker.drain();
    expect(await runsOf(target.id)).toEqual([]);

    w.fake.merged.length = 0;
    const runId = await w.app.engine.startRun(source.id, w.alice.id, { project: 'acme/app' });
    await w.app.worker.drain();
    const followups = await runsOf(target.id);
    expect(followups).toEqual([expect.objectContaining({ run_as: w.alice.id, followup_of: runId })]);
    expect(await runStatus(w, followups[0]!.id, w.alice)).toMatchObject({ status: 'succeeded' });
    expect(w.fake.merged).toEqual([7]);

    const listed = (await api.inject({ method: 'GET', url: `/api/followups?flow=${source.flowId}`, headers: auth(w.tokens.alice) })).json();
    expect(listed).toEqual([expect.objectContaining({ target: expect.objectContaining({ name: 'Merge first' }), on: 'succeeded', enabled: true, lastRunId: followups[0]!.id })]);
    expect((await api.inject({ method: 'GET', url: '/api/followups', headers: auth(w.tokens.bob) })).json()).toEqual([]);
    expect((await api.inject({ method: 'DELETE', url: `/api/followups/${listed[0].id}`, headers: auth(w.tokens.bob) })).statusCode).toBe(403);
    expect((await api.inject({ method: 'DELETE', url: `/api/followups/${listed[0].id}`, headers: auth(w.tokens.alice) })).statusCode).toBe(204);
  });

  it('a follow-up that cannot start is reported to its owner and leaves the finished run alone; chains stop', async () => {
    const a = await approved('A', listFlow);
    const b = await approved('B', listFlow);
    // A missing value: the template cannot resolve.
    await w.app.followups.create({ sourceFlowId: a.flowId, targetVersionId: b.id, on: 'finished', inputs: { project: '{{ steps.nope.output.x }}' } }, w.alice);
    const first = await w.app.engine.startRun(a.id, w.alice.id, { project: 'acme/app' });
    await w.app.worker.drain();
    expect(await runStatus(w, first, w.alice)).toMatchObject({ status: 'succeeded' });
    expect(await runsOf(b.id)).toEqual([]);
    const note = await w.db.query(`SELECT 1 FROM notifications WHERE member_id = $1 AND kind = 'followup_failed' AND run_id = $2`, [w.alice.id, first]);
    expect(note.rowCount).toBe(1);
    await w.db.query(`DELETE FROM flow_followups`);

    // A → B → A → … stops after three follow-ups.
    await w.app.followups.create({ sourceFlowId: a.flowId, targetVersionId: b.id, on: 'finished', inputs: { project: '{{ inputs.project }}' } }, w.alice);
    await w.app.followups.create({ sourceFlowId: b.flowId, targetVersionId: a.id, on: 'finished', inputs: { project: '{{ inputs.project }}' } }, w.alice);
    const before = (await runsOf(a.id)).length;
    await w.app.engine.startRun(a.id, w.alice.id, { project: 'acme/app' });
    await w.app.worker.drain();
    expect((await runsOf(a.id)).length - before + (await runsOf(b.id)).length).toBe(4);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, makeWorld, runStatus, type World } from './helpers.js';

/**
 * A paused run goes on with the newest approved version of its Flow (after its module or the Flow was fixed):
 * steps that ran keep their results and do not run again; when the new version does not fit, it starts again there.
 */

let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
  // Alice can post to Slack but has no GitLab access: the merge step fails.
  await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice');
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const inputs = { type: 'object', properties: { note: { type: 'string' } } };
const tell = { id: 'tell', title: 'Tell the team', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text: '{{ inputs.note }}' } };
const merge = { id: 'merge', title: 'Merge it', type: 'action', module: 'gitlab@1.0.0', action: 'merge_merge_request', input: { project: 'acme/app', iid: 7 } };
const announce = { id: 'merge', title: 'Announce instead', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#release', text: 'Ready to merge' } };
const goOn = (runId: string, token = w.tokens.alice) => api.inject({ method: 'POST', url: `/api/runs/${runId}/continue`, headers: auth(token) });

async function pausedRun(name: string) {
  const v1 = await w.app.flows.create(name, { inputs, steps: [tell, merge] }, w.alice);
  await w.app.flows.decide(v1.id, w.approver, 'approved');
  const runId = await w.app.engine.startRun(v1.id, w.alice.id, { note: 'Release 2.0' });
  await w.app.worker.drain();
  const r = await runStatus(w, runId, w.alice);
  expect(r.steps.map((s) => s.status)).toEqual(['succeeded', 'failed']);
  return { runId, flowId: v1.flowId };
}
async function approveV2(flowId: string, steps: unknown[], schema = inputs) {
  const v2 = await w.app.flows.update(flowId, { inputs: schema, steps }, w.alice);
  await w.app.flows.decide(v2.id, w.approver, 'approved');
  return v2;
}

describe('continuing a paused run on the newest approved version', () => {
  it('without a newer version there is nothing to continue on', async () => {
    const { runId } = await pausedRun('Nothing newer');
    expect((await runStatus(w, runId, w.alice)).nextSteps!.fixes.some((f) => f.kind === 'continue')).toBe(false);
    expect((await goOn(runId)).json()).toEqual({ error: 'no_newer_version' });
  });

  it('goes on in the same run: what ran keeps its result and does not run again; the failed step runs as the new version says', async () => {
    const { runId, flowId } = await pausedRun('Fits');
    const before = (await w.db.query(`SELECT output_enc, finished_at FROM run_steps WHERE run_id = $1 AND step_id = 'tell'`, [runId])).rows[0];
    const v2 = await approveV2(flowId, [tell, announce]);
    expect((await runStatus(w, runId, w.alice)).nextSteps!.fixes[0]).toMatchObject({ kind: 'continue', label: 'Continue on version 2' });
    expect((await goOn(runId, w.tokens.bob)).statusCode).toBe(403);

    expect((await goOn(runId)).json()).toEqual({ runId, moved: true });
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r).toMatchObject({ status: 'succeeded', version: 2, flowVersionId: v2.id, manualRetriesUsed: 0 });
    expect(r.steps.map((s) => [s.id, s.title, s.status])).toEqual([['tell', 'Tell the team', 'succeeded'], ['merge', 'Announce instead', 'succeeded']]);
    const after = (await w.db.query(`SELECT output_enc, finished_at FROM run_steps WHERE run_id = $1 AND step_id = 'tell'`, [runId])).rows[0];
    expect(after).toEqual(before);
    const moved = (await w.db.query(`SELECT related_id FROM audit_events WHERE action = 'run.moved_to_version' AND subject_id = $1`, [runId])).rows;
    expect(moved).toHaveLength(1);
  });

  it('a new version that adds steps after what ran fits too', async () => {
    const { runId, flowId } = await pausedRun('Adds');
    await approveV2(flowId, [tell, announce, { ...tell, id: 'thanks', title: 'Say thanks' }]);
    await goOn(runId);
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).steps.map((s) => [s.id, s.status])).toEqual([['tell', 'succeeded'], ['merge', 'succeeded'], ['thanks', 'succeeded']]);
  });

  it('when it does not fit (a step removed, or new inputs), it starts again there with the same inputs; this run stays', async () => {
    const { runId, flowId } = await pausedRun('Does not fit');
    await approveV2(flowId, [{ ...announce, id: 'announce' }]);
    expect((await runStatus(w, runId, w.alice)).nextSteps!.fixes[0]).toMatchObject({ kind: 'continue', label: 'Start again on version 2 with the same inputs' });
    const res = (await goOn(runId)).json();
    expect(res.moved).toBe(false);
    expect(res.runId).not.toBe(runId);
    await w.app.worker.drain();
    expect(await runStatus(w, res.runId, w.alice)).toMatchObject({ status: 'succeeded', version: 2, inputs: { note: 'Release 2.0' } });
    expect((await runStatus(w, runId, w.alice)).status).toBe('paused');
  });
});

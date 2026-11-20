import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveExampleModules,
  approvedReleaseFlow,
  giveAllCredentials,
  makeWorld,
  releaseInputs,
  runStatus,
  type World,
} from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
});
afterAll(async () => w.db.end());

describe('release coordination flow', () => {
  it('runs end to end: Jira -> GitLab -> approval gate -> merge each MR -> Slack', async () => {
    const version = await approvedReleaseFlow(w);
    await giveAllCredentials(w, w.alice);

    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();

    let run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('waiting');
    expect(run.waitReason).toBe('approval');
    expect(w.fake.merged).toEqual([]);

    await w.app.engine.decideGate(runId, 'signoff', w.approver, 'approved');
    await w.app.worker.drain();

    run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => [s.id, s.status])).toEqual([
      ['tickets', 'succeeded'],
      ['mrs', 'succeeded'],
      ['signoff', 'succeeded'],
      ['merge', 'succeeded'],
      ['announce', 'succeeded'],
    ]);
    expect(w.fake.merged).toEqual([7, 8]);
    expect(w.fake.messages).toEqual([
      { channel: 'C-releases', text: 'Release 2.4: 1 approved tickets, 2 merge requests merged.', auth: 'Bearer xoxb-alice' },
    ]);
    // Every call carried alice's own credential, attached by the broker.
    expect(w.fake.calls.find((c) => c.url.includes('gitlab.com'))!.auth).toBe('glpat-alice');
  });

  it('skips the gate and merges when there is nothing to merge', async () => {
    w.fake.mrs.forEach((m) => (m.state = 'merged'));
    const version = (await w.app.flows.versions((await w.db.query('SELECT id FROM flows LIMIT 1')).rows[0].id))[0]!;
    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('succeeded');
    expect(run.steps.find((s) => s.id === 'signoff')!.status).toBe('skipped');
    expect(run.steps.find((s) => s.id === 'merge')!.status).toBe('skipped');
  });

  it('stops the run when the gate is rejected and shows what never ran', async () => {
    w.fake.mrs.push({ iid: 9, title: 'Late change', detailed_merge_status: 'mergeable', state: 'opened' });
    const version = (await w.app.flows.versions((await w.db.query('SELECT id FROM flows LIMIT 1')).rows[0].id))[0]!;
    const runId = await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    await w.app.engine.decideGate(runId, 'signoff', w.approver, 'rejected');
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('failed');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'failed', 'not_run', 'not_run']);
    expect(w.fake.merged).not.toContain(9);
  });

  it('does not let a member approve the gate on their own run (shared mode)', async () => {
    const version = (await w.app.flows.versions((await w.db.query('SELECT id FROM flows LIMIT 1')).rows[0].id))[0]!;
    await giveAllCredentials(w, w.approver);
    const runId = await w.app.engine.startRun(version.id, w.approver.id, releaseInputs);
    await w.app.worker.drain();
    await expect(w.app.engine.decideGate(runId, 'signoff', w.approver, 'approved')).rejects.toMatchObject({
      code: 'cannot_approve_own_run',
    });
  });
});

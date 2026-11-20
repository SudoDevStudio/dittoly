import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, runStatus, type World } from './helpers.js';
import { AUTO_STOP_DEFAULTS, setAutoStopSettings } from '../src/governance/auto-stop.js';

let w: World;
let versionId: string;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  versionId = (await approvedReleaseFlow(w)).id;
  // These runs fail on purpose, again and again. Automatic stops are tested in auto-stop.test.ts.
  await setAutoStopSettings(w.db, w.admin, { ...AUTO_STOP_DEFAULTS, failureSpike: { ...AUTO_STOP_DEFAULTS.failureSpike, enabled: false } });
});
afterAll(async () => w.db.end());
beforeEach(() => {
  w.fake.failNext = {};
  w.fake.calls.length = 0;
  w.fake.merged.length = 0;
  w.fake.mrs = [
    { iid: 7, title: 'Add export', detailed_merge_status: 'mergeable', state: 'opened' },
    { iid: 8, title: 'Fix login', detailed_merge_status: 'mergeable', state: 'opened' },
  ];
});

const jiraCalls = () => w.fake.calls.filter((c) => c.url.includes('atlassian')).length;

describe('retries', () => {
  it('retries a retryable failure twice automatically, then pauses and tells the member', async () => {
    w.fake.failNext['GET example.atlassian.net'] = [503, 503, 503];
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(jiraCalls()).toBe(3); // 1 attempt + 2 automatic retries
    expect(run.status).toBe('paused');
    expect(run.steps[0]).toMatchObject({ status: 'failed', attempts: 3, errorType: 'http_503' });
    const n = await w.db.query(`SELECT kind FROM notifications WHERE member_id = $1 AND run_id = $2`, [w.alice.id, runId]);
    expect(n.rows.map((r) => r.kind)).toContain('run_paused');
  });

  it('recovers when a retry succeeds', async () => {
    w.fake.failNext['GET example.atlassian.net'] = [503];
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.steps[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('does not retry errors that are not retryable', async () => {
    w.fake.failNext['GET example.atlassian.net'] = [401];
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    expect(jiraCalls()).toBe(1);
    expect((await runStatus(w, runId, w.alice)).steps[0]).toMatchObject({ status: 'failed', errorType: 'http_401' });
  });

  it('allows manual retries up to the limit the Flow creator set (3)', async () => {
    w.fake.failNext['GET example.atlassian.net'] = Array(30).fill(401);
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    await expect(w.app.engine.retry(runId, w.bob)).rejects.toMatchObject({ code: 'forbidden' });
    for (let i = 0; i < 3; i++) {
      await w.app.engine.retry(runId, w.alice);
      await w.app.worker.drain();
    }
    await expect(w.app.engine.retry(runId, w.alice)).rejects.toMatchObject({ code: 'retry_limit_reached' });
    expect(jiraCalls()).toBe(4);
  });

  it('never repeats a write whose outcome is uncertain', async () => {
    w.fake.failNext['PUT gitlab.com'] = ['network'];
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    await w.app.engine.decideGate(runId, 'signoff', w.approver, 'approved');
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('paused');
    expect(run.steps[3]).toMatchObject({ id: 'merge', status: 'failed', errorType: 'uncertain_outcome', attempts: 1 });
    expect(w.fake.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('a manual retry of a forEach step does not repeat items that already succeeded', async () => {
    // MR 7 merges, MR 8 fails with a non-retryable error.
    w.fake.failNext['PUT gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/8'] = [409];
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    await w.app.engine.decideGate(runId, 'signoff', w.approver, 'approved');
    await w.app.worker.drain();
    expect(w.fake.merged).toEqual([7]);
    expect((await runStatus(w, runId, w.alice)).status).toBe('paused');

    await w.app.engine.retry(runId, w.alice);
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('succeeded');
    expect(w.fake.merged).toEqual([7, 8]);
    expect(w.fake.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/7/merge'))).toHaveLength(1);
  });
});

describe('restart recovery', () => {
  it('re-runs a read step that was in flight when the worker died', async () => {
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    // Simulate a crash: the step was marked running, its lease expired, the job is still queued.
    await w.db.query(`UPDATE run_steps SET status = 'running', attempts = 1, lease_until = now() - interval '1 second' WHERE run_id = $1 AND step_id = 'tickets'`, [runId]);
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.steps[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('pauses instead of repeating a write step that was in flight when the worker died', async () => {
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    await w.app.engine.decideGate(runId, 'signoff', w.approver, 'approved');
    // Crash just as the merge step started.
    await w.db.query(`DELETE FROM jobs`);
    await w.db.query(`UPDATE run_steps SET status = 'running', attempts = 1, lease_until = now() - interval '1 second' WHERE run_id = $1 AND step_id = 'merge'`, [runId]);
    await w.db.query(`INSERT INTO jobs (kind, payload) VALUES ('advance', $1)`, [JSON.stringify({ runId })]);
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.steps[3]).toMatchObject({ status: 'failed', errorType: 'uncertain_outcome' });
    expect(w.fake.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('a job whose worker died is picked up again after its lease expires', async () => {
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.db.query(`UPDATE jobs SET locked_until = now() + interval '1 hour', attempts = 1`);
    expect(await w.app.worker.drain()).toBe(0);
    await w.db.query(`UPDATE jobs SET locked_until = now() - interval '1 second'`);
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).waitReason).toBe('approval');
  });

  it('a delay step waits, then continues', async () => {
    const f = (await w.db.query(`SELECT definition FROM flow_versions WHERE id = $1`, [versionId])).rows[0].definition;
    f.steps.splice(1, 0, { id: 'cooldown', type: 'delay', seconds: 3600 });
    const v = await w.app.flows.create('with delay', f, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    let run = await runStatus(w, runId, w.alice);
    expect(run).toMatchObject({ status: 'waiting', waitReason: 'delay' });
    await w.db.query(`UPDATE run_steps SET resume_at = now() WHERE run_id = $1 AND step_id = 'cooldown'`, [runId]);
    await w.db.query(`UPDATE jobs SET run_at = now()`);
    await w.app.worker.drain();
    run = await runStatus(w, runId, w.alice);
    expect(run.steps[1]!.status).toBe('succeeded');
    expect(run.waitReason).toBe('approval');
  });
});

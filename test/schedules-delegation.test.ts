import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextFireTime } from '../src/engine/scheduler.js';
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

const kinds = async (memberId: string) =>
  (await w.db.query(`SELECT kind FROM notifications WHERE member_id = $1 ORDER BY id`, [memberId])).rows.map((r) => r.kind);

describe('cron expressions', () => {
  it('computes the next fire time in the schedule time zone', () => {
    const from = new Date('2026-10-12T10:00:00Z');
    expect(nextFireTime('30 9 * * 1-5', 'Europe/Berlin', from).toISOString()).toBe('2026-10-13T07:30:00.000Z');
    expect(nextFireTime('0 * * * *', 'UTC', from).toISOString()).toBe('2026-10-12T11:00:00.000Z');
  });

  it('rejects invalid expressions, seconds fields and anything more often than once a minute', () => {
    expect(() => nextFireTime('not a cron', 'UTC', new Date())).toThrow();
    expect(() => nextFireTime('*/10 * * * * *', 'UTC', new Date())).toThrow(/5-field|invalid_cron/);
    expect(() => nextFireTime('61 * * * *', 'UTC', new Date())).toThrow();
  });
});

describe('scheduled triggers', () => {
  it('fires a due schedule as its creator, on the fixed version, once per tick', async () => {
    const s = await w.app.scheduler.create({ flowVersionId: versionId, cron: '0 9 * * *', timezone: 'UTC', inputs: releaseInputs }, w.alice);
    await w.db.query(`UPDATE schedules SET next_run_at = now() - interval '3 days' WHERE id = $1`, [s.id]);
    expect(await w.app.scheduler.tick()).toBe(1);
    expect(await w.app.scheduler.tick()).toBe(0); // missed slots fire once, not three times
    const runs = (await w.db.query(`SELECT run_as, flow_version_id FROM runs WHERE schedule_id = $1`, [s.id])).rows;
    expect(runs).toEqual([{ run_as: w.alice.id, flow_version_id: versionId }]);
    const next = (await w.db.query(`SELECT next_run_at FROM schedules WHERE id = $1`, [s.id])).rows[0].next_run_at as Date;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    // Schedule inputs are stored encrypted.
    const raw = JSON.stringify((await w.db.query(`SELECT * FROM schedules WHERE id = $1`, [s.id])).rows);
    expect(raw).not.toContain('acme/app');
  });

  it('validates inputs and the Flow version when the schedule is created', async () => {
    await expect(w.app.scheduler.create({ flowVersionId: versionId, cron: '0 9 * * *', inputs: {} }, w.alice)).rejects.toMatchObject({ code: 'invalid_inputs', message: expect.stringContaining('release: is required') });
    await expect(w.app.scheduler.create({ flowVersionId: versionId, cron: '* * * * *', timezone: 'Mars/Base', inputs: releaseInputs }, w.alice)).rejects.toMatchObject({ code: 'invalid_timezone' });
  });

  it('disables itself and tells its owner when the Flow version loses its approval', async () => {
    const f = await approvedReleaseFlow(w);
    const s = await w.app.scheduler.create({ flowVersionId: f.id, cron: '0 9 * * *', inputs: releaseInputs }, w.alice);
    await w.app.flows.update(f.flowId, f.definition, w.alice); // any change cancels the approval
    await w.db.query(`UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [s.id]);
    expect(await w.app.scheduler.tick()).toBe(0);
    const row = (await w.db.query(`SELECT enabled, disabled_reason FROM schedules WHERE id = $1`, [s.id])).rows[0];
    expect(row).toEqual({ enabled: false, disabled_reason: 'flow_version_not_approved' });
    expect(await kinds(w.alice.id)).toContain('schedule_failed');
    await expect(w.app.scheduler.setEnabled(s.id, w.alice, true)).rejects.toMatchObject({ code: 'flow_version_not_approved' });
  });

  it('only the owner or an admin can switch a schedule on or off', async () => {
    const s = await w.app.scheduler.create({ flowVersionId: versionId, cron: '0 9 * * *', inputs: releaseInputs }, w.alice);
    await expect(w.app.scheduler.setEnabled(s.id, w.bob, false)).rejects.toMatchObject({ code: 'forbidden' });
    await w.app.scheduler.setEnabled(s.id, w.admin, false);
    expect((await w.app.scheduler.list(w.alice)).find((x) => x.id === s.id)!.enabled).toBe(false);
  });
});

describe('delegation lifecycle', () => {
  async function pausedOnGitlab() {
    await w.app.vault.remove(w.alice.id, 'gitlab');
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    return runId;
  }

  it('a delegate without the needed access cannot approve, and can decline instead', async () => {
    const runId = await pausedOnGitlab();
    const id = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.approver.id); // approver has no gitlab credential
    await expect(w.app.engine.decideDelegation(id, w.approver, 'approved')).rejects.toMatchObject({ code: 'delegate_missing_credential' });
    expect((await w.db.query(`SELECT status FROM delegations WHERE id = $1`, [id])).rows[0].status).toBe('pending');
  });

  it('the requester can reassign a pending request to another teammate; the request stays identical', async () => {
    const runId = await pausedOnGitlab();
    await giveAllCredentials(w, w.bob);
    const first = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.approver.id);
    await expect(w.app.engine.reassignDelegation(first, w.bob, w.bob.id)).rejects.toMatchObject({ code: 'not_the_requester' });
    const second = await w.app.engine.reassignDelegation(first, w.alice, w.bob.id);

    const rows = (await w.db.query(`SELECT id, status, delegate_id, request_hash, replaced_by FROM delegations WHERE id = ANY($1)`, [[first, second]])).rows;
    const a = rows.find((r) => r.id === first)!;
    const b = rows.find((r) => r.id === second)!;
    expect(a).toMatchObject({ status: 'cancelled', replaced_by: second });
    expect(b).toMatchObject({ status: 'pending', delegate_id: w.bob.id, request_hash: a.request_hash });
    expect(await kinds(w.approver.id)).toContain('delegation_cancelled');

    await w.app.engine.decideDelegation(second, w.bob, 'approved');
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).steps[1]).toMatchObject({ status: 'succeeded', executedBy: w.bob.id });
  });

  it('the requester can withdraw a request; the run pauses', async () => {
    const runId = await pausedOnGitlab();
    const id = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.bob.id);
    await w.app.engine.cancelDelegation(id, w.alice);
    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('paused');
    expect(run.steps[1]).toMatchObject({ status: 'failed', errorType: 'delegation_cancelled' });
  });

  it('reminds the teammate halfway, then expires, pauses the run and escalates to approvers', async () => {
    const runId = await pausedOnGitlab();
    const id = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.bob.id);
    const created = (await w.db.query(`SELECT created_at FROM delegations WHERE id = $1`, [id])).rows[0].created_at as Date;

    const halfway = new Date(created.getTime() + 13 * 3600_000); // TTL is 24 h in tests
    await w.app.engine.sweepDelegations(halfway);
    const remindedAt = (await w.db.query(`SELECT reminded_at FROM delegations WHERE id = $1`, [id])).rows[0].reminded_at;
    expect(remindedAt).toBeInstanceOf(Date);
    expect(await w.app.engine.sweepDelegations(halfway)).toEqual({ reminded: 0, expired: 0 }); // only once

    const late = new Date(created.getTime() + 25 * 3600_000);
    const res = await w.app.engine.sweepDelegations(late);
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect((await w.db.query(`SELECT status, inputs_enc FROM delegations WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'expired', inputs_enc: null });
    expect((await runStatus(w, runId, w.alice)).steps[1]).toMatchObject({ status: 'failed', errorType: 'delegation_expired' });
    expect(await kinds(w.bob.id)).toContain('delegation_reminder');
    expect(await kinds(w.alice.id)).toContain('delegation_expired');
    expect(await kinds(w.approver.id)).toContain('delegation_escalated');
    // After expiry the requester can ask someone else.
    await expect(w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.admin.id)).resolves.toBeTypeOf('string');
  });

  it('a disabled member cannot be asked', async () => {
    const runId = await pausedOnGitlab();
    await w.db.query(`UPDATE members SET disabled = true WHERE id = $1`, [w.bob.id]);
    await expect(w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.bob.id)).rejects.toMatchObject({ code: 'unknown_delegate' });
    await w.db.query(`UPDATE members SET disabled = false WHERE id = $1`, [w.bob.id]);
  });
});

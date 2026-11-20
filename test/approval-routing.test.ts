import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createMember, type Member } from '../src/core/members.js';
import { createTeam, removeTeamMember, setTeamMember } from '../src/core/teams.js';
import { stepDeadlines, sweepApprovalDeadlines } from '../src/governance/approvals.js';
import { approveExampleModules, giveAllCredentials, makeWorld, releaseFlow, releaseInputs, type World } from './helpers.js';

/** Stand-ins while away, approval by the Flow's own team, and deadlines that remind and escalate. */
let w: World;
let api: ReturnType<typeof buildServer>;
let sam: Member;
let samToken: string;
let payments: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const HOUR = 3_600_000;

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  api = buildServer(w.app);
  const s = await createMember(w.db, 'sam', 'approver', null);
  sam = s.member;
  samToken = s.token;
  // Payments: alice builds and runs, "approver" approves, bob is its admin. Sam and the org admin are outside it.
  payments = (await createTeam(w.db, w.admin, 'Payments')).id;
  await setTeamMember(w.db, w.admin, payments, w.alice.id, 'member');
  await setTeamMember(w.db, w.admin, payments, w.approver.id, 'member');
  await setTeamMember(w.db, w.admin, payments, w.bob.id, 'admin');
  await removeTeamMember(w.db, w.admin, payments, w.admin.id);
  await giveAllCredentials(w, w.alice);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

async function paymentsVersion(name: string, by = w.alice) {
  const f = await releaseFlow();
  return w.app.flows.create(name, f.definition, by, undefined, payments);
}
const policy = async (kind: string, config: unknown) => {
  const r = await api.inject({ method: 'POST', url: '/api/policies', headers: auth(w.tokens.admin), payload: { kind, config } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string };
};
const disable = (id: string) => api.inject({ method: 'PUT', url: `/api/policies/${id}`, headers: auth(w.tokens.admin), payload: { enabled: false } });
const queue = async (token: string) => (await api.inject({ method: 'GET', url: '/api/approvals', headers: auth(token) })).json() as { id: string; forMember?: string; outsideTeam?: boolean }[];
const notes = async (member: Member, kind: string) =>
  (await w.db.query(`SELECT flow_version_id, run_id FROM notifications WHERE member_id = $1 AND kind = $2`, [member.id, kind])).rows;

describe('stand-ins', () => {
  it('only approvers need one, only approvers can be one, members set their own and admins anyone\'s, and they may not overlap', async () => {
    const now = Date.now();
    const body = (standinId: string, extra = {}) => ({ standinId, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 24 * HOUR).toISOString(), ...extra });
    let r = await api.inject({ method: 'POST', url: '/api/standins', headers: auth(w.tokens.alice), payload: body(sam.id) });
    expect(r.json().detail).toContain('only admins and approvers');
    r = await api.inject({ method: 'POST', url: '/api/standins', headers: auth(w.tokens.approver), payload: body(w.bob.id) });
    expect(r.json().detail).toContain('must be an admin or approver');
    r = await api.inject({ method: 'POST', url: '/api/standins', headers: auth(samToken), payload: body(sam.id, { memberId: w.approver.id }) });
    expect(r.json()).toMatchObject({ error: 'admin_only' });

    r = await api.inject({ method: 'POST', url: '/api/standins', headers: auth(w.tokens.approver), payload: body(sam.id, { note: 'Holiday' }) });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ member: 'approver', standin: 'sam', active: true, note: 'Holiday' });
    expect(await notes(sam, 'standin_assigned')).toHaveLength(1);
    r = await api.inject({ method: 'POST', url: '/api/standins', headers: auth(w.tokens.admin), payload: body(w.admin.id, { memberId: w.approver.id }) });
    expect(r.json()).toMatchObject({ error: 'standin_overlaps' });
    // Both of them see it; others do not.
    expect((await api.inject({ method: 'GET', url: '/api/standins', headers: auth(samToken) })).json()).toHaveLength(1);
    expect((await api.inject({ method: 'GET', url: '/api/standins', headers: auth(w.tokens.bob) })).json()).toHaveLength(0);
  });
});

describe('approval by team', () => {
  let rule: { id: string };
  beforeAll(async () => {
    rule = await policy('team_approvals', {});
  });

  it('a stand-in approves for an approver of the team, in their name, and gets their notifications', async () => {
    const v = await paymentsVersion('Standin approves');
    // The approver is away: Sam is told instead.
    expect((await notes(sam, 'flow_approval_needed')).map((n) => n.flow_version_id)).toContain(v.id);
    expect((await notes(w.approver, 'flow_approval_needed')).map((n) => n.flow_version_id)).not.toContain(v.id);
    expect((await queue(samToken)).find((a) => a.id === v.id)).toMatchObject({ forMember: 'approver' });
    const after = await w.app.flows.decide(v.id, sam, 'approved');
    expect(after.status).toBe('approved');
    const row = (await w.db.query(`SELECT decided_for, decided_outside_team FROM flow_versions WHERE id = $1`, [v.id])).rows[0];
    expect(row).toEqual({ decided_for: w.approver.id, decided_outside_team: false });
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'flow.approved_as_standin' AND subject_id = $1 AND related_id = $2`, [v.id, w.approver.id])).rowCount).toBe(1);
  });

  it('without a stand-in, an approver outside the team cannot approve or see it; an org admin can, and it is marked', async () => {
    const standins = (await api.inject({ method: 'GET', url: '/api/standins', headers: auth(w.tokens.approver) })).json() as { id: string }[];
    for (const s of standins) await api.inject({ method: 'DELETE', url: `/api/standins/${s.id}`, headers: auth(w.tokens.approver) });
    const v = await paymentsVersion('Outside the team');
    expect((await queue(samToken)).find((a) => a.id === v.id)).toBeUndefined();
    await expect(w.app.flows.decide(v.id, sam, 'approved')).rejects.toMatchObject({ code: 'not_team_approver' });
    expect((await queue(w.tokens.admin)).find((a) => a.id === v.id)).toMatchObject({ outsideTeam: true });
    await w.app.flows.decide(v.id, w.admin, 'approved');
    const row = (await w.db.query(`SELECT decided_outside_team FROM flow_versions WHERE id = $1`, [v.id])).rows[0];
    expect(row.decided_outside_team).toBe(true);
    const report = (await api.inject({ method: 'GET', url: '/api/admin/audit-report', headers: auth(w.tokens.admin) })).json() as { rows: { subject: string; detail: string }[] };
    expect(report.rows.find((x) => x.subject === 'Outside the team v1')?.detail).toContain('(org admin outside the team)');
  });

  it('a stand-in cannot approve the work of the person they stand in for', async () => {
    await api.inject({
      method: 'POST', url: '/api/standins', headers: auth(w.tokens.approver),
      payload: { standinId: sam.id, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString() },
    });
    const v = await paymentsVersion('By the approver', w.approver);
    await expect(w.app.flows.decide(v.id, sam, 'approved')).rejects.toMatchObject({ code: 'not_team_approver' });
  });

  it('run sign-offs follow the same rule, and record a stand-in\'s decision', async () => {
    const v = await w.app.flows.decide((await paymentsVersion('Signed off by a stand-in')).id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    expect((await notes(sam, 'approval_needed')).map((n) => n.run_id)).toContain(runId);
    await expect(w.app.engine.decideGate(runId, 'signoff', w.bob, 'approved')).rejects.toMatchObject({ code: 'approver_only' });
    await w.app.engine.decideGate(runId, 'signoff', sam, 'approved');
    const d = (await w.db.query(`SELECT decided_by, on_behalf_of, outside_team FROM gate_decisions WHERE run_id = $1`, [runId])).rows[0];
    expect(d).toEqual({ decided_by: sam.id, on_behalf_of: w.approver.id, outside_team: false });
    const view = await w.app.engine.runView(runId, w.alice);
    expect(view.steps.find((x) => x.id === 'signoff')!.decision).toMatchObject({ decision: 'approved', by: 'sam', for: 'approver', outsideTeam: false });
  });

  it('with the rule off, any approver approves again', async () => {
    await disable(rule.id);
    const v = await paymentsVersion('Rule off');
    expect((await queue(samToken)).find((a) => a.id === v.id)).toMatchObject({ id: v.id });
    expect((await w.app.flows.decide(v.id, sam, 'approved')).status).toBe('approved');
  });
});

describe('approval deadlines', () => {
  it('a sign-off step\'s own times win over the rule', () => {
    const rule = { remindAfterHours: 4, escalateAfterHours: 24, orgAdminsAfterHours: 48 };
    expect(stepDeadlines({}, rule)).toBe(rule);
    expect(stepDeadlines({}, null)).toBeNull();
    expect(stepDeadlines({ remindAfterHours: 1 }, rule)).toEqual({ remindAfterHours: 1, escalateAfterHours: 24, orgAdminsAfterHours: 48 });
    expect(stepDeadlines({ remindAfterHours: 2 }, null)).toEqual({ remindAfterHours: 2, escalateAfterHours: 4, orgAdminsAfterHours: 8 });
  });

  it('remind the approvers, then the team\'s admins, then org admins, each once; nothing is rejected', async () => {
    const standins = (await api.inject({ method: 'GET', url: '/api/standins', headers: auth(w.tokens.admin) })).json() as { id: string }[];
    for (const s of standins) await api.inject({ method: 'DELETE', url: `/api/standins/${s.id}`, headers: auth(w.tokens.admin) });
    const bad = await api.inject({ method: 'POST', url: '/api/policies', headers: auth(w.tokens.admin), payload: { kind: 'approval_deadlines', config: { remindAfterHours: 4, escalateAfterHours: 2 } } });
    expect(bad.json().detail).toContain('escalate after more hours');
    const p = await policy('approval_deadlines', { remindAfterHours: 1, escalateAfterHours: 2, orgAdminsAfterHours: 3 });
    const rule = await policy('team_approvals', {});
    const v = await w.app.flows.decide((await paymentsVersion('Waits too long')).id, w.approver, 'approved');
    // Earlier runs merged the ready merge requests; this one needs one to sign off.
    w.fake.mrs.push({ iid: 30, title: 'Late change', detailed_merge_status: 'mergeable', state: 'opened' });
    const runId = await w.app.engine.startRun(v.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    expect((await w.app.engine.runView(runId, w.alice)).waitReason).toBe('approval');
    const at = (h: number) => new Date(Date.now() + h * HOUR);
    const count = async (m: Member, kind: string) => (await notes(m, kind)).filter((n) => n.run_id === runId).length;

    await sweepApprovalDeadlines(w.db, at(0.5));
    expect(await count(w.approver, 'approval_reminder')).toBe(0);
    await sweepApprovalDeadlines(w.db, at(1.5));
    await sweepApprovalDeadlines(w.db, at(1.6));
    expect(await count(w.approver, 'approval_reminder')).toBe(1);
    expect(await count(w.alice, 'approval_reminder')).toBe(0); // the runner is never asked to approve their own run
    expect(await count(w.bob, 'approval_escalated')).toBe(0);
    await sweepApprovalDeadlines(w.db, at(2.5));
    expect(await count(w.bob, 'approval_escalated')).toBe(1); // Payments' admin
    expect(await count(w.admin, 'approval_escalated')).toBe(0);
    await sweepApprovalDeadlines(w.db, at(3.5));
    await sweepApprovalDeadlines(w.db, at(9));
    expect(await count(w.admin, 'approval_escalated')).toBe(1);
    expect(await count(w.bob, 'approval_escalated')).toBe(1);
    expect((await w.app.engine.runView(runId, w.alice)).waitReason).toBe('approval');
    await disable(p.id);
    await disable(rule.id);
  });

  it('also reminds about Flow versions waiting for approval', async () => {
    const p = await policy('approval_deadlines', { remindAfterHours: 1, escalateAfterHours: 2 });
    const v = await paymentsVersion('Version waits');
    await sweepApprovalDeadlines(w.db, new Date(Date.now() + 1.5 * HOUR));
    expect((await notes(w.approver, 'approval_reminder')).map((n) => n.flow_version_id)).toContain(v.id);
    await disable(p.id);
  });
});

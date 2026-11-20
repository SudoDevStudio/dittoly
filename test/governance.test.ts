import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { sealAudit, verifyAudit } from '../src/governance/audit-chain.js';
import { checkRunStart } from '../src/governance/policies.js';
import { compareScopes } from '../src/governance/scopes.js';
import { sweepReviews } from '../src/governance/reviews.js';
import { approveExampleModules, giveAllCredentials, makeWorld, releaseFlow, releaseInputs, runStatus, type World } from './helpers.js';

/** Governance: rules, several approvers, dry runs, access preview, token scopes, audit chain, break-glass, access reviews. */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

async function newReleaseVersion(name: string) {
  const f = await releaseFlow();
  return w.app.flows.create(name, f.definition, w.alice);
}
const policy = async (kind: string, config: unknown) => {
  const r = await api.inject({ method: 'POST', url: '/api/policies', headers: auth(w.tokens.admin), payload: { kind, config } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string };
};
const disable = async (id: string) =>
  expect((await api.inject({ method: 'PUT', url: `/api/policies/${id}`, headers: auth(w.tokens.admin), payload: { enabled: false } })).statusCode).toBe(204);

describe('policy rules', () => {
  it('only admins set rules, each kind is checked against its form, and everyone can read them in plain words', async () => {
    expect((await api.inject({ method: 'POST', url: '/api/policies', headers: auth(w.tokens.approver), payload: { kind: 'no_delegation', config: {} } })).json()).toEqual({ error: 'admin_only' });
    const bad = await api.inject({ method: 'POST', url: '/api/policies', headers: auth(w.tokens.admin), payload: { kind: 'run_window', config: { days: [1], from: '9am', to: '17:00', timezone: 'UTC' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toContain('from');
    const tz = await api.inject({ method: 'POST', url: '/api/policies', headers: auth(w.tokens.admin), payload: { kind: 'run_window', config: { days: [1], from: '09:00', to: '17:00', timezone: 'Mars/Olympus' } } });
    expect(tz.json().detail).toContain('time zone');
    const p = await policy('max_runs_per_day', { count: 500 });
    const list = (await api.inject({ method: 'GET', url: '/api/policies', headers: auth(w.tokens.bob) })).json();
    expect(list.policies.find((x: { id: string }) => x.id === p.id).says).toBe('At most 500 runs per person per day.');
    await disable(p.id);
  });

  it('a Flow that changes data needs two different approvers when a rule says so', async () => {
    const p = await policy('approvals_for_writes', { count: 2, module: 'gitlab' });
    const v = await newReleaseVersion('Two approvers');
    let after = await w.app.flows.decide(v.id, w.approver, 'approved');
    expect(after.status).toBe('pending');
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.admin) })).json();
    expect(review.approvals).toMatchObject({ required: 2, given: [{ handle: 'approver' }] });
    expect(review.approvals.because).toContain('2 different approvers');
    await expect(w.app.flows.decide(v.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'already_approved_by_you' });
    after = await w.app.flows.decide(v.id, w.admin, 'approved');
    expect(after.status).toBe('approved');
    await disable(p.id);
  });

  it('refuses to approve modules that reach hosts outside the allowed list, and Flows that hand steps to teammates where forbidden', async () => {
    const hosts = await policy('allowed_hosts', { patterns: ['gitlab.com', '*.atlassian.net'] });
    const v = await newReleaseVersion('Outside hosts');
    await expect(w.app.flows.decide(v.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'policy_violation' });
    await expect(w.app.flows.decide(v.id, w.approver, 'approved')).rejects.toThrow(/slack\.com/);
    await disable(hosts.id);

    const nd = await policy('no_delegation', { module: 'gitlab' });
    const f = await releaseFlow();
    const def = JSON.parse(JSON.stringify(f.definition));
    def.steps.find((s: { id: string }) => s.id === 'merge').delegateTo = w.bob.id;
    const d = await w.app.flows.create('Delegated merge', def, w.alice);
    await expect(w.app.flows.decide(d.id, w.approver, 'approved')).rejects.toThrow(/cannot be handed to a teammate/);
    await disable(nd.id);
  });

  it('stops real runs outside working hours and past a daily limit, but not dry runs', async () => {
    const v = await w.app.flows.decide((await newReleaseVersion('Hours')).id, w.approver, 'approved');
    const { modules } = await w.app.flows.assertRunnable(w.db, v.id);
    const win = await policy('run_window', { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', timezone: 'Europe/Berlin', writesOnly: true });
    // Saturday 2026-10-17 12:00 in Berlin.
    await expect(checkRunStart(w.db, w.alice.id, v.definition, modules, new Date('2026-10-17T10:00:00Z'))).rejects.toThrow(/outside those hours/);
    // Monday 2026-10-19 10:00 in Berlin.
    await expect(checkRunStart(w.db, w.alice.id, v.definition, modules, new Date('2026-10-19T08:00:00Z'))).resolves.toBeUndefined();
    await disable(win.id);

    const lim = await policy('max_runs_per_day', { count: 1 });
    await giveAllCredentials(w, w.bob);
    await w.app.engine.startRun(v.id, w.bob.id, releaseInputs);
    await expect(w.app.engine.startRun(v.id, w.bob.id, releaseInputs)).rejects.toThrow(/limit for today/);
    await expect(w.app.engine.startRun(v.id, w.bob.id, releaseInputs, { actorId: w.bob.id, dry: true })).resolves.toBeTruthy();
    await disable(lim.id);
    await w.app.worker.drain();
  });
});

describe('before running: access preview and dry run', () => {
  it('shows every step, what it changes, and whose access it uses, with what is missing', async () => {
    const v = await w.app.flows.decide((await newReleaseVersion('Preview')).id, w.approver, 'approved');
    const r = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/access`, headers: auth(w.tokens.alice) })).json();
    expect(r.steps.map((s: { stepId: string; changesData: boolean; dryRun: string }) => [s.stepId, s.changesData, s.dryRun])).toEqual([
      ['tickets', false, 'runs'],
      ['mrs', false, 'runs'],
      ['signoff', false, 'skipped'],
      ['merge', true, 'skipped'],
      ['announce', true, 'skipped'],
    ]);
    expect(r.changesData).toBe(true);
    expect(r.yourServices.sort()).toEqual(['gitlab', 'jira', 'slack']);
    expect(r.missing.map((m: { service: string }) => m.service).sort()).toEqual(['gitlab', 'gitlab', 'jira', 'slack']);
  });

  it('a dry run reads for real, skips sign-offs and everything that changes data, and starts no follow-ups', async () => {
    const v = await w.app.flows.decide((await newReleaseVersion('Dry')).id, w.approver, 'approved');
    await giveAllCredentials(w, w.alice);
    w.fake.mrs.forEach((m) => (m.state = 'opened'));
    w.fake.merged = [];
    const before = w.fake.messages.length;
    const res = await api.inject({ method: 'POST', url: `/api/flow-versions/${v.id}/runs`, headers: auth(w.tokens.alice), payload: { inputs: releaseInputs, dryRun: true } });
    expect(res.statusCode).toBe(202);
    await w.app.worker.drain();
    const run = await runStatus(w, res.json().runId, w.alice);
    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => [s.id, s.status])).toEqual([
      ['tickets', 'succeeded'],
      ['mrs', 'succeeded'],
      ['signoff', 'skipped'],
      ['merge', 'skipped'],
      ['announce', 'skipped'],
    ]);
    expect(w.fake.merged).toEqual([]);
    expect(w.fake.messages.length).toBe(before);
  });
});

describe('least-privilege token scopes', () => {
  it('compares the scopes a token has with what modules declare', () => {
    expect(compareScopes('gitlab', ['api'], ['api'])).toEqual({ status: 'ok', excess: [], missing: [] });
    expect(compareScopes('gitlab', ['api', 'sudo'], ['api'])).toEqual({ status: 'broader', excess: ['sudo'], missing: [] });
    expect(compareScopes('gitlab', ['read_api'], ['api'])).toEqual({ status: 'missing', excess: ['read_api'], missing: ['api'] });
    expect(compareScopes('gitlab', ['api'], ['read_api'])).toMatchObject({ status: 'ok' });
    expect(compareScopes('github', ['repo', 'admin:org'], ['repo:status', 'read:org'])).toMatchObject({ status: 'ok' });
  });

  it('asks GitLab which scopes a stored token has when it is saved, and keeps the result with it', async () => {
    w.fake.gitlabScopes['glpat-wide'] = ['api', 'sudo', 'admin_mode'];
    expect((await api.inject({ method: 'PUT', url: '/api/me/credentials/gitlab', headers: auth(w.tokens.bob), payload: { secret: 'glpat-wide' } })).statusCode).toBe(204);
    let list = (await api.inject({ method: 'GET', url: '/api/me/credentials', headers: auth(w.tokens.bob) })).json();
    expect(list.find((c: { service: string }) => c.service === 'gitlab').scopeCheck).toMatchObject({ status: 'broader', provider: 'gitlab', needed: ['api'], excess: ['sudo', 'admin_mode'] });
    // An unknown or revoked token is reported, not fatal.
    await api.inject({ method: 'PUT', url: '/api/me/credentials/gitlab', headers: auth(w.tokens.bob), payload: { secret: 'glpat-revoked' } });
    list = (await api.inject({ method: 'GET', url: '/api/me/credentials', headers: auth(w.tokens.bob) })).json();
    expect(list.find((c: { service: string }) => c.service === 'gitlab').scopeCheck).toMatchObject({ status: 'error' });
    w.fake.gitlabScopes['glpat-revoked'] = ['api'];
    const again = (await api.inject({ method: 'POST', url: '/api/me/credentials/gitlab/check', headers: auth(w.tokens.bob) })).json();
    expect(again).toMatchObject({ status: 'ok', granted: ['api'] });
    // Services that do not report scopes say so.
    await api.inject({ method: 'PUT', url: '/api/me/credentials/slack', headers: auth(w.tokens.bob), payload: { secret: 'xoxb-x' } });
    list = (await api.inject({ method: 'GET', url: '/api/me/credentials', headers: auth(w.tokens.bob) })).json();
    expect(list.find((c: { service: string }) => c.service === 'slack').scopeCheck).toMatchObject({ status: 'unknown' });
  });
});

describe('tamper-evident audit log and the audit report', () => {
  it('refuses to change or delete audit events, chains them, and notices a slipped-in event', async () => {
    await expect(w.db.query(`UPDATE audit_events SET outcome = 'ok' WHERE id = (SELECT min(id) FROM audit_events)`)).rejects.toThrow(/cannot be changed/);
    await expect(w.db.query(`DELETE FROM audit_events WHERE id = (SELECT min(id) FROM audit_events)`)).rejects.toThrow(/cannot be changed/);
    expect(await sealAudit(w.db, 0)).toBeGreaterThan(10);
    let chain = await verifyAudit(w.db);
    expect(chain.problems).toEqual([]);
    expect(chain.ok).toBe(true);
    expect(chain.head!.hash).toMatch(/^[0-9a-f]{64}$/);

    // Someone with database access disables the guard and edits an event: the chain breaks.
    const victim = chain.head!.eventId;
    await w.db.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
    await w.db.query(`UPDATE audit_events SET actor_id = NULL WHERE id = $1`, [victim]);
    chain = await verifyAudit(w.db);
    expect(chain.ok).toBe(false);
    expect(chain.problems[0]).toContain(`Event ${victim} does not match its seal`);
    // Put it back so later tests see an intact log.
    await w.db.query(`DELETE FROM audit_seals WHERE event_id >= (SELECT min(event_id) FROM audit_seals)`);
    await w.db.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
    await sealAudit(w.db, 0);
    expect((await verifyAudit(w.db)).ok).toBe(true);
  });

  it('gives admins a report with approvals, runs, rule changes and the chain, as JSON or CSV', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/admin/audit-report', headers: auth(w.tokens.approver) })).json()).toEqual({ error: 'admin_only' });
    const r = (await api.inject({ method: 'GET', url: '/api/admin/audit-report', headers: auth(w.tokens.admin) })).json();
    expect(r.chain.ok).toBe(true);
    expect(r.counts.approval).toBeGreaterThan(3);
    expect(r.rows.some((x: { section: string; detail: string }) => x.section === 'approval' && x.detail.includes('decided by approver, admin'))).toBe(true);
    expect(r.rows.some((x: { section: string; what: string }) => x.section === 'run' && x.what === 'dry run')).toBe(true);
    expect(r.rows.some((x: { section: string; what: string }) => x.section === 'policy' && x.what === 'created')).toBe(true);
    const csv = await api.inject({ method: 'GET', url: '/api/admin/audit-report?format=csv', headers: auth(w.tokens.admin) });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('section,at,who,what,subject,detail,flag');
    expect(csv.body).toContain('Audit chain: intact');
  });
});

describe('break-glass', () => {
  it('lets a marked member run as someone else for a limited time, with a reason, telling admins and that person', async () => {
    const v = await w.app.flows.decide((await newReleaseVersion('Emergency')).id, w.approver, 'approved');
    const body = { actAs: w.alice.id, reason: 'Release is blocked and alice is on leave', minutes: 15 };
    expect((await api.inject({ method: 'POST', url: '/api/breakglass', headers: auth(w.tokens.bob), payload: body })).json()).toEqual({ error: 'breakglass_not_allowed' });
    expect((await api.inject({ method: 'PUT', url: `/api/members/${w.bob.id}/breakglass`, headers: auth(w.tokens.approver), payload: { enabled: true } })).json()).toEqual({ error: 'admin_only' });
    expect((await api.inject({ method: 'PUT', url: `/api/members/${w.bob.id}/breakglass`, headers: auth(w.tokens.admin), payload: { enabled: true } })).statusCode).toBe(204);
    expect((await api.inject({ method: 'POST', url: '/api/breakglass', headers: auth(w.tokens.bob), payload: { ...body, reason: 'urgent' } })).statusCode).toBe(400);
    const g = await api.inject({ method: 'POST', url: '/api/breakglass', headers: auth(w.tokens.bob), payload: body });
    expect(g.statusCode).toBe(201);
    const grant = g.json();
    expect(grant).toMatchObject({ member: 'bob', actAs: 'alice', active: true });
    const told = await w.db.query(`SELECT m.handle FROM notifications n JOIN members m ON m.id = n.member_id WHERE n.kind = 'breakglass_used' ORDER BY m.handle`);
    expect(told.rows.map((r) => r.handle)).toEqual(['admin', 'alice']);

    const run = await api.inject({ method: 'POST', url: `/api/flow-versions/${v.id}/runs`, headers: auth(w.tokens.bob), payload: { inputs: releaseInputs, breakglassId: grant.id } });
    expect(run.statusCode).toBe(202);
    const row = (await w.db.query(`SELECT run_as, breakglass_id FROM runs WHERE id = $1`, [run.json().runId])).rows[0];
    expect(row).toEqual({ run_as: w.alice.id, breakglass_id: grant.id });
    // Nobody else can use bob's grant, and it stops when ended.
    expect((await api.inject({ method: 'POST', url: `/api/flow-versions/${v.id}/runs`, headers: auth(w.tokens.approver), payload: { inputs: releaseInputs, breakglassId: grant.id } })).json().error).toBe('breakglass_inactive');
    expect((await api.inject({ method: 'POST', url: `/api/breakglass/${grant.id}/end`, headers: auth(w.tokens.bob) })).statusCode).toBe(204);
    expect((await api.inject({ method: 'POST', url: `/api/flow-versions/${v.id}/runs`, headers: auth(w.tokens.bob), payload: { inputs: releaseInputs, breakglassId: grant.id } })).json().error).toBe('breakglass_inactive');
    await w.app.worker.drain();

    const report = (await api.inject({ method: 'GET', url: '/api/admin/audit-report', headers: auth(w.tokens.admin) })).json();
    expect(report.rows.find((x: { section: string }) => x.section === 'breakglass')).toMatchObject({ who: 'bob', subject: 'as alice', flag: 'break-glass' });
    expect(report.rows.find((x: { section: string; flag: string | null }) => x.section === 'run' && x.flag === 'break-glass')).toMatchObject({ who: 'bob' });
  });
});

describe('access reviews', () => {
  it('asks people to confirm access they hold, renews what they keep, and removes credentials nobody confirmed', async () => {
    await w.app.vault.put(w.approver.id, 'jira', 'a@example.com:token');
    await w.app.vault.put(w.approver.id, 'slack', 'xoxb-approver');
    await w.db.query(`UPDATE credentials SET review_due_at = now() - interval '1 day' WHERE member_id = $1`, [w.approver.id]);
    await sweepReviews(w.db);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE member_id = $1 AND kind = 'access_review_due'`, [w.approver.id])).rows[0].n).toBe(1);
    const due = (await api.inject({ method: 'GET', url: '/api/me/reviews', headers: auth(w.tokens.approver) })).json();
    expect(due.credentials.map((c: { service: string }) => c.service)).toEqual(['jira', 'slack']);

    expect((await api.inject({ method: 'POST', url: '/api/reviews', headers: auth(w.tokens.approver), payload: { kind: 'credential', service: 'jira', keep: true } })).statusCode).toBe(204);
    // Slack is ignored for longer than the grace period: it is removed and the owner told.
    await w.db.query(`UPDATE credentials SET review_due_at = now() - interval '15 days' WHERE member_id = $1 AND service = 'slack'`, [w.approver.id]);
    await sweepReviews(w.db);
    expect((await w.app.vault.list(w.approver.id)).map((c) => c.service)).toEqual(['jira']);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE member_id = $1 AND kind = 'access_removed'`, [w.approver.id])).rows[0].n).toBe(1);
    // Updating a credential counts as reviewing it.
    expect((await w.app.vault.list(w.approver.id))[0]!.reviewDueAt.getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
  });

  it('flags team memberships for team admins without removing anyone on its own', async () => {
    await w.db.query(`UPDATE team_members SET review_due_at = now() - interval '30 days'`);
    await sweepReviews(w.db);
    const r = (await api.inject({ method: 'GET', url: '/api/me/reviews', headers: auth(w.tokens.admin) })).json();
    expect(r.memberships.length).toBeGreaterThan(0);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM team_members`)).rows[0].n).toBe(r.memberships.length);
    const bob = r.memberships.find((m: { handle: string }) => m.handle === 'bob');
    expect((await api.inject({ method: 'POST', url: '/api/reviews', headers: auth(w.tokens.bob), payload: { kind: 'membership', teamId: bob.teamId, memberId: bob.memberId, keep: true } })).json().error).toBe('team_admin_only');
    expect((await api.inject({ method: 'POST', url: '/api/reviews', headers: auth(w.tokens.admin), payload: { kind: 'membership', teamId: bob.teamId, memberId: bob.memberId, keep: true } })).statusCode).toBe(204);
  });
});

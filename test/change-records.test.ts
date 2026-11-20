import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { createMember, type Member } from '../src/core/members.js';
import { recordCall } from '../src/modules/health.js';
import { approveExampleModules, makeWorld, releaseFlow, type World } from './helpers.js';

/** Self-fixes as governed changes: one change record each, never applied by itself, never approved by whoever asked for it. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
let admin2: Member;
let admin3: Member;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const modulesDir = path.resolve(import.meta.dirname, 'fixtures', 'modules');
let admin2Token = '';

async function enqueueFix(name: string, version: string, change: (m: any) => void) {
  const dir = path.join(modulesDir, name);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.version = version;
  change(manifest);
  ai.enqueue({ manifestJson: JSON.stringify(manifest), code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8') });
}
const drift = async (module: string, version: string, action: string) => {
  for (let i = 0; i < 4; i++) await recordCall(w.db, { module, version, action, ok: false, errorType: 'http_410' });
};
const get = async (url: string, token = w.tokens.approver) => (await api.inject({ method: 'GET', url: `/api${url}`, headers: auth(token) })).json();
const versionId = async (name: string, version: string) => (await w.db.query(`SELECT id FROM module_versions WHERE name = $1 AND version = $2`, [name, version])).rows[0].id as string;

let openBugs = '';
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  api = buildServer(w.app);
  const a2 = await createMember(w.db, 'admin2', 'admin', null);
  admin2 = a2.member;
  admin2Token = a2.token;
  admin3 = (await createMember(w.db, 'admin3', 'admin', null)).member;
  const def = {
    inputs: { type: 'object', properties: { project: { type: 'string', description: 'Jira project key', examples: ['OPS'] } }, required: ['project'] },
    moduleSettings: { jira: { site: 'example.atlassian.net' } },
    steps: [{ id: 'bugs', type: 'action', module: 'jira@1.1.0', action: 'search_issues', input: { jql: 'project = {{ inputs.project }} AND type = Bug' } }],
  };
  const v = await w.app.flows.create('Open bugs', def, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  openBugs = v.flowId;
  await w.app.flowTests.save(w.alice, openBugs, { name: 'one bug', case: { inputs: { project: 'OPS' }, answers: { bugs: { output: { issues: [{ key: 'OPS-1', summary: 'Login fails', status: 'Open' }] } } }, expect: { status: 'succeeded' } } });
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('a self-fix is a change record', () => {
  let changeId = '';
  it('records the drift, the AI request, what it produced, the diff and the tests, and proposes without applying anything', async () => {
    // The admin who turns self-fixing on is the requester of the fixes it drafts.
    expect((await api.inject({ method: 'PUT', url: '/api/admin/self-fix', headers: auth(w.tokens.admin), payload: { enabled: true, perDay: 3 } })).statusCode).toBe(200);
    await drift('jira', '1.1.0', 'search_issues');
    await enqueueFix('jira', '1.1.1', (m) => delete m.actions[0].input.properties.maxResults);
    await w.app.maintenance();

    expect((await api.inject({ method: 'GET', url: '/api/changes', headers: auth(w.tokens.alice) })).json()).toEqual({ error: 'approver_only' });
    const list = await get('/changes');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ module: 'jira', fromVersion: '1.1.0', toVersion: '1.1.1', status: 'proposed', widensAccess: false, author: 'Dittoly (self-fix)', requestedBy: 'admin', requestedHow: 'automatic' });
    changeId = list[0].id;

    const c = await get(`/changes/${changeId}`);
    expect(c).toMatchObject({ module: 'jira', fromVersion: '1.1.0', toVersion: '1.1.1' });
    expect(c.drift.summary).toMatchObject({ calls: 4, failures: 4, errors: { http_410: 4 }, actions: ['search_issues'] });
    expect(c.ai).toMatchObject({ provider: 'mock', model: 'mock' });
    expect(c.ai.inputTokens).toBeGreaterThan(0);
    expect(c.diff.changes).toContain('"Search issues" takes different input.');
    expect(c.diff.widening).toEqual([]);
    expect(c.tests.module.total).toBeGreaterThan(0);
    expect(c.tests.module.passed).toBe(c.tests.module.total);
    expect(c.tests.flows).toEqual([{ flowId: openBugs, name: 'Open bugs', total: 1, passed: 1 }]);
    expect(c.flows).toMatchObject([{ name: 'Open bugs', status: 'proposed', versionStatus: 'pending' }]);
    expect(c.moduleVersion).toMatchObject({ status: 'pending_review', approvals: { required: 1, given: [] } });
    // Never applied by itself: the approved version keeps running.
    expect((await w.app.flows.versions(openBugs)).map((v) => v.status)).toEqual(['approved', 'pending']);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'change.proposed' AND subject_id = $1`, [changeId])).rowCount).toBe(1);
    // The module draft is Dittoly's own; its review page links to the change.
    const fixId = await versionId('jira', '1.1.1');
    expect((await w.db.query(`SELECT created_by FROM module_versions WHERE id = $1`, [fixId])).rows[0].created_by).toBeNull();
    expect(await get(`/changes/for?moduleVersion=${fixId}`)).toMatchObject([{ id: changeId, moduleApprovalsGiven: 0 }]);
  });

  it('the requester can never approve any part of it; other people decide, and every decision is recorded', async () => {
    const fixId = await versionId('jira', '1.1.1');
    await expect(w.app.modules.decide(fixId, w.admin, 'approved')).rejects.toMatchObject({ code: 'cannot_approve_change_you_requested' });
    await w.app.modules.decide(fixId, admin2, 'approved');
    expect((await get(`/changes/${changeId}`)).status).toBe('partly_approved');

    const proposed = (await w.app.flows.versions(openBugs))[1]!;
    // The Flow version is the owner's (alice): she cannot approve it, nor can the requester.
    await expect(w.app.flows.decide(proposed.id, w.admin, 'approved')).rejects.toMatchObject({ code: 'cannot_approve_change_you_requested' });
    expect(await get(`/changes/for?flowVersion=${proposed.id}`)).toMatchObject([{ id: changeId }]);
    await w.app.flows.decide(proposed.id, w.approver, 'approved');

    const c = await get(`/changes/${changeId}`);
    expect(c.status).toBe('approved');
    expect(c.decisions).toMatchObject([
      { part: 'module', decision: 'approved', final: true, by: 'admin2' },
      { part: 'flow', subjectId: proposed.id, decision: 'approved', final: true, by: 'approver' },
    ]);
    const actions = (await w.db.query(`SELECT action FROM audit_events WHERE subject_type = 'change' AND subject_id = $1 ORDER BY id`, [changeId])).rows.map((r) => r.action);
    expect(actions).toEqual(['change.proposed', 'change.module_approved', 'change.partly_approved', 'change.flow_approved', 'change.approved']);
  });

  it('the author of a module draft or Flow version still cannot approve it (shared mode)', async () => {
    const dir = path.join(modulesDir, 'slack');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const mv = await w.app.modules.createDraft({ manifest: { ...manifest, version: '1.0.9' }, code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')), origin: 'seed' }, admin3);
    await w.app.modules.submit(mv.id, admin3);
    await expect(w.app.modules.decide(mv.id, admin3, 'approved')).rejects.toMatchObject({ code: 'cannot_review_own_module' });
    const f = await releaseFlow();
    const v = await w.app.flows.create('Authored by the approver', f.definition, w.approver);
    await expect(w.app.flows.decide(v.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'cannot_approve_own_flow' });
  });
});

describe('a self-fix that widens access', () => {
  it('is flagged, needs several different admins (none of them the requester), and its Flows need distinct approvers', async () => {
    // Flows that change data with gitlab need two approvers.
    expect((await api.inject({ method: 'POST', url: '/api/policies', headers: auth(w.tokens.admin), payload: { kind: 'approvals_for_writes', config: { count: 2, module: 'gitlab' } } })).statusCode).toBe(201);
    const f = await releaseFlow();
    let v = await w.app.flows.create('Release', f.definition, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    v = await w.app.flows.decide(v.id, w.admin, 'approved');
    expect(v.status).toBe('approved');

    // Self-fixing off: this one is asked for by hand.
    await api.inject({ method: 'PUT', url: '/api/admin/self-fix', headers: auth(w.tokens.admin), payload: { enabled: false, perDay: 3 } });
    await drift('gitlab', '1.0.0', 'list_merge_requests');
    await w.app.maintenance();
    // admin2 asks for the fix by hand; the fixed module reaches one more host.
    await enqueueFix('gitlab', '1.0.1', (m) => m.hosts.push('gitlab.example.com'));
    const asked = await api.inject({ method: 'POST', url: '/api/modules-drift/gitlab/fix', headers: auth(admin2Token) });
    expect(asked.statusCode, asked.body).toBe(201);
    const { changeId, id: fixId } = asked.json();

    const c = await get(`/changes/${changeId}`);
    expect(c).toMatchObject({ status: 'proposed', widensAccess: true, requestedBy: 'admin2', requestedHow: 'by_hand', moduleVersion: { approvals: { required: 2, given: [] } } });
    expect(c.widening).toEqual(['reaches new hosts: gitlab.example.com']);
    expect(c.diff.changes[0]).toBe('Now also reaches gitlab.example.com.');
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'change.proposed_widening_access' AND subject_id = $1`, [changeId])).rowCount).toBe(1);

    await expect(w.app.modules.decide(fixId, admin2, 'approved')).rejects.toMatchObject({ code: 'cannot_approve_change_you_requested' });
    await w.app.modules.decide(fixId, w.admin, 'approved');
    expect((await w.app.modules.get(w.db, fixId))!.status).toBe('pending_review');
    await expect(w.app.modules.decide(fixId, w.admin, 'approved')).rejects.toMatchObject({ code: 'already_approved_by_you' });
    expect(await get(`/changes/for?moduleVersion=${fixId}`)).toMatchObject([{ status: 'partly_approved', moduleApprovalsGiven: 1 }]);
    await w.app.modules.decide(fixId, admin3, 'approved');
    expect((await w.app.modules.get(w.db, fixId))!.status).toBe('approved');

    // The proposed Release version: two different approvers, neither the owner (alice) nor the requester (admin2).
    const proposed = (await w.app.flows.versions(v.flowId)).find((x) => x.status === 'pending')!;
    expect(JSON.stringify(proposed.definition)).toContain('gitlab@1.0.1');
    await expect(w.app.flows.decide(proposed.id, admin2, 'approved')).rejects.toMatchObject({ code: 'cannot_approve_change_you_requested' });
    expect((await w.app.flows.decide(proposed.id, w.approver, 'approved')).status).toBe('pending');
    expect((await get(`/changes/${changeId}`)).status).toBe('partly_approved');
    expect((await w.app.flows.decide(proposed.id, w.admin, 'approved')).status).toBe('approved');

    const done = await get(`/changes/${changeId}`);
    expect(done.status).toBe('approved');
    expect(done.moduleVersion.approvals.given.map((g: { handle: string }) => g.handle)).toEqual(['admin', 'admin3']);
    expect(done.decisions.map((d: { part: string; by: string; final: boolean }) => `${d.part}:${d.by}:${d.final}`)).toEqual(['module:admin:false', 'module:admin3:true', 'flow:approver:false', 'flow:admin:true']);
  });

  it('a rejected fix rejects the change, and a newer fix supersedes one still waiting', async () => {
    await drift('slack', '1.0.0', 'post_message');
    await w.app.maintenance();
    await enqueueFix('slack', '1.0.1', () => undefined);
    const first = (await api.inject({ method: 'POST', url: '/api/modules-drift/slack/fix', headers: auth(admin2Token) })).json();
    await enqueueFix('slack', '1.0.2', () => undefined);
    const second = (await api.inject({ method: 'POST', url: '/api/modules-drift/slack/fix', headers: auth(admin2Token) })).json();
    expect((await get(`/changes/${first.changeId}`)).status).toBe('superseded');
    // The requester may still reject.
    await w.app.modules.decide(second.id, admin2, 'rejected');
    expect((await get(`/changes/${second.changeId}`)).status).toBe('rejected');
  });

  it('change records and their decisions are in the audit report, under change management', async () => {
    const r = (await api.inject({ method: 'GET', url: '/api/admin/audit-report', headers: auth(w.tokens.admin) })).json();
    const changes = r.rows.filter((x: { section: string }) => x.section === 'change');
    expect(changes.length).toBeGreaterThan(5);
    const widening = changes.find((x: { flag: string | null }) => x.flag?.startsWith('widens access'));
    expect(widening).toMatchObject({ who: 'Dittoly (self-fix)', subject: 'gitlab@1.0.0 -> 1.0.1' });
    expect(widening.controls).toEqual(expect.arrayContaining(['SOC 2 CC8.1', 'ISO/IEC 27001:2022 A.8.32']));
    expect(changes.some((x: { flag: string | null }) => x.flag === 'approved own change request')).toBe(false);
    expect(r.counts.change).toBe(changes.length);
  });
});

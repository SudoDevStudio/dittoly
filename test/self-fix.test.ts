import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { createMember } from '../src/core/members.js';
import { recordCall } from '../src/modules/health.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/** Self-fixing Flows: a drifting module gets a fix drafted by itself, and the Flows using it get proposed new versions. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const jiraDir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'jira');

async function jiraFix(version: string, code?: string) {
  const manifest = JSON.parse(await readFile(path.join(jiraDir, 'manifest.json'), 'utf8'));
  manifest.version = version;
  // The fixed API no longer takes maxResults.
  delete manifest.actions[0].input.properties.maxResults;
  ai.enqueue({ manifestJson: JSON.stringify(manifest), code: code ?? (await readFile(path.join(jiraDir, 'module.mjs'), 'utf8')), testsJson: await readFile(path.join(jiraDir, 'tests.json'), 'utf8') });
}
const drift = async (module: string, version: string) => {
  for (let i = 0; i < 4; i++) await recordCall(w.db, { module, version, action: module === 'slack' ? 'post_message' : 'list_merge_requests', ok: false, errorType: 'http_410' });
};
const driftList = async () => (await api.inject({ method: 'GET', url: '/api/modules-drift', headers: auth(w.tokens.admin) })).json() as any[];
const bugsDef = (input: Record<string, unknown>) => ({
  inputs: { type: 'object', properties: { project: { type: 'string', description: 'Jira project key', examples: ['OPS'] } }, required: ['project'] },
  moduleSettings: { jira: { site: 'example.atlassian.net' } },
  steps: [{ id: 'bugs', type: 'action', module: 'jira@1.1.0', action: 'search_issues', input }],
});
let openBugs = '';
let bigSearch = '';

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  api = buildServer(w.app);
  // Two approved Flows on jira@1.1.0: one keeps working with the fix, one passes an input the fix drops.
  let v = await w.app.flows.create('Open bugs', bugsDef({ jql: 'project = {{ inputs.project }} AND type = Bug' }), w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  openBugs = v.flowId;
  await w.app.flowTests.save(w.alice, openBugs, { name: 'one bug', case: { inputs: { project: 'OPS' }, answers: { bugs: { output: { issues: [{ key: 'OPS-1', summary: 'Login fails', status: 'Open' }] } } }, expect: { status: 'succeeded' } } });
  v = await w.app.flows.create('Big search', bugsDef({ jql: 'project = {{ inputs.project }}', maxResults: 100 }), w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  bigSearch = v.flowId;
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('settings', () => {
  it('on by default, three fixes a day; only admins change it, and changes are audited', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/admin/self-fix', headers: auth(w.tokens.admin) })).json()).toEqual({ enabled: true, perDay: 3, aiConfigured: true });
    expect((await api.inject({ method: 'PUT', url: '/api/admin/self-fix', headers: auth(w.tokens.alice), payload: { enabled: false, perDay: 3 } })).statusCode).toBe(403);
  });
});

describe('when an app changes', () => {
  it('drafts the fix by itself, sends it for review, and proposes new versions of the Flows its tests still pass for', async () => {
    for (let i = 0; i < 4; i++) await recordCall(w.db, { module: 'jira', version: '1.1.0', action: 'search_issues', ok: false, errorType: 'http_410' });
    await jiraFix('1.1.1');
    const asked = ai.requests.length;
    await w.app.maintenance();
    expect(ai.requests.length).toBe(asked + 1);
    expect(ai.requests.at(-1)!.prompt).toContain('4 of 4 calls failed');

    const [d] = await driftList();
    expect(d.fix).toMatchObject({ ref: 'jira 1.1.1', status: 'pending_review', error: null });
    const flows = d.fix.flows as { name: string; status: string; versionId?: string; reason?: string }[];
    expect(flows.find((f) => f.name === 'Open bugs')).toMatchObject({ status: 'proposed' });
    expect(flows.find((f) => f.name === 'Big search')).toMatchObject({ status: 'needs_person' });
    expect(flows.find((f) => f.name === 'Big search')!.reason).toContain('maxResults');

    // The fix is Dittoly's own draft, for admins to review.
    const mv = (await w.db.query(`SELECT created_by, generation FROM module_versions WHERE name = 'jira' AND version = '1.1.1'`)).rows[0];
    expect(mv.created_by).toBeNull();
    expect(mv.generation.fix).toMatchObject({ fromVersion: '1.1.0' });
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'module.fix_drafted' AND outcome = 'ok'`)).rowCount).toBe(1);

    // The proposed version pins the fix and says why; the approved one keeps running meanwhile.
    const versions = await w.app.flows.versions(openBugs);
    expect(versions.map((v) => [v.version, v.status])).toEqual([[1, 'approved'], [2, 'pending']]);
    expect(JSON.stringify(versions[1]!.definition)).toContain('jira@1.1.1');
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versions[1]!.id}/review`, headers: auth(w.tokens.approver) })).json();
    expect(review.generation.fix).toEqual({ module: 'jira', fromVersion: '1.1.0', toVersion: '1.1.1', tests: { total: 1, passed: 1 } });
    await expect(w.app.flows.assertRunnable(w.db, versions[0]!.id)).resolves.toBeTruthy();
    expect((await w.db.query(`SELECT 1 FROM notifications WHERE kind = 'flow_fix_proposed' AND member_id = $1 AND flow_version_id = $2`, [w.alice.id, versions[1]!.id])).rowCount).toBe(1);
    // Nothing is approvable before the fixed module is approved.
    await expect(w.app.flows.decide(versions[1]!.id, w.approver, 'approved')).rejects.toThrow(/modules_not_approved/);

    // Tried once per warning.
    await w.app.maintenance();
    expect(ai.requests.length).toBe(asked + 1);

    // People approve: the module, then the Flow version, which replaces the old one.
    const reviewer = (await createMember(w.db, 'admin2', 'admin', null)).member;
    const fixId = (await w.db.query(`SELECT id FROM module_versions WHERE name = 'jira' AND version = '1.1.1'`)).rows[0].id;
    await w.app.modules.decide(fixId, reviewer, 'approved');
    await w.app.flows.decide(versions[1]!.id, w.approver, 'approved');
    expect((await w.app.flows.versions(openBugs)).map((v) => [v.version, v.status])).toEqual([[1, 'superseded'], [2, 'approved']]);
    expect(await driftList()).toEqual([]);
  });

  it('stays within the daily number of fixes, reports a fix that does not pass, and can be switched off', async () => {
    expect((await api.inject({ method: 'PUT', url: '/api/admin/self-fix', headers: auth(w.tokens.admin), payload: { enabled: true, perDay: 1 } })).statusCode).toBe(200);
    await drift('gitlab', '1.0.0');
    const asked = ai.requests.length;
    await w.app.maintenance();
    expect(ai.requests.length).toBe(asked); // one fix already today
    expect((await driftList()).find((d) => d.module === 'gitlab').fix).toBeNull();

    await api.inject({ method: 'PUT', url: '/api/admin/self-fix', headers: auth(w.tokens.admin), payload: { enabled: true, perDay: 5 } });
    const manifest = JSON.parse(await readFile(path.resolve(jiraDir, '..', 'gitlab', 'manifest.json'), 'utf8'));
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, version: '1.0.1' }), code: 'const x = require("fs");\nexport default {};', testsJson: '[]' });
    await w.app.maintenance();
    const gl = (await driftList()).find((d) => d.module === 'gitlab');
    expect(gl.fix).toMatchObject({ status: 'draft', error: 'the drafted fix does not pass its tests', flows: [] });
    expect((await w.db.query(`SELECT 1 FROM notifications WHERE kind = 'module_fix_failed'`)).rowCount).toBeGreaterThan(0);

    await api.inject({ method: 'PUT', url: '/api/admin/self-fix', headers: auth(w.tokens.admin), payload: { enabled: false, perDay: 5 } });
    await drift('slack', '1.0.0');
    await w.app.maintenance();
    expect((await driftList()).find((d) => d.module === 'slack').fix).toBeNull();
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'module.self_fix_off'`)).rowCount).toBe(1);
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { createMember } from '../src/core/members.js';
import { lineDiff } from '../src/modules/diff.js';
import { detectDrift, recordCall, recordingFetch } from '../src/modules/health.js';
import { approveExampleModules, giveAllCredentials, makeWorld, releaseFlow, type World } from './helpers.js';

/** Module safety: tests recorded against the real app, drift warnings, and what changed between versions. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'gitlab');

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const gitlab = async () => (await w.app.modules.list()).find((m) => m.name === 'gitlab' && m.status === 'approved')!;
async function gitlabSource(version: string, edit: (code: string) => string = (c) => c) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  return {
    manifest: { ...manifest, version },
    code: edit(await readFile(path.join(dir, 'module.mjs'), 'utf8')),
    tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
    origin: 'seed' as const,
  };
}

describe('recorded tests', () => {
  it('records a read action against the real app once, as the approver, and every new version must pass it', async () => {
    await w.app.vault.put(w.approver.id, 'gitlab', 'glpat-approver-secret');
    const id = (await gitlab()).id;
    const rec = await api.inject({ method: 'POST', url: `/api/modules/${id}/record`, headers: auth(w.tokens.approver), payload: { action: 'list_merge_requests', input: { project: 'acme/app', label: 'ready' }, name: 'open MRs of acme/app' } });
    expect(rec.statusCode, rec.body).toBe(200);
    const { test, output } = rec.json();
    expect(output.mergeRequests.length).toBeGreaterThan(0);
    expect(test.http).toHaveLength(1);
    expect(test.http[0]).toMatchObject({ method: 'GET', status: 200 });
    expect(test.http[0].urlPrefix).toContain('https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests');
    expect(JSON.stringify(test)).not.toContain('glpat-approver-secret');
    // Nothing is kept until the person saves it.
    expect((await api.inject({ method: 'GET', url: `/api/modules/${id}/recordings`, headers: auth(w.tokens.approver) })).json()).toEqual([]);
    expect((await api.inject({ method: 'POST', url: `/api/modules/${id}/recordings`, headers: auth(w.tokens.approver), payload: { test } })).statusCode).toBe(201);
    expect((await api.inject({ method: 'GET', url: `/api/modules/${id}/recordings`, headers: auth(w.tokens.bob) })).json()).toMatchObject([{ action: 'list_merge_requests', recordedBy: 'approver', fromVersion: '1.0.0' }]);

    // A new version that reads a different field breaks the recorded test.
    const broken = await w.app.modules.createDraft(await gitlabSource('1.0.1', (c) => c.replace("mr.detailed_merge_status === 'mergeable'", "mr.merge_status.ok")), w.alice);
    expect(broken.validationReport!.passed).toBe(false);
    expect(broken.validationReport!.tests.find((t) => t.name === 'recorded: open MRs of acme/app')).toMatchObject({ passed: false });
    // An unchanged one passes it.
    const fine = await w.app.modules.createDraft(await gitlabSource('1.0.2'), w.alice);
    expect(fine.validationReport!.tests.find((t) => t.name === 'recorded: open MRs of acme/app')).toMatchObject({ passed: true });
  });

  it('input that does not fit the action is refused before anything runs, saying which field and why', async () => {
    const id = (await gitlab()).id;
    const res = await api.inject({ method: 'POST', url: `/api/modules/${id}/record`, headers: auth(w.tokens.approver), payload: { action: 'list_merge_requests', input: { repo: 'acme/app' }, name: 'x' } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'lookup_needs_input', detail: expect.stringContaining('project: is required') });
  });

  it('only records actions that only read, and only for approvers', async () => {
    const id = (await gitlab()).id;
    const write = await api.inject({ method: 'POST', url: `/api/modules/${id}/record`, headers: auth(w.tokens.approver), payload: { action: 'merge_merge_request', input: { project: 'acme/app', iid: 7 }, name: 'merge' } });
    expect(write.json().error).toBe('only_read_actions_can_be_recorded');
    expect(w.fake.merged).toEqual([]);
    expect((await api.inject({ method: 'POST', url: `/api/modules/${id}/record`, headers: auth(w.tokens.bob), payload: { action: 'list_merge_requests', input: { project: 'a/b' }, name: 'x' } })).json().error).toBe('approver_only');
  });

  it('masks secrets that come back in answers and URLs', async () => {
    const inner = async () => new Response(JSON.stringify({ token: 'sk-live-123456', ok: true }), { headers: { 'content-type': 'application/json' } });
    const r = recordingFetch(inner, () => ['sk-live-123456']);
    const res = await r.fetch('https://api.example.com/x?key=sk-live-123456', { method: 'GET' });
    expect(await res.json()).toEqual({ token: 'test-credential', ok: true });
    expect(r.http[0]).toMatchObject({ urlPrefix: 'https://api.example.com/x?key=test-credential', json: { token: 'test-credential', ok: true } });
    expect(r.problem()).toBeNull();
  });

  it('records an answer that is not JSON (an Atom feed) as its text and content type', async () => {
    const xml = '<?xml version="1.0"?><feed><entry><title>Newest</title></entry></feed>';
    const inner = async () => new Response(xml, { headers: { 'content-type': 'application/atom+xml; charset=UTF-8' } });
    const r = recordingFetch(inner, () => []);
    expect(await (await r.fetch('https://www.example.com/feeds/videos.xml', { method: 'GET' })).text()).toBe(xml);
    expect(r.http[0]).toEqual({ method: 'GET', urlPrefix: 'https://www.example.com/feeds/videos.xml', status: 200, body: xml, contentType: 'application/atom+xml; charset=UTF-8' });
    expect(r.problem()).toBeNull();
  });
});

describe('drift detection', () => {
  it('warns admins when most calls fail the way a changed API fails, and offers an AI fix that is reviewed as usual', async () => {
    for (let i = 0; i < 4; i++) await recordCall(w.db, { module: 'jira', version: '1.1.0', action: 'search_issues', ok: false, errorType: 'http_410' });
    await recordCall(w.db, { module: 'jira', version: '1.1.0', action: 'search_issues', ok: true, errorType: null });
    // Outages and expired tokens are not drift.
    for (let i = 0; i < 5; i++) await recordCall(w.db, { module: 'slack', version: '1.0.0', action: 'post_message', ok: false, errorType: 'http_503' });
    expect(await detectDrift(w.db)).toEqual(['jira']);
    expect(await detectDrift(w.db)).toEqual([]); // told once
    expect((await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'module_drift'`)).rows[0].n).toBe(1);
    const drift = (await api.inject({ method: 'GET', url: '/api/modules-drift', headers: auth(w.tokens.admin) })).json();
    expect(drift).toMatchObject([{ module: 'jira', version: '1.1.0', summary: { calls: 5, failures: 4, errors: { http_410: 4 }, actions: ['search_issues'] } }]);

    const jiraDir = path.resolve(dir, '..', 'jira');
    ai.enqueue({
      manifestJson: (await readFile(path.join(jiraDir, 'manifest.json'), 'utf8')).replace('"1.1.0"', '"1.1.1"'),
      code: await readFile(path.join(jiraDir, 'module.mjs'), 'utf8'),
      testsJson: await readFile(path.join(jiraDir, 'tests.json'), 'utf8'),
    });
    const fix = await api.inject({ method: 'POST', url: '/api/modules-drift/jira/fix', headers: auth(w.tokens.admin) });
    expect(fix.statusCode, fix.body).toBe(201);
    expect(fix.json()).toMatchObject({ version: '1.1.1', passed: true });
    // The AI was told what failed, never any data.
    expect(ai.requests.at(-1)!.prompt).toContain('4 of 5 calls failed');
    expect(ai.requests.at(-1)!.prompt).toContain('http_410 x4');
    // Approving the fixed version clears the warning.
    // The fix went for review by itself, as a change record the admin who asked for it cannot approve.
    await expect(w.app.modules.decide(fix.json().id, w.admin, 'approved')).rejects.toMatchObject({ code: 'cannot_approve_change_you_requested' });
    const second = (await createMember(w.db, 'admin2', 'admin', null)).member;
    await w.app.modules.decide(fix.json().id, second, 'approved');
    expect((await api.inject({ method: 'GET', url: '/api/modules-drift', headers: auth(w.tokens.admin) })).json()).toEqual([]);
  });

  it('counts real action calls from runs', async () => {
    const before = (await w.db.query(`SELECT coalesce(max(id), 0)::int AS n FROM module_calls`)).rows[0].n;
    const f = await releaseFlow();
    const v = await w.app.flows.decide((await w.app.flows.create('Counting', f.definition, w.alice)).id, w.approver, 'approved');
    await giveAllCredentials(w, w.alice);
    await w.app.engine.startRun(v.id, w.alice.id, { release: '1', jql: 'x', project: 'acme/app', channel: 'C1' });
    await w.app.worker.drain();
    const rows = (await w.db.query(`SELECT module_name, action, ok FROM module_calls WHERE id > $1 ORDER BY id`, [before])).rows;
    expect(rows.slice(0, 2)).toEqual([
      { module_name: 'jira', action: 'search_issues', ok: true },
      { module_name: 'gitlab', action: 'list_merge_requests', ok: true },
    ]);
  });
});

describe('what changed between versions', () => {
  it('describes manifest changes in plain words and shows the code as a line diff', async () => {
    const draft = await w.app.modules.createDraft(
      {
        ...(await gitlabSource('1.1.0', (c) => c.replace("per_page: '100'", "per_page: '50'"))),
        manifest: {
          ...(await gitlabSource('1.1.0')).manifest,
          hosts: ['gitlab.com', 'gitlab.acme.com'],
          credentials: [{ ...(await gitlabSource('1.1.0')).manifest.credentials[0], hosts: ['gitlab.com', 'gitlab.acme.com'], scopes: ['read_api'] }],
        },
      },
      w.alice,
    );
    const d = (await api.inject({ method: 'GET', url: `/api/modules/${draft.id}/diff`, headers: auth(w.tokens.admin) })).json();
    expect(d.against.version).toBe('1.0.0');
    expect(d.changes).toEqual(
      expect.arrayContaining([
        'Now also reaches gitlab.acme.com.',
        'The gitlab credential is now sent to gitlab.com, gitlab.acme.com (was gitlab.com).',
        'The gitlab token now needs scopes read_api (was api).',
      ]),
    );
    expect(d.code.lines).toEqual(expect.arrayContaining([{ op: '-', text: expect.stringContaining("per_page: '100'") }, { op: '+', text: expect.stringContaining("per_page: '50'") }]));
    expect(d.code).toMatchObject({ added: 1, removed: 1 });
  });

  it('describes Flow version changes by step', async () => {
    const f = await releaseFlow();
    const v1 = await w.app.flows.create('Diffed', f.definition, w.alice);
    const def = JSON.parse(JSON.stringify(f.definition));
    def.steps = def.steps.filter((s: { id: string }) => s.id !== 'announce');
    def.steps.find((s: { id: string }) => s.id === 'merge').delegateTo = w.bob.id;
    def.steps.find((s: { id: string }) => s.id === 'mrs').title = 'Find merge requests';
    const v2 = await w.app.flows.update(v1.flowId, def, w.alice);
    const d = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v2.id}/diff`, headers: auth(w.tokens.approver) })).json();
    expect(d.against.version).toBe(1);
    expect(d.changes).toEqual(
      expect.arrayContaining(['Step "Merge each ready MR" is now handed to a teammate.', 'Step "Find ready merge requests" is now called "Find merge requests".', 'Step "Tell the channel" was removed.']),
    );
  });

  it('keeps line diffs short around the changes', () => {
    const a = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 25', 'line twenty-five');
    const d = lineDiff(a, b, 2);
    expect(d.lines.map((l) => `${l.op}${l.text}`)).toEqual([' … 23 unchanged lines', ' line 23', ' line 24', '-line 25', '+line twenty-five', ' line 26', ' line 27', ' … 22 unchanged lines']);
  });
});

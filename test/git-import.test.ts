import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { defaultTeamFor } from '../src/core/teams.js';
import { remoteFor } from '../src/git-sync/remote.js';
import type { FetchLike } from '../src/runtime/broker.js';
import { createApp, decideApp, draftLayout } from '../src/team-apps/service.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * Git sync, git → Dittoly: what is merged into the connected branch comes back as versions waiting for approval.
 * What Dittoly wrote itself never comes back; git never approves anything.
 */
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@acme.test', ...args], { cwd, encoding: 'utf8', env });

const notify = {
  inputs: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-ops', text: '{{ inputs.text }}' } }],
};

let w: World;
let api: ReturnType<typeof buildServer>;
let dir: string;
let work: string;
let connId: string;
let flowId: string;
let appId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (token: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  api.inject({ method, url: `/api${url}`, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });
const sync = async () => {
  expect((await call(w.tokens.admin, 'POST', `/git-connections/${connId}/sync`)).statusCode).toBe(202);
  await w.app.worker.drain();
  return (await call(w.tokens.admin, 'GET', '/git-connection')).json().imports as { status: string; created: { kind: string; name: string; version: string | number }[]; problems: string[] }[];
};
const push = (msg: string) => {
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', msg);
  git(work, 'push', '-q', 'origin', 'HEAD:main');
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dty-gitimport-'));
  const bare = path.join(dir, 'repo.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  work = path.join(dir, 'work');
  git(dir, 'clone', '-q', bare, work);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'start');
  git(work, 'push', '-q', 'origin', 'HEAD:main');

  w = await makeWorld({}, { gitFileRemotes: true });
  api = buildServer(w.app);
  await approveExampleModules(w);
  const v = await w.app.flows.create('Notify ops', notify, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  flowId = v.flowId;
  const teamId = await defaultTeamFor(w.db, w.alice.id);
  const { plan } = await draftLayout(w.app, w.alice, { name: 'Ops desk', teamId, flows: [{ flowId }] });
  const created = await createApp(w.app, w.alice, { name: 'Ops desk', teamId, spec: { flows: [{ flowId }], plan } });
  appId = created.appId;
  await decideApp(w.app, w.approver, created.versionId, 'approved');

  connId = (await call(w.tokens.admin, 'PUT', '/git-connection', { provider: 'git', repoUrl: `file://${bare}`, token: 't' })).json().id;
  // Everything approved goes to git, and someone merges it.
  await call(w.tokens.admin, 'POST', `/git-connections/${connId}/export-all`);
  await w.app.worker.drain();
  git(work, 'fetch', '-q', 'origin');
  const branch = git(work, 'branch', '-r', '--format=%(refname:short)').split('\n').find((b) => b.includes('dittoly/sync-'))!.trim();
  git(work, 'merge', '-q', '--ff-only', branch);
  git(work, 'push', '-q', 'origin', 'HEAD:main');
});
afterAll(async () => {
  await api.close();
  await w.db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('git sync: git → Dittoly', () => {
  it('what Dittoly wrote itself comes back as nothing', async () => {
    expect(await sync()).toEqual([]);
    expect((await w.app.flows.versions(flowId)).map((v) => v.status)).toEqual(['approved']);
  });

  it('a merged change to a Flow waits for approval, and the approved version keeps running', async () => {
    const file = path.join(work, 'dittoly/flows/default/notify-ops/flow.json');
    const flow = JSON.parse(await readFile(file, 'utf8'));
    flow.definition.steps[0].input.channel = 'C-team';
    await writeFile(file, JSON.stringify(flow, null, 2));
    push('Post to the team channel');

    const [first] = await sync();
    expect(first).toMatchObject({ status: 'imported', created: [{ kind: 'flow', name: 'Notify ops', version: 2 }], problems: [] });
    const versions = await w.app.flows.versions(flowId);
    expect(versions.map((v) => v.status)).toEqual(['approved', 'pending']);
    // Still runs on v1 until someone approves v2.
    await expect(w.app.flows.assertRunnable(w.db, versions[0]!.id)).resolves.toBeTruthy();
    const gen = (await w.db.query<{ generation: { git: { path: string; commit: string } } }>(`SELECT generation FROM flow_versions WHERE id = $1`, [versions[1]!.id])).rows[0]!.generation;
    expect(gen.git).toMatchObject({ path: 'dittoly/flows/default/notify-ops/flow.json', commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    // Reading the same commit again changes nothing.
    expect(await sync()).toHaveLength(1);
    await w.app.flows.decide(versions[1]!.id, w.approver, 'approved');
    expect((await w.app.flows.versions(flowId)).map((v) => v.status)).toEqual(['superseded', 'approved']);
  });

  it('new files make new pending Flows; a changed module is tested and sent for review; problems are listed', async () => {
    await mkdir(path.join(work, 'dittoly/flows/default/weekly-digest'), { recursive: true });
    await writeFile(path.join(work, 'dittoly/flows/default/weekly-digest/flow.json'), JSON.stringify({ format: 'dittoly-flow', formatVersion: 1, name: 'Weekly digest', definition: notify, children: [] }));
    const mod = path.join(work, 'dittoly/modules/slack/module.mjs');
    await writeFile(mod, `// Reviewed in git.\n${await readFile(mod, 'utf8')}`);
    await mkdir(path.join(work, 'dittoly/flows/default/broken'), { recursive: true });
    await writeFile(path.join(work, 'dittoly/flows/default/broken/flow.json'), '{ not json');
    await mkdir(path.join(work, 'dittoly/flows/elsewhere/x'), { recursive: true });
    await writeFile(path.join(work, 'dittoly/flows/elsewhere/x/flow.json'), JSON.stringify({ format: 'dittoly-flow', name: 'X', definition: notify }));
    push('New Flow, a module tweak, and two bad files');

    const [latest] = await sync();
    expect(latest!.created).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'flow', name: 'Weekly digest', version: 1 }),
      expect.objectContaining({ kind: 'module', name: 'slack', version: '1.0.1' }),
    ]));
    expect(latest!.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('broken/flow.json: not a Dittoly Flow file'),
      expect.stringContaining('no team "elsewhere"'),
    ]));
    const slack = (await w.db.query<{ status: string; origin: string; created_by: string | null }>(`SELECT status, origin, created_by FROM module_versions WHERE name = 'slack' AND version = '1.0.1'`)).rows[0];
    expect(slack).toEqual({ status: 'pending_review', origin: 'git', created_by: null });
    const digest = (await w.db.query<{ status: string }>(`SELECT v.status FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE f.name = 'Weekly digest'`)).rows;
    expect(digest).toEqual([{ status: 'pending' }]);
  });

  it('a changed app layout is a new pending version; its live version stays live', async () => {
    const file = path.join(work, 'dittoly/apps/default/ops-desk/app.json');
    const appFile = JSON.parse(await readFile(file, 'utf8'));
    appFile.plan.layout.nav = 'sidebar-left';
    await writeFile(file, JSON.stringify(appFile, null, 2));
    push('Sidebar for the ops desk');
    const [latest] = await sync();
    expect(latest!.created).toEqual([expect.objectContaining({ kind: 'app', name: 'Ops desk', version: 2 })]);
    const versions = (await w.db.query<{ version: number; status: string }>(`SELECT version, status FROM app_versions WHERE app_id = $1 ORDER BY version`, [appId])).rows;
    expect(versions).toEqual([{ version: 1, status: 'approved' }, { version: 2, status: 'pending' }]);
  });

});

describe('git sync converges: each change is handled once, and nothing is lost', () => {
  // The branch as the 10-minute schedule reads it (no forcing), at a later time each call.
  let clock = Date.now();
  const scheduled = async () => {
    clock += 3_600_000;
    await w.app.gitSync.scheduleImports(new Date(clock));
    await w.app.worker.drain();
  };
  const flowFile = () => path.join(work, 'dittoly/flows/default/notify-ops/flow.json');
  const setChannel = async (channel: string) => {
    const flow = JSON.parse(await readFile(flowFile(), 'utf8'));
    flow.definition.steps[0].input.channel = channel;
    await writeFile(flowFile(), JSON.stringify(flow, null, 2));
  };
  const flowVersions = async () => (await w.app.flows.versions(flowId)).map((v) => ({ version: v.version, status: v.status, channel: (v.definition as unknown as typeof notify).steps[0]!.input.channel }));
  const mergeExport = (prefix: string) => {
    git(work, 'fetch', '-q', 'origin');
    const branch = git(work, 'branch', '-r', '--format=%(refname:short)').split('\n').map((b) => b.trim()).filter((b) => b.startsWith(`origin/${prefix}`)).sort().at(-1)!;
    git(work, 'merge', '-q', '--no-edit', '-X', 'theirs', branch);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
  };

  it('a change that only edits a module\'s tests is a new module version', async () => {
    const pending = (await w.db.query<{ id: string }>(`SELECT id FROM module_versions WHERE name = 'slack' AND status = 'pending_review'`)).rows[0]!;
    await w.app.modules.decide(pending.id, w.admin, 'approved');
    const file = path.join(work, 'dittoly/modules/slack/tests.json');
    const tests = JSON.parse(await readFile(file, 'utf8')) as unknown[];
    await writeFile(file, JSON.stringify([...tests, ...tests.slice(0, 1)], null, 2));
    push('One more slack test');
    await scheduled();
    const rows = (await w.db.query<{ version: string; status: string }>(`SELECT version, status FROM module_versions WHERE name = 'slack' ORDER BY created_at`)).rows;
    expect(rows.at(-1)).toEqual({ version: '1.0.2', status: 'pending_review' });
  });

  it('a change held back while another waits for approval is read again once that is decided, without a new commit', async () => {
    await setChannel('C-a');
    push('Channel a');
    await scheduled();
    await setChannel('C-b');
    push('Channel b, while a waits');
    await scheduled();
    const waiting = await flowVersions();
    expect(waiting.at(-1)).toMatchObject({ status: 'pending', channel: 'C-a' });
    await w.app.flows.decide((await w.app.flows.versions(flowId)).at(-1)!.id, w.approver, 'approved');
    // No new commit: the held-back file is read again on the next scheduled read.
    await scheduled();
    expect((await flowVersions()).at(-1)).toMatchObject({ status: 'pending', channel: 'C-b' });
    // Reading again adds nothing.
    const before = (await flowVersions()).length;
    await scheduled();
    await scheduled();
    expect(await flowVersions()).toHaveLength(before);
  });

  it('merging what Dittoly exported is not a change; going back to an older version is, once', async () => {
    await w.app.flows.decide((await w.app.flows.versions(flowId)).at(-1)!.id, w.approver, 'approved');
    // A change made in Dittoly is approved, and its pull request is merged: nothing comes back.
    const made = await w.app.flows.update(flowId, { ...notify, steps: [{ ...notify.steps[0]!, input: { ...notify.steps[0]!.input, channel: 'C-m' } }] }, w.alice);
    await w.app.flows.decide(made.id, w.approver, 'approved');
    await w.app.worker.drain();
    mergeExport(`dittoly/flow-notify-ops-v${made.version}`);
    const count = (await flowVersions()).length;
    await scheduled();
    expect(await flowVersions()).toHaveLength(count);
    // Someone puts the original channel back on purpose: one new pending version, never approved by git.
    await setChannel('C-ops');
    push('Back to the ops channel');
    await scheduled();
    await scheduled();
    const after = await flowVersions();
    expect(after).toHaveLength(count + 1);
    expect(after.at(-1)).toMatchObject({ status: 'pending', channel: 'C-ops' });
    expect(after.filter((v) => v.status === 'approved')).toEqual([expect.objectContaining({ channel: 'C-m' })]);
  });

  it('a branch that cannot be read is reported', async () => {
    await rm(path.join(dir, 'repo.git'), { recursive: true, force: true });
    const [latest] = await sync();
    expect(latest).toMatchObject({ status: 'failed', problems: [expect.stringContaining('git_request_failed')] });
  });
});

describe('reading GitHub and GitLab', () => {
  const files: Record<string, string> = { 'dittoly/flows/default/a/flow.json': '{"a":1}', 'dittoly/other.txt': 'ignored', 'elsewhere/flow.json': 'ignored' };
  it('GitHub: the tree at the head commit, then each synced file; nothing when the commit is unchanged', async () => {
    const seen: string[] = [];
    const fetch: FetchLike = async (url) => {
      const p = new URL(url).pathname;
      seen.push(p);
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (p === '/repos/acme/automations/git/ref/heads/main') return ok({ object: { sha: 'c1' } });
      if (p === '/repos/acme/automations/git/trees/c1') return ok({ tree: Object.keys(files).map((f) => ({ path: f, type: 'blob', sha: `b-${f}` })) });
      if (p.startsWith('/repos/acme/automations/git/blobs/')) return ok({ content: Buffer.from(files[decodeURIComponent(p.split('/blobs/b-')[1]!)]!).toString('base64') });
      return new Response('{}', { status: 404 });
    };
    const r = remoteFor('github', 'https://github.com/acme/automations', 't', { fetch, internalHosts: [] });
    const snap = await r.snapshot('main', 'dittoly');
    expect(snap.commit).toBe('c1');
    expect([...snap.files]).toEqual([['dittoly/flows/default/a/flow.json', '{"a":1}']]);
    seen.length = 0;
    expect((await r.snapshot('main', 'dittoly', 'c1')).files.size).toBe(0);
    expect(seen).toEqual(['/repos/acme/automations/git/ref/heads/main']);
  });

  it('GitLab: the branch head, the tree under the folder, each synced file', async () => {
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      const p = u.pathname;
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (p === '/api/v4/projects/acme%2Fautomations/repository/branches/main') return ok({ commit: { id: 'c2' } });
      if (p === '/api/v4/projects/acme%2Fautomations/repository/tree') return ok(u.searchParams.get('page') === '1' ? [{ path: 'dittoly/flows/default/a/flow.json', type: 'blob' }, { path: 'dittoly/flows', type: 'tree' }] : []);
      if (p === '/api/v4/projects/acme%2Fautomations/repository/files/dittoly%2Fflows%2Fdefault%2Fa%2Fflow.json/raw') return new Response('{"a":1}', { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const snap = await remoteFor('gitlab', 'https://gitlab.example.com/acme/automations', 't', { fetch, internalHosts: [] }).snapshot('main', 'dittoly');
    expect(snap).toEqual({ commit: 'c2', files: new Map([['dittoly/flows/default/a/flow.json', '{"a":1}']]) });
  });
});

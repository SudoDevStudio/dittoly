import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { defaultTeamFor } from '../src/core/teams.js';
import { remoteFor } from '../src/git-sync/remote.js';
import type { FetchLike } from '../src/runtime/broker.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * Git sync, Dittoly → git: approved versions land in the connected repository on a branch of their own (a pull
 * request on GitHub and GitLab). Plain git is exercised against real local repositories; GitHub and GitLab against
 * fakes of their REST APIs.
 */
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
async function bareRepo(dir: string, name: string): Promise<string> {
  const bare = path.join(dir, `${name}.git`);
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const work = path.join(dir, `${name}-seed`);
  git(dir, 'clone', '-q', bare, work);
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  return `file://${bare}`;
}
const show = (bare: string, ref: string, file: string) => git(path.dirname(bare.slice(7)), '--git-dir', bare.slice(7), 'show', `${ref}:${file}`);
const branches = (bare: string) => git(path.dirname(bare.slice(7)), '--git-dir', bare.slice(7), 'branch', '--format=%(refname:short)').trim().split('\n').filter(Boolean).sort();

const notify = {
  inputs: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-ops', text: '{{ inputs.text }}' } }],
};

let w: World;
let api: ReturnType<typeof buildServer>;
let dir: string;
let orgRepo: string;
let teamRepo: string;
let teamId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  api.inject({ method, url: `/api${url}`, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dty-gitsync-'));
  orgRepo = await bareRepo(dir, 'org');
  teamRepo = await bareRepo(dir, 'team');
  w = await makeWorld({}, { gitFileRemotes: true });
  api = buildServer(w.app);
  teamId = await defaultTeamFor(w.db, w.alice.id);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('git sync: Dittoly → git', () => {
  it('only admins connect the organization; the token is never shown', async () => {
    expect((await call(w.tokens.bob, 'PUT', '/git-connection', { provider: 'git', repoUrl: orgRepo, token: 't' })).statusCode).toBe(403);
    expect((await call(w.tokens.admin, 'PUT', '/git-connection', { provider: 'git', repoUrl: orgRepo })).json().error).toBe('token_required');
    expect((await call(w.tokens.admin, 'PUT', '/git-connection', { provider: 'git', repoUrl: 'http://example.com/a/b', token: 't' })).json().error).toBe('invalid_repo_url');
    const saved = await call(w.tokens.admin, 'PUT', '/git-connection', { provider: 'git', repoUrl: orgRepo, token: 'secret-token' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ provider: 'git', repoUrl: orgRepo, branch: 'main', folder: 'dittoly', exports: [] });
    expect(JSON.stringify(saved.json())).not.toContain('secret-token');
    // A branch that does not exist is refused before anything is kept.
    expect((await call(w.tokens.admin, 'PUT', '/git-connection', { provider: 'git', repoUrl: orgRepo, branch: 'nope' })).json().error).toBe('git_not_found');
  });

  it('an approved module and Flow each arrive on a branch of their own; nothing pending or rejected does', async () => {
    await approveExampleModules(w);
    const v = await w.app.flows.create('Notify ops', notify, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const rejected = await w.app.flows.create('Not this one', notify, w.alice);
    await w.app.flows.decide(rejected.id, w.approver, 'rejected');
    await w.app.worker.drain();

    expect(branches(orgRepo).sort()).toEqual(['dittoly/flow-notify-ops-v1', 'dittoly/module-gitlab-v1.0.0', 'dittoly/module-jira-v1.1.0', 'dittoly/module-slack-v1.0.0', 'main']);
    const flow = JSON.parse(show(orgRepo, 'dittoly/flow-notify-ops-v1', 'dittoly/flows/default/notify-ops/flow.json'));
    expect(flow).toMatchObject({ format: 'dittoly-flow', name: 'Notify ops', version: 1, definition: notify, children: [] });
    expect(show(orgRepo, 'dittoly/module-slack-v1.0.0', 'dittoly/modules/slack/manifest.json')).toContain('"name": "slack"');
    expect(show(orgRepo, 'dittoly/module-slack-v1.0.0', 'dittoly/modules/slack/module.mjs')).toContain('post_message');

    const conn = (await call(w.tokens.admin, 'GET', '/git-connection')).json();
    expect(conn.exports).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'flow', title: 'Flow "Notify ops" v1', status: 'pushed', branch: 'dittoly/flow-notify-ops-v1' })]));
    expect(conn.exports).toHaveLength(4);
  });

  it('a team connection takes its Flows (a Super Flow names the Flows it runs); modules stay with the organization', async () => {
    // The team's admins manage it (members cannot).
    expect((await call(w.tokens.bob, 'PUT', '/git-connection', { teamId, provider: 'git', repoUrl: teamRepo, token: 't' })).statusCode).toBe(403);
    expect((await call(w.tokens.admin, 'PUT', '/git-connection', { teamId, provider: 'git', repoUrl: teamRepo, token: 't', folder: 'automation' })).statusCode).toBe(200);
    const child = (await w.app.flows.versions((await w.db.query<{ id: string }>(`SELECT id FROM flows WHERE name = 'Notify ops'`)).rows[0]!.id)).at(-1)!;
    const parent = await w.app.flows.create('Release train', { inputs: notify.inputs, steps: [{ id: 'go', type: 'flow', runs: [{ id: 'a', flow: child.flowId, version: 1, input: { text: '{{ inputs.text }}' } }] }] }, w.alice);
    await w.app.flows.decide(parent.id, w.approver, 'approved');
    await w.app.worker.drain();
    expect(branches(teamRepo).sort()).toEqual(['dittoly/flow-release-train-v1', 'main']);
    const file = JSON.parse(show(teamRepo, 'dittoly/flow-release-train-v1', 'automation/flows/default/release-train/flow.json'));
    expect(file.children).toEqual([{ flowId: child.flowId, version: 1, name: 'Notify ops', team: 'Default' }]);
    expect(branches(orgRepo)).not.toContain('dittoly/flow-release-train-v1');
  });

  it('exports everything approved as one branch, and a failure can be retried', async () => {
    const conn = (await call(w.tokens.admin, 'GET', '/git-connection')).json();
    expect((await call(w.tokens.admin, 'POST', `/git-connections/${conn.id}/export-all`)).statusCode).toBe(202);
    await w.app.worker.drain();
    const all = branches(orgRepo).find((b) => b.startsWith('dittoly/sync-'))!;
    expect(show(orgRepo, all, 'dittoly/README.md')).toContain('Approvals, run history and secrets are never written here.');
    // The organization's sync holds the modules, but not the Flows of a team that has its own repository.
    expect(show(orgRepo, all, 'dittoly/modules/jira/manifest.json')).toContain('"jira"');
    expect(() => show(orgRepo, all, 'dittoly/flows/default/notify-ops/flow.json')).toThrow();

    // A repository that went away: the export fails, says why, and can be retried.
    await rm(orgRepo.slice(7), { recursive: true, force: true });
    await call(w.tokens.admin, 'POST', `/git-connections/${conn.id}/export-all`);
    await w.app.worker.drain();
    const failed = (await call(w.tokens.admin, 'GET', '/git-connection')).json().exports[0];
    expect(failed).toMatchObject({ kind: 'all', status: 'failed', error: expect.stringContaining('git_request_failed') });
    expect((await call(w.tokens.admin, 'POST', `/git-exports/${failed.id}/retry`)).statusCode).toBe(202);
  });

  it('disconnecting stops syncing', async () => {
    const conn = (await call(w.tokens.admin, 'GET', `/git-connection?team=${teamId}`)).json();
    expect((await call(w.tokens.admin, 'DELETE', `/git-connections/${conn.id}`)).statusCode).toBe(204);
    expect((await call(w.tokens.admin, 'GET', `/git-connection?team=${teamId}`)).json()).toBeNull();
  });
});

/** A small fake of the GitHub and GitLab REST APIs: what Dittoly asks for, and what it wrote. */
function fakeHost() {
  const seen: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const base: Record<string, string> = { 'dittoly/flows/default/same/flow.json': 'same\n', 'dittoly/modules/old/module.mjs': 'old\n' };
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    seen.push({ method: init.method ?? 'GET', url: u.pathname + u.search, headers: init.headers as Record<string, string>, body });
    const ok = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    const p = u.pathname;
    // GitHub
    if (p === '/repos/acme/automations/git/ref/heads/main') return ok(200, { object: { sha: 'base-sha' } });
    if (p.startsWith('/repos/acme/automations/contents/')) {
      const f = decodeURIComponent(p.slice('/repos/acme/automations/contents/'.length));
      return base[f] ? ok(200, { content: Buffer.from(base[f]!).toString('base64') }) : ok(404, {});
    }
    if (p === '/repos/acme/automations/git/commits/base-sha') return ok(200, { tree: { sha: 'tree-sha' } });
    if (p === '/repos/acme/automations/git/trees') return ok(201, { sha: 'new-tree' });
    if (p === '/repos/acme/automations/git/commits') return ok(201, { sha: 'new-commit' });
    if (p === '/repos/acme/automations/git/refs') return ok(201, {});
    if (p === '/repos/acme/automations/pulls') return ok(201, { html_url: 'https://github.com/acme/automations/pull/7' });
    // GitLab
    if (p.startsWith('/api/v4/projects/acme%2Fautomations/repository/files/')) {
      const f = decodeURIComponent(p.split('/repository/files/')[1]!.replace(/\/raw$/, ''));
      return base[f] ? new Response(base[f], { status: 200 }) : new Response('{}', { status: 404 });
    }
    if (p === '/api/v4/projects/acme%2Fautomations/repository/commits') return ok(201, {});
    if (p === '/api/v4/projects/acme%2Fautomations/merge_requests') return ok(201, { web_url: 'https://gitlab.example.com/acme/automations/-/merge_requests/3' });
    return ok(404, { message: 'unexpected' });
  };
  return { fetch, seen };
}

describe('git hosts', () => {
  const req = (content: string) => ({ files: [{ path: 'dittoly/flows/default/same/flow.json', content }, { path: 'dittoly/modules/x/module.mjs', content: 'code\n' }], base: 'main', branch: 'dittoly/flow-x-v1', title: 'Dittoly: Flow "X" v1', body: 'b' });

  it('GitHub: one commit on a new branch and a pull request, with the token as a bearer header', async () => {
    const h = fakeHost();
    const out = await remoteFor('github', 'https://github.com/acme/automations', 'ghp_x', { fetch: h.fetch, internalHosts: [] }).publish(req('changed\n'));
    expect(out).toEqual({ unchanged: false, branch: 'dittoly/flow-x-v1', url: 'https://github.com/acme/automations/pull/7' });
    const tree = h.seen.find((s) => s.url.endsWith('/git/trees'))!.body as { base_tree: string; tree: { path: string; content: string }[] };
    expect(tree.base_tree).toBe('tree-sha');
    expect(tree.tree.map((t) => t.path)).toEqual(['dittoly/flows/default/same/flow.json', 'dittoly/modules/x/module.mjs']);
    expect(h.seen.find((s) => s.url.endsWith('/pulls'))!.body).toMatchObject({ head: 'dittoly/flow-x-v1', base: 'main', title: 'Dittoly: Flow "X" v1' });
    expect(h.seen.every((s) => s.headers.authorization === 'Bearer ghp_x')).toBe(true);
  });

  it('GitLab: one commit with create/update actions and a merge request', async () => {
    const h = fakeHost();
    const out = await remoteFor('gitlab', 'https://gitlab.example.com/acme/automations.git', 'glpat-x', { fetch: h.fetch, internalHosts: [] }).publish(req('changed\n'));
    expect(out.url).toBe('https://gitlab.example.com/acme/automations/-/merge_requests/3');
    const commit = h.seen.find((s) => s.url.endsWith('/repository/commits'))!.body as { branch: string; start_branch: string; actions: { action: string; file_path: string }[] };
    expect(commit).toMatchObject({ branch: 'dittoly/flow-x-v1', start_branch: 'main' });
    expect(commit.actions.map((a) => [a.action, a.file_path])).toEqual([['update', 'dittoly/flows/default/same/flow.json'], ['create', 'dittoly/modules/x/module.mjs']]);
    expect(h.seen.every((s) => s.headers['private-token'] === 'glpat-x')).toBe(true);
  });

  it('a file given without content is removed when it is there (a module whose code became module.ts), and skipped when not', async () => {
    const files = [
      { path: 'dittoly/modules/old/module.ts', content: 'typed\n' },
      { path: 'dittoly/modules/old/module.mjs', content: null },
      { path: 'dittoly/modules/new/module.mjs', content: null },
    ];
    const gh = fakeHost();
    await remoteFor('github', 'https://github.com/acme/automations', 't', { fetch: gh.fetch, internalHosts: [] }).publish({ ...req(''), files });
    const tree = gh.seen.find((s) => s.url.endsWith('/git/trees'))!.body as { tree: { path: string; sha?: null; content?: string }[] };
    expect(tree.tree).toEqual([
      { path: 'dittoly/modules/old/module.ts', mode: '100644', type: 'blob', content: 'typed\n' },
      { path: 'dittoly/modules/old/module.mjs', mode: '100644', type: 'blob', sha: null },
    ]);
    const gl = fakeHost();
    await remoteFor('gitlab', 'https://gitlab.example.com/acme/automations.git', 't', { fetch: gl.fetch, internalHosts: [] }).publish({ ...req(''), files });
    const commit = gl.seen.find((s) => s.url.endsWith('/repository/commits'))!.body as { actions: { action: string; file_path: string }[] };
    expect(commit.actions.map((a) => [a.action, a.file_path])).toEqual([['create', 'dittoly/modules/old/module.ts'], ['delete', 'dittoly/modules/old/module.mjs']]);
  });

  it('nothing is written when the files already match the base branch', async () => {
    for (const provider of ['github', 'gitlab'] as const) {
      const h = fakeHost();
      const same = { ...req('same\n'), files: [{ path: 'dittoly/flows/default/same/flow.json', content: 'same\n' }] };
      expect(await remoteFor(provider, 'https://github.com/acme/automations', 't', { fetch: h.fetch, internalHosts: [] }).publish(same)).toMatchObject({ unchanged: true, url: null });
      expect(h.seen.every((s) => s.method === 'GET')).toBe(true);
    }
  });

  it('a refused token is reported plainly', async () => {
    const fetch: FetchLike = async () => new Response('{}', { status: 401 });
    await expect(remoteFor('github', 'https://github.com/acme/automations', 'bad', { fetch, internalHosts: [] }).check('main')).rejects.toMatchObject({ code: 'git_unauthorized' });
  });
});

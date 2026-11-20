import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import type { FetchLike } from '../runtime/broker.js';
import { classifyAddress } from '../runtime/egress.js';

/**
 * Writing files to a git repository as one commit on a branch of its own, and opening a pull (merge) request
 * for it: GitHub and GitLab through their REST APIs (through Dittoly's guarded fetch, so the usual outbound
 * rules apply), any other host with the git command over HTTPS (a branch is pushed; there is no API to open the
 * request with). Nothing is pushed when the files already match the base branch.
 */

export type Provider = 'github' | 'gitlab' | 'git';
/** A file to write; `content: null` removes it when it is there (e.g. a module's module.mjs once it is TypeScript). */
export interface RepoFile { path: string; content: string | null }
export interface Published { unchanged: boolean; branch: string; url: string | null }
export interface PublishRequest { files: RepoFile[]; base: string; branch: string; title: string; body: string }

export class GitError extends AppError {
  constructor(code: string, message?: string) {
    super(code, 502, message);
  }
}

/** https://host/owner/repo(.git) → host and the repository's path. */
export function parseRepoUrl(raw: string): { url: URL; host: string; repoPath: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError('invalid_repo_url', 400);
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new AppError('invalid_repo_url', 400, 'use an https URL without credentials, e.g. https://github.com/acme/automations');
  const repoPath = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repoPath)) throw new AppError('invalid_repo_url', 400, 'the URL must name a repository, e.g. https://github.com/acme/automations');
  return { url: u, host: u.host, repoPath };
}

/** The files Dittoly reads back: these names, under the folder; bounded so a large repository cannot flood it. */
export const SYNCED_FILES = /(^|\/)(manifest\.json|module\.ts|module\.mjs|tests\.json|flow\.json|app\.json)$/;
const MAX_FILES = 400;
const MAX_BYTES = 8_000_000;
export interface Snapshot { commit: string; files: Map<string, string> }
const inFolder = (p: string, folder: string) => p.startsWith(`${folder}/`) && SYNCED_FILES.test(p);
function budget(files: Map<string, string>, add: string) {
  let size = add.length;
  for (const v of files.values()) size += v.length;
  if (files.size >= MAX_FILES || size > MAX_BYTES) throw new GitError('git_too_large', `more than ${MAX_FILES} files or ${MAX_BYTES / 1_000_000} MB under the folder`);
}

export interface Remote {
  publish(req: PublishRequest): Promise<Published>;
  /** The branch's head commit, and the synced files under the folder (path → text). */
  snapshot(base: string, folder: string, since?: string | null): Promise<Snapshot>;
  /** A cheap check that the repository and branch are reachable with this token. */
  check(base: string): Promise<void>;
}

export function remoteFor(provider: Provider, repoUrl: string, token: string, o: { fetch: FetchLike; internalHosts: readonly string[]; allowFileRemote?: boolean }): Remote {
  if (provider === 'github') return new GitHubRemote(repoUrl, token, o.fetch);
  if (provider === 'gitlab') return new GitLabRemote(repoUrl, token, o.fetch);
  return new PlainGitRemote(repoUrl, token, o.internalHosts, o.allowFileRemote === true);
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const enc = encodeURIComponent;

async function call(fetch: FetchLike, url: string, init: RequestInit, ok: number[] = [200, 201]): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.status === 401 || res.status === 403) throw new GitError('git_unauthorized', 'the token was refused, or it lacks write access to the repository');
  if (res.status === 404 && !ok.includes(404)) throw new GitError('git_not_found', 'the repository or branch was not found (or the token cannot see it)');
  if (!ok.includes(res.status)) throw new GitError('git_request_failed', `${new URL(url).host} answered ${res.status}`);
  return { status: res.status, body };
}

class GitHubRemote implements Remote {
  private readonly api: string;
  private readonly repo: string;
  constructor(repoUrl: string, private readonly token: string, private readonly fetch: FetchLike) {
    const { url, repoPath } = parseRepoUrl(repoUrl);
    // github.com, or GitHub Enterprise Server's API on the same host.
    this.api = url.hostname === 'github.com' ? 'https://api.github.com' : `https://${url.host}/api/v3`;
    this.repo = repoPath;
  }
  private init(method: string, body?: unknown): RequestInit {
    return {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
  }
  private url(p: string) {
    return `${this.api}/repos/${this.repo}${p}`;
  }
  async check(base: string) {
    await call(this.fetch, this.url(`/git/ref/heads/${enc(base)}`), this.init('GET'));
  }
  async snapshot(base: string, folder: string, since?: string | null): Promise<Snapshot> {
    const commit = ((await call(this.fetch, this.url(`/git/ref/heads/${enc(base)}`), this.init('GET'))).body as { object: { sha: string } }).object.sha;
    const files = new Map<string, string>();
    if (commit === since) return { commit, files };
    const tree = (await call(this.fetch, this.url(`/git/trees/${commit}?recursive=1`), this.init('GET'))).body as { tree: { path: string; type: string; sha: string }[] };
    for (const t of tree.tree.filter((x) => x.type === 'blob' && inFolder(x.path, folder))) {
      const blob = (await call(this.fetch, this.url(`/git/blobs/${t.sha}`), this.init('GET'))).body as { content: string };
      const text = Buffer.from(blob.content ?? '', 'base64').toString('utf8');
      budget(files, text);
      files.set(t.path, text);
    }
    return { commit, files };
  }
  async publish(req: PublishRequest): Promise<Published> {
    const head = (await call(this.fetch, this.url(`/git/ref/heads/${enc(req.base)}`), this.init('GET'))).body as { object: { sha: string } };
    const changes: RepoFile[] = [];
    for (const f of req.files) {
      const r = await call(this.fetch, this.url(`/contents/${f.path.split('/').map(enc).join('/')}?ref=${enc(req.base)}`), this.init('GET'), [200, 404]);
      const now = r.status === 200 ? Buffer.from(String((r.body as { content?: string }).content ?? ''), 'base64').toString('utf8') : null;
      if (now !== f.content) changes.push(f);
    }
    if (!changes.length) return { unchanged: true, branch: req.branch, url: null };
    const commit = (await call(this.fetch, this.url(`/git/commits/${head.object.sha}`), this.init('GET'))).body as { tree: { sha: string } };
    const tree = (await call(this.fetch, this.url('/git/trees'), this.init('POST', {
      base_tree: commit.tree.sha,
      // sha null removes the file.
      tree: changes.map((f) => (f.content === null ? { path: f.path, mode: '100644', type: 'blob', sha: null } : { path: f.path, mode: '100644', type: 'blob', content: f.content })),
    }))).body as { sha: string };
    const created = (await call(this.fetch, this.url('/git/commits'), this.init('POST', { message: `${req.title}\n\n${req.body}`, tree: tree.sha, parents: [head.object.sha] }))).body as { sha: string };
    // The branch is Dittoly's own: a retry moves it to the new commit.
    const ref = await call(this.fetch, this.url('/git/refs'), this.init('POST', { ref: `refs/heads/${req.branch}`, sha: created.sha }), [201, 422]);
    if (ref.status === 422) await call(this.fetch, this.url(`/git/refs/heads/${req.branch.split('/').map(enc).join('/')}`), this.init('PATCH', { sha: created.sha, force: true }));
    const pr = await call(this.fetch, this.url('/pulls'), this.init('POST', { title: req.title, head: req.branch, base: req.base, body: req.body }), [201, 422]);
    if (pr.status === 201) return { unchanged: false, branch: req.branch, url: String((pr.body as { html_url?: string }).html_url ?? '') || null };
    // Already open for this branch: point at it.
    const owner = this.repo.split('/')[0]!;
    const open = await call(this.fetch, this.url(`/pulls?state=open&head=${enc(`${owner}:${req.branch}`)}`), this.init('GET'));
    const first = (open.body as { html_url?: string }[])[0];
    return { unchanged: false, branch: req.branch, url: first?.html_url ?? null };
  }
}

class GitLabRemote implements Remote {
  private readonly api: string;
  constructor(repoUrl: string, private readonly token: string, private readonly fetch: FetchLike) {
    const { url, repoPath } = parseRepoUrl(repoUrl);
    this.api = `https://${url.host}/api/v4/projects/${enc(repoPath)}`;
  }
  private init(method: string, body?: unknown): RequestInit {
    return { method, headers: { 'private-token': this.token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) };
  }
  async check(base: string) {
    await call(this.fetch, `${this.api}/repository/branches/${enc(base)}`, this.init('GET'));
  }
  async snapshot(base: string, folder: string, since?: string | null): Promise<Snapshot> {
    const commit = ((await call(this.fetch, `${this.api}/repository/branches/${enc(base)}`, this.init('GET'))).body as { commit: { id: string } }).commit.id;
    const files = new Map<string, string>();
    if (commit === since) return { commit, files };
    const paths: string[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = (await call(this.fetch, `${this.api}/repository/tree?path=${enc(folder)}&recursive=true&per_page=100&page=${page}&ref=${commit}`, this.init('GET'), [200, 404])).body as { path: string; type: string }[] | null;
      if (!Array.isArray(r) || !r.length) break;
      paths.push(...r.filter((x) => x.type === 'blob' && inFolder(x.path, folder)).map((x) => x.path));
      if (r.length < 100) break;
    }
    for (const p of paths) {
      const res = await this.fetch(`${this.api}/repository/files/${enc(p)}/raw?ref=${commit}`, this.init('GET'));
      if (!res.ok) throw new GitError('git_request_failed', `reading ${p} answered ${res.status}`);
      const text = await res.text();
      budget(files, text);
      files.set(p, text);
    }
    return { commit, files };
  }
  async publish(req: PublishRequest): Promise<Published> {
    const actions: ({ action: 'create' | 'update'; file_path: string; content: string } | { action: 'delete'; file_path: string })[] = [];
    for (const f of req.files) {
      const res = await this.fetch(`${this.api}/repository/files/${enc(f.path)}/raw?ref=${enc(req.base)}`, this.init('GET'));
      if (res.status === 401 || res.status === 403) throw new GitError('git_unauthorized', 'the token was refused, or it lacks write access to the repository');
      const now = res.status === 200 ? await res.text() : (await res.text(), null);
      if (now === f.content) continue;
      actions.push(f.content === null ? { action: 'delete', file_path: f.path } : { action: now === null ? 'create' : 'update', file_path: f.path, content: f.content });
    }
    if (!actions.length) return { unchanged: true, branch: req.branch, url: null };
    // force: the branch is Dittoly's own, rebuilt from the base branch on a retry.
    await call(this.fetch, `${this.api}/repository/commits`, this.init('POST', { branch: req.branch, start_branch: req.base, force: true, commit_message: `${req.title}\n\n${req.body}`, actions }));
    const mr = await call(this.fetch, `${this.api}/merge_requests`, this.init('POST', { source_branch: req.branch, target_branch: req.base, title: req.title, description: req.body, remove_source_branch: true }), [201, 409]);
    if (mr.status === 201) return { unchanged: false, branch: req.branch, url: String((mr.body as { web_url?: string }).web_url ?? '') || null };
    const open = await call(this.fetch, `${this.api}/merge_requests?state=opened&source_branch=${enc(req.branch)}`, this.init('GET'));
    return { unchanged: false, branch: req.branch, url: (open.body as { web_url?: string }[])[0]?.web_url ?? null };
  }
}

/** Any git host over HTTPS: clone the base branch, write the files, push a branch. The token goes in an HTTP header (never argv). */
class PlainGitRemote implements Remote {
  constructor(
    private readonly repoUrl: string,
    private readonly token: string,
    private readonly internalHosts: readonly string[],
    private readonly allowFileRemote: boolean,
  ) {}
  private async target(): Promise<string> {
    // Tests push to a local bare repository.
    if (this.allowFileRemote && this.repoUrl.startsWith('file://')) return this.repoUrl;
    const { url } = parseRepoUrl(this.repoUrl);
    const key = url.port ? url.host : `${url.hostname}:443`;
    if (!this.internalHosts.includes(url.host) && !this.internalHosts.includes(key)) {
      const addrs = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true }).catch(() => []);
      if (!addrs.length) throw new GitError('git_unreachable');
      // The same address rules as module traffic (src/runtime/egress.ts): private hosts must be listed by an admin.
      if (addrs.some((a) => classifyAddress(a.address) !== 'public')) throw new GitError('git_private_address', 'the repository is on a private address; an admin must list its host in DITTOLY_INTERNAL_HOSTS');
    }
    return url.href;
  }
  private env(dir: string, url: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    if (this.token && url.startsWith('https:')) {
      const user = this.token.includes(':') ? '' : 'x-access-token:';
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${user}${this.token}`).toString('base64')}`;
    }
    return env;
  }
  private git(args: string[], env: NodeJS.ProcessEnv, cwd?: string, full = false): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      let out = '';
      const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=' + (this.allowFileRemote ? 'always' : 'never'), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      // Most commands only need the end of their output (for errors); a listing needs all of it.
      const keep = (b: Buffer) => { out = full ? (out + b.toString()).slice(0, 2_000_000) : (out + b.toString()).slice(-4000); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('error', () => { clearTimeout(timer); resolve({ code: null, out }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
  }
  private fail(r: { code: number | null; out: string }, what: string): never {
    if (r.code === null) throw new GitError('git_unavailable', 'the git command is not installed where Dittoly runs');
    if (/Authentication failed|403|401|could not read Username/i.test(r.out)) throw new GitError('git_unauthorized', 'the token was refused, or it lacks write access to the repository');
    throw new GitError('git_request_failed', `git ${what} failed`);
  }
  async check(base: string) {
    const url = await this.target();
    const dir = await mkdtemp(path.join(tmpdir(), 'dty-git-'));
    try {
      const r = await this.git(['ls-remote', '--exit-code', '--heads', '--', url, base], this.env(dir, url));
      if (r.code === 2) throw new GitError('git_not_found', `no branch ${base} in the repository`);
      if (r.code !== 0) this.fail(r, 'ls-remote');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async snapshot(base: string, folder: string, since?: string | null): Promise<Snapshot> {
    const url = await this.target();
    const dir = await mkdtemp(path.join(tmpdir(), 'dty-git-'));
    const src = path.join(dir, 'src');
    const env = this.env(dir, url);
    try {
      const head = await this.git(['ls-remote', '--exit-code', '--heads', '--', url, base], env);
      if (head.code !== 0) this.fail(head, 'ls-remote');
      const commit = head.out.trim().split(/\s+/)[0] ?? '';
      const files = new Map<string, string>();
      if (commit === since) return { commit, files };
      const cloned = await this.git(['clone', '--depth', '1', '--branch', base, '--single-branch', '--', url, src], env);
      if (cloned.code !== 0) this.fail(cloned, 'clone');
      // The branch may have moved since ls-remote: the files are those of the commit actually checked out.
      const checkedOut = await this.git(['rev-parse', 'HEAD'], env, src);
      if (checkedOut.code !== 0) this.fail(checkedOut, 'rev-parse');
      const listed = await this.git(['ls-files', '-z', '--', folder], env, src, true);
      for (const p of listed.out.split('\0').filter((x) => x && inFolder(x, folder))) {
        const text = await readFile(path.join(src, p), 'utf8');
        budget(files, text);
        files.set(p, text);
      }
      return { commit: checkedOut.out.trim(), files };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async publish(req: PublishRequest): Promise<Published> {
    const url = await this.target();
    const dir = await mkdtemp(path.join(tmpdir(), 'dty-git-'));
    const src = path.join(dir, 'src');
    const env = this.env(dir, url);
    try {
      const cloned = await this.git(['clone', '--depth', '1', '--branch', req.base, '--single-branch', '--', url, src], env);
      if (cloned.code !== 0) this.fail(cloned, 'clone');
      const touched: string[] = [];
      for (const f of req.files) {
        const full = path.resolve(src, f.path);
        if (!full.startsWith(src + path.sep)) throw new GitError('invalid_path');
        const now = await readFile(full, 'utf8').catch(() => null);
        if (now === f.content) continue;
        if (f.content === null) await rm(full);
        else {
          await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, f.content);
        }
        touched.push(f.path);
      }
      if (!touched.length) return { unchanged: true, branch: req.branch, url: null };
      await this.git(['add', '-A', '--', ...touched], env, src);
      const diff = await this.git(['diff', '--cached', '--quiet'], env, src);
      if (diff.code === 0) return { unchanged: true, branch: req.branch, url: null };
      const commit = await this.git(['-c', 'user.name=Dittoly', '-c', 'user.email=dittoly@localhost', 'commit', '-q', '-m', req.title, '-m', req.body], env, src);
      if (commit.code !== 0) this.fail(commit, 'commit');
      // The branch is Dittoly's own: a retry replaces it.
      const pushed = await this.git(['push', '--force', 'origin', `HEAD:refs/heads/${req.branch}`], env, src);
      if (pushed.code !== 0) this.fail(pushed, 'push');
      return { unchanged: false, branch: req.branch, url: null };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

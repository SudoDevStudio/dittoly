import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { scaffoldFiles } from '../src/git-sync/scaffold.js';
import { compileModuleSource, readablePair } from '../src/modules/source.js';
import { withBase } from '../src/modules/module-base.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * Modules are written in TypeScript: Dittoly compiles the source itself, stores both, runs the JavaScript and shows
 * people (and git) the TypeScript. Modules written as JavaScript keep working as before.
 */
const slack = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
const read = (f: string) => readFile(path.join(slack, f), 'utf8');

/** The Slack example, typed. */
async function typedSlack(note = 'Slack reports most errors with HTTP 200 and ok: false.'): Promise<string> {
  const js = await read('module.mjs');
  return `interface PostMessageInput { channel: string; text: string }
interface SlackAnswer { ok: boolean; ts: string; error?: string }
// ${note}
${js
  .replace('async post_message(input, ctx) {', 'async post_message(input: PostMessageInput, ctx: ModuleContext): Promise<{ ts: string }> {')
  .replace('async delete_message(input, ctx) {', 'async delete_message(input: { channel: string; ts: string }, ctx: ModuleContext): Promise<{ ts: string }> {')
  .replaceAll('const data = res.json();', 'const data = res.json() as SlackAnswer;')}`;
}

const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld({}, { ai, gitFileRemotes: true });
  api = buildServer(w.app);
  await approveExampleModules(w);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (token: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  api.inject({ method, url: `/api${url}`, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('compiling a module', () => {
  it('removes the types and keeps the code; a syntax error says where, without repeating the source', async () => {
    const out = await compileModuleSource(await typedSlack());
    expect(out).toContain('async post_message(input, ctx)');
    expect(out).not.toContain('interface');
    expect(out).toMatch(/export\s*\{\s*actions\s*\}/);
    await expect(compileModuleSource('export const actions = { async a(x: ) {} }')).rejects.toMatchObject({ code: 'invalid_module_source', message: expect.stringMatching(/^module\.ts:1:\d+: /) });
  });

  it('people compare TypeScript with TypeScript, else the code that runs', () => {
    expect(readablePair({ code: 'a', source: 'A' }, { code: 'b', source: 'B' })).toEqual(['A', 'B']);
    expect(readablePair({ code: 'a', source: null }, { code: 'b', source: 'B' })).toEqual(['a', 'b']);
  });
});

describe('a TypeScript module version', () => {
  it('stores the source and the compiled code, runs the compiled code, and neither can change afterwards', async () => {
    const source = await typedSlack();
    const manifest = { ...JSON.parse(await read('manifest.json')), version: '1.0.1' };
    const mv = await w.app.modules.createDraft({ manifest, source, tests: JSON.parse(await read('tests.json')), origin: 'seed' }, w.alice);
    expect(mv.validationReport?.passed).toBe(true);
    expect(mv.source).toBe(source);
    expect(mv.code).toBe(await compileModuleSource(source));
    const review = (await call(w.tokens.admin, 'GET', `/modules/${mv.id}/review`)).json();
    expect(review).toMatchObject({ source, sourceSha256: mv.sourceSha256, codeSha256: mv.codeSha256 });
    await expect(w.db.query(`UPDATE module_versions SET source = 'export const actions = {}' WHERE id = $1`, [mv.id])).rejects.toThrow(/immutable/);
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
  });

  it('the AI writes TypeScript; code that does not compile goes back to it with the compiler\'s words', async () => {
    const answer = async (code: string) => ({ manifestJson: JSON.stringify({ ...JSON.parse(await read('manifest.json')), name: 'slack-notes' }), code, testsJson: await read('tests.json') });
    ai.enqueue(await answer('export const actions = { async post_message(input: { channel: string ) {} }'));
    ai.enqueue(await answer(await typedSlack()));
    const res = await call(w.tokens.alice, 'POST', '/modules/generate', { request: 'Post release notes to a Slack channel' });
    expect(res.statusCode).toBe(201);
    const fixPrompt = ai.requests.at(-1)!.prompt;
    expect(fixPrompt).toContain('does not compile: module.ts:1:');
    const review = res.json();
    // Dittoly puts its base on top of what the AI wrote; the module's own part is the AI's code.
    expect(review.source).toBe(withBase(await typedSlack()));
    expect(review.ownSource).toBe((await typedSlack()).trimStart());
    expect(review.validationReport.passed).toBe(true);
  });
});

describe('git sync with TypeScript modules', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@acme.test', ...args], { cwd, encoding: 'utf8', env });
  let dir: string;
  let work: string;
  let connId: string;
  const folder = () => path.join(work, 'dittoly');
  type Read = { created: { kind: string; name: string; version: string }[]; problems: string[] };
  const reads = async () => (await call(w.tokens.admin, 'GET', '/git-connection')).json().imports as Read[];
  /** What this read found (a read that found nothing is not listed). */
  const sync = async (): Promise<Read> => {
    const before = (await reads()).length;
    expect((await call(w.tokens.admin, 'POST', `/git-connections/${connId}/sync`)).statusCode).toBe(202);
    await w.app.worker.drain();
    const all = await reads();
    return all.length > before ? all[0]! : { created: [], problems: [] };
  };
  const push = (msg: string) => {
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', msg);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
  };
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dty-gitts-'));
    const bare = path.join(dir, 'repo.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    work = path.join(dir, 'work');
    git(dir, 'clone', '-q', bare, work);
    // The repository already has Slack as JavaScript, from before modules were TypeScript.
    const old = path.join(work, 'dittoly', 'modules', 'slack');
    execFileSync('mkdir', ['-p', old]);
    await writeFile(path.join(old, 'module.mjs'), await read('module.mjs'));
    push('start');
    connId = (await call(w.tokens.admin, 'PUT', '/git-connection', { provider: 'git', repoUrl: `file://${bare}`, token: 't' })).json().id;
    await call(w.tokens.admin, 'POST', `/git-connections/${connId}/export-all`);
    await w.app.worker.drain();
    git(work, 'fetch', '-q', 'origin');
    const branch = git(work, 'branch', '-r', '--format=%(refname:short)').split('\n').find((b) => b.includes('dittoly/sync-'))!.trim();
    git(work, 'merge', '-q', '--ff-only', branch);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes module.ts for a TypeScript module (removing its old module.mjs), module.mjs for a JavaScript one, and the project files', async () => {
    expect(await readFile(path.join(folder(), 'modules/slack/module.ts'), 'utf8')).toBe(await typedSlack());
    expect(existsSync(path.join(folder(), 'modules/slack/module.mjs'))).toBe(false);
    expect(existsSync(path.join(folder(), 'modules/jira/module.mjs'))).toBe(true);
    expect(existsSync(path.join(folder(), 'modules/jira/module.ts'))).toBe(false);
    for (const f of ['package.json', 'tsconfig.json', 'types/dittoly.d.ts', 'scripts/build.mjs', 'schemas/flow.schema.json', '.vscode/settings.json']) {
      expect(existsSync(path.join(folder(), f)), f).toBe(true);
    }
  });

  it('what Dittoly wrote comes back as nothing; a merged change to module.ts is compiled by Dittoly and waits for review', async () => {
    expect((await sync()).created).toEqual([]);
    await writeFile(path.join(folder(), 'modules/slack/module.ts'), await typedSlack('Edited in git.'));
    push('Edit the Slack module');
    const r = await sync();
    expect(r.created).toEqual([expect.objectContaining({ kind: 'module', name: 'slack' })]);
    const row = (await w.db.query<{ source: string; code: string; status: string; origin: string }>(`SELECT source, code, status, origin FROM module_versions WHERE name = 'slack' AND version = $1`, [r.created[0]!.version])).rows[0]!;
    expect(row).toMatchObject({ source: await typedSlack('Edited in git.'), status: 'pending_review', origin: 'git' });
    expect(row.code).toBe(await compileModuleSource(row.source));
  });

  it('a module.ts that does not compile, or a folder with both files, is listed as a problem', async () => {
    const broken = path.join(folder(), 'modules/slack-broken');
    execFileSync('mkdir', ['-p', broken]);
    await writeFile(path.join(broken, 'manifest.json'), JSON.stringify({ ...JSON.parse(await read('manifest.json')), name: 'slack-broken' }));
    await writeFile(path.join(broken, 'module.ts'), 'export const actions = {');
    await writeFile(path.join(folder(), 'modules/jira/module.ts'), await read('module.mjs'));
    push('Two broken modules');
    const r = await sync();
    expect(r.created).toEqual([]);
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringContaining('jira/: has both module.ts and module.mjs'), expect.stringMatching(/slack-broken.*module\.ts:1:/)]));
  });
});

describe('the repository\'s build', () => {
  it('pins the esbuild version Dittoly compiles with', async () => {
    const own = JSON.parse(await readFile(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).dependencies.esbuild;
    const repo = JSON.parse((await scaffoldFiles('x')).find((f) => f.path === 'x/package.json')!.content!).devDependencies.esbuild;
    expect(repo).toBe(own);
  });
});

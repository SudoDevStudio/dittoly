import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { AppRunner } from '../src/engine/apps.js';
import { runFixStep } from '../src/engine/fix.js';
import { openTunnel, RemoteCodeRunner } from '../src/engine/remote-runner.js';
import { Refused } from '../src/engine/workspace-files.js';
import { fixStepSchema } from '../src/flows/definition.js';
import { loadRunnerConfig } from '../src/runner/config.js';
import { RunnerServer } from '../src/runner/server.js';
import { StepError } from '../src/runtime/ai-step.js';

/**
 * DITTOLY_CODE_RUNNER=remote: a code runner (src/runner/server.ts) in this process, its steps in direct mode
 * (no Docker needed), and Dittoly's client (src/engine/remote-runner.ts) talking to it over HTTP. A fix step runs
 * end to end through it, exactly as it does on this machine; an app step's app is reached through its tunnel.
 */
const TOKEN = 'a'.repeat(40);
let base: string;
let repo: string;
let outside: string;
let server: RunnerServer;
let url: string;

const act = (a: Record<string, string>) => ({ action: 'list', path: '', content: '', query: '', command: '', summary: '', regressionTest: '', ...a });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
const remote = (token = TOKEN) => new RemoteCodeRunner({ url, token, browser: 'process' });
const wsOptions = (runId: string) => ({ runId, repo: 'https://git.example.com/acme/shop.git', ref: 'main', token: null, image: 'node:26', env: {}, secrets: {}, keepAlive: async () => undefined });

async function startRunner(slots: number, cloneDelayMs = 0): Promise<RunnerServer> {
  const apps = new AppRunner({
    mode: 'local',
    internalHosts: ['git.example.com'],
    directAllowed: async () => true,
    dockerAvailable: async () => false,
    clone: async (_url, ref, _token, dir) => {
      await new Promise((r) => setTimeout(r, cloneDelayMs));
      execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', ref, `file://${repo}`, path.join(dir, 'src')], { stdio: 'ignore' });
      return 'abc123';
    },
  });
  return new RunnerServer({ token: TOKEN, apps, slots });
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'dty-remote-'));
  repo = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  await mkdir(path.join(repo, 'test'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'outside the clone');
  await writeFile(path.join(repo, 'cart.js'), 'exports.total = (items) => items.reduce((n, i) => n + i.price, 0);\n');
  await writeFile(path.join(repo, 'test.js'), "const assert = require('node:assert');\nassert.strictEqual(require('./cart.js').total([{ price: 2 }]), 2);\n");
  await writeFile(path.join(repo, 'repro.js'), "const assert = require('node:assert');\nassert.strictEqual(require('./cart.js').total([{ price: 2, qty: 3 }]), 6);\n");
  await writeFile(
    path.join(repo, 'server.mjs'),
    "import http from 'node:http';\nhttp.createServer((q, s) => s.end('hello from the runner ' + q.url)).listen(Number(process.env.PORT), process.env.HOST);\n",
  );
  await symlink(outside, path.join(repo, 'link'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'shop');
  server = await startRunner(1);
  url = `http://127.0.0.1:${await server.listen(0, '127.0.0.1')}`;
});

afterAll(async () => {
  await server.close();
  await rm(base, { recursive: true, force: true });
});

describe('settings', () => {
  const env = { DITTOLY_MODE: 'local', DATABASE_URL: 'postgres://x@localhost/x', DITTOLY_MASTER_KEY: Buffer.alloc(32).toString('base64') };
  it('Dittoly: local by default; remote needs an https address and the token', () => {
    expect(loadConfig(env).codeRunner).toBeNull();
    expect(loadConfig({ ...env, DITTOLY_CODE_RUNNER: 'remote', DITTOLY_RUNNER_URL: 'https://runner.example.com:8443/', DITTOLY_RUNNER_TOKEN: TOKEN }).codeRunner).toEqual({ url: 'https://runner.example.com:8443', token: TOKEN, caFile: undefined });
    expect(() => loadConfig({ ...env, DITTOLY_CODE_RUNNER: 'remote', DITTOLY_RUNNER_TOKEN: TOKEN })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, DITTOLY_CODE_RUNNER: 'remote', DITTOLY_RUNNER_URL: 'http://runner.example.com', DITTOLY_RUNNER_TOKEN: TOKEN })).toThrow('https');
    expect(() => loadConfig({ ...env, DITTOLY_CODE_RUNNER: 'remote', DITTOLY_RUNNER_URL: 'https://runner.example.com', DITTOLY_RUNNER_TOKEN: 'short' })).toThrow('DITTOLY_RUNNER_TOKEN');
    expect(loadConfig({ ...env, DITTOLY_CODE_RUNNER: 'remote', DITTOLY_RUNNER_URL: 'http://127.0.0.1:8443', DITTOLY_RUNNER_TOKEN: TOKEN }).codeRunner?.url).toBe('http://127.0.0.1:8443');
  });

  it('the runner: a long token, and TLS unless it listens on this machine only', () => {
    expect(() => loadRunnerConfig({})).toThrow('DITTOLY_RUNNER_TOKEN');
    expect(() => loadRunnerConfig({ DITTOLY_RUNNER_TOKEN: TOKEN })).toThrow('TLS');
    expect(loadRunnerConfig({ DITTOLY_RUNNER_TOKEN: TOKEN, DITTOLY_RUNNER_HOST: '127.0.0.1' })).toMatchObject({ host: '127.0.0.1', port: 8443, slots: 2, tls: undefined });
  });
});

describe('a fix step on the runner', () => {
  it('runs end to end: the AI reads and writes through the runner, Dittoly verifies there', async () => {
    const ai = new MockProvider();
    for (const a of [
      act({ action: 'read', path: 'cart.js' }),
      act({ action: 'write', path: 'cart.js', content: 'exports.total = (items) => items.reduce((n, i) => n + i.price * (i.qty ?? 1), 0);\n' }),
      act({ action: 'write', path: 'test/qty.test.js', content: "const assert = require('node:assert');\nassert.strictEqual(require('../cart.js').total([{ price: 2, qty: 3 }]), 6);\n" }),
      act({ action: 'run', command: 'test/qty.test.js' }),
      act({ action: 'write', path: 'link/secret.txt', content: 'overwritten' }),
      act({ action: 'read', path: '../outside/secret.txt' }),
      act({ action: 'search', query: 'qty' }),
      act({ action: 'done', summary: 'total() ignored the quantity.', regressionTest: 'test/qty.test.js' }),
    ])
      ai.enqueue(a);
    const step = fixStepSchema.parse({ id: 'fix', type: 'fix', ai: 'organization', repo: 'https://git.example.com/acme/shop.git', ref: 'main', install: 'true', test: 'node test.js', testFile: 'node {file}', reproduce: 'node repro.js', instruction: 'Fix it' });
    const out = await runFixStep(step, { repo: 'https://git.example.com/acme/shop.git', ref: 'main', instruction: 'Fix it', context: {}, onlyFilesIn: null }, { apps: remote(), provider: ai, runId: 'r-fix', token: null, secrets: {}, keepAlive: async () => undefined });
    expect(out.verified).toMatchObject({ reproducedBefore: true, regressionTestFailsBefore: true, regressionTestPassesAfter: true, reproducedAfter: false, testsPassAfter: true });
    expect(out.change.files.map((f) => f.path).sort()).toEqual(['cart.js', 'test/qty.test.js']);
    expect(out.change.diff).toContain('+exports.total = (items) => items.reduce((n, i) => n + i.price * (i.qty ?? 1), 0);');
    expect(out.baseCommit).toBe('abc123');
    expect(out.network.mode).toBe('direct');
    const prompts = ai.requests.map((r) => r.prompt).join('\n');
    expect(prompts).toContain('exports.total = (items) => items.reduce((n, i) => n + i.price, 0);');
    expect(prompts).toContain('write link/secret.txt\nrefused: path_outside_workspace');
    expect(prompts).toContain('read ../outside/secret.txt\nrefused: path_outside_workspace');
    expect(prompts).toMatch(/search "qty"\n.*cart\.js:1:/);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside the clone');
  }, 60_000);

  it('keeps refusals as refusals, and a closed workspace is gone', async () => {
    const ws = await remote().workspace(wsOptions('r-ws'));
    expect(ws.commit).toBe('abc123');
    expect(await ws.files.list('')).toContain('cart.js');
    await expect(ws.files.read('.git/config', 100)).rejects.toBeInstanceOf(Refused);
    await expect(ws.files.read('test', 100)).rejects.toThrow('not_a_file');
    expect(await ws.files.write('notes/a.txt', Buffer.from('hi'))).toBe('notes/a.txt');
    expect(await ws.files.read('notes/a.txt', 1)).toEqual({ data: Buffer.from('h'), size: 2 });
    expect(await ws.exec('cat notes/a.txt', { phase: 'test', timeoutMs: 10_000 })).toEqual({ code: 0, output: 'hi' });
    await ws.close();
    await expect(ws.files.list('')).rejects.toThrow('workspace_not_found');
  }, 30_000);

  it('asks for the token, refuses other git commands, and makes a step wait when its slots are taken', async () => {
    await expect(remote('b'.repeat(40)).workspace(wsOptions('r-auth'))).rejects.toThrow('runner_unauthorized');
    const first = await remote().workspace(wsOptions('r-slot-1'));
    // One slot: a second step waits its turn (the engine turns sandbox_busy into a wait).
    const busy = await remote().workspace(wsOptions('r-slot-2')).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(StepError);
    expect(busy).toMatchObject({ code: 'sandbox_busy', retryable: true });
    await expect(first.files.git(['push', 'origin', 'main'], 1000)).rejects.toThrow('git_command_not_allowed');
    await first.close();
    const next = await remote().workspace(wsOptions('r-slot-2'));
    await next.close();
    expect(await remote().modeFor()).toBe('direct');
    expect(await new RemoteCodeRunner({ url: 'http://127.0.0.1:9', token: TOKEN, browser: 'process' }).modeFor()).toBe('off');
  }, 30_000);
});

describe('a caller that stops waiting', () => {
  it('gets nothing left open: the workspace it asked for is closed and its slot freed', async () => {
    const slow = await startRunner(1, 400);
    const at = `http://127.0.0.1:${await slow.listen(0, '127.0.0.1')}`;
    const http = await import('node:http');
    const body = JSON.stringify({ runId: 'r-gone', repo: 'https://git.example.com/acme/shop.git', ref: 'main', token: null, image: 'node:26', env: {}, secrets: {} });
    const req = http.request(`${at}/v1/workspaces`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
    req.on('error', () => undefined);
    req.end(body);
    await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    await new Promise((r) => setTimeout(r, 800));
    // The one slot is free again: the abandoned workspace did not keep it.
    const ws = await new RemoteCodeRunner({ url: at, token: TOKEN, browser: 'process' }).workspace(wsOptions('r-after'));
    await ws.close();
    await slow.close();
  }, 30_000);
});

describe('an app step on the runner', () => {
  it('is reached through its tunnel, with its own token only, until its run stops it', async () => {
    const runner = remote();
    const step = { id: 'app', type: 'app', image: 'node:26', start: 'node server.mjs', port: 3000, path: '/', env: {}, readySeconds: 20, timeoutSeconds: 60 } as never;
    const started = await runner.start({ runId: 'r-app', step, repo: 'https://git.example.com/acme/shop.git', ref: 'main', token: null, keepAlive: async () => undefined });
    // This run's browser reaches the app on this machine's loopback address; the bytes go through the runner.
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(runner.isRunning('r-app', started.hostKey)).toBe(true);
    expect(await (await fetch(`${started.url}page?x=1`)).text()).toBe('hello from the runner /page?x=1');
    // The tunnel needs the app's own token: the runner's shared token does not open it.
    await expect(openTunnel(`${url}/v1/apps/unknown/tunnel`, TOKEN)).rejects.toThrow('tunnel_refused_404');
    await runner.stopRun('r-app');
    expect(runner.isRunning('r-app', started.hostKey)).toBe(false);
    await expect(fetch(started.url)).rejects.toThrow();
  }, 60_000);
});

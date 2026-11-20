import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Broker, type FetchLike } from '../src/sandbox/broker.js';
import { DockerRunner, ProcessRunner, type SandboxRunner } from '../src/sandbox/runner.js';
import { parseManifest, type Manifest } from '../src/modules/manifest.js';

const manifest: Manifest = (() => {
  const r = parseManifest({
    name: 'demo',
    version: '1.0.0',
    title: 'Demo',
    description: 'Demo module',
    hosts: ['api.example.com', 'other.example.com'],
    credentials: [
      {
        id: 'token',
        service: 'demo',
        label: 'Demo token',
        hosts: ['api.example.com'],
        placement: { type: 'bearer' },
      },
    ],
    actions: [
      { name: 'probe', title: 'Probe', description: 'Probe', effect: 'read', credentials: ['token'], input: {}, output: {} },
      { name: 'nocred', title: 'No cred', description: 'No cred', effect: 'read', credentials: [], input: {}, output: {} },
    ],
  });
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r.manifest;
})();

// The docker backend runs when an image is named, e.g. DITTOLY_TEST_DOCKER_IMAGE=node:26-alpine.
const dockerImage = process.env.DITTOLY_TEST_DOCKER_IMAGE;
const runners: [string, SandboxRunner][] = [['process', new ProcessRunner()]];
if (dockerImage) runners.push(['docker', new DockerRunner(dockerImage)]);

function brokerFor(action: string, seen: { url: string; auth: string | null }[] = []) {
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ hello: 'world' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return new Broker({ manifest, action, resolveSecret: async () => 'SECRET-123', fetchImpl });
}

it.skipIf(process.platform === 'win32')('runs local modules when the temporary directory is a symlink', async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'dty-sandbox-path-')));
  const previous = process.env.TMPDIR;
  try {
    const actual = path.join(home, 'actual');
    const alias = path.join(home, 'alias');
    await mkdir(actual);
    await symlink(actual, alias, 'dir');
    process.env.TMPDIR = alias;
    const result = await new ProcessRunner().invoke({
      code: 'export const actions = { probe: async () => ({ executed: true }) };',
      action: 'probe', input: {}, broker: brokerFor('probe'),
    });
    expect(result).toEqual({ ok: true, output: { executed: true } });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(home, { recursive: true, force: true });
  }
});

describe.each(runners)('%s sandbox', (_name, runner) => {
  it('runs an action and routes HTTP through the broker with the credential attached', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const broker = brokerFor('probe', seen);
    const code = `export const actions = {
      async probe(input, ctx) {
        const r = await ctx.http.request({ url: 'https://api.example.com/x?q=' + input.q, credential: 'token' });
        return { status: r.status, body: r.json() };
      } }`;
    const r = await runner.invoke({ code, action: 'probe', input: { q: 1 }, broker });
    expect(r).toEqual({ ok: true, output: { status: 200, body: { hello: 'world' } } });
    expect(seen).toEqual([{ url: 'https://api.example.com/x?q=1', auth: 'Bearer SECRET-123' }]);
  });

  it('blocks an undeclared host', async () => {
    const broker = brokerFor('probe');
    const code = `export const actions = { async probe(i, ctx) { await ctx.http.request({ url: 'https://evil.example.net/' }); } }`;
    const r = await runner.invoke({ code, action: 'probe', input: {}, broker });
    expect(r).toEqual({ ok: false, errorType: 'egress_denied_host', retryable: false });
    expect(broker.violations).toEqual(['egress_denied_host']);
  });

  it('will not send a credential to a declared host it is not meant for', async () => {
    const broker = brokerFor('probe');
    const code = `export const actions = { async probe(i, ctx) { await ctx.http.request({ url: 'https://other.example.com/', credential: 'token' }); } }`;
    const r = await runner.invoke({ code, action: 'probe', input: {}, broker });
    expect(r.ok).toBe(false);
    expect(broker.violations).toEqual(['credential_denied_host']);
  });

  it('will not give an action a credential it did not declare', async () => {
    const broker = brokerFor('nocred');
    const code = `export const actions = { async nocred(i, ctx) { await ctx.http.request({ url: 'https://api.example.com/', credential: 'token' }); } }`;
    await runner.invoke({ code, action: 'nocred', input: {}, broker });
    expect(broker.violations).toEqual(['credential_denied']);
  });

  it('refuses plain http unless the host is explicitly allowed for local development', async () => {
    const broker = brokerFor('probe');
    const code = `export const actions = { async probe(i, ctx) { await ctx.http.request({ url: 'http://api.example.com/' }); } }`;
    await runner.invoke({ code, action: 'probe', input: {}, broker });
    expect(broker.violations).toEqual(['egress_denied_scheme']);
  });

  it('has no direct network, file, process or environment access', async () => {
    const broker = brokerFor('probe');
    const code = `
      const tryIt = async (f) => { try { await f(); return 'allowed'; } catch (e) { return e.code ?? e.cause?.code ?? 'denied'; } };
      export const actions = { async probe() {
        const fs = await import('node:fs');
        const cp = await import('node:child_process');
        const dns = await import('node:dns/promises');
        return {
          fetch: await tryIt(() => fetch('https://api.example.com/')),
          dns: await tryIt(() => dns.lookup('example.com')),
          readFile: await tryIt(() => fs.readFileSync('/etc/hostname')),
          writeFile: await tryIt(() => fs.writeFileSync('/tmp/dty-escape', 'x')),
          spawn: await tryIt(() => cp.execSync('id')),
          eval: await tryIt(() => new Function('return 1')()),
          env: Object.keys(process.env).length,
        };
      } }`;
    const r = await runner.invoke({ code, action: 'probe', input: {}, broker });
    expect(r.ok).toBe(true);
    const out = (r as { output: Record<string, unknown> }).output;
    for (const k of ['fetch', 'dns', 'readFile', 'writeFile', 'spawn', 'eval']) expect(out[k], k).not.toBe('allowed');
    expect(out.env).toBe(0);
  });

  it('cannot signal other processes, such as the server that started it', async () => {
    const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const code = `
        const tryIt = (f) => { try { f(); return 'allowed'; } catch (e) { return e.code ?? 'denied'; } };
        export const actions = { async probe(input) {
          return {
            kill: tryIt(() => process.kill(input.pid, 'SIGTERM')),
            parent: tryIt(() => process.kill(process.ppid, 0)),
            raw: tryIt(() => process._kill(input.pid, 15)),
            replace: tryIt(() => Object.defineProperty(process, 'kill', { value: () => true })),
            assign: tryIt(() => { 'use strict'; process.kill = () => true; if (process.kill() !== true) throw new Error(); }),
          };
        } }`;
      const r = await runner.invoke({ code, action: 'probe', input: { pid: victim.pid }, broker: brokerFor('probe') });
      expect(r).toMatchObject({ ok: true, output: { kill: 'process_signal_denied', parent: 'process_signal_denied', raw: 'process_signal_denied' } });
      const out = (r as { output: Record<string, unknown> }).output;
      expect(out.replace).not.toBe('allowed');
      expect(out.assign).not.toBe('allowed');
      expect(victim.exitCode).toBeNull();
      expect(victim.signalCode).toBeNull();
    } finally {
      victim.kill('SIGKILL');
    }
  });

  it('times out a module that never returns', async () => {
    const broker = brokerFor('probe');
    const code = `export const actions = { probe: () => new Promise(() => {}) }`;
    const r = await runner.invoke({ code, action: 'probe', input: {}, broker, timeoutMs: 3000 });
    expect(r).toEqual({ ok: false, errorType: 'action_timeout', retryable: true });
  });

  it('describes the actions a module exports', async () => {
    const code = `export const actions = { a() {}, b() {} }`;
    const r = await runner.invoke({ code, action: '__describe', input: null, broker: brokerFor('probe') });
    expect(r).toEqual({ ok: true, output: { actions: ['a', 'b'] } });
  });
});

describe('asking a person for help', () => {
  const askThrice = `export const actions = { async probe(input, { page }) {
    const out = [];
    for (let i = 0; i < 3; i++) out.push(await page.askForHelp('sign in').then(() => 'ok', (e) => e.code));
    return out;
  } }`;
  /** A broker whose help requests take `waitMs`, as if a person took that long. */
  const helpBroker = (waitMs: number, asked: string[] = []) => ({
    handle: async () => ({ ok: false as const, error: 'x', retryable: false, violation: false }),
    call: async (_kind: string, req: Record<string, unknown>) => {
      asked.push(String(req.op));
      await new Promise((r) => setTimeout(r, waitMs));
      return { ok: true as const, result: null };
    },
  });

  it('an action may ask at most twice', async () => {
    const asked: string[] = [];
    const r = await new ProcessRunner().invoke({ code: askThrice, action: 'probe', input: {}, broker: helpBroker(0, asked) });
    expect(r).toEqual({ ok: true, output: ['ok', 'ok', 'help_limit_reached'] });
    // The third request never reached the broker.
    expect(asked.filter((op) => op === 'askForHelp')).toHaveLength(2);
  });

  it('waiting for a person does not stop the wall clock: the action ends at the overall limit', async () => {
    const code = `export const actions = { async probe(input, { page }) { await page.askForHelp('sign in'); await page.askForHelp('again'); return 'done'; } }`;
    const started = Date.now();
    // Each wait is shorter than the action's own timeout, but together they pass the wall-clock limit.
    const r = await new ProcessRunner().invoke({ code, action: 'probe', input: {}, broker: helpBroker(700, []), timeoutMs: 1_000, wallClockMs: 1_000 });
    expect(r).toEqual({ ok: false, errorType: 'help_limit_reached', retryable: false });
    expect(Date.now() - started).toBeLessThan(1_400);
  });

  it('the broker also allows two help requests per action', async () => {
    const browserManifest = (parseManifest({
      name: 'help-check',
      version: '1.0.0',
      title: 'B',
      description: 'd',
      hosts: [],
      browser: { hosts: ['portal.example.com'] },
      credentials: [],
      actions: [{ name: 'a', title: 'A', description: 'a', effect: 'read', credentials: [], input: {}, output: {} }],
    }) as { manifest: Manifest }).manifest;
    const session = { send: async () => ({ ok: true }), onFrame: () => undefined, closed: false, close: async () => undefined };
    const broker = new Broker({ manifest: browserManifest, action: 'a', resolveSecret: async () => null, cannedPages: [], browser: { backend: 'local', start: async () => session } });
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(await broker.call('browser', { op: 'askForHelp', message: 'help' }));
    expect(outcomes.map((o) => (o.ok ? 'ok' : o.error))).toEqual(['ok', 'ok', 'help_limit_reached']);
  });
});

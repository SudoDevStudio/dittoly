import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppRunner } from '../src/engine/apps.js';
import { appNetworksFor, proxyRunArgs, serverRunArgs, StdioSandbox } from '../src/mcp/stdio.js';
import { browserRunArgs, DockerBrowserLauncher, privateAllowList } from '../src/sandbox/browser.js';

/**
 * Docker sandboxes, without Docker: a stand-in `docker` on PATH records every command, so the
 * tests check what would run. Each app, fix step, browser session and MCP session gets an
 * internal network of its own, removed when it stops; app containers run unprivileged.
 */
let bin: string;
let logFile: string;
const savedPath = process.env.PATH;

beforeAll(async () => {
  bin = await mkdtemp(path.join(tmpdir(), 'dty-fake-docker-'));
  logFile = path.join(bin, 'calls.log');
  await writeFile(
    path.join(bin, 'docker'),
    `#!/bin/sh
# App startup and readiness probes run concurrently. Append one complete record so
# their arguments cannot interleave and masquerade as a malformed Docker command.
record=$(printf '%s\\037' "$@")
printf '%s\\n' "$record" >> '${logFile}'
case "$1" in
  logs) echo '{"ready":true}'; echo '{"decision":"deny","host":"evil.example.com:443","reason":"not_allowed"}' ;;
  inspect) echo '10.9.8.7' ;;
  run) case " $* " in *" dty-app-"*) exec sleep 3 ;; esac ;;
esac
exit 0
`,
  );
  await chmod(path.join(bin, 'docker'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
});
afterAll(async () => {
  process.env.PATH = savedPath;
  await rm(bin, { recursive: true, force: true });
});
beforeEach(async () => {
  await writeFile(logFile, '');
});

async function calls(): Promise<string[][]> {
  return (await readFile(logFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f').slice(0, -1));
}
/**
 * The first call that matches, waiting for it: the stand-in's readiness probe answers at once, so start() can return
 * before the concurrently started app container's own record is appended (real Docker has no logs before the
 * container exists).
 */
async function callWhere(match: (a: string[]) => boolean): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    const hit = (await calls()).find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the expected docker call was never made');
}
const created = (c: string[][]) => c.filter((a) => a[0] === 'network' && a[1] === 'create' && a.includes('--internal')).map((a) => a[a.length - 1]!);
const removed = (c: string[][]) => c.filter((a) => a[0] === 'network' && a[1] === 'rm').map((a) => a[2]!);
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

function runner() {
  return new AppRunner({
    mode: 'shared',
    internalHosts: ['git.example.com'],
    directAllowed: async () => false,
    dockerAvailable: async () => true,
    clone: async (_u, _r, _t, dir) => {
      await mkdir(path.join(dir, 'src', '.git'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'server.mjs'), '');
      return 'abc123';
    },
  });
}
const step = { id: 'app', type: 'app', image: 'node:26', install: 'npm ci', start: 'node server.mjs', port: 3000, path: '/', env: {}, readySeconds: 10, timeoutSeconds: 60 } as never;

describe('docker sandboxes get a network each', () => {
  it('an app step: its own internal network for install, build and the app, removed when the run stops; the app runs unprivileged and read-only', async () => {
    const apps = runner();
    const opts = { step, repo: 'https://git.example.com/a.git', ref: 'main', token: null, keepAlive: async () => undefined };
    const one = await apps.start({ runId: 'r1', ...opts });
    const two = await apps.start({ runId: 'r2', ...opts });
    const c = await calls();
    const nets = created(c);
    expect(nets).toHaveLength(2);
    expect(nets[0]).toMatch(/^dty-sbx-[0-9a-f-]{12}$/);
    expect(nets[0]).not.toBe(nets[1]);
    expect(c.flat()).not.toContain('dittoly-mcp-sandbox');

    const runs = c.filter((a) => a[0] === 'run');
    const install = runs.find((a) => a.includes('npm ci'))!;
    expect(after(install, '--network')).toBe(nets[0]);
    expect(after(install, '--user')).toBe('65534:65534');
    expect(install).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '-e', 'HOME=/dty-home']));
    const app = await callWhere((a) => a[0] === 'run' && a.includes('node server.mjs') && a.includes(one.hostKey.split(':')[0]!));
    expect(after(app, '--network')).toBe(nets[0]);
    expect(after(app, '--user')).toBe('65534:65534');
    expect(app).toEqual(expect.arrayContaining(['--read-only', '--tmpfs']));
    // The install's proxy sits on the app's network, and only there.
    const connects = c.filter((a) => a[0] === 'network' && a[1] === 'connect');
    expect(connects.map((a) => a[2])).toEqual([nets[0], nets[1]]);

    // A browser session of run 1 may join run 1's app network, and no other.
    expect(appNetworksFor([one.hostKey])).toEqual([nets[0]]);
    expect(appNetworksFor([two.hostKey])).toEqual([nets[1]]);

    await apps.stopRun('r1');
    await apps.stopRun('r2');
    const end = await calls();
    expect(removed(end)).toEqual(expect.arrayContaining(nets));
    expect(appNetworksFor([one.hostKey, two.hostKey])).toEqual([]);
    // The app's container is removed before its network.
    const rmApp = end.findIndex((a) => a[0] === 'rm' && a.includes(one.hostKey.split(':')[0]!));
    const rmNet = end.findIndex((a) => a[0] === 'network' && a[1] === 'rm' && a[2] === nets[0]);
    expect(rmApp).toBeGreaterThan(-1);
    expect(rmNet).toBeGreaterThan(rmApp);
  }, 30_000);

  it('a fix step: its commands run on the workspace\'s own network, removed on close', async () => {
    const ws = await runner().workspace({ runId: 'r3', repo: 'https://git.example.com/a.git', ref: 'main', token: null, image: 'node:26', env: {}, secrets: {}, keepAlive: async () => undefined });
    await ws.exec('npm test', { phase: 'test', timeoutMs: 10_000 });
    let c = await calls();
    const [net] = created(c);
    const cmd = c.find((a) => a[0] === 'run' && a.includes('npm test'))!;
    expect(after(cmd, '--network')).toBe(net);
    expect(after(cmd, '--user')).toBe('65534:65534');
    await ws.close();
    c = await calls();
    expect(removed(c)).toEqual([net]);
  }, 30_000);

  it('a fix step\'s phases: each its own proxy and destinations, TCP forwards mapped to the proxy, each secret only in its phases', async () => {
    const { parseDestination } = await import('../src/runtime/destinations.js');
    const d = (s: string) => parseDestination(s) as import('../src/runtime/destinations.js').Destination;
    const network = { egress: { test: [d('testdb.example.com:5432'), d('api.test.example.com')] }, secretPhases: { DB_URL: ['test' as const], BUILD_TOKEN: ['build' as const] } };
    const secrets = { DB_URL: 'postgres://u:p@testdb.example.com/x', BUILD_TOKEN: 'bt-123' };
    const ws = await runner().workspace({ runId: 'r4', repo: 'https://git.example.com/a.git', ref: 'main', token: null, image: 'node:26', env: {}, secrets, network, keepAlive: async () => undefined });
    await ws.exec('npm ci', { phase: 'install', timeoutMs: 10_000 });
    await ws.exec('npm run build', { phase: 'build', timeoutMs: 10_000 });
    await ws.exec('npm test', { phase: 'test', timeoutMs: 10_000 });
    const c = await calls();
    const [net] = created(c);
    const proxies = c.filter((a) => a[0] === 'run' && a.includes('/proxy.mjs'));
    // install and build have the same list (no build destinations): one proxy; the tests get their own.
    expect(proxies).toHaveLength(2);
    const allowOf = (a: string[]) => a.find((x) => x.startsWith('DTY_ALLOW='))!.slice('DTY_ALLOW='.length).split(',');
    expect(allowOf(proxies[0]!)).not.toContain('testdb.example.com:5432');
    expect(allowOf(proxies[1]!)).toEqual(expect.arrayContaining(['testdb.example.com:5432', 'api.test.example.com:443', 'registry.npmjs.org:443', 'git.example.com:443']));
    expect(proxies[1]).toContain('DTY_TCP=5432=testdb.example.com:5432');
    // The first proxy is gone before the tests run.
    const firstProxy = after(proxies[0]!, '--name')!;
    const rmFirst = c.findIndex((a) => a[0] === 'rm' && a.includes(firstProxy));
    const testRun = c.findIndex((a) => a[0] === 'run' && a.includes('npm test'));
    expect(rmFirst).toBeGreaterThan(-1);
    expect(rmFirst).toBeLessThan(testRun);
    const install = c.find((a) => a[0] === 'run' && a.includes('npm ci'))!;
    const build = c.find((a) => a[0] === 'run' && a.includes('npm run build'))!;
    const test = c[testRun]!;
    for (const a of [install, build, test]) expect(after(a, '--network')).toBe(net);
    expect(install).not.toContain('--env-file');
    expect(install).not.toContain('--add-host');
    expect(test).toEqual(expect.arrayContaining(['--add-host', 'testdb.example.com:10.9.8.7']));
    expect(await readFile(after(build, '--env-file')!, 'utf8')).toBe('BUILD_TOKEN=bt-123\n');
    expect(await readFile(after(test, '--env-file')!, 'utf8')).toBe(`DB_URL=${secrets.DB_URL}\n`);
    // Secrets never on a command line.
    expect(c.flat().join(' ')).not.toContain('bt-123');
    const report = await ws.network();
    expect(report.mode).toBe('docker');
    expect(report.phases.map((p) => [p.phase, p.secrets])).toEqual([['install', []], ['build', ['BUILD_TOKEN']], ['test', ['DB_URL']]]);
    expect(report.phases[2]!.reaches).toContain('testdb.example.com:5432');
    expect(report.refused).toContainEqual({ phase: 'test', host: 'evil.example.com:443', reason: 'not_allowed' });
    await ws.close();
    expect(removed(await calls())).toContain(net);
  }, 30_000);

  it('an app step\'s run destinations: a proxy of its own for the running app (no registries), mapped TCP hosts; none without them', async () => {
    const { parseDestination } = await import('../src/runtime/destinations.js');
    const d = (s: string) => parseDestination(s) as import('../src/runtime/destinations.js').Destination;
    const apps = runner();
    const started = await apps.start({ runId: 'r5', step, repo: 'https://git.example.com/a.git', ref: 'main', token: null, keepAlive: async () => undefined, network: { egress: { run: [d('api.stripe.com'), d('cache.example.com:6379')] }, secretPhases: {} } });
    const c = await calls();
    const proxies = c.filter((a) => a[0] === 'run' && a.includes('/proxy.mjs'));
    expect(proxies).toHaveLength(2);
    const runAllow = proxies[1]!.find((x) => x.startsWith('DTY_ALLOW='))!;
    expect(runAllow).toBe('DTY_ALLOW=api.stripe.com:443,cache.example.com:6379');
    const app = await callWhere((a) => a[0] === 'run' && a.includes('node server.mjs') && a.includes(started.hostKey.split(':')[0]!));
    expect(app).toEqual(expect.arrayContaining(['--add-host', 'cache.example.com:10.9.8.7']));
    expect(app.some((x) => x.startsWith('HTTPS_PROXY=http://dty-proxy-'))).toBe(true);
    expect(started.network.phases.map((p) => [p.phase, p.reaches])).toEqual([
      ['install', expect.arrayContaining(['git.example.com:443'])],
      ['run', ['api.stripe.com:443', 'cache.example.com:6379']],
    ]);
    await apps.stopRun('r5');
    await writeFile(logFile, '');
    const plain = await apps.start({ runId: 'r6', step, repo: 'https://git.example.com/a.git', ref: 'main', token: null, keepAlive: async () => undefined });
    const c2 = await calls();
    const app2 = await callWhere((a) => a[0] === 'run' && a.includes('node server.mjs') && a.includes(plain.hostKey.split(':')[0]!));
    expect(app2.some((x) => x.startsWith('HTTPS_PROXY='))).toBe(false);
    expect(c2.filter((a) => a[0] === 'run' && a.includes('/proxy.mjs'))).toHaveLength(1);
    expect(plain.network.phases.at(-1)).toEqual({ phase: 'run', reaches: [], secrets: [] });
    await apps.stopRun('r6');
  }, 30_000);

  it('a browser session: driver and proxy on a network of their own, the proxy joined to its run\'s app network; both removed on close', async () => {
    const sandbox = new StdioSandbox();
    const appNet = await sandbox.createNetwork();
    const { shareAppNetwork, unshareAppNetwork } = await import('../src/mcp/stdio.js');
    shareAppNetwork('dty-app-x:3000', appNet);
    try {
      await writeFile(logFile, '');
      // The stand-in docker exits at once, so the driver never answers: the start fails and cleans up.
      await expect(new DockerBrowserLauncher('pw-image').start({ hosts: ['dty-app-x:3000'], plainHttp: ['dty-app-x:3000'], allowPrivate: ['dty-app-x'] })).rejects.toMatchObject({ code: 'browser_start_failed' });
      const c = await calls();
      const [session] = created(c);
      const proxyRun = c.find((a) => a[0] === 'run' && a.includes('/proxy.mjs'))!;
      // An internal host listed without a port still counts.
      expect(proxyRun).toContain('DTY_ALLOW_PRIVATE=dty-app-x:3000');
      const connects = c.filter((a) => a[0] === 'network' && a[1] === 'connect').map((a) => a[2]);
      expect(connects).toEqual([session, appNet]);
      const driver = c.find((a) => a[0] === 'run' && a.includes('/driver/browser-driver.mjs'))!;
      expect(after(driver, '--network')).toBe(session);
      expect(removed(c)).toEqual([session]);
    } finally {
      unshareAppNetwork('dty-app-x:3000');
      await sandbox.removeNetwork(appNet);
    }
  }, 30_000);

  it('argument builders: the proxy, MCP servers and browser drivers', async () => {
    expect(proxyRunArgs({ name: 'p', image: 'node:26-alpine', allow: ['a.example.com:443'], allowPrivate: [] })).toEqual(
      expect.arrayContaining(['--network', 'dittoly-mcp-egress', '--read-only', '--cap-drop', 'ALL', 'DTY_ALLOW=a.example.com:443']),
    );
    const server = { image: 'node:26-alpine', volume: 'v', entry: '/srv/x.js', allow: [], credentialEnv: 'TOKEN' };
    const args = serverRunArgs({ name: 's', network: 'dty-sbx-abc', proxyUrl: 'http://p:3128', server, withSecret: true });
    expect(after(args, '--network')).toBe('dty-sbx-abc');
    expect(args).toEqual(expect.arrayContaining(['--read-only', '--user', '1000:1000', '-e', 'TOKEN']));
    expect(browserRunArgs({ name: 'b', image: 'pw', network: null, driverScript: '/d.mjs', playwrightDir: '/pw' })).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(privateAllowList(['a.corp:443', 'b.corp:8080', 'c.example.com:443'], ['a.corp', 'b.corp:8080'])).toEqual(['a.corp:443', 'b.corp:8080']);

    // A stdio MCP session: its own network for the proxy, removed with it.
    const log: string[][] = [];
    const sandbox = new StdioSandbox({ docker: async (a) => (log.push(a), a[0] === 'logs' ? '{"ready":true}' : '') });
    const proxy = await sandbox.startProxy(['api.example.com:443']);
    expect(proxy.network).toMatch(/^dty-sbx-/);
    expect(log).toContainEqual(['network', 'connect', proxy.network, expect.stringMatching(/^dty-proxy-/)]);
    await proxy.stop();
    expect(log.at(-1)).toEqual(['network', 'rm', proxy.network]);
  });
});

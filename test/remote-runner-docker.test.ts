import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppRunner } from '../src/engine/apps.js';
import { RemoteCodeRunner } from '../src/engine/remote-runner.js';
import { appNetworksFor, EGRESS_NETWORK } from '../src/mcp/stdio.js';
import { RunnerServer } from '../src/runner/server.js';

/**
 * DITTOLY_CODE_RUNNER=remote with real containers: the runner builds and runs in its Docker sandboxes and publishes
 * a running app on its loopback address only; Dittoly's relay container carries the browser's connections to it
 * through the app's tunnel. The "browser" here is a container on the network the browser's proxy would join.
 * Skipped where Docker is not available.
 */
const docker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const TOKEN = 'd'.repeat(40);
const sh = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
// The runner answers in this process: a container that talks to it must not block the event loop.
const shAsync = async (args: string[]) => (await promisify(execFile)('docker', args, { encoding: 'utf8', timeout: 60_000 })).stdout.trim();

describe.skipIf(!docker)('a remote code runner in Docker', () => {
  let fixture: string;
  let server: RunnerServer;
  let remote: RemoteCodeRunner;

  beforeAll(async () => {
    try {
      execFileSync('docker', ['network', 'create', EGRESS_NETWORK], { stdio: 'ignore' });
    } catch {
      // exists
    }
    fixture = await mkdtemp(path.join(tmpdir(), 'dty-remote-docker-'));
    await writeFile(path.join(fixture, 'server.mjs'), "import http from 'node:http';\nhttp.createServer((q, s) => s.end('served on the runner')).listen(Number(process.env.PORT), process.env.HOST);\n");
    const apps = new AppRunner({
      mode: 'shared',
      internalHosts: [],
      directAllowed: async () => false,
      publishApps: true,
      clone: async (_u, _r, _t, dir) => {
        await mkdir(path.join(dir, 'src'));
        await writeFile(path.join(dir, 'src', 'server.mjs'), await import('node:fs/promises').then((f) => f.readFile(path.join(fixture, 'server.mjs'))));
        execFileSync('git', ['init', '-q', path.join(dir, 'src')]);
        return 'c0ffee';
      },
    });
    server = new RunnerServer({ token: TOKEN, apps, slots: 2 });
    const port = await server.listen(0, '0.0.0.0');
    // The relay container reaches the runner at this machine's address on the egress network.
    const gateway = sh(['network', 'inspect', EGRESS_NETWORK, '-f', '{{(index .IPAM.Config 0).Gateway}}']);
    remote = new RemoteCodeRunner({ url: `http://${gateway}:${port}`, token: TOKEN, browser: 'docker' });
  }, 120_000);

  afterAll(async () => {
    await remote?.stopAll();
    await server?.close();
    await rm(fixture, { recursive: true, force: true });
  });

  it("the browser's network reaches the app on the runner; nothing is left once the run stops", async () => {
    const step = { id: 'app', type: 'app', image: 'node:26-alpine', start: 'node server.mjs', port: 3000, path: '/', env: {}, readySeconds: 60, timeoutSeconds: 120 } as never;
    const started = await remote.start({ runId: 'rd-app', step, repo: 'https://github.com/acme/shop.git', ref: 'main', token: null, keepAlive: async () => undefined });
    expect(started.mode).toBe('docker');
    expect(started.url).toMatch(/^http:\/\/dty-app-[0-9a-f-]+:3000\/$/);
    const [network] = appNetworksFor([started.hostKey]);
    expect(network).toBeTruthy();
    const body = await shAsync(['run', '--rm', '--network', network!, 'node:26-alpine', 'node', '-e', `fetch(${JSON.stringify(started.url)}).then(r=>r.text()).then(t=>console.log(t),e=>{console.log('failed '+e.cause?.code);process.exit(1)})`]);
    expect(body).toBe('served on the runner');
    // Published on the runner's loopback address only, from a network no other container is on.
    const [ports, networks] = sh(['ps', '--filter', 'name=-fwd', '--format', '{{.Ports}} {{.Networks}}']).split(' ');
    expect(ports).toMatch(/^127\.0\.0\.1:\d+->8080\/tcp$/);
    expect(networks!.split(',').sort()).toEqual([expect.stringMatching(/^dty-app-.*-fwd-net$/), expect.stringMatching(/^dty-sbx-/)]);
    await remote.stopRun('rd-app');
    expect(appNetworksFor([started.hostKey])).toEqual([]);
    expect(sh(['ps', '-a', '--filter', 'name=dty-relay-', '--format', '{{.Names}}'])).toBe('');
    expect(sh(['ps', '-a', '--filter', 'name=dty-app-', '--format', '{{.Names}}'])).toBe('');
    expect(sh(['network', 'ls', '--filter', 'name=-fwd-net', '--format', '{{.Name}}'])).toBe('');
  }, 240_000);

  it('a fix step runs its commands in the runner\'s containers', async () => {
    const ws = await remote.workspace({ runId: 'rd-fix', repo: 'https://github.com/acme/shop.git', ref: 'main', token: null, image: 'node:26-alpine', env: {}, secrets: {}, keepAlive: async () => undefined });
    expect(ws.mode).toBe('docker');
    const r = await ws.exec('id -u && test -f server.mjs && echo found', { phase: 'test', timeoutMs: 60_000 });
    expect(r).toMatchObject({ code: 0 });
    expect(r.output).toContain('65534');
    expect(r.output).toContain('found');
    await ws.close();
  }, 240_000);
});

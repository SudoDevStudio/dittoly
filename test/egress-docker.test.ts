import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppRunner } from '../src/engine/apps.js';
import { EGRESS_NETWORK } from '../src/mcp/stdio.js';
import { parseDestination, type Destination } from '../src/runtime/destinations.js';

/**
 * A fix step's phases in real containers: the test phase reaches its declared test database (a TCP
 * forward, by the database's own name) and the install phase cannot, nor can either reach anything
 * undeclared. Skipped where Docker is not available.
 */
const docker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const db = 'dty-test-tcpdb';
const d = (s: string) => parseDestination(s) as Destination;
// Connects to host:port, sends "ping", prints what comes back, or "refused".
const probe = (host: string, port: number) =>
  `node -e "const s=require('net').connect(${port},'${host}',()=>s.write('ping'));s.on('data',d=>{console.log('got:'+d);process.exit(0)});s.on('error',e=>{console.log('refused:'+e.code);process.exit(1)});s.on('close',()=>{console.log('refused:closed');process.exit(1)});setTimeout(()=>{console.log('refused:timeout');process.exit(1)},8000)"`;

describe.skipIf(!docker)('phase destinations in Docker', () => {
  beforeAll(() => {
    try {
      execFileSync('docker', ['network', 'create', EGRESS_NETWORK], { stdio: 'ignore' });
    } catch {
      // exists
    }
    execFileSync('docker', ['rm', '-f', db], { stdio: 'ignore' });
    // A TCP echo server standing in for a test database, on a private address (so it is listed as internal).
    execFileSync('docker', ['run', '-d', '--rm', '--name', db, '--network', EGRESS_NETWORK, 'node:26-alpine', 'node', '-e', "require('net').createServer(s=>s.pipe(s)).listen(5432)"], { stdio: 'ignore' });
  }, 60_000);
  afterAll(() => {
    execFileSync('docker', ['rm', '-f', db], { stdio: 'ignore' });
  });

  it('the test phase reaches its TCP destination by name; the install phase does not', async () => {
    const apps = new AppRunner({
      mode: 'shared',
      internalHosts: [`${db}:5432`],
      directAllowed: async () => false,
      clone: async (_u, _r, _t, dir) => {
        await mkdir(path.join(dir, 'src', '.git'), { recursive: true });
        await writeFile(path.join(dir, 'src', 'README'), 'x');
        return 'c0ffee'.padEnd(40, '0');
      },
    });
    const ws = await apps.workspace({
      runId: 'tcp',
      repo: 'https://github.com/example/app.git',
      ref: 'main',
      token: null,
      image: 'node:26-alpine',
      env: {},
      secrets: { DB_URL: `postgres://u:p@${db}:5432/x` },
      network: { egress: { test: [d(`${db}:5432`)] }, secretPhases: { DB_URL: ['test'] } },
      keepAlive: async () => undefined,
    });
    try {
      const install = await ws.exec(probe(db, 5432), { phase: 'install', timeoutMs: 30_000 });
      expect(install.output).toContain('refused:');
      expect(install.code).not.toBe(0);
      const test = await ws.exec(probe(db, 5432), { phase: 'test', timeoutMs: 30_000 });
      expect(test.output, test.output).toContain('got:ping');
      // The secret reached the test phase only, and never the output.
      const env = await ws.exec('test -n "$DB_URL" && echo "has:$DB_URL"', { phase: 'test', timeoutMs: 30_000 });
      expect(env.output).toContain('has:[secret removed]');
      expect((await ws.exec('echo "has:${DB_URL:-none}"', { phase: 'install', timeoutMs: 30_000 })).output).toContain('has:none');
      // Undeclared: refused by the proxy (through HTTPS_PROXY), and recorded with its reason.
      await ws.exec(`node -e "fetch('https://example.org').then(()=>console.log('reached'),e=>console.log('blocked'))"`, { phase: 'test', timeoutMs: 30_000 });
      const report = await ws.network();
      expect(report.phases.find((p) => p.phase === 'test')).toMatchObject({ secrets: ['DB_URL'], reaches: expect.arrayContaining([`${db}:5432`]) });
      expect(report.refused).toContainEqual({ phase: 'test', host: 'example.org:443', reason: 'not_allowed' });
    } finally {
      await ws.close();
    }
  }, 180_000);

  it("a step's container sees neither Dittoly's files, its database, nor Docker", async () => {
    const apps = new AppRunner({
      mode: 'shared',
      internalHosts: [],
      directAllowed: async () => false,
      clone: async (_u, _r, _t, dir) => {
        await mkdir(path.join(dir, 'src', '.git'), { recursive: true });
        await writeFile(path.join(dir, 'src', 'README'), 'x');
        return 'c0ffee'.padEnd(40, '0');
      },
    });
    const ws = await apps.workspace({ runId: 'iso', repo: 'https://github.com/example/app.git', ref: 'main', token: null, image: 'node:26-alpine', env: {}, secrets: {}, keepAlive: async () => undefined });
    // A service on the host listening on every interface (as Dittoly itself does, or a database published
    // with -p 5432:5432), the server's database as the server reaches it, and the Docker host's addresses.
    const host = net.createServer((sock) => sock.end('host-service'));
    await new Promise<void>((r) => host.listen(0, '0.0.0.0', r));
    const port = (host.address() as net.AddressInfo).port;
    const db = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost:5433/x');
    const bridge = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim() || '172.17.0.1';
    // The step network's own gateway address (x.y.0.1 of its /16), where an internal network's bridge sits on the host.
    const ownGateway = `node -e "const a=Object.values(require('os').networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal).address.split('.');console.log(a[0]+'.'+a[1]+'.0.1')"`;
    try {
      for (const phase of ['install', 'build', 'test'] as const) {
        const files = await ws.exec(`ls ${JSON.stringify(process.cwd())} /var/run/docker.sock 2>&1; ls /app /dty-home`, { phase, timeoutMs: 30_000 });
        expect(files.output).toContain('No such file or directory');
        expect(files.output).not.toContain('package.json');
        const gateway = (await ws.exec(ownGateway, { phase, timeoutMs: 30_000 })).output.trim().split('\n').at(-1)!;
        expect(gateway).toMatch(/^\d+\.\d+\.0\.1$/);
        for (const [h, p] of [[gateway, port], [bridge, port], ['host.docker.internal', port], [db.hostname, Number(db.port || 5432)], [gateway, Number(db.port || 5432)]] as const) {
          const r = await ws.exec(probe(h, p), { phase, timeoutMs: 30_000 });
          expect(r.output, `${phase} ${h}:${p}`).toContain('refused:');
        }
      }
    } finally {
      host.close();
      await ws.close();
    }
  }, 180_000);
});

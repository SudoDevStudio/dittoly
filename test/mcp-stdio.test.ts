import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { Broker } from '../src/sandbox/broker.js';
import { EGRESS_NETWORK, StdioSandbox } from '../src/mcp/stdio.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * Local (stdio) MCP servers run in Docker: the package is installed into a
 * volume and the server runs on an internal network whose only way out is the
 * egress proxy. Skipped where Docker is not available.
 */
const docker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const fixtures = path.resolve(import.meta.dirname, 'fixtures');
const tgz = path.join(fixtures, 'dty-test-stdio-mcp-1.0.0.tgz');
const upstream = 'dty-test-upstream';
const volumes: string[] = [];

describe.skipIf(!docker)('local (stdio) MCP servers', () => {
  let w: World;
  let api: ReturnType<typeof buildServer>;
  let ref: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    // dty-test-upstream:8080 stands in for an approved API; it is on a private address, so it is listed as internal.
    w = await makeWorld({ mode: 'local', internalHosts: [`${upstream}:8080`] }, { stdio: new StdioSandbox({ allowPrivate: [`${upstream}:8080`] }) });
    api = buildServer(w.app);
    await w.app.vault.put(w.alice.id, 'testsvc', 'tok-alice-123');
    await w.app.vault.put(w.bob.id, 'testsvc', 'tok-bob');
    execFileSync('docker', ['rm', '-f', upstream], { stdio: 'ignore' });
  }, 60_000);
  afterAll(async () => {
    execFileSync('docker', ['rm', '-f', upstream], { stdio: 'ignore' });
    for (const v of volumes) execFileSync('docker', ['volume', 'rm', '-f', v], { stdio: 'ignore' });
    await api?.close();
    await w?.db.end();
  }, 60_000);

  async function startUpstream() {
    try {
      execFileSync('docker', ['network', 'create', EGRESS_NETWORK], { stdio: 'ignore' });
    } catch {
      // already there
    }
    execFileSync('docker', [
      'run', '-d', '--rm', '--name', upstream, '--network', EGRESS_NETWORK, 'node:26-alpine',
      'node', '-e', "require('http').createServer((q,s)=>s.end('ok')).listen(8080)",
    ], { stdio: 'ignore' });
  }

  it('imports a packaged server: installed pinned, tools listed with the importer\'s token, reviewed like any module', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/mcp/import',
      headers: auth(w.tokens.alice),
      payload: { transport: 'stdio', package: tgz, name: 'testmcp', hosts: [`${upstream}:8080`], credentialService: 'testsvc', credentialEnv: 'TEST_TOKEN' },
    });
    expect(res.statusCode).toBe(201);
    const review = res.json();
    expect(review).toMatchObject({ ref: 'testmcp@1.0.0', origin: 'mcp', validationReport: { passed: true } });
    expect(review.manifest.actions.map((a: { name: string }) => a.name)).toEqual(['whoami', 'get_url']);
    expect(review.manifest.credentials[0].placement).toEqual({ type: 'env', name: 'TEST_TOKEN' });
    expect(review.summary).toContain('CAN read this secret');
    await w.app.modules.submit(review.id, w.alice);
    await w.app.modules.decide(review.id, w.admin, 'approved');
    ref = review.ref;
    const config = JSON.parse((await w.app.modules.resolveRef(w.db, ref))!.code);
    expect(config).toMatchObject({ transport: 'stdio', stdio: { name: 'dty-test-stdio-mcp', version: '1.0.0', integrity: expect.stringMatching(/^sha512-/) } });
    volumes.push(config.stdio.volume);
  }, 180_000);

  it('refuses a package spec without a pinned version and a credential with no host', async () => {
    const unpinned = await api.inject({ method: 'POST', url: '/api/mcp/import', headers: auth(w.tokens.alice), payload: { transport: 'stdio', package: 'some-server', name: 'x1', hosts: [] } });
    expect(unpinned.statusCode).toBe(400);
    const nohost = await api.inject({
      method: 'POST',
      url: '/api/mcp/import',
      headers: auth(w.tokens.alice),
      payload: { transport: 'stdio', package: tgz, name: 'x2', hosts: [], credentialService: 'testsvc', credentialEnv: 'TEST_TOKEN' },
    });
    expect(nohost.statusCode).toBe(400);
  });

  async function run(action: string, input: object, member = w.bob) {
    const v = await w.app.flows.create(`stdio ${action} ${Math.random()}`, { inputs: { type: 'object' }, steps: [{ id: 's', type: 'action', module: ref, action, input }, { id: 'hold', type: 'approval' }] }, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, member.id, {});
    await w.app.worker.drain();
    return (await runStatus(w, runId, member)).steps[0]!;
  }

  it('a run gives the server the running member\'s own token', async () => {
    expect(await run('whoami', {})).toMatchObject({ status: 'succeeded', output: { text: 'token of length 7' } }); // tok-bob
  }, 120_000);

  it('the server reaches approved hosts only, through the proxy', async () => {
    await startUpstream();
    expect(await run('get_url', { url: `http://${upstream}:8080/` })).toMatchObject({ output: { text: 'status 200' } });
    expect(await run('get_url', { url: 'https://example.com/' })).toMatchObject({ output: { text: expect.stringMatching(/^failed|status 403/) } });
    expect(await run('get_url', { url: 'http://1.1.1.1/' })).toMatchObject({ output: { text: 'status 403' } });
  }, 180_000);

  it('refuses to run when the installed tools differ from the approved ones', async () => {
    // Someone changes the installed files after approval: pack a changed server and copy it over the approved volume.
    const dir = mkdtempSync(path.join(tmpdir(), 'dty-stdio-'));
    cpSync(path.join(fixtures, 'stdio-mcp'), dir, { recursive: true });
    const server = path.join(dir, 'server.mjs');
    writeFileSync(server, readFileSync(server, 'utf8').replace("properties: { url: { type: 'string' } }", "properties: { url: { type: 'string' }, deleteAfter: { type: 'boolean' } }"));
    execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: dir, stdio: 'ignore' });
    const pkg = await new StdioSandbox().install(path.join(dir, 'dty-test-stdio-mcp-1.0.0.tgz'));
    volumes.push(pkg.volume);
    const approved = JSON.parse((await w.app.modules.resolveRef(w.db, ref))!.code).stdio.volume;
    execFileSync('docker', ['run', '--rm', '-v', `${approved}:/srv`, '-v', `${pkg.volume}:/new:ro`, 'node:26-alpine', 'cp', '-a', '/new/.', '/srv/'], { stdio: 'ignore' });
    expect(await run('get_url', { url: 'http://x/' })).toMatchObject({ status: 'failed', errorType: 'mcp_tool_changed' });
  }, 180_000);

  it('refuses stdio servers in shared mode', async () => {
    const shared = await makeWorld();
    const s = buildServer(shared.app);
    const res = await s.inject({ method: 'POST', url: '/api/mcp/import', headers: auth(shared.tokens.alice), payload: { transport: 'stdio', package: tgz, name: 'x3', hosts: [] } });
    expect(res.json()).toMatchObject({ error: 'stdio_mcp_local_only' });
    await s.close();
    await shared.db.end();
  });
});

describe('env credentials', () => {
  it('the broker never resolves or sends an env credential', async () => {
    let resolved = false;
    const broker = new Broker({
      manifest: {
        name: 'x', version: '1.0.0', title: 'X', description: 'x', hosts: ['api.example.com'], settings: [], endpoints: [],
        credentials: [{ id: 't', service: 's', label: 'T', hosts: ['api.example.com'], placement: { type: 'env', name: 'T' } }],
        actions: [{ name: 'a', title: 'A', description: 'a', effect: 'read', credentials: ['t'], input: { type: 'object' }, output: { type: 'object' } }],
      },
      action: 'a',
      resolveSecret: async () => {
        resolved = true;
        return 'secret';
      },
      insecureHttpHosts: [],
      internalHosts: [],
      fetchImpl: async () => new Response('ok'),
    });
    const r = await broker.handle({ method: 'GET', url: 'https://api.example.com/', headers: {}, credential: 't', body: null, json: false });
    expect(r).toMatchObject({ ok: false, error: 'credential_placement_unsupported' });
    expect(resolved).toBe(false);
  });
});

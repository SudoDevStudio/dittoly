import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { AppRunner } from '../src/engine/apps.js';
import { LocalBrowserLauncher } from '../src/sandbox/browser.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * App steps build and start a branch's code; a browse step then checks the running app.
 * Here: a local install without Docker, where the admin allowed running code directly.
 * (The git clone is replaced by copying a fixture; the Docker path needs a Docker daemon.)
 */
const CHROMIUM = process.env.DITTOLY_CHROMIUM ?? '/opt/pw-browsers/chromium';
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
let fixture: string;
const clones: { url: string; ref: string; token: string | null }[] = [];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  fixture = path.join(process.env.TMPDIR ?? '/tmp', `dty-fixture-${process.pid}`);
  await mkdir(fixture, { recursive: true });
  await writeFile(
    path.join(fixture, 'server.mjs'),
    `import http from 'node:http';
const version = process.env.APP_TITLE ?? 'Shop';
http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(req.url === '/cart' ? '<title>Cart</title><h1>Your cart is empty</h1>' : '<title>' + version + '</title><a href="/cart">Cart</a>');
}).listen(Number(process.env.PORT), process.env.HOST);`,
  );
  await writeFile(path.join(fixture, 'build.sh'), 'echo built > built.txt\n');
  const apps = new AppRunner({
    mode: 'local',
    internalHosts: ['git.example.com'],
    directAllowed: async () => true,
    dockerAvailable: async () => false,
    clone: async (url, ref, token, dir) => {
      clones.push({ url: url.href, ref, token });
      await cp(fixture, path.join(dir, 'src'), { recursive: true });
      return 'abc123';
    },
  });
  w = await makeWorld({ mode: 'local' }, { apps, ai, browser: new LocalBrowserLauncher(CHROMIUM), runnerAi: () => ai });
  api = buildServer(w.app);
}, 60_000);
afterAll(async () => {
  await w.app.apps.stopAll();
  await api.close();
  await w.db.end();
});

const decide = (d: Record<string, string>) => ({ decision: 'act', action: 'none', role: '', name: '', text: '', value: '', note: '', ...d });

describe('app steps', () => {
  it('build a branch, start it, and let a browse step check it; the app stops when the run ends', async () => {
    const def = {
      inputs: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'] },
      steps: [
        {
          id: 'build',
          type: 'app',
          repo: 'https://git.example.com/acme/shop.git',
          ref: '{{ inputs.branch }}',
          credential: 'gitlab',
          install: 'true',
          build: 'sh build.sh',
          start: 'node server.mjs',
          env: { APP_TITLE: 'Acme Shop' },
          readySeconds: 30,
        },
        { id: 'check', type: 'browse', ai: 'organization', app: 'build', url: '{{ steps.build.output.url }}', checks: [{ check: 'Open the cart', expect: 'empty' }], maxActions: 4 },
      ],
    };
    const v = await w.app.flows.create('Check a branch', def, w.alice);
    const summary = (await w.app.flows.review(v.id)).summary;
    expect(summary).toContain("RUNS THAT BRANCH'S CODE to start the app: install \"true\", build \"sh build.sh\", start \"node server.mjs\"");
    expect(summary).toContain('Pages load only from the app started by step build');
    await w.app.flows.decide(v.id, w.approver, 'approved');
    await w.app.vault.put(w.alice.id, 'gitlab', 'glpat-alice');

    ai.enqueue(decide({ action: 'click', role: 'link', name: 'Cart' }));
    ai.enqueue(decide({ decision: 'pass', note: 'Your cart is empty.' }));
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { branch: 'feature/cart' });
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run.steps.map((s) => [s.id, s.status, s.errorType ?? null])).toEqual([['build', 'succeeded', null], ['check', 'succeeded', null]]);
    expect(clones).toEqual([{ url: 'https://git.example.com/acme/shop.git', ref: 'feature/cart', token: 'glpat-alice' }]);
    const built = run.steps[0]!.output as { url: string; hostKey: string; commit: string; mode: string };
    expect(built).toMatchObject({ commit: 'abc123', mode: 'direct' });
    expect(built.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    // The AI saw the branch's app, with the title from the Flow's settings.
    expect(ai.requests[0]!.prompt).toContain(`CURRENT URL: ${built.url}`);
    expect((run.steps[1]!.output as { passed: boolean }).passed).toBe(true);
    // Stopped with the run.
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(built.url)).rejects.toThrow();
  }, 120_000);

  it('refuses unsafe refs and non-https repositories, and runs nothing without Docker unless the admin allowed it', async () => {
    const off = new AppRunner({ mode: 'local', internalHosts: [], directAllowed: async () => false, dockerAvailable: async () => false });
    expect(await off.modeFor()).toBe('off');
    const step = { id: 'b', type: 'app', image: 'node:26', start: 'x', port: 3000, path: '/', env: {}, readySeconds: 5, timeoutSeconds: 30 } as never;
    await expect(off.start({ runId: 'r', step, repo: 'https://git.example.com/a.git', ref: 'main', token: null, keepAlive: async () => undefined })).rejects.toMatchObject({ code: 'app_needs_docker_or_direct' });
    const on = new AppRunner({ mode: 'local', internalHosts: [], directAllowed: async () => true, dockerAvailable: async () => false, clone: async () => 'x' });
    await expect(on.start({ runId: 'r', step, repo: 'https://g.example.com/a.git', ref: '--upload-pack=evil', token: null, keepAlive: async () => undefined })).rejects.toMatchObject({ code: 'invalid_ref' });
    await expect(on.start({ runId: 'r', step, repo: 'file:///etc', ref: 'main', token: null, keepAlive: async () => undefined })).rejects.toMatchObject({ code: 'invalid_repo_url' });
    await expect(on.start({ runId: 'r', step, repo: 'https://127.0.0.1/a.git', ref: 'main', token: null, keepAlive: async () => undefined })).rejects.toMatchObject({ code: 'repo_private_address' });
    // Only admins choose, and only on a local install.
    expect((await api.inject({ method: 'PUT', url: '/api/settings/app-runner', headers: auth(w.tokens.alice), payload: { directAllowed: true } })).json()).toMatchObject({ error: 'admin_only' });
  });
});

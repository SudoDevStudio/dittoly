import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppBundle } from '../src/export/bundle.js';
import type { AppDefinition, Features, RunningApp, StartOptions } from '../src/export/app-runtime/main.js';
import { checkPlan, defaultPlan, planFlows, uiPlanSchema } from '../src/export/frontend/plan.js';
import { mainSource, runtimeSources } from '../src/export/files.js';
import { createExport, listExports, previewExport, reexport, reviewExport, saveTheme, worstContrast } from '../src/export/service.js';
import { tarGz } from '../src/export/tar.js';
import { contrast, deriveTheme } from '../src/export/theme.js';
import { MockProvider } from '../src/ai/provider.js';
import { frontendFiles } from '../src/export/frontend/templates.js';
import { planExport } from '../src/export/service.js';
import { approveExampleModules, FakeApps, giveAllCredentials, makeWorld, runStatus, type World } from './helpers.js';

/**
 * Export approved Flows as an app: a TypeScript project, all source code, with the Flows as code.
 * Each test unpacks it, compiles it with tsc, and runs what it compiled: settings from the
 * environment, runs in memory or in the store STATE_URL names.
 */

let w: World;
let flowId = '';
/** The approved version the export is built from, so a run here can be compared with a run there. */
let versionId = '';
const tmp = mkdtempSync(path.join(tmpdir(), 'dty-export-'));
const repo = path.resolve(import.meta.dirname, '..');
const STATE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/dittoly_test';

const definition = {
  description: 'Finds issues and asks for a sign-off.',
  inputs: { type: 'object', properties: { jql: { type: 'string', maxLength: 200 } }, required: ['jql'], additionalProperties: false },
  moduleSettings: { jira: { site: 'example.atlassian.net' } },
  steps: [
    { id: 'issues', type: 'action', title: 'Find issues', module: 'jira@1.1.0', action: 'search_issues', input: { jql: '{{ inputs.jql }}' } },
    { id: 'signoff', type: 'approval', title: 'Release manager signs off' },
  ],
};

/** Unpack an export, compile it, and load what it compiled. */
async function build(out: { archive: Buffer; filename: string; bundle: AppBundle }): Promise<{ dir: string; def: AppDefinition; start: (o: Omit<StartOptions, 'root'>) => Promise<RunningApp> }> {
  const into = mkdtempSync(path.join(tmp, 'app-'));
  writeFileSync(path.join(into, out.filename), out.archive);
  execFileSync('tar', ['-xzf', out.filename], { cwd: into });
  const dir = path.join(into, out.bundle.slug);
  // The packages it names, as installed here (the Docker build installs them from npm).
  symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
  execFileSync(path.join(repo, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], { cwd: dir, stdio: 'pipe' });
  const { app } = (await import(path.join(dir, 'dist', 'app.js'))) as { app: AppDefinition };
  // What src/main.ts starts the app with, as compiled.
  const { features } = (await import(path.join(dir, 'dist', 'main.js'))) as { features: Features };
  const { startApp } = (await import(path.join(dir, 'dist', 'runtime', 'main.js'))) as typeof import('../src/export/app-runtime/main.js');
  return { dir, def: app, start: (o) => startApp(app, { ...o, root: dir, features }) };
}

async function clearState() {
  const c = new pg.Client({ connectionString: STATE_URL });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS dty_runs, dty_rows, dty_marks');
  await c.end();
}

async function poll<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  const v = await w.app.flows.create('Release desk', definition, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  flowId = v.flowId;
  versionId = v.id;
});
afterAll(async () => {
  await w.db.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('themes', () => {
  it('text stays readable whatever colour is picked', () => {
    for (const primary of ['#ffff00', '#000000', '#7f7f7f', '#2f6fdf', '#ff4fd8', '#e6f2ff']) {
      const t = deriveTheme({ name: 'x', primary, font: 'system', radius: 'medium' });
      expect(worstContrast(t), primary).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.light.focus, t.light.surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the export', () => {
  it('previews what the app needs from its environment', async () => {
    const p = await previewExport(w.app, w.admin, { name: 'Release desk', kind: 'ui', flows: [{ flowId, access: 'public' }] });
    expect(p.modules).toEqual(['jira@1.1.0']);
    const names = p.env.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['APP_SECRET', 'APP_ADMIN_TOKEN', 'STATE_URL', 'SETTING_JIRA_SITE', 'CRED_JIRA']));
    expect(names).not.toContain('DATABASE_URL');
    expect(p.env.find((v) => v.name === 'SETTING_JIRA_SITE')).toMatchObject({ required: true, example: 'example.atlassian.net' });
    // A sign-off waits, so runs must outlive a restart: a state store is required.
    expect(p.env.find((v) => v.name === 'STATE_URL')!.required).toBe(true);
    expect(p.needs).toEqual({ ai: false, humanSteps: true, state: true });
    // Members cannot export; drafts cannot be exported.
    await expect(previewExport(w.app, w.alice, { name: 'x', kind: 'api', flows: [{ flowId }] })).rejects.toMatchObject({ code: 'export_admin_or_approver' });
    const draft = await w.app.flows.create('Draft only', definition, w.alice);
    await expect(previewExport(w.app, w.admin, { name: 'x', kind: 'api', flows: [{ flowId: draft.flowId }] })).rejects.toMatchObject({ code: 'export_not_possible' });
  });

  it('refuses steps that cannot run outside Dittoly', async () => {
    const handed = await w.app.flows.create('Handed over', { ...definition, steps: [{ ...definition.steps[0], delegateTo: w.bob.id }] }, w.alice);
    await w.app.flows.decide(handed.id, w.approver, 'approved').catch(() => undefined);
    await expect(previewExport(w.app, w.admin, { name: 'x', kind: 'api', flows: [{ flowId: handed.flowId }] })).rejects.toMatchObject({ message: expect.stringMatching(/a teammate|no approved version/) });
  });

  let built: Awaited<ReturnType<typeof build>>;
  let bundle: AppBundle;
  it('is a TypeScript project: the Flows as code, the approved module code, a small runtime, no database and no secrets', async () => {
    const theme = await saveTheme(w.db, w.admin, { name: 'Acme', brand: { name: 'Acme', primary: '#0f766e', font: 'geometric', radius: 'large' } });
    const out = await createExport(w.app, w.admin, { name: 'Release desk', kind: 'ui', flows: [{ flowId, access: 'public' }], themeId: theme.id });
    bundle = out.bundle;
    built = await build(out);
    const files = execFileSync('find', ['.', '-type', 'f', '-not', '-path', './node_modules/*', '-not', '-path', './dist/*'], { cwd: built.dir, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(files.filter((f) => !f.startsWith('./src/runtime/'))).toEqual([
      './.dockerignore', './.env.example', './.gitignore', './Dockerfile', './README.md', './docker-compose.yml', './openapi.json', './package.json',
      './public/app.css', './public/core.js', './public/index.html', './public/main.js', './public/render.js', './public/theme.css',
      './sandbox/modules/jira@1.1.0.mjs', './sandbox/runner.mjs', './src/app.ts', './src/flows/release-desk.ts', './src/main.ts', './tsconfig.json',
    ]);
    // The runtime is source code, the app's own: the engine, the server, the broker, and only what these Flows use
    // (a sign-off: a state store and notices). No compiled files, no database layer, no drivers for other protocols, no AI.
    const runtime = files.filter((f) => f.startsWith('./src/runtime/')).map((f) => f.slice('./src/runtime/'.length)).sort();
    expect(runtime.every((f) => f.endsWith('.ts'))).toBe(true);
    expect(runtime).toEqual(expect.arrayContaining(['engine.ts', 'server.ts', 'broker.ts', 'egress.ts', 'pool.ts', 'flow.ts', 'state.ts', 'store-redis.ts', 'store-postgres.ts', 'notify.ts']));
    for (const absent of ['endpoint-calls.ts', 'protocols.ts', 'databases.ts', 'db-postgres.ts', 'transport-smtp.ts', 'ai.ts', 'ai-step.ts', 'ai-steps.ts', 'schedules.ts', 'google-auth.ts', 'transports.ts', 'report.ts', 'input-steps.ts', 'form.ts', 'table-steps.ts', 'values.ts', 'hooks.ts', 'verify.ts']) expect(runtime).not.toContain(absent);
    expect(runtime.length).toBeLessThan(30);
    for (const f of runtime) expect(readFileSync(path.join(built.dir, 'src', 'runtime', f), 'utf8'), f).not.toMatch(/from '\.\.\/|import\('\.\.\//);
    expect(readFileSync(path.join(built.dir, 'src', 'main.ts'), 'utf8')).toContain("import { notices } from './runtime/notify.js';");
    const pkg = JSON.parse(readFileSync(path.join(built.dir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['ajv', 'nodemailer', 'pg', 're2js', 'redis', 'undici']);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['@types/node', '@types/nodemailer', '@types/pg', 'typescript']);
    for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) expect(v).toMatch(/^\d+\.\d+\.\d+$/);

    // The Flow is code: each step's input an expression of what came before.
    const code = readFileSync(path.join(built.dir, 'src', 'flows', 'release-desk.ts'), 'utf8');
    expect(code).toContain("jql: ref(s, 'inputs.jql')");
    expect(code).toContain("type: 'approval'");
    expect(readFileSync(path.join(built.dir, 'sandbox', 'modules', 'jira@1.1.0.mjs'), 'utf8')).toBe(bundle.modules[0]!.code);
    const env = readFileSync(path.join(built.dir, '.env.example'), 'utf8');
    expect(env).toContain('SETTING_JIRA_SITE=example.atlassian.net');
    expect(env).toMatch(/^CRED_JIRA=$/m);
    expect(env).toMatch(/^STATE_URL=redis:\/\/state:6379$/m);
    expect(readFileSync(path.join(built.dir, 'src', 'app.ts'), 'utf8')).not.toContain('jira-token');
    expect(readFileSync(path.join(built.dir, 'Dockerfile'), 'utf8')).toContain('CMD ["node", "dist/main.js"]');
    expect(readFileSync(path.join(built.dir, 'docker-compose.yml'), 'utf8')).toContain('image: redis:8-alpine');
    const openapi = JSON.parse(readFileSync(path.join(built.dir, 'openapi.json'), 'utf8'));
    expect(openapi.paths['/api/flows/release-desk/runs'].post.requestBody.content['application/json'].schema.properties.inputs).toEqual(definition.inputs);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM app_exports`)).rows[0].n).toBe(1);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'app.exported'`)).rowCount).toBe(1);
  }, 60_000);

  describe('running on its own', () => {
    let s: RunningApp;
    const fake = new FakeApps();
    const sent: { url: string; body: Record<string, string> }[] = [];
    const notifyFetch = (async (url: string, init: RequestInit) => (sent.push({ url, body: JSON.parse(String(init.body)) }), new Response(null, { status: 204 }))) as unknown as typeof fetch;
    const env = {
      APP_SECRET: 'x'.repeat(40),
      APP_ADMIN_TOKEN: 'admin-token-123456',
      APP_API_TOKEN: 'api-token-123456',
      SETTING_JIRA_SITE: 'example.atlassian.net',
      CRED_JIRA: 'app@example.com:jira-token-app',
      PUBLIC_URL: 'http://app.example.com',
      NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/notify',
      STATE_URL,
    };
    const call = (p: string, init: RequestInit = {}, token?: string) =>
      fetch(s.url + p, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string>) } });
    const start = () => built.start({ env, fetchImpl: fake.fetch, notifyFetch, listen: { host: '127.0.0.1', port: 0 } });

    beforeAll(async () => {
      await clearState();
      const credFile = path.join(tmp, 'cred');
      writeFileSync(credFile, env.CRED_JIRA + '\n');
      const { CRED_JIRA: _, ...rest } = env;
      s = await built.start({ env: { ...rest, CRED_JIRA_FILE: credFile }, fetchImpl: fake.fetch, notifyFetch, listen: { host: '127.0.0.1', port: 0 } });
    }, 60_000);
    afterAll(async () => {
      await s?.stop();
      await clearState();
    });

    it('says which settings are missing, by name', async () => {
      await expect(built.start({ env: { APP_SECRET: 'short' } })).rejects.toThrow(/APP_ADMIN_TOKEN is required[\s\S]*STATE_URL is required[\s\S]*SETTING_JIRA_SITE is required[\s\S]*CRED_JIRA is required[\s\S]*APP_SECRET must be at least 32/);
    });

    it('runs a public Flow, waits for a sign-off, and finishes when an admin approves', async () => {
      const info = await (await call('/api/app')).json();
      expect(info).toMatchObject({ name: 'Release desk', kind: 'ui', flows: [{ key: 'release-desk', access: 'public' }] });
      expect(info.plan.pages.map((p: { kind: string }) => p.kind)).toEqual(['form', 'inbox', 'runs']);
      expect(info.theme.brand.name).toBe('Release desk');

      const started = await call('/api/flows/release-desk/runs?wait=20', { method: 'POST', body: JSON.stringify({ inputs: { jql: 'project = REL' } }) });
      expect(started.status).toBe(201);
      const { runId, runToken, run } = await started.json();
      expect(run.status).toBe('waiting');
      expect(run.waiting).toEqual([{ stepId: 'signoff', kind: 'approval', title: 'Release manager signs off' }]);
      expect(run.steps[0].output.issues[0].key).toBe('REL-1');
      // The credential from the environment reached Jira; the module never saw it.
      expect(fake.calls.some((r) => r.url.includes('example.atlassian.net') && r.auth === 'Basic ' + Buffer.from(env.CRED_JIRA).toString('base64'))).toBe(true);
      expect((await call('/api/flows/release-desk/runs', { method: 'POST', body: JSON.stringify({ inputs: {} }) })).status).toBe(400);

      // Only tokens (or the run token) read a run; only the admin token decides.
      expect((await call(`/api/runs/${runId}`)).status).toBe(401);
      expect((await call(`/api/runs/${runId}`, { headers: { 'x-run-token': runToken } })).status).toBe(200);
      expect((await call(`/api/runs/${runId}/steps/signoff/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, env.APP_API_TOKEN)).status).toBe(403);
      const inbox = await (await call('/api/inbox', {}, env.APP_ADMIN_TOKEN)).json();
      expect(inbox.items).toEqual([expect.objectContaining({ runId, stepId: 'signoff', kind: 'approval', flow: 'release-desk' })]);
      expect((await call(`/api/runs/${runId}/steps/signoff/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, env.APP_ADMIN_TOKEN)).status).toBe(204);
      const done = await poll(async () => (await call(`/api/runs/${runId}`, {}, env.APP_API_TOKEN)).json(), (r) => r.status === 'succeeded');
      expect(done.status).toBe('succeeded');
      const runs = await (await call('/api/runs?flow=release-desk', {}, env.APP_API_TOKEN)).json();
      expect(runs.runs[0]).toMatchObject({ id: runId, flow: 'release-desk', status: 'succeeded' });
    });

    it('does what Dittoly does: the same inputs give the same steps and the same outputs', async () => {
      // The point of an export is that the approved Flow keeps working without Dittoly. That is only true if the
      // same inputs, answered the same way, come out the same on both sides; this compares them step by step.
      const inputs = { jql: 'project = FID' };
      // The run inside Dittoly uses the person's own Jira credential; the exported app uses CRED_JIRA.
      await giveAllCredentials(w, w.alice);
      const mine = await w.app.engine.startRun(versionId, w.alice.id, inputs);
      await w.app.worker.drain();
      await w.app.engine.decideGate(mine, 'signoff', w.approver, 'approved');
      await w.app.worker.drain();
      const inside = await runStatus(w, mine, w.alice);

      const started = await call('/api/flows/release-desk/runs?wait=20', { method: 'POST', body: JSON.stringify({ inputs }) });
      const { runId } = await started.json();
      expect((await call(`/api/runs/${runId}/steps/signoff/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, env.APP_ADMIN_TOKEN)).status).toBe(204);
      const outside = await poll(async () => (await call(`/api/runs/${runId}`, {}, env.APP_API_TOKEN)).json(), (r) => r.status === 'succeeded');

      // The same outcome, the same steps in the same order, each ending the same way.
      expect(outside.status).toBe(inside.status);
      expect(outside.steps.map((s: { id: string }) => s.id)).toEqual(inside.steps.map((s) => s.id));
      expect(outside.steps.map((s: { status: string }) => s.status)).toEqual(inside.steps.map((s) => s.status));
      // And the step that talked to the app answered the same thing on both sides.
      const issues = (steps: { id: string; output?: unknown }[]) => steps.find((s) => s.id === 'issues')?.output;
      expect(issues(outside.steps)).toEqual(issues(inside.steps as { id: string; output?: unknown }[]));
    }, 60_000);

    it('announces a waiting step once, with signed links that work only as signed', async () => {
      sent.length = 0;
      const { runId } = await (await call('/api/flows/release-desk/runs?wait=20', { method: 'POST', body: JSON.stringify({ inputs: { jql: 'x' } }) })).json();
      // Sent, then recorded on the run, so a later sweep does not announce it again.
      const notified = await poll(async () => (await s.store.getRun(runId))?.notified ?? [], (n) => n.length > 0);
      expect(notified).toEqual(['signoff']);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ url: env.NOTIFY_WEBHOOK_URL, body: { event: 'step.waiting', runId, stepId: 'signoff', kind: 'approval' } });
      const link = new URL(sent[0]!.body.rejectUrl!);
      expect(link.origin).toBe('http://app.example.com');
      // The link opens a confirmation page; posting it decides. A changed link does nothing.
      expect(await (await call(link.pathname + link.search)).text()).toContain('Reject this step?');
      const form = Object.fromEntries(link.searchParams);
      const bad = await call('/approve', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, decision: 'approved' }).toString() });
      expect(bad.status).toBe(403);
      const ok = await call('/approve', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
      expect(await ok.text()).toContain('Rejected');
      const status = await poll(async () => (await (await call(`/api/runs/${runId}`, {}, env.APP_ADMIN_TOKEN)).json()).status, (x) => x === 'failed');
      expect(status).toBe('failed');
    });

    it('serves the built-in UI with a strict content security policy', async () => {
      const page = await call('/checkout');
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(await page.text()).toContain('<script type="module" src="/main.js">');
      expect(await (await call('/core.js')).text()).toContain('export function createClient');
      expect(await (await call('/theme.css')).text()).toContain('--primary');
      expect((await call('/api/nothing')).status).toBe(404);
      expect((await call('/openapi.json')).status).toBe(200);
      expect(await (await call('/%2e%2e/package.json')).text()).not.toContain('"dependencies"');
    });

    it('a run waiting for a person carries on after a restart', async () => {
      const { runId } = await (await call('/api/flows/release-desk/runs?wait=20', { method: 'POST', body: JSON.stringify({ inputs: { jql: 'after restart' } }) })).json();
      await s.stop();
      s = await start();
      const before = await (await call(`/api/runs/${runId}`, {}, env.APP_ADMIN_TOKEN)).json();
      expect(before).toMatchObject({ status: 'waiting', waiting: [{ stepId: 'signoff' }] });
      expect((await call(`/api/runs/${runId}/steps/signoff/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, env.APP_ADMIN_TOKEN)).status).toBe(204);
      expect((await poll(async () => (await call(`/api/runs/${runId}`, {}, env.APP_ADMIN_TOKEN)).json(), (r) => r.status === 'succeeded')).status).toBe('succeeded');
      // Every run this app has done so far is still listed, this one included, after the restart.
      const listed = (await (await call('/api/runs', {}, env.APP_API_TOKEN)).json()).runs as { id: string }[];
      expect(listed.some((r) => r.id === runId)).toBe(true);
      expect(listed.length).toBe(4);
    }, 60_000);

    it('refuses to start when a module is not the approved code', async () => {
      const file = path.join(built.dir, 'sandbox', 'modules', 'jira@1.1.0.mjs');
      const code = readFileSync(file, 'utf8');
      writeFileSync(file, code + '\n// changed');
      try {
        await expect(built.start({ env, listen: { host: '127.0.0.1', port: 0 } })).rejects.toThrow(/does not match its approved code/);
      } finally {
        writeFileSync(file, code);
      }
    });
  });

  it('a Flow that never waits needs no state store: runs live in memory', async () => {
    const quick = await w.app.flows.create('Quick search', { inputs: definition.inputs, moduleSettings: definition.moduleSettings, steps: [definition.steps[0]] }, w.alice);
    await w.app.flows.decide(quick.id, w.approver, 'approved');
    const out = await createExport(w.app, w.admin, { name: 'Search', kind: 'api', flows: [{ flowId: quick.flowId, access: 'token' }] });
    expect(out.bundle.needs.state).toBe(false);
    const b = await build(out);
    expect(Object.keys(JSON.parse(readFileSync(path.join(b.dir, 'package.json'), 'utf8')).dependencies).sort()).toEqual(['ajv', 're2js', 'undici']);
    expect(readFileSync(path.join(b.dir, 'docker-compose.yml'), 'utf8')).not.toContain('redis');
    expect(readFileSync(path.join(b.dir, 'src', 'main.ts'), 'utf8')).toContain('export const features: Features = {};');
    expect(execFileSync('ls', [path.join(b.dir, 'src', 'runtime')], { encoding: 'utf8' })).not.toMatch(/state|store-|notify/);
    // Nothing to keep across restarts, so there is no store to point it at.
    await expect(b.start({ env: { APP_SECRET: 'q'.repeat(40), APP_API_TOKEN: 'api-token-123456', SETTING_JIRA_SITE: 'example.atlassian.net', CRED_JIRA: 'a@b.c:t', STATE_URL } })).rejects.toThrow(/keeps its runs in memory/);
    const s = await b.start({ env: { APP_SECRET: 'q'.repeat(40), APP_API_TOKEN: 'api-token-123456', SETTING_JIRA_SITE: 'example.atlassian.net', CRED_JIRA: 'a@b.c:t' }, fetchImpl: new FakeApps().fetch, listen: { host: '127.0.0.1', port: 0 } });
    try {
      expect(s.store.kind).toBe('memory');
      const r = await (await fetch(`${s.url}/api/flows/quick-search/runs?wait=20`, { method: 'POST', headers: { authorization: 'Bearer api-token-123456', 'content-type': 'application/json' }, body: '{"inputs":{"jql":"x"}}' })).json();
      expect(r).toMatchObject({ status: 'succeeded', run: { result: { issues: [{ key: 'REL-1' }] } } });
      expect(await (await fetch(`${s.url}/`)).text()).toContain('/openapi.json');
    } finally {
      await s.stop();
    }
  }, 60_000);
});

describe('the runtime source', () => {
  it('imports nothing from the rest of Dittoly, and every combination of its parts compiles on its own', () => {
    // Everything an app could need: each protocol, AI steps, a Google credential, schedules, state, notices.
    const endpoints = ['smtp', 'amqp', 'mqtt', 'websocket', 'sse', 'postgres', 'mysql', 'mssql', 'mongodb'].map((protocol) => ({ protocol }));
    const bundle = {
      needs: { state: true, humanSteps: true, ai: true },
      schedules: [{ flow: 'f', cron: '0 * * * *', timezone: 'UTC' }],
      hooks: [{ flow: 'f' }],
      flows: [{ definition: { steps: [{ type: 'ai' }, { type: 'report' }, { type: 'input' }, { type: 'table' }] } }],
      modules: [{ manifest: { endpoints, credentials: [{ placement: { type: 'google_service_account' } }] } }],
    } as unknown as AppBundle;
    const main = mainSource(bundle);
    expect(main).toContain('db: (policy) => sqlQueries({ postgres, mysql, mssql: sqlServer }, policy)');
    expect(main).toContain('steps: { report: formatReport, input: inputSteps, table: tableStep }');
    const { files } = runtimeSources([main]);
    const dir = mkdtempSync(path.join(tmp, 'runtime-'));
    execFileSync('mkdir', ['-p', path.join(dir, 'src', 'runtime')]);
    for (const f of files) writeFileSync(path.join(dir, f.path), f.content);
    writeFileSync(path.join(dir, 'src', 'main.ts'), main);
    writeFileSync(path.join(dir, 'src', 'app.ts'), "import type { AppDefinition } from './runtime/main.js';\nexport const app = {} as AppDefinition;\n");
    writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }');
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2024', module: 'nodenext', moduleResolution: 'nodenext', strict: true, skipLibCheck: true, noEmit: true, types: ['node'] }, include: ['src'] }));
    symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
    execFileSync(path.join(repo, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], { cwd: dir, stdio: 'pipe' });
    // Dittoly's own wiring (every transport at once) is never part of an app.
    expect(files.map((f) => f.path)).not.toContain('src/runtime/transports.ts');
  }, 60_000);
});

describe('prompt-injection containment', () => {
  it('a step text an AI wrote could steer waits for a sign-off in the exported app too', async () => {
    const v = await w.app.flows.create('Summarise and post', {
      inputs: { type: 'object', properties: { ticket: { type: 'string' } }, required: ['ticket'] },
      steps: [
        { id: 'summary', type: 'ai', ai: 'organization', instruction: 'Summarise the ticket.', input: { ticket: '{{ inputs.ticket }}' } },
        { id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C', text: '{{ steps.summary.output.text }}' } },
      ],
    }, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const out = await createExport(w.app, w.admin, { name: 'Summaries', kind: 'api', flows: [{ flowId: v.flowId, access: 'token' }] });
    expect(out.bundle.flows[0]!.guarded).toEqual(['post']);
    // Someone must be able to sign it off: the app gets the admin token, notices and a state store.
    expect(out.bundle.needs).toMatchObject({ humanSteps: true, state: true });
    const b = await build(out);
    expect(readFileSync(path.join(b.dir, 'src', 'flows', 'summarise-and-post.ts'), 'utf8')).toMatch(/id: 'post',\s+type: 'action',\s+title: null,\s+guard: true/);
  }, 60_000);
});

describe('exporting again', () => {
  it('marks an export when a Flow in it gets a newer approved version, shows what changed, and exports it again', async () => {
    const v1 = await w.app.flows.create('Desk two', { inputs: definition.inputs, moduleSettings: definition.moduleSettings, steps: [definition.steps[0]] }, w.alice);
    await w.app.flows.decide(v1.id, w.approver, 'approved');
    const first = await createExport(w.app, w.admin, { name: 'Desk two', kind: 'api', flows: [{ flowId: v1.flowId, access: 'token' }] });
    const row = async () => (await listExports(w.db, w.admin)).find((e) => e.sha256 === first.bundle.sha256)!;
    expect(await row()).toMatchObject({ reexportable: true, updates: null });
    const id = (await row()).id;
    expect(await reviewExport(w.app, w.admin, id)).toMatchObject({ changed: false, problem: null, flows: [] });

    // Version 2 adds a sign-off: a new step, an admin token and a state store become required.
    const v2 = await w.app.flows.update(v1.flowId, { inputs: definition.inputs, moduleSettings: definition.moduleSettings, steps: definition.steps }, w.alice);
    // Proposed but not approved yet: the approved version is superseded, so it cannot be exported as it was.
    expect((await row()).updates).toBe('pending');
    expect((await reviewExport(w.app, w.admin, id)).problem).toMatch(/no approved version/);
    await w.app.flows.decide(v2.id, w.approver, 'approved');
    expect((await row()).updates).toBe('new');
    const changes = await reviewExport(w.app, w.admin, id);
    expect(changes).toMatchObject({
      changed: true,
      problem: null,
      flows: [{ key: 'desk-two', from: 1, to: 2, added: [{ id: 'signoff', type: 'approval', title: 'Release manager signs off' }], removed: [], changed: [] }],
      modules: { added: [], removed: [] },
      state: true,
    });
    expect(changes.env.added.map((v) => v.name)).toEqual(expect.arrayContaining(['STATE_URL']));
    expect(changes.env.nowRequired).toContain('APP_ADMIN_TOKEN');

    // Exporting again uses the same request with the current versions, and is a new export.
    const second = await reexport(w.app, w.admin, id);
    expect(second.bundle.flows.map((f) => [f.key, f.version])).toEqual([['desk-two', 2]]);
    const fresh = (await listExports(w.db, w.admin)).find((e) => e.sha256 === second.bundle.sha256)!;
    expect(fresh).toMatchObject({ reexportable: true, updates: null });
    expect(await reviewExport(w.app, w.admin, fresh.id)).toMatchObject({ changed: false });

    // Exports made before re-exporting existed are listed but not offered again.
    await w.db.query(`UPDATE app_exports SET request = NULL, snapshot = NULL WHERE id = $1`, [id]);
    expect(await row()).toMatchObject({ reexportable: false, updates: null });
    await expect(reexport(w.app, w.admin, id)).rejects.toMatchObject({ code: 'export_not_reexportable' });
    // Members cannot see or make exports.
    await expect(reviewExport(w.app, w.alice, fresh.id)).rejects.toMatchObject({ code: 'export_admin_or_approver' });
  }, 60_000);
});

describe('Super Flows', () => {
  it('bring the Flows they run, pinned, as code that calls them by name', async () => {
    const parent = await w.app.flows.create('Release train', {
      inputs: { type: 'object', properties: { jql: { type: 'string' } }, required: ['jql'] },
      steps: [{ id: 'desk', type: 'flow', runs: [{ id: 'main', flow: flowId, version: 1, input: { jql: '{{ inputs.jql }}' } }] }],
    }, w.alice);
    await w.app.flows.decide(parent.id, w.approver, 'approved');
    const out = await createExport(w.app, w.admin, { name: 'Train', kind: 'api', flows: [{ flowId: parent.flowId, access: 'token' }] });
    expect(out.bundle.flows.map((f) => [f.key, f.exposed])).toEqual([['release-train', true], ['release-desk', false]]);
    expect(out.bundle.modules.map((m) => m.name)).toEqual(['jira']);
    const b = await build(out);
    expect(readFileSync(path.join(b.dir, 'src', 'flows', 'release-train.ts'), 'utf8')).toContain("flow: 'release-desk'");

    await clearState();
    const env = { APP_SECRET: 'y'.repeat(40), APP_API_TOKEN: 'api-token-123456', APP_ADMIN_TOKEN: 'admin-token-123456', SETTING_JIRA_SITE: 'example.atlassian.net', CRED_JIRA: 'app@example.com:t', STATE_URL };
    const s = await b.start({ env, fetchImpl: new FakeApps().fetch, listen: { host: '127.0.0.1', port: 0 } });
    try {
      const auth = { authorization: `Bearer ${env.APP_API_TOKEN}`, 'content-type': 'application/json' };
      // Only the Super Flow is offered; the Flow it runs is not.
      expect((await fetch(`${s.url}/api/flows/release-desk/runs`, { method: 'POST', headers: auth, body: '{"inputs":{"jql":"x"}}' })).status).toBe(404);
      const { runId } = await (await fetch(`${s.url}/api/flows/release-train/runs?wait=20`, { method: 'POST', headers: auth, body: JSON.stringify({ inputs: { jql: 'project = REL' } }) })).json();
      // The child run waits for its sign-off; approving it lets the Super Flow finish.
      const admin = { authorization: `Bearer ${env.APP_ADMIN_TOKEN}`, 'content-type': 'application/json' };
      const items = await poll(async () => (await (await fetch(`${s.url}/api/inbox`, { headers: admin })).json()).items as { runId: string; stepId: string }[], (x) => x.length > 0);
      expect(items).toEqual([expect.objectContaining({ stepId: 'signoff', flow: 'release-desk' })]);
      expect((await fetch(`${s.url}/api/runs/${items[0]!.runId}/steps/signoff/decision`, { method: 'POST', headers: admin, body: '{"decision":"approved"}' })).status).toBe(204);
      const done = await poll(async () => (await (await fetch(`${s.url}/api/runs/${runId}`, { headers: admin })).json()), (r) => r.status === 'succeeded');
      expect(done.status).toBe('succeeded');
      expect(done.result).toMatchObject({ main: { status: 'succeeded', steps: { issues: { issues: [{ key: 'REL-1' }] } } } });
    } finally {
      await s.stop();
      await clearState();
    }
  }, 120_000);
});

describe('frontends', () => {
  it('the AI plans pages from the Flows (with the layout image), fixing its own mistakes once; without a brief no AI is asked', async () => {
    const ai = new MockProvider();
    const shop = await makeWorld({}, { ai });
    try {
      await approveExampleModules(shop);
      const v = await shop.app.flows.create('Release desk', definition, shop.alice);
      await shop.app.flows.decide(v.id, shop.approver, 'approved');
      const exp = { name: 'Desk', kind: 'custom', framework: 'react', flows: [{ flowId: v.flowId, access: 'public' }] };
      const plain = await planExport(shop.app, shop.admin, { export: exp });
      expect(plain).toMatchObject({ ai: false, plan: { pages: [{ kind: 'form', flow: 'release-desk' }, { kind: 'inbox' }, { kind: 'runs' }] } });
      expect(ai.requests).toHaveLength(0);

      const wrong = { home: 'issues', layout: { nav: 'sidebar-left' }, pages: [{ id: 'issues', kind: 'table', title: 'Issues', path: '/', flow: 'release-desk', inputs: { project: 'REL' }, source: {} }] };
      const right = { home: 'issues', layout: { nav: 'sidebar-left' }, pages: [{ id: 'issues', kind: 'table', title: 'Issues', path: '/', flow: 'release-desk', inputs: { jql: 'project = REL' }, source: { step: 'issues', path: 'issues' }, columns: [{ key: 'key', label: 'Key' }, { key: 'fields.summary', label: 'Summary' }] }, { id: 'inbox', kind: 'inbox', title: 'Sign-offs', path: '/inbox' }] };
      ai.enqueue({ planJson: JSON.stringify(wrong), explanation: 'x' });
      ai.enqueue({ planJson: JSON.stringify(right), explanation: 'A table of issues and a sign-off inbox.' });
      const png = 'data:image/png;base64,' + Buffer.from('fake image').toString('base64');
      const drafted = await planExport(shop.app, shop.admin, { export: exp, brief: 'issues as a table, sidebar on the left', image: png });
      expect(drafted).toMatchObject({ ai: true, explanation: 'A table of issues and a sign-off inbox.', plan: { layout: { nav: 'sidebar-left' } } });
      expect(ai.requests[0]!.images).toEqual([{ mediaType: 'image/png', data: Buffer.from('fake image').toString('base64') }]);
      expect(ai.requests[1]!.prompt).toContain('page issues sets unknown input project');

      // The export carries the plan and a project for the framework, with the theme and the shared core.
      const out = await createExport(shop.app, shop.admin, { ...exp, plan: drafted.plan });
      expect(out.bundle.frontend).toMatchObject({ framework: 'react', plan: drafted.plan });
      const files = frontendFiles(out.bundle).map((f) => f.path);
      expect(files).toEqual(expect.arrayContaining(['package.json', 'src/App.tsx', 'src/dittoly/core.js', 'src/dittoly/core.d.ts', 'src/theme.css', 'src/app.config.json']));
      await expect(createExport(shop.app, shop.admin, { ...exp, plan: wrong })).rejects.toMatchObject({ code: 'invalid_plan' });
    } finally {
      await shop.db.end();
    }
  });

  it('every framework gets a complete project', () => {
    const plan = defaultPlan(planFlows([{ key: 'shop', name: 'Shop', description: '', access: 'public', exposed: true, definition: { inputs: { type: 'object', properties: {} }, steps: [] } }], []));
    const theme = deriveTheme({ name: 'Shop', primary: '#0f766e', font: 'system', radius: 'medium' });
    const need: Record<string, string[]> = {
      react: ['vite.config.ts', 'index.html', 'src/main.tsx'],
      next: ['next.config.mjs', 'app/layout.tsx', 'app/[[...slug]]/page.tsx', 'app/App.tsx'],
      angular: ['angular.json', 'src/main.ts', 'src/app/app.component.ts', 'src/app/app.component.html'],
      astro: ['astro.config.mjs', 'src/pages/[...slug].astro', 'src/dittoly/render.js'],
      vue: ['vite.config.ts', 'src/App.vue', 'src/main.ts'],
    };
    for (const framework of ['react', 'next', 'angular', 'astro', 'vue'] as const) {
      const files = frontendFiles({ name: 'Shop', slug: 'shop', theme, frontend: { framework, plan } } as unknown as AppBundle);
      const paths = files.map((f) => f.path);
      expect(paths, framework).toEqual(expect.arrayContaining(['package.json', 'README.md', ...need[framework]!]));
      const pkg = JSON.parse(String(files.find((f) => f.path === 'package.json')!.content));
      expect(pkg.scripts.build, framework).toBeTruthy();
      // Exact versions only: a rebuild next year installs the same thing.
      for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) expect(v, framework).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('page plans', () => {
  it('the default plan fits the Flows, and a plan naming unknown Flows or fields is refused', () => {
    const flows = planFlows([{ key: 'shop', name: 'Shop', description: '', access: 'public', exposed: true, definition: { inputs: { type: 'object', properties: { q: { type: 'string' } } }, steps: [{ id: 'list', type: 'action' }] } }], []);
    const plan = defaultPlan(flows);
    expect(plan.pages[0]).toMatchObject({ kind: 'table', flow: 'shop' });
    expect(checkPlan(plan, flows)).toEqual([]);
    const bad = uiPlanSchema.parse({ home: 'p', pages: [{ id: 'p', kind: 'cards', title: 'P', path: '/', flow: 'nope', inputs: { x: 1 }, source: { step: 'zzz' } }] });
    expect(checkPlan(bad, flows)).toEqual(['page p uses unknown Flow nope']);
    const bad2 = uiPlanSchema.parse({ home: 'p', pages: [{ id: 'p', kind: 'cards', title: 'P', path: '/', flow: 'shop', inputs: { x: 1 }, source: { step: 'zzz' } }] });
    expect(checkPlan(bad2, flows)).toEqual(['page p reads unknown step zzz', 'page p sets unknown input x']);
  });

  it('tar archives refuse paths that escape', () => {
    expect(() => tarGz([{ path: '../x', content: '' }])).toThrow(/bad path/);
  });
});

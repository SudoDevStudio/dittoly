import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { EndpointCaller, FetchLike } from '../../runtime/broker.js';
import { AppEngine, type AiSteps, type ModuleDef, type StepKinds, type TableDef } from './engine.js';
import { ConfigError, readAppEnv, type AppEnv, type EnvVar } from './env.js';
import type { FlowCode } from './flow.js';
import type { PageLook } from './pages.js';
import { SandboxPool } from './pool.js';
import { buildServer, type ServerApp } from './server.js';
import { MemoryStore, type RunRecord, type Store } from './store.js';
import type { HookDef, ScheduleDef } from './triggers.js';

/**
 * Starts the app: its Flows as code (src/flows), the approved module code (sandbox/modules), and
 * this runtime. Configured entirely by environment variables; state only where a Flow needs it.
 */

export interface AppDefinition {
  format: 'dittoly.app/2';
  name: string;
  slug: string;
  kind: ServerApp['kind'];
  /** sha256 of the approved content it was generated from. */
  sha256: string;
  dittolyVersion: string;
  theme: unknown;
  plan: unknown;
  humanSteps: boolean;
  /** A Flow waits for a person, waits a while or uses a table: runs must outlive a restart. */
  needsState: boolean;
  look: PageLook;
  env: EnvVar[];
  schedules: ScheduleDef[];
  hooks: HookDef[];
  tables: TableDef[];
  modules: ModuleDef[];
  flows: FlowCode[];
}

export interface RunningApp {
  url: string;
  engine: AppEngine;
  store: Store;
  env: AppEnv;
  stop(): Promise<void>;
}

/** Announces steps that wait for a person (notify.ts). */
export interface Notices {
  waiting(runId: string, stepId: string): Promise<boolean>;
  sweep(runs: RunRecord[]): Promise<void>;
}

/** The parts only some apps need. src/main.ts passes the ones this app uses. */
export interface Features {
  /** Flows that wait for people: announce it (notify.ts). */
  notices?: (
    env: AppEnv,
    app: { name: string; flowName: (key: string) => string; stepTitle: (flow: string, step: string) => string },
    store: Store,
    markNotified: (runId: string, stepId: string) => Promise<void>,
    fetchImpl?: typeof fetch,
  ) => Notices;
  /** Report, input and table steps (report.ts, input-steps.ts, table-steps.ts). */
  steps?: StepKinds;
  /** Webhooks (hooks.ts). */
  receiveHook?: (
    hook: HookDef,
    secret: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
    d: { engine: AppEngine; store: Store; limited: (key: string, max: number) => boolean },
  ) => Promise<{ status: number; body: Record<string, unknown>; runId?: string }>;
  /** Flows that run on a schedule (schedules.ts). */
  schedules?: (list: ScheduleDef[], d: { engine: AppEngine; store: Store; onError: (flow: string) => void }) => Promise<() => void>;
  /** Runs that wait are kept in the store STATE_URL names (state.ts). */
  openStore?: (url: string, secret: string) => Promise<Store>;
  /** AI steps (ai-steps.ts). */
  aiSteps?: (env: AppEnv) => Promise<AiSteps>;
  /** Modules with SMTP, message, WebSocket, SSE or database endpoints (endpoint-calls.ts). */
  calls?: EndpointCaller;
  /** Modules with a Google service account credential (google-auth.ts). */
  googleToken?: (secret: string, scopes: readonly string[]) => Promise<string>;
}

export interface StartOptions {
  /** The app's folder: sandbox/, public/ and openapi.json. */
  root: string;
  features?: Features;
  env?: NodeJS.ProcessEnv;
  listen?: { host: string; port: number };
  /** Test hooks. */
  fetchImpl?: FetchLike;
  notifyFetch?: typeof fetch;
  retry?: { autoRetries: number; backoffMs: number };
}

export async function startApp(def: AppDefinition, o: StartOptions): Promise<RunningApp> {
  const env = readAppEnv(o.env ?? process.env, { slug: def.slug, env: def.env, needsState: def.needsState });
  const sandboxDir = path.join(o.root, 'sandbox');
  // The module code must be exactly what was approved.
  for (const m of def.modules) {
    const code = readFileSync(path.join(sandboxDir, m.file));
    if (createHash('sha256').update(code).digest('hex') !== m.codeSha256) throw new ConfigError(`module ${m.ref} does not match its approved code (sandbox/${m.file} was changed)`);
  }
  const f = o.features ?? {};
  if (env.stateUrl && !f.openStore) throw new ConfigError('STATE_URL is set, but this app keeps its runs in memory: none of its Flows waits, so there is nothing to keep across a restart.');
  const store = env.stateUrl && f.openStore ? await f.openStore(env.stateUrl, env.secret) : new MemoryStore();
  const pool = new SandboxPool({ sandboxDir, runner: path.join(sandboxDir, 'runner.mjs'), perModule: env.workers });
  pool.warm(def.modules.map((m) => m.file));
  const flows = new Map(def.flows.map((f) => [f.key, f]));
  let notifier: Notices | null = null;
  const engine = new AppEngine({
    flows,
    modules: new Map(def.modules.map((m) => [m.ref, m])),
    tables: new Map(def.tables.map((t) => [t.name, t])),
    store,
    sandbox: pool,
    settings: env.settings,
    credentials: env.credentials,
    ...(f.aiSteps ? { aiSteps: await f.aiSteps(env) } : {}),
    ...(f.steps ? { steps: f.steps } : {}),
    ...(f.calls ? { calls: f.calls } : {}),
    ...(f.googleToken ? { googleToken: f.googleToken } : {}),
    insecureHttpHosts: env.insecureHttpHosts,
    internalHosts: env.internalHosts,
    retentionDays: env.retentionDays,
    onWaiting: (run, stepId) => void notifier?.waiting(run.id, stepId).catch(() => false),
    ...(o.retry ? { retry: o.retry } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  notifier =
    f.notices?.(
      env,
      {
        name: def.name,
        flowName: (key) => flows.get(key)?.name ?? 'A Flow',
        stepTitle: (flow, step) => flows.get(flow)?.steps.find((s) => s.id === step)?.title ?? step,
      },
      store,
      (runId, stepId) => engine.markNotified(runId, stepId),
      o.notifyFetch,
    ) ?? null;
  const server = buildServer({
    app: { name: def.name, kind: def.kind, theme: def.theme, plan: def.plan, humanSteps: def.humanSteps, look: def.look, hooks: def.hooks },
    flows,
    engine,
    store,
    env,
    webDir: path.join(o.root, 'public'),
    openapi: JSON.parse(readFileSync(path.join(o.root, 'openapi.json'), 'utf8')),
    ...(f.receiveHook ? { receiveHook: f.receiveHook } : {}),
  });
  const listen = o.listen ?? { host: '0.0.0.0', port: env.port };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  await engine.resume();
  // Runs sealed with another APP_SECRET cannot be read: say so, once, instead of failing.
  if (store.unreadable) process.stderr.write(`${store.unreadable} stored run(s) could not be read with this APP_SECRET and are skipped.\n`);
  const stopSchedules = env.disableSchedules || !f.schedules ? () => undefined : await f.schedules(def.schedules, { engine, store, onError: () => undefined });
  const tick = setInterval(() => {
    void store.sweep(new Date()).catch(() => 0);
    if (notifier) void store.activeRuns().then((runs) => notifier!.sweep(runs)).catch(() => undefined);
  }, 60_000);
  tick.unref();
  return {
    url: `http://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`,
    engine,
    store,
    env,
    async stop() {
      clearInterval(tick);
      stopSchedules();
      engine.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      pool.close();
      await store.close();
    },
  };
}

/** The entry point (src/main.ts calls this). */
export async function runApp(def: AppDefinition, root: string, features: Features = {}): Promise<void> {
  try {
    const app = await startApp(def, { root, features });
    process.stdout.write(`${def.name} is running at ${app.env.publicUrl} (listening on ${app.url}).\n`);
    const shutdown = async () => {
      await app.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    process.stderr.write(err instanceof ConfigError ? `${err.message}\n` : `The app could not start (${(err as Error).message}).\n`);
    process.exit(1);
  }
}

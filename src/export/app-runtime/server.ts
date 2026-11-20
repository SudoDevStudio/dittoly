import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { EngineError, type AppEngine } from './engine.js';
import { deriveKey, same, sign, type AppEnv } from './env.js';
import type { FlowCode } from './flow.js';
import { linkPage, type PageLook } from './pages.js';
import type { RunRecord, Store } from './store.js';
import type { Features } from './main.js';
import type { HookDef } from './triggers.js';

/**
 * The exported app's HTTP surface, on node:http with no framework. It serves only the app's
 * Flows, their runs and the steps that wait for people, with three kinds of access:
 * - APP_ADMIN_TOKEN: everything, including decisions and the inbox;
 * - APP_API_TOKEN: start any exposed Flow, read runs;
 * - none: start public Flows (rate limited); the run token returned then lets the same caller read
 *   that run and answer its forms.
 * Everything else is the app's web files (built-in UI, generated frontend or an info page).
 */

export interface ServerApp {
  name: string;
  kind: 'runner' | 'api' | 'ui' | 'custom';
  theme: unknown;
  plan: unknown;
  humanSteps: boolean;
  look: PageLook;
  hooks: HookDef[];
}

type Access = 'admin' | 'api' | null;
const MAX_WAIT_S = 30;
const MAX_BODY = 2_000_000;
const RUN_ID = /^[0-9a-f-]{36}$/;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function buildServer(o: {
  app: ServerApp;
  flows: Map<string, FlowCode>;
  engine: AppEngine;
  store: Store;
  env: AppEnv;
  /** The app's web files: index.html and the rest. */
  webDir: string;
  openapi: unknown;
  /** Webhook deliveries (hooks.ts), for apps with webhooks. */
  receiveHook?: Features['receiveHook'];
}): Server {
  const { app, flows, engine, store, env, receiveHook } = o;
  const linkKey = deriveKey(env.secret, 'links');
  const runKey = deriveKey(env.secret, 'run-tokens');
  const runToken = (runId: string) => sign(runKey, runId).slice(0, 32);
  const exposed = new Map([...flows.values()].filter((f) => f.exposed).map((f) => [f.key, f]));
  const hooks = new Map(app.hooks.map((h) => [h.flow, h]));

  const hits = new Map<string, number[]>();
  const limited = (key: string, max: number) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) hits.clear();
    return list.length > max;
  };

  const access = (req: IncomingMessage): Access => {
    const h = req.headers.authorization;
    const token = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) return null;
    if (env.adminToken && same(token, env.adminToken)) return 'admin';
    if (env.apiToken && same(token, env.apiToken)) return 'api';
    return null;
  };
  const runAccess = (req: IncomingMessage, url: URL, runId: string): Access | 'owner' => {
    const a = access(req);
    if (a) return a;
    const t = req.headers['x-run-token'] ?? url.searchParams.get('runToken') ?? undefined;
    return typeof t === 'string' && same(t, runToken(runId)) ? 'owner' : null;
  };

  /** A run as the app shows it: step results, what it waits for, and the last result. */
  const summary = (run: RunRecord) => {
    const defs = engine.flow(run).steps;
    const steps = run.steps.map((s, i) => ({ id: s.id, type: defs[i]?.type, title: defs[i]?.title ?? null, status: s.status, errorType: s.errorType, output: s.output }));
    const waiting = run.steps
      .map((s, i) => ({ s, def: defs[i] }))
      .filter(({ s, def }) => s.status === 'waiting' && (def?.type === 'approval' || def?.type === 'input' || s.errorType === 'awaiting_sign_off'))
      .map(({ s, def }) => ({ stepId: s.id, kind: def!.type === 'input' ? 'input' : 'approval', title: def!.title, form: def!.type === 'input' ? engine.inputView(run, s.id) : undefined, signOff: s.errorType === 'awaiting_sign_off' ? s.signOff : undefined }));
    const result = [...run.steps].reverse().find((s) => s.status === 'succeeded' && s.output !== undefined && s.output !== null)?.output ?? null;
    return { id: run.id, flow: run.flow, status: run.status, waitReason: run.waitReason, createdAt: run.createdAt, finishedAt: run.finishedAt, steps, waiting, result };
  };

  const send = (res: ServerResponse, status: number, body?: unknown, type = 'application/json') => {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    const data = type === 'application/json' ? JSON.stringify(body) : (body as string | Buffer);
    res.writeHead(status, { 'content-type': type }).end(data);
  };
  const deny = (res: ServerResponse, code = 401) => send(res, code, { error: code === 401 ? 'unauthorized' : 'forbidden' });

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'payload_too_large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  const json = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const raw = await readBody(req);
    if (!raw.length) return {};
    try {
      const v = JSON.parse(raw.toString('utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      throw new HttpError(400, 'bad_request');
    }
  };

  // Signed links from notifications: a page with a button (link scanners only GET), then the decision.
  const linkOk = (q: Record<string, string | undefined>) => {
    const { run, step, decision, exp, sig } = q;
    if (!run || !step || (decision !== 'approved' && decision !== 'rejected') || !exp || !sig) return false;
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
    return same(sig, sign(linkKey, `${run}.${step}.${decision}.${exp}`));
  };

  // The web files.
  const root = path.resolve(o.webDir);
  const file = (p: string) => {
    const full = path.resolve(root, '.' + p);
    return full.startsWith(root + path.sep) && existsSync(full) && statSync(full).isFile() ? full : null;
  };
  const csp = app.kind === 'ui' ? "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'" : null;
  const openapiBody = JSON.stringify(o.openapi);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://app');
    const p = url.pathname;
    const m = req.method ?? 'GET';
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    const origin = req.headers.origin;
    if (origin && env.corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-run-token');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (m === 'OPTIONS') return send(res, 204);
    }

    if (p === '/health') return send(res, 200, { ok: true });
    if (p === '/openapi.json') return send(res, 200, openapiBody, 'application/json');

    if (p === '/api/app' && m === 'GET') {
      return send(res, 200, {
        name: app.name,
        kind: app.kind,
        theme: app.theme,
        plan: app.plan,
        humanSteps: app.humanSteps,
        flows: [...exposed.values()].map((f) => ({ key: f.key, name: f.name, description: f.description, access: f.access, inputs: f.inputs, form: f.form })),
      });
    }

    let mm = /^\/api\/flows\/([^/]+)\/runs$/.exec(p);
    if (mm && m === 'POST') {
      const f = exposed.get(decodeURIComponent(mm[1]!));
      if (!f) return send(res, 404, { error: 'not_found' });
      const a = access(req);
      if (f.access === 'token' && !a) return deny(res);
      if (!a && (limited(`${req.socket.remoteAddress}:${f.key}`, 30) || limited('public', 600))) return send(res, 429, { error: 'too_many_runs' });
      const body = await json(req);
      const run = await engine.start(f.key, body.inputs ?? {});
      const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));
      const settled = (wait ? await engine.settle(run.id, wait * 1000) : null) ?? (await store.getRun(run.id)) ?? run;
      return send(res, 201, { runId: run.id, status: settled.status, runToken: runToken(run.id), run: summary(settled) });
    }

    if (p === '/api/runs' && m === 'GET') {
      if (!access(req)) return deny(res);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
      const flow = url.searchParams.get('flow') ?? undefined;
      if (flow && !flows.has(flow)) return send(res, 200, { runs: [] });
      const runs = await store.listRuns({ ...(flow ? { flow } : {}), limit });
      return send(res, 200, { runs: runs.map((r) => ({ id: r.id, flow: r.flow, status: r.status, waitReason: r.waitReason, createdAt: r.createdAt, finishedAt: r.finishedAt })) });
    }

    mm = /^\/api\/runs\/([^/]+)$/.exec(p);
    if (mm && m === 'GET') {
      const id = mm[1]!;
      if (!RUN_ID.test(id) || !runAccess(req, url, id)) return deny(res);
      const run = await store.getRun(id);
      return run ? send(res, 200, summary(run)) : send(res, 404, { error: 'not_found' });
    }

    mm = /^\/api\/runs\/([^/]+)\/steps\/([^/]+)\/decision$/.exec(p);
    if (mm && m === 'POST') {
      const a = access(req);
      if (a !== 'admin') return deny(res, a ? 403 : 401);
      const body = await json(req);
      const d = body.decision;
      if (d !== 'approved' && d !== 'rejected') return send(res, 400, { error: 'invalid_decision' });
      const sha = body.valuesSha256;
      if (sha !== undefined && (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha))) return send(res, 400, { error: 'invalid_values_sha256' });
      await engine.decide(mm[1]!, decodeURIComponent(mm[2]!), d, sha);
      return send(res, 204);
    }

    mm = /^\/api\/runs\/([^/]+)\/steps\/([^/]+)\/input$/.exec(p);
    if (mm && m === 'POST') {
      const a = RUN_ID.test(mm[1]!) ? runAccess(req, url, mm[1]!) : null;
      if (a !== 'admin' && a !== 'owner') return deny(res, a ? 403 : 401);
      await engine.submitInput(mm[1]!, decodeURIComponent(mm[2]!), (await json(req)).values ?? {});
      return send(res, 204);
    }

    if (p === '/api/inbox' && m === 'GET') {
      const a = access(req);
      if (a !== 'admin') return deny(res, a ? 403 : 401);
      const runs = (await store.activeRuns())
        .filter((r) => r.status === 'waiting' && (r.waitReason === 'approval' || r.waitReason === 'input_needed'))
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
        .slice(0, 100);
      const items = runs.flatMap((r) => {
        const s = summary(r);
        return s.waiting.map((w) => ({ runId: s.id, flow: s.flow, createdAt: s.createdAt, ...w }));
      });
      return send(res, 200, { items });
    }

    if (p === '/approve') {
      const html = 'text/html; charset=utf-8';
      if (m === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        return send(res, 200, linkPage(app.look, linkOk(q) ? q : null), html);
      }
      if (m === 'POST') {
        const q = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
        if (!linkOk(q)) return send(res, 403, linkPage(app.look, null), html);
        await engine.decide(q.run!, q.step!, q.decision as 'approved' | 'rejected');
        return send(res, 200, linkPage(app.look, q, true), html);
      }
    }

    mm = /^\/hooks\/([^/]+)$/.exec(p);
    if (mm && m === 'POST') {
      const flow = decodeURIComponent(mm[1]!);
      const hook = hooks.get(flow);
      if (!hook || !receiveHook) return send(res, 404, { error: 'not_found' });
      const r = await receiveHook(hook, env.hookSecrets[flow], req.headers, await readBody(req), { engine, store, limited });
      return send(res, r.status, r.runId ? { runId: r.runId, runToken: runToken(r.runId) } : r.body);
    }

    if (m !== 'GET' || p.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
    let decoded: string;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      return send(res, 400, { error: 'bad_request' });
    }
    // A file, a route's own index.html (static exports), or the app shell (single-page apps).
    const hit = file(decoded) ?? file(path.posix.join(decoded, 'index.html')) ?? file(`${decoded.replace(/\/$/, '')}.html`) ?? file('/index.html');
    if (!hit) return send(res, 404, { error: 'not_found' });
    if (csp && hit.endsWith('.html')) res.setHeader('content-security-policy', csp);
    return send(res, 200, readFileSync(hit), TYPES[path.extname(hit)] ?? 'application/octet-stream');
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.code });
      if (err instanceof EngineError) return send(res, err.status, { error: err.code, ...(err.detail ? { detail: err.detail } : {}) });
      send(res, 500, { error: 'internal_error' });
    });
  });
}

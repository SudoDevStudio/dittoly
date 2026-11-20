import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { z } from 'zod';
import { log } from '../core/log.js';
import type { AppRunner, AppStartOptions, Workspace, WorkspaceOptions } from '../engine/apps.js';
import { FIX_GIT_COMMANDS, Refused } from '../engine/workspace-files.js';
import { StepError } from '../runtime/ai-step.js';

/**
 * The code runner (docs/code-runner.md): app and fix steps of a Dittoly server, on another machine. It has no
 * database and none of Dittoly's files: each call brings what the step needs (the repository, the token that
 * clones it, the phase destinations and secrets), and a step's clone, containers, networks, token and secrets go
 * when it ends. Builds, tests and apps run in the same Docker sandboxes as on a Dittoly server (src/engine/apps.ts).
 *
 * Every call needs the shared token (DITTOLY_RUNNER_TOKEN); an app's tunnel needs that app's own token, which
 * opens only the way to that app. At most `slots` steps build and test at once: more get 503 sandbox_busy, and
 * Dittoly's run waits its turn, as for its own slots.
 */

/** A workspace nobody used for this long is closed (its step's lease ran out long before). */
const IDLE_MS = 45 * 60_000;
const MAX_WORKSPACE_MS = 6 * 60 * 60_000;
const MAX_BODY = 40 * 1024 * 1024;
const MAX_TUNNELS_PER_APP = 64;

export interface RunnerServerOptions {
  token: string;
  apps: AppRunner;
  /** How many steps build and test at once. */
  slots: number;
  tls?: { cert: string; key: string } | undefined;
}

interface OpenWorkspace {
  ws: Workspace;
  runId: string;
  opened: number;
  lastUsed: number;
}

interface OpenApp {
  runId: string;
  hostKey: string;
  tokenHash: Buffer;
  tunnels: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const sameSecret = (given: string, expected: Buffer) => timingSafeEqual(sha(given), expected);

const workspaceBody = z.object({
  runId: z.string().min(1).max(200),
  repo: z.string().min(1).max(2000),
  ref: z.string().min(1).max(200),
  token: z.string().max(10_000).nullable(),
  image: z.string().min(1).max(500),
  env: z.record(z.string(), z.string()),
  secrets: z.record(z.string(), z.string()),
  network: z.unknown().optional(),
});
const appBody = z.object({
  runId: z.string().min(1).max(200),
  step: z.object({ id: z.string(), port: z.number().int().min(1).max(65535) }).passthrough(),
  repo: z.string().min(1).max(2000),
  ref: z.string().min(1).max(200),
  token: z.string().max(10_000).nullable(),
  secrets: z.record(z.string(), z.string()).optional(),
  network: z.unknown().optional(),
});
const pathBody = z.object({ path: z.string().max(1000) });
const PHASES = ['install', 'build', 'test'] as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}

export class RunnerServer {
  readonly server: http.Server;
  private readonly tokenHash: Buffer;
  private readonly workspaces = new Map<string, OpenWorkspace>();
  private readonly apps = new Map<string, OpenApp>();
  /** Steps building or testing now: open workspaces and apps being started. */
  private busy = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly o: RunnerServerOptions) {
    this.tokenHash = sha(o.token);
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handle(req, res);
    this.server = o.tls ? https.createServer({ cert: o.tls.cert, key: o.tls.key }, handler) : http.createServer(handler);
    this.server.on('upgrade', (req, socket, head) => this.tunnel(req, socket as net.Socket, head));
    // No request limit of its own: a command runs as long as its step allows.
    this.server.requestTimeout = 0;
    this.timer = setInterval(() => void this.expire(), 60_000);
    this.timer.unref();
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  /** Closes every workspace and stops every app (shutting down). */
  async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.workspaces.keys()].map((id) => this.closeWorkspace(id)));
    await this.o.apps.stopAll();
    this.apps.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
  }

  // ---------------------------------------------------------------- requests

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      const data = Buffer.from(JSON.stringify(body ?? {}));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(data.length), 'cache-control': 'no-store' });
      res.end(data);
    };
    try {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), this.tokenHash)) throw new HttpError(401, { error: 'unauthorized' });
      const body = await readBody(req);
      // Dittoly stopped waiting (its step's lease ran out): what this call opened is undone, not left running.
      let gone = false;
      res.on('close', () => {
        if (!res.writableFinished) gone = true;
      });
      reply(200, await this.route(req.method ?? 'GET', new URL(req.url ?? '/', 'http://runner').pathname, body, () => gone));
    } catch (err) {
      if (err instanceof HttpError) return reply(err.status, err.body);
      if (err instanceof Refused) return reply(422, { refused: err.message });
      if (err instanceof StepError) return reply(err.code === 'sandbox_busy' ? 503 : 422, { error: err.code, ...((err as { logTail?: string }).logTail ? { logTail: (err as { logTail?: string }).logTail } : {}) });
      if (err instanceof z.ZodError) return reply(400, { error: 'invalid_request' });
      log.error('runner_request_failed', { errorType: (err as { code?: string }).code ?? (err as Error).name });
      reply(500, { error: 'runner_failed' });
    }
  }

  private async route(method: string, p: string, body: unknown, gone: () => boolean = () => false): Promise<unknown> {
    if (method === 'GET' && p === '/v1/health') return { ok: true, mode: await this.o.apps.modeFor(), slots: this.o.slots, busy: this.busy };
    if (method === 'POST' && p === '/v1/workspaces') return this.openWorkspace(workspaceBody.parse(body) as Omit<WorkspaceOptions, 'keepAlive'>, gone);
    if (method === 'POST' && p === '/v1/apps') return this.startApp(appBody.parse(body) as unknown as Omit<AppStartOptions, 'keepAlive'>, gone);
    let m = /^\/v1\/apps\/([^/]+)$/.exec(p);
    if (m && method === 'DELETE') return this.stopApp(decodeURIComponent(m[1]!));
    m = /^\/v1\/workspaces\/([^/]+)(?:\/(exec|list|read|write|resolve|git|network))?$/.exec(p);
    if (!m) throw new HttpError(404, { error: 'not_found' });
    const id = decodeURIComponent(m[1]!);
    if (method === 'DELETE' && !m[2]) {
      await this.closeWorkspace(id);
      return {};
    }
    const open = this.workspaces.get(id);
    if (!open || method !== 'POST' || !m[2]) throw new HttpError(404, { error: 'workspace_not_found' });
    open.lastUsed = Date.now();
    const { ws } = open;
    switch (m[2]) {
      case 'exec': {
        const b = z.object({ cmd: z.string().min(1).max(10_000), phase: z.enum(PHASES), timeoutMs: z.number().int().min(1000).max(24 * 3_600_000) }).parse(body);
        const r = await ws.exec(b.cmd, { phase: b.phase, timeoutMs: b.timeoutMs });
        open.lastUsed = Date.now();
        return r;
      }
      case 'list':
        return { text: await ws.files.list(pathBody.parse(body).path) };
      case 'read': {
        const b = pathBody.extend({ max: z.number().int().min(0).max(25_000_000) }).parse(body);
        const r = await ws.files.read(b.path, b.max);
        return { data: r.data.toString('base64'), size: r.size };
      }
      case 'write': {
        const b = pathBody.extend({ content: z.string().nullable() }).parse(body);
        return { path: await ws.files.write(b.path, b.content === null ? null : Buffer.from(b.content, 'base64')) };
      }
      case 'resolve':
        return ws.files.resolve(pathBody.parse(body).path);
      case 'git': {
        const b = z.object({ args: z.array(z.string().max(10_000)).min(1).max(1000), max: z.number().int().min(1).max(25_000_000) }).parse(body);
        if (!(FIX_GIT_COMMANDS as readonly string[]).includes(b.args[0]!)) throw new HttpError(400, { error: 'git_command_not_allowed' });
        const r = await ws.files.git(b.args, b.max);
        return { code: r.code, out: r.out.toString('base64') };
      }
      case 'network':
        return ws.network();
    }
    throw new HttpError(404, { error: 'not_found' });
  }

  // ---------------------------------------------------------------- workspaces and apps

  private take(): void {
    if (this.busy >= this.o.slots) throw new StepError('sandbox_busy', true);
    this.busy++;
  }

  private async openWorkspace(opts: Omit<WorkspaceOptions, 'keepAlive'>, gone: () => boolean): Promise<unknown> {
    this.take();
    let ws: Workspace;
    try {
      ws = await this.o.apps.workspace({ ...opts, keepAlive: async () => undefined });
    } catch (err) {
      this.busy--;
      throw err;
    }
    // From here the slot is the workspace's: closing it frees the slot.
    const id = randomUUID();
    this.workspaces.set(id, { ws, runId: opts.runId, opened: Date.now(), lastUsed: Date.now() });
    if (gone()) {
      await this.closeWorkspace(id);
      throw new HttpError(499, { error: 'caller_gone' });
    }
    log.info('runner_workspace_opened', { runId: opts.runId });
    return { id, commit: ws.commit, mode: ws.mode };
  }

  private async closeWorkspace(id: string): Promise<void> {
    const open = this.workspaces.get(id);
    if (!open) return;
    this.workspaces.delete(id);
    this.busy--;
    await open.ws.close().catch(() => undefined);
  }

  private async startApp(opts: Omit<AppStartOptions, 'keepAlive'>, gone: () => boolean): Promise<unknown> {
    // Only the install and build count against the slots: a running app does not.
    this.take();
    let started;
    try {
      started = await this.o.apps.start({ ...opts, keepAlive: async () => undefined });
    } finally {
      this.busy--;
    }
    if (gone()) {
      await this.o.apps.stopApp(opts.runId, started.hostKey);
      throw new HttpError(499, { error: 'caller_gone' });
    }
    const id = randomUUID();
    const tunnelToken = randomBytes(32).toString('base64url');
    this.apps.set(id, { runId: opts.runId, hostKey: started.hostKey, tokenHash: sha(tunnelToken), tunnels: 0 });
    return { id, ...started, port: opts.step.port, tunnelToken };
  }

  private async stopApp(id: string): Promise<unknown> {
    const app = this.apps.get(id);
    if (app) {
      this.apps.delete(id);
      await this.o.apps.stopApp(app.runId, app.hostKey);
    }
    return {};
  }

  /** Workspaces left behind (Dittoly lost the step, or the machine running it) are closed; stopped apps forgotten. */
  private async expire(now = Date.now()): Promise<void> {
    for (const [id, w] of this.workspaces) {
      if (now - w.lastUsed > IDLE_MS || now - w.opened > MAX_WORKSPACE_MS) {
        log.info('runner_workspace_expired', { runId: w.runId });
        await this.closeWorkspace(id);
      }
    }
    for (const [id, a] of this.apps) if (!this.o.apps.isRunning(a.runId, a.hostKey)) this.apps.delete(id);
  }

  // ---------------------------------------------------------------- tunnels

  /** GET /v1/apps/:id/tunnel with Upgrade: dittoly-tcp and the app's own token: a raw TCP stream to the app. */
  private tunnel(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const m = /^\/v1\/apps\/([^/]+)\/tunnel$/.exec(new URL(req.url ?? '/', 'http://runner').pathname);
    const app = m ? this.apps.get(decodeURIComponent(m[1]!)) : undefined;
    const auth = req.headers.authorization ?? '';
    if (!app || req.headers.upgrade?.toLowerCase() !== 'dittoly-tcp') return refuse(404);
    if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), app.tokenHash)) return refuse(401);
    const target = this.o.apps.find(app.runId, app.hostKey)?.target;
    if (!target) return refuse(410);
    if (app.tunnels >= MAX_TUNNELS_PER_APP) return refuse(429);
    app.tunnels++;
    const upstream = net.connect(target.port, target.host);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      app.tunnels--;
      socket.destroy();
      upstream.destroy();
    };
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dittoly-tcp\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => {
      if (!socket.writableEnded && !done && upstream.connecting) refuse(502);
      end();
    });
    upstream.on('close', end);
    socket.on('error', end);
    socket.on('close', end);
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, { error: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (!size) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, { error: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

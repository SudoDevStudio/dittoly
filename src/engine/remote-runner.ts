import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { promisify } from 'node:util';
import { containerEngine } from '../sandbox/engine.js';
import { log } from '../core/log.js';
import { APP_RELAY_SCRIPT } from '../paths.js';
import { EGRESS_NETWORK, shareAppNetwork, StdioSandbox, unshareAppNetwork } from '../mcp/stdio.js';
import { ownerLabels } from '../sandbox/owner.js';
import { StepError } from '../runtime/ai-step.js';
import type { AppMode, AppStartOptions, AppStarted, CodeRunner, NetworkReport, Workspace, WorkspaceOptions } from './apps.js';
import { Refused, type WorkspaceFiles } from './workspace-files.js';

/**
 * App and fix steps on a code runner machine (DITTOLY_CODE_RUNNER=remote; the runner is src/runner/server.ts, see
 * docs/code-runner.md). Dittoly keeps the AI, the Flow, the credentials and the database; the runner clones the
 * repository with the step's token for that one step, builds, tests and runs it in its own Docker sandboxes, with the
 * same per-phase egress, and forgets the token and the secrets with the step.
 *
 * A fix step's workspace is the same interface as on this machine: each command, file read or write and git call is
 * one HTTPS call. An app step's app keeps running on the runner; this run's browser reaches it through a relay here
 * (a container on a network only the browser's proxy joins, or this machine's loopback address when the browser runs
 * without Docker) that carries each connection to the runner through a tunnel only that app's token opens.
 */

const runFile = promisify(execFile);
/** A call's own limit beyond the command it waits for; and how often a long call keeps its step's lease. */
const CALL_SLACK_MS = 60_000;
const KEEP_ALIVE_MS = 30_000;
/** Cloning, installing and building: as long as any step may take (its own timeout applies on the runner). */
const LONG_CALL_MS = 3 * 60 * 60_000;

export interface RemoteRunnerOptions {
  url: string;
  token: string;
  /** PEM of the CA that signed the runner's certificate, when it is not publicly trusted. */
  ca?: string | undefined;
  caFile?: string | undefined;
  /** How this machine's browser runs: docker (relay container) or process (relay on loopback). */
  browser: 'docker' | 'process';
  /** Test hook: runs one docker command (arguments only). */
  docker?: (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
}

interface RemoteApp {
  runId: string;
  id: string;
  hostKey: string;
  stop: () => Promise<void>;
}

class RunnerError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; refused?: string; logTail?: string },
  ) {
    super(body.error ?? body.refused ?? `runner_${status}`);
  }
}

export class RemoteCodeRunner implements CodeRunner {
  private readonly running = new Map<string, RemoteApp[]>();
  private readonly ca: string | undefined;
  private readonly proxies = new StdioSandbox();

  constructor(private readonly o: RemoteRunnerOptions) {
    this.ca = o.ca ?? (o.caFile ? readFileSync(o.caFile, 'utf8') : undefined);
  }

  // ---------------------------------------------------------------- calls

  /** One JSON call to the runner; a long one keeps its step's lease meanwhile and stops when the lease is lost. */
  private async call<T>(method: string, path: string, body: unknown, o: { timeoutMs: number; keepAlive?: () => Promise<void> } = { timeoutMs: CALL_SLACK_MS }): Promise<T> {
    const u = new URL(path, this.o.url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let fail: (err: unknown) => void = () => undefined;
    const request = new Promise<T>((resolve, reject) => {
      const req = lib.request(
        u,
        {
          method,
          headers: { authorization: `Bearer ${this.o.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
          ...(this.ca ? { ca: this.ca } : {}),
          timeout: o.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => {
            let parsed: unknown = {};
            try {
              parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
            } catch {
              return reject(new StepError('runner_bad_answer'));
            }
            if ((res.statusCode ?? 500) >= 400) return reject(new RunnerError(res.statusCode ?? 500, parsed as RunnerError['body']));
            resolve(parsed as T);
          });
          res.on('error', () => reject(new StepError('runner_unreachable', true)));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => reject(err instanceof StepError || err instanceof RunnerError ? err : new StepError('runner_unreachable', true)));
      fail = (err) => {
        req.destroy();
        reject(err);
      };
      req.end(payload);
    });
    if (!o.keepAlive) return request.catch(rethrow);
    const timer = setInterval(() => o.keepAlive!().catch(fail), KEEP_ALIVE_MS);
    try {
      return await request.catch(rethrow);
    } finally {
      clearInterval(timer);
    }
  }

  // ---------------------------------------------------------------- CodeRunner

  async dockerAvailable(): Promise<boolean> {
    return this.o.docker ? this.o.docker(['info']).then(() => true, () => false) : this.proxies.available();
  }

  async modeFor(): Promise<AppMode> {
    try {
      return (await this.call<{ mode: AppMode }>('GET', '/v1/health', undefined, { timeoutMs: 10_000 })).mode;
    } catch {
      return 'off';
    }
  }

  async workspace(a: WorkspaceOptions): Promise<Workspace> {
    await a.keepAlive();
    const { keepAlive, ...opts } = a;
    const w = await this.call<{ id: string; commit: string; mode: 'docker' | 'direct' }>('POST', '/v1/workspaces', opts, { timeoutMs: LONG_CALL_MS, keepAlive });
    const at = `/v1/workspaces/${encodeURIComponent(w.id)}`;
    const short = { timeoutMs: CALL_SLACK_MS };
    const files: WorkspaceFiles = {
      list: async (rel) => (await this.call<{ text: string }>('POST', `${at}/list`, { path: rel }, short)).text,
      read: async (rel, max) => {
        const r = await this.call<{ data: string; size: number }>('POST', `${at}/read`, { path: rel, max }, short);
        return { data: Buffer.from(r.data, 'base64'), size: r.size };
      },
      write: async (rel, content) => (await this.call<{ path: string }>('POST', `${at}/write`, { path: rel, content: content === null ? null : content.toString('base64') }, short)).path,
      resolve: (rel) => this.call<{ path: string; isFile: boolean }>('POST', `${at}/resolve`, { path: rel }, short),
      git: async (args, max) => {
        const r = await this.call<{ code: number | null; out: string }>('POST', `${at}/git`, { args, max }, { timeoutMs: 5 * 60_000 });
        return { code: r.code, out: Buffer.from(r.out, 'base64') };
      },
    };
    return {
      mode: w.mode,
      commit: w.commit,
      files,
      exec: async (cmd, o) => {
        await keepAlive();
        return this.call<{ code: number | null; output: string }>('POST', `${at}/exec`, { cmd, phase: o.phase, timeoutMs: o.timeoutMs }, { timeoutMs: o.timeoutMs + CALL_SLACK_MS, keepAlive });
      },
      network: () => this.call<NetworkReport>('POST', `${at}/network`, {}, short),
      close: () => this.call('DELETE', at, undefined, short).then(() => undefined, () => undefined),
    };
  }

  async start(a: AppStartOptions): Promise<AppStarted> {
    await a.keepAlive();
    const { keepAlive, ...opts } = a;
    const r = await this.call<AppStarted & { id: string; port: number; tunnelToken: string }>('POST', '/v1/apps', opts, { timeoutMs: LONG_CALL_MS, keepAlive });
    const stopRemote = () => this.call('DELETE', `/v1/apps/${encodeURIComponent(r.id)}`, undefined, { timeoutMs: CALL_SLACK_MS }).then(() => undefined, () => undefined);
    const tunnelUrl = new URL(`/v1/apps/${encodeURIComponent(r.id)}/tunnel`, this.o.url).toString();
    let relay: { url: string; hostKey: string; stop: () => Promise<void> };
    try {
      relay = this.o.browser === 'docker' ? await this.dockerRelay(r.url, r.hostKey, r.port, tunnelUrl, r.tunnelToken) : await this.loopbackRelay(r.url, tunnelUrl, r.tunnelToken);
    } catch (err) {
      await stopRemote();
      throw err;
    }
    const app: RemoteApp = {
      runId: a.runId,
      id: r.id,
      hostKey: relay.hostKey,
      stop: async () => {
        await relay.stop().catch(() => undefined);
        await stopRemote();
      },
    };
    this.running.set(a.runId, [...(this.running.get(a.runId) ?? []), app]);
    return { url: relay.url, hostKey: relay.hostKey, commit: r.commit, mode: r.mode, logTail: r.logTail, network: r.network };
  }

  isRunning(runId: string, hostKey: string): boolean {
    return (this.running.get(runId) ?? []).some((a) => a.hostKey === hostKey);
  }

  async stopRun(runId: string): Promise<void> {
    const list = this.running.get(runId) ?? [];
    this.running.delete(runId);
    await Promise.all(list.map((a) => a.stop().catch(() => undefined)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stopRun(id)));
  }

  // ---------------------------------------------------------------- relays

  /** The browser without Docker: a relay on this machine's loopback address; the app is at 127.0.0.1:<port>. */
  private async loopbackRelay(appUrl: string, tunnelUrl: string, token: string): Promise<{ url: string; hostKey: string; stop: () => Promise<void> }> {
    const server = net.createServer((client) => {
      client.pause();
      openTunnel(tunnelUrl, token, this.ca).then(
        (upstream) => {
          const end = () => {
            client.destroy();
            upstream.destroy();
          };
          client.on('error', end).on('close', end);
          upstream.on('error', end).on('close', end);
          client.pipe(upstream).pipe(client);
          client.resume();
        },
        () => client.destroy(),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as net.AddressInfo).port;
    const u = new URL(appUrl);
    return {
      url: `http://127.0.0.1:${port}${u.pathname}${u.search}`,
      hostKey: `127.0.0.1:${port}`,
      stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  /**
   * The browser in Docker: a relay container with the app's name on a new internal network (the browser's proxy
   * joins it, as it joins a local app's network), and on the egress network to reach the runner.
   */
  private async dockerRelay(appUrl: string, hostKey: string, port: number, tunnelUrl: string, token: string): Promise<{ url: string; hostKey: string; stop: () => Promise<void> }> {
    const docker = this.o.docker ?? (async (args: string[], env?: NodeJS.ProcessEnv) => (await runFile(await containerEngine(), args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(env ?? {}) }, timeout: 120_000 })).stdout);
    const name = new URL(appUrl).hostname;
    const relay = `dty-relay-${randomUUID().slice(0, 12)}`;
    const network = await this.proxies.createNetwork();
    let started = false;
    const stop = async () => {
      unshareAppNetwork(hostKey);
      if (started) await docker(['rm', '-f', relay]).catch(() => undefined);
      await this.proxies.removeNetwork(network);
    };
    try {
      if (!(await docker(['network', 'ls', '--filter', `name=^${EGRESS_NETWORK}$`, '--format', '{{.Name}}'])).trim()) await docker(['network', 'create', EGRESS_NETWORK]).catch(() => undefined);
      // The token goes by name only: its value is in docker's environment, never on its command line.
      await docker(
        [
          'run', '-d', '--rm', ...ownerLabels(), '--name', relay, '--network', EGRESS_NETWORK,
          '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--pids-limit', '64', '--memory', '64m',
          '-e', `DTY_PORT=${port}`, '-e', `DTY_TUNNEL_URL=${tunnelUrl}`, '-e', 'DTY_RELAY_TOKEN',
          '-v', `${APP_RELAY_SCRIPT}:/relay.mjs:ro`,
          ...(this.o.caFile ? ['-v', `${this.o.caFile}:/runner-ca.pem:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/runner-ca.pem'] : []),
          this.proxies.image, 'node', '/relay.mjs',
        ],
        { DTY_RELAY_TOKEN: token },
      );
      started = true;
      await docker(['network', 'connect', '--alias', name, network, relay]);
      for (let i = 0; i < 50; i++) {
        if ((await docker(['logs', relay]).catch(() => '')).includes('"ready":true')) {
          shareAppNetwork(hostKey, network);
          return { url: appUrl, hostKey, stop };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new StepError('app_relay_failed');
    } catch (err) {
      log.warn('app_relay_failed', { errorType: err instanceof StepError ? err.code : 'docker' });
      await stop();
      throw err instanceof StepError ? err : new StepError('app_relay_failed');
    }
  }
}

/** A runner's answer as the step sees it: a refused path stays a refusal (the AI sees it), anything else a step error. */
function rethrow(err: unknown): never {
  if (err instanceof RunnerError) {
    if (err.body.refused) throw new Refused(err.body.refused);
    if (err.status === 401 || err.status === 403) throw new StepError('runner_unauthorized');
    const e = new StepError(err.body.error ?? 'runner_failed', err.status === 503);
    if (err.body.logTail) Object.assign(e, { logTail: err.body.logTail });
    throw e;
  }
  throw err;
}

/** One tunnel to an app on the runner (the same protocol as sandbox-runtime/app-relay.mjs). */
export function openTunnel(tunnelUrl: string, token: string, ca?: string): Promise<net.Socket> {
  const u = new URL(tunnelUrl);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, connection: 'Upgrade', upgrade: 'dittoly-tcp' },
      ...(ca ? { ca } : {}),
      timeout: 15_000,
    });
    req.on('upgrade', (_res, socket, head) => {
      socket.setTimeout(0);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`tunnel_refused_${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('tunnel_timeout')));
    req.on('error', reject);
    req.end();
  });
}

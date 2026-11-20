import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { readLines } from './lines.js';
import { createRequire } from 'node:module';
import { AppError } from '../core/errors.js';
import { BROWSER_DRIVER_SCRIPT, EGRESS_PROXY_SCRIPT } from '../paths.js';
import { appNetworksFor, StdioSandbox } from '../mcp/stdio.js';
import { containerEngine } from './engine.js';
import { ownerLabels } from './owner.js';

/**
 * Headless browsers for browser scripts (modules with a "browser" section).
 *
 * The module's script never gets the browser: it sends plain-data operations
 * through the sandbox protocol, the broker checks them, and a browser driver
 * (sandbox-runtime/browser-driver.mjs) carries them out. The driver lets pages
 * load only the declared hosts, and all browser traffic also goes through the
 * Dittoly egress proxy, which refuses other hosts and private addresses.
 *
 * - local: the driver and the proxy are child processes on this machine, using
 *   an installed Chromium;
 * - docker (shared servers): the driver runs in the Playwright image on an
 *   internal network of its own session (no route out), its only way out the
 *   session's proxy container.
 */

export interface CannedPage {
  urlPrefix: string;
  status?: number;
  contentType?: string;
  body?: string;
}

export interface BrowserSessionOptions {
  /** Hosts pages may load: host[:port] or "*.example.com", settings already filled in. */
  hosts: string[];
  /** host[:port] keys that may be loaded over plain http (DITTOLY_INSECURE_HTTP_HOSTS). */
  plainHttp: readonly string[];
  /** host:port keys allowed to resolve to private addresses (DITTOLY_INTERNAL_HOSTS). */
  allowPrivate: readonly string[];
  /** Sandbox tests: answer every request from these pages; no network at all. */
  canned?: CannedPage[];
  /** The module may also load any public https page (GET only). */
  publicRead?: boolean;
}

export interface DriverReply {
  ok: boolean;
  result?: unknown;
  error?: string;
  retryable?: boolean;
  /** Hosts the page tried to reach and was refused, so far. */
  blocked?: string[];
}

/** One screencast frame: a JPEG, base64, and the page it shows. */
export interface LiveFrame {
  data: string;
  width: number;
  height: number;
  url: string;
}

export interface BrowserSession {
  send(op: Record<string, unknown>): Promise<DriverReply>;
  /** Screencast frames, while one is running (op "live.start"). */
  onFrame(listener: ((f: LiveFrame) => void) | null): void;
  readonly closed: boolean;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  readonly backend: 'local' | 'docker';
  start(o: BrowserSessionOptions): Promise<BrowserSession>;
}

const OP_TIMEOUT_MS = 45_000;

/** The proxy's allow list: host:port pairs (or "*.domain:port"); https by default, http only where allowed. */
export function proxyAllowList(o: Pick<BrowserSessionOptions, 'hosts' | 'plainHttp' | 'publicRead'>): string[] {
  const out = new Set<string>();
  // Any public host over https; the driver lets only GET and HEAD through to undeclared hosts.
  if (o.publicRead) out.add('*:443');
  for (const raw of o.hosts) {
    // A browse step's "*.example.com" means any subdomain; the proxy writes that "**.example.com" ("*." is one label there).
    const h = raw.startsWith('*.') ? `*${raw}` : raw;
    if (/:\d+$/.test(h)) out.add(h);
    else {
      out.add(`${h}:443`);
      if (o.plainHttp.includes(raw) || o.plainHttp.includes(`${raw}:80`)) out.add(`${h}:80`);
    }
  }
  return [...out];
}

/** The proxy's private-address list: allowed host:port pairs whose host:port, or bare host, is an internal host. */
export function privateAllowList(allow: readonly string[], internal: readonly string[]): string[] {
  const keys = new Set(internal.map((h) => h.toLowerCase()));
  return allow.filter((h) => keys.has(h.toLowerCase()) || keys.has(h.slice(0, h.lastIndexOf(':')).toLowerCase()));
}

/** `docker run` arguments of a browser driver: its session's network (or none, for canned pages), no capabilities, read-only. */
export function browserRunArgs(o: { name: string; image: string; network: string | null; driverScript: string; playwrightDir: string }): string[] {
  return [
    'run', '--rm', '-i', ...ownerLabels(), '--name', o.name,
    '--network', o.network ?? 'none',
    '--read-only', '--tmpfs', '/tmp:rw,size=256m', '--shm-size', '256m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '1g', '--cpus', '1',
    '--user', 'pwuser', '--env', 'HOME=/tmp',
    '-v', `${o.driverScript}:/driver/browser-driver.mjs:ro`,
    '-v', `${o.playwrightDir}:/driver/node_modules/playwright-core:ro`,
    o.image, 'node', '/driver/browser-driver.mjs',
  ];
}

/** Speaks the driver's newline-delimited JSON protocol over a child's stdin/stdout. */
class DriverProcess implements BrowserSession {
  private next = 1;
  private readonly pending = new Map<number, (r: DriverReply) => void>();
  private readyWait: ((ok: boolean) => void) | null = null;
  closed = false;
  private frameListener: ((f: LiveFrame) => void) | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly cleanup: () => Promise<void>,
  ) {
    // stderr may contain page text; it is drained and discarded.
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    // Frames are screenshots, so lines can be large; a driver flooding output is stopped and closed.
    readLines(child.stdout, 32_000_000, (line) => {
      let msg: DriverReply & { id?: number; type?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'ready') this.readyWait?.(true);
      else if (msg.type === 'frame') this.frameListener?.(msg as unknown as LiveFrame);
      else if (typeof msg.id === 'number') {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve?.(msg);
      }
    }, () => child.kill('SIGKILL'));
    child.on('close', () => {
      this.closed = true;
      this.readyWait?.(false);
      for (const resolve of this.pending.values()) resolve({ ok: false, error: 'browser_exited', retryable: true });
      this.pending.clear();
    });
    child.on('error', () => this.readyWait?.(false));
  }

  init(config: Record<string, unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000);
      this.readyWait = (ok) => {
        clearTimeout(timer);
        this.readyWait = null;
        resolve(ok);
      };
      this.child.stdin.write(JSON.stringify({ type: 'init', ...config }) + '\n');
    });
  }

  onFrame(listener: ((f: LiveFrame) => void) | null): void {
    this.frameListener = listener;
  }

  send(op: Record<string, unknown>): Promise<DriverReply> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'browser_exited', retryable: true });
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'browser_timeout', retryable: true });
      }, OP_TIMEOUT_MS);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.child.stdin.write(JSON.stringify({ ...op, id }) + '\n');
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.child.stdin.write(JSON.stringify({ type: 'close' }) + '\n');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.child.kill('SIGKILL');
          resolve();
        }, 5_000);
        this.child.once('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    await this.cleanup();
  }
}

/** Where playwright-core is installed, for running the driver (it must match the browser it drives). */
function playwrightCoreDir(): string {
  return path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
}

/** The Playwright image whose browsers match the playwright-core this server runs. */
export function defaultBrowserImage(): string {
  const version = (createRequire(import.meta.url)('playwright-core/package.json') as { version: string }).version;
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

export function createBrowserLauncher(config: { sandbox: 'process' | 'docker'; browserImage?: string | undefined; browserPath?: string | undefined; internalHosts: readonly string[] }): BrowserLauncher {
  return config.sandbox === 'docker'
    ? new DockerBrowserLauncher(config.browserImage ?? defaultBrowserImage(), { allowPrivate: config.internalHosts })
    : new LocalBrowserLauncher(config.browserPath);
}

/** Local install and development: Chromium on this machine, a local egress proxy process. */
export class LocalBrowserLauncher implements BrowserLauncher {
  readonly backend = 'local' as const;
  constructor(private readonly executablePath?: string) {}

  private async startProxy(o: BrowserSessionOptions): Promise<{ url: string; stop: () => Promise<void> }> {
    const allow = proxyAllowList(o);
    const child = spawn(process.execPath, [EGRESS_PROXY_SCRIPT], {
      env: { DTY_ALLOW: allow.join(','), DTY_ALLOW_PRIVATE: privateAllowList(allow, o.allowPrivate).join(','), DTY_PORT: '0', DTY_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const port = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        try {
          const m = JSON.parse(line) as { ready?: boolean; port?: number };
          if (m.ready && m.port) {
            clearTimeout(timer);
            resolve(m.port);
          }
        } catch {
          // decision lines
        }
      });
      child.on('close', () => resolve(null));
    });
    const stop = async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    };
    if (!port) {
      await stop();
      throw new AppError('browser_proxy_failed', 502);
    }
    return { url: `http://127.0.0.1:${port}`, stop };
  }

  async start(o: BrowserSessionOptions): Promise<BrowserSession> {
    const proxy = o.canned ? null : await this.startProxy(o);
    const child = spawn(process.execPath, [BROWSER_DRIVER_SCRIPT], {
      cwd: path.dirname(BROWSER_DRIVER_SCRIPT),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), HOME: process.env.HOME ?? '/tmp' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = new DriverProcess(child, async () => {
      await proxy?.stop();
    });
    const ok = await session.init({
      hosts: o.hosts,
      plainHttp: o.plainHttp,
      proxy: proxy?.url ?? null,
      executablePath: this.executablePath ?? null,
      canned: o.canned ?? null,
      publicRead: o.publicRead === true,
    });
    if (!ok) {
      await session.close();
      throw new AppError('browser_start_failed', 502);
    }
    return session;
  }
}

/**
 * Shared servers: the driver runs in the Playwright image with the same
 * playwright-core this server uses (mounted read-only, so versions match), on
 * an internal network of its own session with no route out except that session's egress proxy.
 * Sandbox tests run with no network at all.
 */
export class DockerBrowserLauncher implements BrowserLauncher {
  readonly backend = 'docker' as const;
  private readonly proxies: StdioSandbox;

  constructor(
    private readonly image: string,
    opts: { proxyImage?: string; allowPrivate?: readonly string[]; proxies?: StdioSandbox; spawn?: typeof spawn } = {},
  ) {
    this.proxies = opts.proxies ?? new StdioSandbox({ image: opts.proxyImage, allowPrivate: opts.allowPrivate });
    this.spawn = opts.spawn ?? spawn;
  }

  private readonly spawn: typeof spawn;

  async start(o: BrowserSessionOptions): Promise<BrowserSession> {
    // The session's proxy also joins the network of any running app the page may load (an app step's).
    const proxy = o.canned ? null : await this.proxies.startProxy(proxyAllowList(o), { join: appNetworksFor(o.hosts), allowPrivate: o.allowPrivate });
    const name = `dty-browser-${randomUUID().slice(0, 12)}`;
    const child = this.spawn(await containerEngine(), browserRunArgs({ name, image: this.image, network: proxy?.network ?? null, driverScript: BROWSER_DRIVER_SCRIPT, playwrightDir: playwrightCoreDir() }), {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const session = new DriverProcess(child, async () => {
      // The driver must be gone before its network can be removed.
      const engine = await containerEngine();
      await new Promise<void>((resolve) => {
        const rm = this.spawn(engine, ['rm', '-f', name], { stdio: 'ignore' });
        rm.on('error', () => resolve());
        rm.on('close', () => resolve());
      });
      await proxy?.stop();
    });
    const ok = await session.init({ hosts: o.hosts, plainHttp: o.plainHttp, proxy: proxy?.url ?? null, executablePath: null, canned: o.canned ?? null, publicRead: o.publicRead === true });
    if (!ok) {
      await session.close();
      throw new AppError('browser_start_failed', 502);
    }
    return session;
  }
}

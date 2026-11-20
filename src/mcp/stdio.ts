import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AppError } from '../core/errors.js';
import { log } from '../core/log.js';
import { containerEngine, isolationOptional, networkCreateArgs } from '../sandbox/engine.js';
import { EGRESS_PROXY_SCRIPT } from '../paths.js';
import { ownerLabels } from '../sandbox/owner.js';

/**
 * Sandbox for local (stdio) MCP servers, local install only.
 *
 * A stdio MCP server is a program, so unlike a module its own network calls do
 * not pass through the broker. Instead each call runs it in a container on a
 * Docker internal network of its own (one per session, removed when it ends), which
 * has no route out and no other sandbox on it. Its only way out is a
 * Dittoly egress proxy container (sandbox-runtime/egress-proxy.mjs) that
 * forwards only to the hosts approved in the manifest and refuses private
 * addresses. The container has a read-only filesystem, no capabilities, runs
 * as an unprivileged user, and has PID and memory limits.
 *
 * The npm package is installed once, at import, into a Docker volume, with
 * install scripts disabled; runs mount that volume read-only. The member's
 * token is given to the server as an environment variable: unlike modules, the
 * server does see the secret (the review page says so), and the proxy limits
 * where it can send it.
 */

const run = promisify(execFile);
/** Prefix of the internal networks, one per sandbox session (proxy and workload only). */
export const SANDBOX_NETWORK_PREFIX = 'dty-sbx-';
/** The proxy's side: a normal (routed) user-defined network. */
export const EGRESS_NETWORK = 'dittoly-mcp-egress';

/** One session's egress proxy and the internal network it shares with that session's containers only. */
export interface SessionProxy {
  url: string;
  /** The session's internal network: run the session's containers with --network <this>. */
  network: string;
  /** Remove the proxy and the network. */
  stop: () => Promise<void>;
  /** With TCP forwards: the proxy's address on the session network (containers map each forwarded host to it). */
  address?: string;
  /** What it refused so far: host:port and why (not_allowed, unresolved, private_address). Read before stop. */
  refusals?: () => Promise<{ host: string; reason: string }[]>;
}

/** A plain TCP forward the proxy listens for (on the destination's own port) and connects to host:port. */
export interface TcpForward {
  host: string;
  port: number;
}

/**
 * Networks of running apps, by the host:port Dittoly's browser reaches them at. A browser
 * session that may load such a host has its proxy joined to that app's network, and to no other.
 */
const appNetworks = new Map<string, string>();
export function shareAppNetwork(hostKey: string, network: string): void {
  appNetworks.set(hostKey.toLowerCase(), network);
}
export function unshareAppNetwork(hostKey: string): void {
  appNetworks.delete(hostKey.toLowerCase());
}
export function appNetworksFor(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map((h) => appNetworks.get(h.toLowerCase())).filter((n): n is string => !!n))];
}

/** `docker run` arguments of a session's egress proxy (on the routed network; joined to the session's network after). */
export function proxyRunArgs(o: { name: string; image: string; allow: readonly string[]; allowPrivate: readonly string[]; tcp?: readonly TcpForward[] }): string[] {
  return [
    'run', '-d', '--rm', ...ownerLabels(), '--name', o.name, '--network', EGRESS_NETWORK,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--pids-limit', '64', '--memory', '128m',
    '-e', `DTY_ALLOW=${o.allow.join(',')}`, '-e', `DTY_ALLOW_PRIVATE=${o.allowPrivate.join(',')}`,
    ...(o.tcp?.length ? ['-e', `DTY_TCP=${o.tcp.map((t) => `${t.port}=${t.host}:${t.port}`).join(',')}`] : []),
    '-v', `${EGRESS_PROXY_SCRIPT}:/proxy.mjs:ro`,
    o.image, 'node', '/proxy.mjs',
  ];
}

/** `docker run` arguments of one stdio MCP server session. The secret is passed by name only (its value is in the environment). */
export function serverRunArgs(o: { name: string; network: string; proxyUrl: string; server: StdioServer; withSecret: boolean }): string[] {
  return [
    'run', '--rm', '-i', ...ownerLabels(), '--name', o.name, '--network', o.network,
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '1000:1000', '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
    '-v', `${o.server.volume}:/srv:ro`,
    '-e', `HTTPS_PROXY=${o.proxyUrl}`, '-e', `HTTP_PROXY=${o.proxyUrl}`, '-e', `https_proxy=${o.proxyUrl}`, '-e', `http_proxy=${o.proxyUrl}`,
    '-e', 'NODE_USE_ENV_PROXY=1', '-e', 'NO_PROXY=',
    ...(o.server.credentialEnv && o.withSecret ? ['-e', o.server.credentialEnv] : []),
    o.server.image, 'node', o.server.entry,
  ];
}
const NPM_REGISTRY = 'registry.npmjs.org:443';

export interface InstalledPackage {
  volume: string;
  name: string;
  version: string;
  integrity: string | null;
  /** Path of the server's entry point inside the volume. */
  entry: string;
}

export interface StdioServer {
  image: string;
  volume: string;
  entry: string;
  /** host:port pairs the server may reach. */
  allow: string[];
  /** Environment variable that receives the member's token, if any. */
  credentialEnv: string | null;
}

/** Docker's bridge option that leaves the network's bridge without a host address (see createNetwork). */
export const ISOLATED_GATEWAY = 'com.docker.network.bridge.gateway_mode_ipv4=isolated';
let warnedNotIsolated = false;

export class StdioSandbox {
  constructor(
    private readonly opts: {
      image?: string;
      /** host:port pairs allowed on private addresses (DITTOLY_INTERNAL_HOSTS). */
      allowPrivate?: readonly string[];
      /** Test hook: runs one docker command (arguments only) instead of the docker CLI. */
      docker?: (args: string[]) => Promise<string>;
    } = {},
  ) {}

  get image(): string {
    return this.opts.image ?? 'node:26-alpine';
  }

  private async docker(args: string[], env?: NodeJS.ProcessEnv, timeout = 120_000, quiet = false): Promise<string> {
    if (this.opts.docker) return this.opts.docker(args);
    try {
      const { stdout } = await run(await containerEngine(), args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(env ?? {}) }, timeout, maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { code?: string; stderr?: string };
      if (e.code === 'ENOENT') throw new AppError('stdio_mcp_needs_docker', 409);
      // Docker's own messages can name files or images, so only the subcommand is logged. Simply asking whether
      // Docker is there says nothing is wrong, so it does not warn: a personal install needs none.
      if (!quiet) log.warn('stdio_mcp_docker_failed', { action: args[0] ?? 'unknown' });
      if (process.env.DITTOLY_DEBUG_DOCKER) process.stderr.write(`${String(e.stderr ?? '')}\n`);
      throw new AppError('stdio_mcp_docker_failed', 502);
    }
  }

  async available(): Promise<boolean> {
    return this.docker(['info', '--format', '{{.ServerVersion}}'], undefined, 15_000, true).then(
      () => true,
      () => false,
    );
  }

  private async ensureEgressNetwork(): Promise<void> {
    const exists = await this.docker(['network', 'ls', '--filter', `name=^${EGRESS_NETWORK}$`, '--format', '{{.Name}}']);
    if (!exists.trim()) await this.docker(['network', 'create', EGRESS_NETWORK]).catch(() => undefined);
  }

  /**
   * A new internal network (no route out) for one session; remove it with removeNetwork once its containers are gone.
   * An internal network's bridge still has an address on the host, through which its containers reach every port
   * the host listens on (Dittoly itself, a database published on all interfaces): with the isolated gateway mode
   * (Docker 28 and later) the bridge has none, and the containers reach only each other. An older Docker refuses
   * the option: the network is made without it, and a warning says the host is reachable.
   */
  async createNetwork(): Promise<string> {
    const network = `${SANDBOX_NETWORK_PREFIX}${randomUUID().slice(0, 12)}`;
    const engine = await containerEngine();
    try {
      await this.docker(networkCreateArgs(engine, network, ownerLabels()));
    } catch (err) {
      // Podman's internal networks have no gateway address to begin with: a failure there is a real one.
      if (!isolationOptional(engine)) throw err;
      if (!warnedNotIsolated) log.warn('sandbox_network_not_isolated', { errorType: 'docker_before_28' });
      warnedNotIsolated = true;
      await this.docker(networkCreateArgs(engine, network, ownerLabels(), false));
    }
    return network;
  }

  async removeNetwork(network: string): Promise<void> {
    await this.docker(['network', 'rm', network], undefined, 30_000).catch(() => undefined);
  }

  /**
   * Start an egress proxy for one session on a new internal network of its own; returns its address
   * there, the network, and a stop function that removes both. `network`: use this session network
   * instead (made with createNetwork; the caller removes it). `join`: further networks the proxy is
   * attached to (a running app's, so this session's browser can reach it). `allowPrivate`: this
   * session's internal hosts, in addition to the sandbox's own.
   */
  async startProxy(allow: string[], o: { network?: string; join?: readonly string[]; allowPrivate?: readonly string[]; tcp?: readonly TcpForward[] } = {}): Promise<SessionProxy> {
    await this.ensureEgressNetwork();
    const network = o.network ?? (await this.createNetwork());
    const name = `dty-proxy-${randomUUID().slice(0, 12)}`;
    // An internal host may be listed with or without its port.
    const internal = [...(this.opts.allowPrivate ?? []), ...(o.allowPrivate ?? [])].map((h) => h.toLowerCase());
    const privateAllowed = allow.filter((h) => internal.includes(h) || internal.includes(h.slice(0, h.lastIndexOf(':'))));
    let started = false;
    const stop = async () => {
      if (started) await this.docker(['rm', '-f', name], undefined, 30_000).catch(() => undefined);
      if (!o.network) await this.removeNetwork(network);
    };
    try {
      await this.docker(proxyRunArgs({ name, image: this.image, allow, allowPrivate: privateAllowed, tcp: o.tcp }));
      started = true;
      await this.docker(['network', 'connect', network, name]);
      for (const n of o.join ?? []) await this.docker(['network', 'connect', n, name]);
      // Containers reach a TCP forward by the destination's own name, mapped to the proxy (--add-host).
      const address = o.tcp?.length ? (await this.docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name])).trim() : undefined;
      if (o.tcp?.length && !address) throw new AppError('stdio_mcp_proxy_failed', 502);
      const refusals = async () => {
        const out = await this.docker(['logs', name], undefined, 10_000).catch(() => '');
        const seen = new Map<string, { host: string; reason: string }>();
        for (const line of out.split('\n')) {
          try {
            const m = JSON.parse(line) as { decision?: string; host?: string; reason?: string };
            if (m.decision === 'deny' && m.host) seen.set(`${m.host} ${m.reason}`, { host: m.host, reason: m.reason ?? 'not_allowed' });
          } catch {
            // not a decision line
          }
        }
        return [...seen.values()].slice(0, 50);
      };
      for (let i = 0; i < 50; i++) {
        if ((await this.docker(['logs', name], undefined, 10_000)).includes('"ready":true')) return { url: `http://${name}:3128`, network, stop, refusals, ...(address ? { address } : {}) };
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new AppError('stdio_mcp_proxy_failed', 502);
    } catch (err) {
      await stop();
      throw err;
    }
  }

  /**
   * Install an npm package (a "name@version" spec, or an absolute path to a .tgz for local packages)
   * into a fresh volume. Only the npm registry is reachable during install; install scripts never run.
   */
  async install(spec: string): Promise<InstalledPackage> {
    const volume = `dty-mcp-${randomUUID().slice(0, 12)}`;
    const local = spec.startsWith('/') && spec.endsWith('.tgz');
    const proxy = local ? null : await this.startProxy([NPM_REGISTRY]);
    const pkgArg = local ? `/pkg/${basename(spec)}` : spec;
    try {
      await this.docker([
        'run', '--rm', '--network', proxy ? proxy.network : 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m',
        '-v', `${volume}:/srv`,
        ...(local ? ['-v', `${spec}:${pkgArg}:ro`] : []),
        ...(proxy ? ['-e', `npm_config_https_proxy=${proxy.url}`, '-e', `npm_config_proxy=${proxy.url}`] : []),
        '-e', 'npm_config_update_notifier=false', '-w', '/srv',
        this.image, 'sh', '-c',
        // The package spec is passed as an argument, never interpolated into the script.
        'npm init -y >/dev/null && npm install --ignore-scripts --no-audit --no-fund --save-exact "$0"  >/dev/null',
        pkgArg,
      ], undefined, 300_000);
      const info = JSON.parse(
        await this.docker([
          'run', '--rm', '--network', 'none', '-v', `${volume}:/srv:ro`, this.image, 'node', '-e',
          `const fs=require('fs');const deps=Object.keys(require('/srv/package.json').dependencies||{});const name=deps[0];
           const pkg=require('/srv/node_modules/'+name+'/package.json');const lock=require('/srv/package-lock.json').packages['node_modules/'+name]||{};
           const bin=typeof pkg.bin==='string'?pkg.bin:Object.values(pkg.bin||{})[0];
           console.log(JSON.stringify({name,version:pkg.version,integrity:lock.integrity||null,bin}))`,
        ]),
      ) as { name: string; version: string; integrity: string | null; bin?: string };
      if (!info.bin) throw new AppError('stdio_mcp_no_bin', 422);
      return { volume, name: info.name, version: info.version, integrity: info.integrity, entry: `/srv/node_modules/${info.name}/${info.bin.replace(/^\.\//, '')}` };
    } catch (err) {
      await this.docker(['volume', 'rm', '-f', volume], undefined, 30_000).catch(() => undefined);
      throw err;
    } finally {
      await proxy?.stop();
    }
  }

  /** Run the server for one session and hand a connected MCP client to `fn`. */
  async withServer<T>(server: StdioServer, secret: string | null, timeoutMs: number, fn: (client: Client) => Promise<T>): Promise<T> {
    const proxy = await this.startProxy(server.allow);
    const name = `dty-mcp-${randomUUID().slice(0, 12)}`;
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    if (server.credentialEnv && secret) env[server.credentialEnv] = secret; // passed by name, never on the command line
    const transport = new StdioClientTransport({
      command: await containerEngine(),
      args: serverRunArgs({ name, network: proxy.network, proxyUrl: proxy.url, server, withSecret: !!secret }),
      env,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'dittoly', version: '0.1.0' });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          await client.connect(transport);
          return fn(client);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AppError('action_timeout', 504)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => undefined);
      await this.docker(['rm', '-f', name], undefined, 30_000).catch(() => undefined);
      await proxy.stop();
    }
  }
}

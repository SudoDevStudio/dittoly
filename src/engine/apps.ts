import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Queryable } from '../db/db.js';
import { containerEngine } from '../sandbox/engine.js';
import { ownerLabels, sandboxTempDir } from '../sandbox/owner.js';
import { audit } from '../core/audit.js';
import { forbidden } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { APP_PHASES, FIX_PHASES, type AppStep, type StepPhase } from '../flows/definition.js';
import { shareAppNetwork, StdioSandbox, unshareAppNetwork, type SessionProxy, type TcpForward } from '../mcp/stdio.js';
import type { Destination } from '../runtime/destinations.js';
import { classifyAddress } from '../runtime/egress.js';
import { StepError } from './builtin.js';
import { localFiles, type WorkspaceFiles } from './workspace-files.js';
import { TCP_FORWARD_SCRIPT } from '../paths.js';

/**
 * App steps: build and start an app from a git branch, so a later browse step
 * can check it. The branch's code runs (install scripts, build tools, the app):
 *
 * - docker (preferred): install and build in a container whose only way out is
 *   the egress proxy (git host and package registries); the app then runs on an
 *   internal network of its own (removed when it stops), reachable only by the
 *   proxy of its run's browser. No host files. Every container runs as nobody
 *   (65534:65534) with no capabilities; the app's own container also has a
 *   read-only root filesystem (only /app and a /tmp tmpfs are writable). Install,
 *   build and fix-step commands keep a writable root filesystem: package managers
 *   and build tools write caches and toolchains outside /app (corepack, node-gyp,
 *   pip and friends), and as nobody they can only write where the image lets anyone.
 * - direct (local installs, only when an admin switched it on): in a temporary
 *   folder, as this user, with full network. Like running the branch yourself.
 *
 * The clone happens on this machine with the runner's token (never given to the
 * project's code). Apps stop when their run ends, or after two hours.
 *
 * Phases (StepNetwork): install, build, and run (the app) or test (a fix step's commands). Each phase
 * has its own proxy in docker mode, started when the phase starts and stopped before the next one, so
 * what one phase may reach another cannot: the install reaches only the git host and the package
 * registries; build and test also the destinations the step declares for them (egress, inside the
 * organization's ceiling); the running app only its own "run" destinations. A destination on a port
 * other than 80/443 is a plain TCP forward (a test database): the proxy listens on that port and the
 * container maps the host's name to the proxy (--add-host), so the address is resolved and checked by
 * the proxy at each connection. Direct mode has the machine's full network in every phase.
 *
 * Secret env vars (secretEnv) reach only their phases (by default every phase but the install: package
 * scripts are the least trusted code). In docker mode they go in an --env-file per phase (mode 0600,
 * outside the clone, deleted when the step ends or once the app's container started), never on the
 * command line; in direct mode in the process environment. Their values are removed from logs.
 *
 * Fix steps (src/engine/fix.ts) use the same clone, modes and egress through a Workspace.
 */

export type AppMode = 'docker' | 'direct' | 'off';

export interface RunningApp {
  runId: string;
  url: string;
  /** host:port the browser must be allowed to reach (over plain http, on a private address). */
  hostKey: string;
  /** Where this process reaches the app (a code runner's tunnel connects here); null: only from its network. */
  target: { host: string; port: number } | null;
  stop: () => Promise<void>;
}

/** What starting an app step's app returns (the step's output). */
export interface AppStarted {
  url: string;
  hostKey: string;
  commit: string;
  mode: AppMode;
  logTail: string;
  network: NetworkReport;
}

/**
 * Where app and fix steps build, test and run code: this machine (AppRunner), or a code runner machine
 * (DITTOLY_CODE_RUNNER=remote: RemoteCodeRunner in src/engine/remote-runner.ts, served by src/runner/server.ts).
 */
export interface CodeRunner {
  /** Docker on this machine (sandbox housekeeping). */
  dockerAvailable(): Promise<boolean>;
  /** How app and fix steps run now: docker, direct, or off. */
  modeFor(): Promise<AppMode>;
  start(a: AppStartOptions): Promise<AppStarted>;
  workspace(a: WorkspaceOptions): Promise<Workspace>;
  isRunning(runId: string, hostKey: string): boolean;
  stopRun(runId: string): Promise<void>;
  stopAll(): Promise<void>;
}

const MAX_LIFETIME_MS = 2 * 60 * 60_000;
const LOG_TAIL = 4000;
/**
 * Where installs fetch packages from, for each toolchain the fix and app steps support (test/fixtures/flows/toolchains.json).
 * Checked against each registry's own metadata: crates.io's index config names static.crates.io for downloads,
 * services.gradle.org redirects Gradle distributions to GitHub release assets, Packagist's dists are GitHub zipballs.
 */
export const PACKAGE_REGISTRIES = [
  // npm, Yarn, Bun (npm registry), Deno (JSR, deno.land)
  'registry.npmjs.org:443',
  'registry.yarnpkg.com:443',
  'jsr.io:443',
  'npm.jsr.io:443',
  'deno.land:443',
  // pip
  'pypi.org:443',
  'files.pythonhosted.org:443',
  // Bundler
  'rubygems.org:443',
  'index.rubygems.org:443',
  // Maven and Gradle
  'repo.maven.apache.org:443',
  'repo1.maven.org:443',
  'services.gradle.org:443',
  'downloads.gradle.org:443',
  'plugins.gradle.org:443',
  'plugins-artifacts.gradle.org:443',
  // Go modules and their checksum database
  'proxy.golang.org:443',
  'sum.golang.org:443',
  // Cargo
  'index.crates.io:443',
  'static.crates.io:443',
  // NuGet
  'api.nuget.org:443',
  // Composer
  'repo.packagist.org:443',
  'api.github.com:443',
  'codeload.github.com:443',
  // Git dependencies and release downloads
  'github.com:443',
  'objects.githubusercontent.com:443',
  'release-assets.githubusercontent.com:443',
];

/** Where a step's containers keep the toolchains' downloads between its phases (each phase is a new container). */
const SANDBOX_HOME = '/dty-home';
/** Caches that some images point outside HOME, where the sandbox user cannot write: moved into it. */
const TOOL_HOMES: Record<string, string> = {
  CARGO_HOME: `${SANDBOX_HOME}/.cargo`,
  GOMODCACHE: `${SANDBOX_HOME}/go/pkg/mod`,
  GOCACHE: `${SANDBOX_HOME}/.cache/go-build`,
  // Go makes its module cache read-only; the server could not remove the step's home afterwards.
  GOFLAGS: '-modcacherw',
  BUNDLE_PATH: `${SANDBOX_HOME}/.bundle`,
  GRADLE_USER_HOME: `${SANDBOX_HOME}/.gradle`,
  DENO_DIR: `${SANDBOX_HOME}/.cache/deno`,
  COMPOSER_HOME: `${SANDBOX_HOME}/.composer`,
  DOTNET_CLI_HOME: SANDBOX_HOME,
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
};

/**
 * Java reads neither HOME nor the proxy variables: both as JVM system properties (Maven, Gradle and the JVM's
 * own HTTP client use them). Without user.home, Maven and Gradle look in the sandbox user's /nonexistent.
 * Maven's resolver ignores the proxy properties: it gets them from mavenSettings below.
 */
export function javaOptions(proxyUrl: string | null | undefined, home: boolean): string {
  const u = proxyUrl ? new URL(proxyUrl) : null;
  return [
    ...(home ? [`-Duser.home=${SANDBOX_HOME}`] : []),
    ...(u ? ['https', 'http'].map((s) => `-D${s}.proxyHost=${u.hostname} -D${s}.proxyPort=${u.port || '80'}`) : []),
    ...(u ? [`-Dhttp.nonProxyHosts=${JAVA_NO_PROXY}`] : []),
  ].join(' ');
}

/**
 * The container's own addresses, which never go through the egress proxy: a project's tests start its server on
 * a loopback port and call it, and those calls are not the step reaching out. Without this they are sent to the
 * proxy, which rightly refuses an address nobody allowed, and a suite that passes everywhere else fails here —
 * with "403 blocked by ..." in the middle of someone's test output and no sign of where it came from.
 * The host this container runs on is NOT in the list: it is reached by another name, and stays blocked.
 */
export const NO_PROXY_HOSTS = 'localhost,127.0.0.1,::1,[::1],0.0.0.0';
/** The same for the JVM, which reads its own setting and spells the list with | (and no brackets around ::1). */
const JAVA_NO_PROXY = 'localhost|127.*|[::1]|0.0.0.0';

/** Maven's user settings with the phase's proxy (Maven reads no proxy from the environment or the JVM). */
export function mavenSettings(proxyUrl: string): string {
  const u = new URL(proxyUrl);
  const proxy = (protocol: string) =>
    `    <proxy><id>dittoly-${protocol}</id><active>true</active><protocol>${protocol}</protocol><host>${u.hostname}</host><port>${u.port || '80'}</port></proxy>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<settings>\n  <proxies>\n${proxy('https')}\n${proxy('http')}\n  </proxies>\n</settings>\n`;
}

/**
 * Files the server gives a step's containers read-only, written in a folder of the step's that the
 * containers cannot write (a container could otherwise point the server's write elsewhere).
 */
export async function sandboxConfig(dir: string, src: string): Promise<(proxyUrl: string | null) => Promise<string | null>> {
  const conf = path.join(dir, 'conf');
  await mkdir(conf, { mode: 0o755 });
  const written = new Map<string, string>();
  // Only a Maven build reads these settings, and mounting a single file inside the home mount is what Docker
  // Desktop on macOS refuses ("create mountpoint ... mount", exit 125). A Node or Python project never needs it.
  const maven = await usesMaven(src);
  return async (proxyUrl) => {
    if (!proxyUrl || !maven) return null;
    if (!written.has(proxyUrl)) {
      const file = path.join(conf, `maven-settings-${written.size}.xml`);
      await writeFile(file, mavenSettings(proxyUrl), { mode: 0o644 });
      written.set(proxyUrl, file);
    }
    return written.get(proxyUrl)!;
  };
}

const SETTING = 'run_project_code_directly';

/** Local installs only: let app steps run project code directly on this machine when Docker is missing. */
export async function getDirectCode(db: Queryable): Promise<boolean> {
  const row = (await db.query<{ value: { enabled?: boolean } }>(`SELECT value FROM org_settings WHERE key = $1`, [SETTING])).rows[0];
  return row?.value.enabled === true;
}

export async function setDirectCode(db: Queryable, actor: Member, enabled: boolean, mode: 'local' | 'shared'): Promise<boolean> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (mode !== 'local' && enabled) throw forbidden('local_mode_only');
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [SETTING, JSON.stringify({ enabled }), actor.id],
  );
  await audit(db, { actorId: actor.id, action: enabled ? 'org.direct_code_enabled' : 'org.direct_code_disabled', subjectType: 'org', subjectId: SETTING, outcome: 'ok' });
  return enabled;
}

/** An https git URL on a public address (or a host listed in DITTOLY_INTERNAL_HOSTS). */
async function checkRepo(raw: string, internalHosts: readonly string[]): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new StepError('invalid_repo_url');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new StepError('invalid_repo_url');
  const key = u.port ? u.host : `${u.hostname}:443`;
  if (!internalHosts.includes(u.host) && !internalHosts.includes(key)) {
    const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new StepError('repo_unreachable', true);
    for (const a of addrs) {
      // The same address rules as module traffic (src/runtime/egress.ts).
      if (classifyAddress(a.address) !== 'public') throw new StepError('repo_private_address');
    }
  }
  return u;
}

// ---------------------------------------------------------------- secrets

/**
 * Removes secret values from text: each value as it is, URL-encoded, in base64 (and base64url),
 * and the password of a URL ("postgres://u:pw@host"), as logs and error messages tend to show them.
 */
export function redactor(secrets: readonly string[]): (text: string) => string {
  const forms = new Set<string>();
  for (const s of secrets) {
    if (!s) continue;
    forms.add(s);
    forms.add(encodeURIComponent(s));
    const b64 = Buffer.from(s, 'utf8').toString('base64');
    forms.add(b64);
    forms.add(b64.replace(/=+$/, ''));
    forms.add(Buffer.from(s, 'utf8').toString('base64url'));
    try {
      const u = new URL(s);
      if (u.password) {
        forms.add(u.password);
        forms.add(decodeURIComponent(u.password));
      }
    } catch {
      // not a URL
    }
  }
  const list = [...forms].filter((f) => f.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => (list.length ? list.reduce((t, f) => t.split(f).join('[secret removed]'), text) : text);
}

/** Apply a redactor to every string in a value. */
export function redactDeep<T>(value: T, redact: (t: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Secret env vars in a file only this user can read, outside the clone; remove() deletes it. */
export async function writeEnvFile(values: Record<string, string>): Promise<{ path: string; remove: () => Promise<void> }> {
  for (const v of Object.values(values)) if (/[\r\n\0]/.test(v)) throw new StepError('secret_env_invalid');
  const dir = await sandboxTempDir('env');
  await chmod(dir, 0o700);
  const file = path.join(dir, 'env');
  await writeFile(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
  return { path: file, remove: () => rm(dir, { recursive: true, force: true }).catch(() => undefined) };
}

/** The unprivileged user every app and fix-step container runs as. */
export const SANDBOX_USER = '65534:65534';

/**
 * The sandbox flags every container of an app or fix step gets: its run's own internal network, an
 * unprivileged user, no capabilities, limited resources, only the clone mounted. readOnly: a read-only
 * root filesystem with a /tmp tmpfs (the app's own container; see the note at the top).
 */
export function sandboxFlags(src: string, network: string, readOnly = false, home?: string, mavenSettingsFile?: string | null): string[] {
  return [
    '--rm', ...ownerLabels(), '--network', network, '--user', SANDBOX_USER, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...(readOnly ? ['--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=512m'] : []),
    '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '-v', `${src}:/app`, '-w', '/app',
    ...(home ? ['-v', `${home}:${SANDBOX_HOME}`, '-e', `HOME=${SANDBOX_HOME}`, ...Object.entries(TOOL_HOMES).flatMap(([k, v]) => ['-e', `${k}=${v}`])] : ['-e', 'HOME=/tmp']),
    ...(home && mavenSettingsFile ? ['-v', `${mavenSettingsFile}:${SANDBOX_HOME}/.m2/settings.xml:ro`] : []),
  ];
}

/**
 * The arguments of one `docker run` for an app or fix step. Plain env values go on the command
 * line (-e); secrets only through envFile, so they never show in the process list.
 */
export function dockerRunArgs(o: {
  src: string;
  image: string;
  cmd: string;
  network: string;
  readOnly?: boolean;
  name?: string;
  proxyUrl?: string | null;
  env?: Record<string, string>;
  envFile?: string | null;
  /** host:address pairs: TCP destinations, mapped to the phase's proxy. */
  addHosts?: readonly string[];
  /** The step's own folder for the toolchains' caches, kept across its phases. */
  home?: string;
  /** Maven settings with the phase's proxy (mavenSettings), mounted read-only in home. */
  mavenSettingsFile?: string | null;
}): string[] {
  // NODE_USE_ENV_PROXY: Node's own fetch uses the proxy only when asked (curl, npm, pip and others read the variables).
  const proxy = o.proxyUrl
    ? [
        '-e', `HTTPS_PROXY=${o.proxyUrl}`, '-e', `HTTP_PROXY=${o.proxyUrl}`, '-e', `https_proxy=${o.proxyUrl}`, '-e', `http_proxy=${o.proxyUrl}`,
        '-e', 'NODE_USE_ENV_PROXY=1',
        // What the container serves itself is not a destination to allow (see NO_PROXY_HOSTS).
        '-e', `NO_PROXY=${NO_PROXY_HOSTS}`, '-e', `no_proxy=${NO_PROXY_HOSTS}`,
      ]
    : [];
  const java = javaOptions(o.proxyUrl, Boolean(o.home));
  return [
    'run',
    ...sandboxFlags(o.src, o.network, o.readOnly, o.home, o.mavenSettingsFile),
    ...(o.name ? ['--name', o.name] : []),
    ...(o.addHosts ?? []).flatMap((h) => ['--add-host', h]),
    ...proxy,
    ...(java ? ['-e', `JAVA_TOOL_OPTIONS=${java}`] : []),
    '-e',
    'CI=1',
    ...Object.entries(o.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...(o.envFile ? ['--env-file', o.envFile] : []),
    o.image,
    'sh',
    '-c',
    // What the commands write in the clone stays writable (and removable) by this server's own user.
    'umask 0000 && exec sh -c "$0"',
    o.cmd,
  ];
}

/** Whether the clone is a Maven build (only then are Maven's proxy settings worth mounting). */
async function usesMaven(src: string): Promise<boolean> {
  for (const f of ['pom.xml', 'mvnw', '.mvn/maven.config']) {
    try {
      await stat(path.join(src, f));
      return true;
    } catch {
      // not there
    }
  }
  return false;
}

/** The step's toolchain caches, beside its clone: written by the containers' unprivileged user, removed with the step's folder. */
export async function sandboxHome(dir: string): Promise<string> {
  const home = path.join(dir, 'home');
  // .m2 too: Docker would make it (root's) for the Maven settings mounted in it.
  for (const d of [home, path.join(home, '.m2')]) {
    await mkdir(d);
    await chmod(d, 0o777);
  }
  // And the file the settings are mounted over: a container runtime that has to create it inside the home mount
  // itself fails on Docker Desktop for macOS (exit 125, "create mountpoint for /dty-home/.m2/settings.xml").
  const placeholder = path.join(home, '.m2', 'settings.xml');
  await writeFile(placeholder, '', { mode: 0o644 });
  await chmod(placeholder, 0o666);
  return home;
}

/** The clone is written by the containers' unprivileged user; its parent folder (mode 0700) keeps others out. */
async function openToSandbox(src: string): Promise<void> {
  const code = await run('chmod', ['-R', 'a+rwX', src], { timeoutMs: 60_000 });
  if (code !== 0) throw new StepError('clone_failed');
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; tail?: string[] }): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (d: Buffer) => {
      if (!opts.tail) return;
      opts.tail.push(d.toString('utf8'));
      while (opts.tail.join('').length > LOG_TAIL * 2) opts.tail.shift();
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Why git could not clone, from what it said: the branch (or commit) is not there, the repository is not there or the
 * token cannot see it (GitHub answers "not found" for a private repository it may not read), the token was refused,
 * or something else.
 */
export function cloneFailure(said: string, withToken: boolean): string {
  if (/Remote branch .* not found|couldn't find remote ref|not our ref|unadvertised object/i.test(said)) return 'clone_branch_not_found';
  if (/Repository not found|repository '.*' not found|\b404\b|does not appear to be a git repository/i.test(said)) return withToken ? 'clone_repo_not_found' : 'clone_repo_not_found_no_token';
  if (/Authentication failed|could not read Username|\b40[13]\b|Permission denied|access denied|HTTP Basic: Access denied/i.test(said)) return withToken ? 'clone_access_denied' : 'clone_repo_not_found_no_token';
  if (/Could not resolve host|Failed to connect|Connection timed out|Connection refused|unable to access/i.test(said)) return 'clone_unreachable';
  return 'clone_failed';
}

/** Clone one branch, with the runner's token in an extra header passed through the environment (never argv). */
async function clone(url: URL, ref: string, token: string | null, dir: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    const user = token.includes(':') ? '' : url.hostname.includes('gitlab') ? 'oauth2:' : 'x-access-token:';
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${user}${token}`).toString('base64')}`;
  }
  const git = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
  const src = path.join(dir, 'src');
  let code: number | null;
  // What git said, to tell why a clone failed (the token is in a header git never prints).
  const said: string[] = [];
  if (/^[0-9a-f]{40}$/.test(ref)) {
    // An exact commit (e.g. the one deployed): fetch only it. GitHub and GitLab serve any commit a branch reaches.
    code = await run('git', [...git, 'init', '-q', src], { env, timeoutMs: 30_000 });
    if (code === 0) code = await run('git', [...git, '-C', src, 'fetch', '-q', '--depth', '1', '--', url.href, ref], { env, timeoutMs: 5 * 60_000, tail: said });
    if (code === 0) code = await run('git', ['-C', src, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], { env, timeoutMs: 60_000 });
  } else {
    code = await run('git', [...git, 'clone', '--depth', '1', '--branch', ref, '--single-branch', '--', url.href, src], { env, timeoutMs: 5 * 60_000, tail: said });
  }
  if (code !== 0) throw new StepError(code === null ? 'git_unavailable' : cloneFailure(said.join(''), Boolean(token)));
  const tail: string[] = [];
  await run('git', ['-C', path.join(dir, 'src'), 'rev-parse', 'HEAD'], { env, timeoutMs: 10_000, tail });
  return tail.join('').trim().slice(0, 40);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitReady(url: string, timeoutMs: number, alive: () => boolean, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!alive()) return false;
    try {
      const r = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export interface AppStartOptions {
  runId: string;
  step: AppStep;
  repo: string;
  ref: string;
  token: string | null;
  keepAlive: () => Promise<void>;
  /** Secret env vars (name -> value), resolved from secretEnv when the step runs. */
  secrets?: Record<string, string>;
  /** Destinations and secret phases; without it, no extra destination and secrets in every phase but install. */
  network?: StepNetwork;
}

/** What a step's phases may reach and which secrets each gets (checked against the organization's ceiling by the engine). */
export interface StepNetwork {
  egress: Partial<Record<StepPhase, Destination[]>>;
  secretPhases: Record<string, StepPhase[]>;
}

/** What each phase could reach and got, and what its proxy refused: the step's network evidence. */
export interface NetworkReport {
  mode: 'docker' | 'direct';
  phases: { phase: StepPhase; reaches: string[]; secrets: string[] }[];
  refused: { phase: string; host: string; reason: string }[];
}

/** The secret env vars of one phase. */
function phaseSecrets(secrets: Record<string, string>, net: StepNetwork | undefined, phase: StepPhase, all: readonly StepPhase[]): Record<string, string> {
  if (phase === 'install') return {};
  return Object.fromEntries(Object.entries(secrets).filter(([name]) => (net?.secretPhases[name] ?? all).includes(phase)));
}

/** One phase's proxy list and TCP forwards: base (git host, registries) plus its destinations. */
function phaseAllow(base: readonly string[], net: StepNetwork | undefined, phase: StepPhase): { allow: string[]; tcp: TcpForward[] } {
  const extra = phase === 'install' ? [] : (net?.egress[phase] ?? []);
  return {
    allow: [...new Set([...base, ...extra.map((d) => d.text)])],
    tcp: extra.filter((d) => d.kind === 'tcp').map((d) => ({ host: d.host, port: d.port })),
  };
}

/**
 * One proxy at a time for a step's phases on its own network: entering a phase whose list differs stops the
 * previous proxy (its refusals are kept) and starts the phase's own.
 */
class PhaseProxies {
  private current: { key: string; proxy: SessionProxy; phases: Set<StepPhase>; tcp: TcpForward[] } | null = null;
  readonly refused: NetworkReport['refused'] = [];
  constructor(
    private readonly proxies: StdioSandbox,
    private readonly network: string,
  ) {}

  async enter(phase: StepPhase, list: { allow: string[]; tcp: TcpForward[] }): Promise<{ proxy: SessionProxy; addHosts: string[] }> {
    const key = JSON.stringify([...list.allow].sort());
    if (this.current?.key !== key) {
      await this.leave();
      const proxy = await this.proxies.startProxy(list.allow, { network: this.network, tcp: list.tcp });
      this.current = { key, proxy, phases: new Set(), tcp: list.tcp };
    }
    this.current!.phases.add(phase);
    const { proxy, tcp } = this.current!;
    return { proxy, addHosts: tcp.map((t) => `${t.host}:${proxy.address}`) };
  }

  async leave(): Promise<void> {
    if (!this.current) return;
    const { proxy, phases } = this.current;
    this.current = null;
    for (const r of (await proxy.refusals?.().catch(() => [])) ?? []) this.refused.push({ phase: [...phases].join('/'), ...r });
    await proxy.stop();
  }
}

/** A clone a fix step works in: commands run there in the step's mode, with its egress rules. */
export interface Workspace {
  mode: 'docker' | 'direct';
  /** The clone's files and Dittoly's git on its repository data (moved out of the clone before any of its code ran). */
  files: WorkspaceFiles;
  commit: string;
  /** Run one command of a phase in the clone (its destinations and secrets); output is the end of what it printed, secrets removed. */
  exec(cmd: string, o: { phase: 'install' | 'build' | 'test'; timeoutMs: number }): Promise<{ code: number | null; output: string }>;
  /** Stops the phase proxy and says what each phase could reach and what was refused. */
  network(): Promise<NetworkReport>;
  close(): Promise<void>;
}

export interface WorkspaceOptions {
  runId: string;
  repo: string;
  ref: string;
  token: string | null;
  image: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
  network?: StepNetwork;
  keepAlive: () => Promise<void>;
}

const EXEC_TAIL = 12_000;

/** Run a shell command in its own process group (killed whole on timeout), keeping the end of its output. */
function execTail(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const keep = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > EXEC_TAIL * 2) out = out.slice(-EXEC_TAIL);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, output: out.slice(-EXEC_TAIL) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out.slice(-EXEC_TAIL) });
    });
  });
}

/**
 * On a code runner machine: a forward container joins connections to the app. It is on the app's network and on a
 * network of its own (no other container is on it), where its port is published on the runner's loopback address
 * only. Returns where the runner reaches it; the caller removes the container, then `network`.
 */
async function publishApp(forward: string, app: string, appNetwork: string, port: number): Promise<{ host: string; port: number; network: string }> {
  const docker = async (args: string[]) => run(await containerEngine(), args, { timeoutMs: 60_000 });
  const network = `${forward}-net`;
  const fwdPort = 8080;
  if ((await docker(['network', 'create', ...ownerLabels(), network])) !== 0) throw new StepError('app_publish_failed');
  const started = await docker([
    'run', '-d', '--rm', ...ownerLabels(), '--name', forward, '--network', network, '-p', `127.0.0.1::${fwdPort}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--pids-limit', '64', '--memory', '64m',
    '-e', `DTY_PORT=${fwdPort}`, '-e', `DTY_TARGET=${app}:${port}`, '-v', `${TCP_FORWARD_SCRIPT}:/fwd.mjs:ro`,
    'node:26-alpine', 'node', '/fwd.mjs',
  ]);
  if (started !== 0 || (await docker(['network', 'connect', appNetwork, forward])) !== 0) throw new StepError('app_publish_failed');
  const out: string[] = [];
  await run(await containerEngine(), ['port', forward, `${fwdPort}/tcp`], { timeoutMs: 30_000, tail: out });
  const m = /127\.0\.0\.1:(\d+)/.exec(out.join(''));
  if (!m) throw new StepError('app_publish_failed');
  return { host: '127.0.0.1', port: Number(m[1]), network };
}

export class AppRunner implements CodeRunner {
  private readonly running = new Map<string, RunningApp[]>();
  private readonly proxies: StdioSandbox;

  constructor(
    private readonly o: {
      mode: 'local' | 'shared';
      internalHosts: readonly string[];
      directAllowed: () => Promise<boolean>;
      dockerAvailable?: () => Promise<boolean>;
      /** Test hook: replaces the git clone (copy a fixture into dir/src); returns the commit. */
      clone?: (url: URL, ref: string, token: string | null, dir: string) => Promise<string>;
      /** Called before a step's containers run on an image (sandbox-housekeeping's recordImageUse). */
      onImage?: (image: string) => Promise<void>;
      /** On a code runner machine: each running app is also published on this machine's loopback address, for its tunnel. */
      publishApps?: boolean;
    },
  ) {
    this.proxies = new StdioSandbox({ allowPrivate: o.internalHosts });
  }

  dockerAvailable(): Promise<boolean> {
    return (this.o.dockerAvailable ?? (() => this.proxies.available()))();
  }

  /** Docker when available; direct only in local mode when an admin allowed it. */
  async modeFor(): Promise<AppMode> {
    if (await this.dockerAvailable()) return 'docker';
    if (this.o.mode === 'local' && (await this.o.directAllowed())) return 'direct';
    return 'off';
  }

  async start(a: AppStartOptions): Promise<AppStarted> {
    const mode = await this.modeFor();
    if (mode === 'off') throw new StepError(this.o.mode === 'local' ? 'app_needs_docker_or_direct' : 'app_needs_docker');
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(a.ref) || a.ref.startsWith('-') || a.ref.includes('..')) throw new StepError('invalid_ref');
    const url = await checkRepo(a.repo, this.o.internalHosts);
    const dir = await sandboxTempDir('app');
    const tail: string[] = [];
    const redact = redactor(Object.values(a.secrets ?? {}));
    let started: RunningApp | null = null;
    try {
      await a.keepAlive();
      const commit = await (this.o.clone ?? clone)(url, a.ref, a.token, dir);
      await a.keepAlive();
      if (a.secrets) for (const v of Object.values(a.secrets)) if (/[\r\n\0]/.test(v)) throw new StepError('secret_env_invalid');
      const report: NetworkReport = { mode, phases: [], refused: [] };
      started = mode === 'docker' ? await this.startDocker(a, url, dir, tail, report) : await this.startDirect(a, dir, tail, report);
      const list = this.running.get(a.runId) ?? [];
      list.push(started);
      this.running.set(a.runId, list);
      const app = started;
      setTimeout(() => void this.stopRun(a.runId).catch(() => undefined), MAX_LIFETIME_MS).unref();
      log.info('app_started', { runId: a.runId, stepId: a.step.id });
      return { url: app.url, hostKey: app.hostKey, commit, mode, logTail: redact(tail.join('')).slice(-LOG_TAIL), network: report };
    } catch (err) {
      if (started) await started.stop().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (err instanceof StepError) throw Object.assign(err, { logTail: redact(tail.join('')).slice(-LOG_TAIL) });
      throw err;
    }
  }

  /**
   * Clone a repository for a fix step, in the same mode and with the same egress as an app step.
   * Nothing runs yet: the caller runs install, build and tests with exec().
   */
  async workspace(a: WorkspaceOptions): Promise<Workspace> {
    const mode = await this.modeFor();
    if (mode === 'off') throw new StepError(this.o.mode === 'local' ? 'app_needs_docker_or_direct' : 'app_needs_docker');
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(a.ref) || a.ref.startsWith('-') || a.ref.includes('..')) throw new StepError('invalid_ref');
    const url = await checkRepo(a.repo, this.o.internalHosts);
    const dir = await sandboxTempDir('fix');
    const src = path.join(dir, 'src');
    const redact = redactor(Object.values(a.secrets));
    const cleanup: (() => Promise<void>)[] = [() => rm(dir, { recursive: true, force: true }).catch(() => undefined)];
    const close = async () => {
      for (const c of cleanup.reverse()) await c();
    };
    try {
      await a.keepAlive();
      const commit = await (this.o.clone ?? clone)(url, a.ref, a.token, dir);
      // The repository data leaves the clone before any project code runs: what Dittoly later reads
      // from it (the original files, the change) is then out of that code's reach (in docker mode).
      const gitDir = path.join(dir, 'git');
      await rename(path.join(src, '.git'), gitDir).catch(() => {
        throw new StepError('clone_failed');
      });
      const base = [...new Set([...PACKAGE_REGISTRIES, `${url.hostname}:${url.port || 443}`])];
      const used = new Set<'install' | 'build' | 'test'>();
      const report = (refused: NetworkReport['refused']): NetworkReport => ({
        mode,
        phases: (['install', ...FIX_PHASES] as const)
          .filter((p) => used.has(p))
          .map((phase) => ({ phase, reaches: mode === 'docker' ? phaseAllow(base, a.network, phase).allow : ['any address (direct mode: this machine\'s full network)'], secrets: Object.keys(phaseSecrets(a.secrets, a.network, phase, FIX_PHASES)) })),
        refused,
      });
      if (mode === 'docker') {
        await openToSandbox(src);
        await this.o.onImage?.(a.image);
        const home = await sandboxHome(dir);
        const settingsFor = await sandboxConfig(dir, src);
        // The network and each phase's proxy belong to this fix step alone; all go on close.
        const network = await this.proxies.createNetwork();
        cleanup.push(() => this.proxies.removeNetwork(network));
        const phases = new PhaseProxies(this.proxies, network);
        cleanup.push(() => phases.leave());
        const envFiles = new Map<string, Awaited<ReturnType<typeof writeEnvFile>> | null>();
        cleanup.push(async () => {
          for (const f of envFiles.values()) await f?.remove();
        });
        const envFileFor = async (phase: StepPhase) => {
          if (!envFiles.has(phase)) {
            const values = phaseSecrets(a.secrets, a.network, phase, FIX_PHASES);
            envFiles.set(phase, Object.keys(values).length ? await writeEnvFile(values) : null);
          }
          return envFiles.get(phase)?.path ?? null;
        };
        return {
          mode,
          files: localFiles(src, gitDir),
          commit,
          close,
          network: async () => {
            await phases.leave();
            return report(phases.refused);
          },
          exec: async (cmd, o) => {
            await a.keepAlive();
            used.add(o.phase);
            const { proxy, addHosts } = await phases.enter(o.phase, phaseAllow(base, a.network, o.phase));
            const r = await execTail(await containerEngine(), dockerRunArgs({ src, image: a.image, cmd, network, proxyUrl: proxy.url, env: a.env, envFile: await envFileFor(o.phase), addHosts, home, mavenSettingsFile: await settingsFor(proxy.url) }), { timeoutMs: o.timeoutMs });
            return { code: r.code, output: redact(r.output) };
          },
        };
      }
      return {
        mode,
        files: localFiles(src, gitDir),
        commit,
        close,
        network: async () => report([]),
        exec: async (cmd, o) => {
          await a.keepAlive();
          used.add(o.phase);
          // No Dittoly secrets in the environment: only what a shell needs, the Flow's values and the phase's secret env vars.
          const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, CI: '1', ...a.env, ...phaseSecrets(a.secrets, a.network, o.phase, FIX_PHASES) };
          const r = await execTail('sh', ['-c', cmd], { cwd: src, env, timeoutMs: o.timeoutMs });
          return { code: r.code, output: redact(r.output) };
        },
      };
    } catch (err) {
      await close();
      throw err;
    }
  }

  /** Install and build through their phase proxies; then run on the internal network, reaching only its "run" destinations. */
  private async startDocker(a: AppStartOptions, repo: URL, dir: string, tail: string[], report: NetworkReport): Promise<RunningApp> {
    const s = a.step;
    const src = path.join(dir, 'src');
    const base = [...new Set([...PACKAGE_REGISTRIES, `${repo.hostname}:${repo.port || 443}`])];
    await openToSandbox(src);
    await this.o.onImage?.(s.image);
    const home = await sandboxHome(dir);
    const settingsFor = await sandboxConfig(dir, src);
    // This app's own internal network: the install and build reach out only through its proxy (stopped
    // before the app starts); after that only the proxy of its run's browser joins it.
    const network = await this.proxies.createNetwork();
    const name = `dty-app-${randomUUID().slice(0, 12)}`;
    const hostKey = `${name}:${s.port}`;
    const phases = new PhaseProxies(this.proxies, network);
    // The running app's own proxy (only with "run" destinations): it lives as long as the app.
    let runProxy: SessionProxy | null = null;
    const forward = `${name}-fwd`;
    let published = false;
    const stop = async () => {
      unshareAppNetwork(hostKey);
      if (published) {
        await run(await containerEngine(), ['rm', '-f', forward], { timeoutMs: 30_000 });
        await run(await containerEngine(), ['network', 'rm', `${forward}-net`], { timeoutMs: 30_000 });
      }
      await run(await containerEngine(), ['rm', '-f', name], { timeoutMs: 30_000 });
      await phases.leave().catch(() => undefined);
      await runProxy?.stop().catch(() => undefined);
      await this.proxies.removeNetwork(network);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };
    // Secrets of each phase: in a file docker reads, deleted once the app's container is up.
    const envFiles: Awaited<ReturnType<typeof writeEnvFile>>[] = [];
    const envFileFor = async (phase: StepPhase) => {
      const values = phaseSecrets(a.secrets ?? {}, a.network, phase, APP_PHASES);
      if (!Object.keys(values).length) return null;
      const f = await writeEnvFile(values);
      envFiles.push(f);
      return f.path;
    };
    let ready = false;
    let exited = false;
    try {
      for (const [phase, cmd] of [['install', s.install], ['build', s.build]] as const) {
        if (!cmd) continue;
        await a.keepAlive();
        const list = phaseAllow(base, a.network, phase);
        report.phases.push({ phase, reaches: list.allow, secrets: Object.keys(phaseSecrets(a.secrets ?? {}, a.network, phase, APP_PHASES)) });
        const { proxy, addHosts } = await phases.enter(phase, list);
        const code = await run(await containerEngine(), dockerRunArgs({ src, image: s.image, cmd, network, proxyUrl: proxy.url, envFile: await envFileFor(phase), addHosts, home, mavenSettingsFile: await settingsFor(proxy.url) }), { timeoutMs: s.timeoutSeconds * 1000, tail });
        if (code !== 0) throw new StepError(phase === 'install' ? 'install_failed' : 'build_failed');
      }
      await phases.leave();
      report.refused.push(...phases.refused);
      const runList = phaseAllow([], a.network, 'run');
      report.phases.push({ phase: 'run', reaches: runList.allow, secrets: Object.keys(phaseSecrets(a.secrets ?? {}, a.network, 'run', APP_PHASES)) });
      let addHosts: string[] = [];
      if (runList.allow.length) {
        runProxy = await this.proxies.startProxy(runList.allow, { network, tcp: runList.tcp });
        addHosts = runList.tcp.map((t) => `${t.host}:${runProxy!.address}`);
      }
      const child = spawn(
        await containerEngine(),
        dockerRunArgs({ src, image: s.image, cmd: s.start, network, readOnly: true, name, env: { PORT: String(s.port), HOST: '0.0.0.0', ...s.env }, envFile: await envFileFor('run'), proxyUrl: runProxy?.url ?? null, addHosts, home, mavenSettingsFile: await settingsFor(runProxy?.url ?? null) }),
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.collect(child, tail);
      // The server checks readiness from inside the app's network, as the browser's proxy will reach it.
      ready = await this.dockerReady(name, network, s, a.keepAlive, () => child.exitCode === null);
      exited = child.exitCode !== null;
    } catch (err) {
      await stop();
      throw err;
    } finally {
      for (const f of envFiles) await f.remove();
    }
    if (!ready) {
      await stop();
      throw new StepError(exited ? 'app_exited' : 'app_not_ready');
    }
    let target: RunningApp['target'] = null;
    if (this.o.publishApps) {
      published = true;
      try {
        const p = await publishApp(forward, name, network, s.port);
        target = { host: p.host, port: p.port };
      } catch (err) {
        await stop();
        throw err;
      }
    }
    shareAppNetwork(hostKey, network);
    return { runId: a.runId, url: `http://${name}:${s.port}${s.path}`, hostKey, target, stop };
  }

  private async dockerReady(name: string, network: string, s: AppStep, keepAlive: () => Promise<void>, alive: () => boolean): Promise<boolean> {
    const end = Date.now() + s.readySeconds * 1000;
    while (Date.now() < end && alive()) {
      await keepAlive();
      const code = await run(await containerEngine(), ['run', '--rm', ...ownerLabels(), '--network', network, '--user', SANDBOX_USER, '--read-only', '--cap-drop', 'ALL', 'node:26-alpine', 'node', '-e', `fetch('http://${name}:${s.port}${s.path}').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))`], { timeoutMs: 15_000 });
      if (code === 0) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /** Local installs, admin opt-in: run in a temp folder as this user. */
  private async startDirect(a: AppStartOptions, dir: string, tail: string[], report: NetworkReport): Promise<RunningApp> {
    const s = a.step;
    const cwd = path.join(dir, 'src');
    const port = await freePort();
    // No Dittoly secrets in the environment: only what a shell needs, the port and the Flow's own values.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, CI: '1', PORT: String(port), HOST: '127.0.0.1', ...s.env };
    // Each phase's secret env vars (none for the install).
    const envOf = (phase: StepPhase): NodeJS.ProcessEnv => ({ ...env, ...phaseSecrets(a.secrets ?? {}, a.network, phase, APP_PHASES) });
    const full = ["any address (direct mode: this machine's full network)"];
    for (const [phase, cmd] of [['install', s.install], ['build', s.build]] as const) {
      if (!cmd) continue;
      await a.keepAlive();
      report.phases.push({ phase, reaches: full, secrets: Object.keys(phaseSecrets(a.secrets ?? {}, a.network, phase, APP_PHASES)) });
      const code = await run('sh', ['-c', cmd], { cwd, env: envOf(phase), timeoutMs: s.timeoutSeconds * 1000, tail });
      if (code !== 0) throw new StepError(phase === 'install' ? 'install_failed' : 'build_failed');
    }
    report.phases.push({ phase: 'run', reaches: full, secrets: Object.keys(phaseSecrets(a.secrets ?? {}, a.network, 'run', APP_PHASES)) });
    const child = spawn('sh', ['-c', s.start], { cwd, env: envOf('run'), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.collect(child, tail);
    const stop = async () => {
      if (child.exitCode === null && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL'); // the whole process group: sh and the app it started
        } catch {
          child.kill('SIGKILL');
        }
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };
    const url = `http://127.0.0.1:${port}${s.path}`;
    const deadline = Date.now() + s.readySeconds * 1000;
    let ready = false;
    while (!ready && Date.now() < deadline && child.exitCode === null) {
      await a.keepAlive();
      ready = await waitReady(url, Math.min(10_000, deadline - Date.now()), () => child.exitCode === null);
    }
    if (!ready) {
      await stop();
      throw new StepError(child.exitCode === null ? 'app_not_ready' : 'app_exited');
    }
    return { runId: a.runId, url, hostKey: `127.0.0.1:${port}`, target: { host: '127.0.0.1', port }, stop };
  }

  private collect(child: ChildProcess, tail: string[]): void {
    const keep = (d: Buffer) => {
      tail.push(d.toString('utf8'));
      while (tail.join('').length > LOG_TAIL * 2) tail.shift();
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', () => undefined);
  }

  isRunning(runId: string, hostKey: string): boolean {
    return !!this.find(runId, hostKey);
  }

  find(runId: string, hostKey: string): RunningApp | undefined {
    return (this.running.get(runId) ?? []).find((a) => a.hostKey === hostKey);
  }

  /** Stops one app of a run (a code runner stops each app it was asked to). */
  async stopApp(runId: string, hostKey: string): Promise<void> {
    const list = this.running.get(runId) ?? [];
    const app = list.find((a) => a.hostKey === hostKey);
    if (!app) return;
    const rest = list.filter((a) => a !== app);
    if (rest.length) this.running.set(runId, rest);
    else this.running.delete(runId);
    await app.stop().catch(() => undefined);
  }

  async stopRun(runId: string): Promise<void> {
    const list = this.running.get(runId) ?? [];
    this.running.delete(runId);
    await Promise.all(list.map((a) => a.stop().catch(() => undefined)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stopRun(id)));
  }
}

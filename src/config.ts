import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import { CONTAINER_ENGINES } from './sandbox/engine.js';

/**
 * Deployment modes.
 * - shared: one self-hosted server for an organization with many members.
 * - local:  a single member's own machine; that member is also admin and approver.
 */
export type DeploymentMode = 'shared' | 'local';

export const AI_PROVIDERS = ['claude-cli', 'codex-cli', 'anthropic', 'openai', 'ollama', 'mock', 'none'] as const;

/**
 * Said at start-up when no AI is set up, where the person is already looking: without it the first thing they try
 * — describing what they want — is the thing that cannot work.
 */
export const NO_AI =
  `No AI is set up, so Dittoly cannot draft a module or a Flow from a description (everything else works).\n` +
  `Set DITTOLY_AI_PROVIDER to anthropic, openai, ollama, claude-cli or codex-cli, with its key\n` +
  `(ANTHROPIC_API_KEY, OPENAI_API_KEY, or for ollama DITTOLY_AI_MODEL), and start again.\n`;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** Providers that run under one person's own CLI login. Never allowed on a shared server. */
export const LOCAL_ONLY_PROVIDERS: ReadonlySet<AiProviderId> = new Set(['claude-cli', 'codex-cli']);

export const SANDBOX_BACKENDS = ['process', 'docker'] as const;
/** The container engines a 'docker' sandbox can run on (src/sandbox/engine.ts). */
export { CONTAINER_ENGINES, type ContainerEngine } from './sandbox/engine.js';
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

export interface Config {
  mode: DeploymentMode;
  databaseUrl: string;
  masterKey: Buffer;
  aiProvider: AiProviderId;
  aiModel: string | undefined;
  /** More providers an admin may switch the organization's AI to, on the Admin page (DITTOLY_AI_PROVIDERS). */
  aiExtraProviders?: AiProviderId[];
  ollamaUrl: string | undefined;
  /** Settings for a model the organization runs itself (Ollama): context size and sampling. */
  ollama?: { maxContext?: number; temperature?: number; topP?: number; topK?: number };
  sandbox: SandboxBackend;
  sandboxImage: string;
  /** host[:port] values the broker may reach over plain http. Local mode only, for development. */
  insecureHttpHosts: string[];
  /** host[:port] values modules may reach on private network addresses (e.g. a self-hosted GitLab). */
  internalHosts: string[];
  /** Browser scripts, docker sandbox: the Playwright image the browser runs in (defaults to the installed playwright-core's version). */
  browserImage?: string | undefined;
  /** Browser scripts, process sandbox: the Chromium to run (defaults to Playwright's own browser download). */
  browserPath?: string | undefined;
  host: string;
  port: number;
  retry: { autoRetries: number; backoffMs: number };
  webhook: { toleranceSeconds: number; rateLimitPerMinute: number };
  delegationTtlHours: number;
  /** Base URL members use to reach this server, e.g. https://dittoly.example.com */
  publicUrl: string;
  sessionTtlHours: number;
  smtpUrl: string | undefined;
  emailFrom: string;
  /** Slack bot token (xoxb-...) for direct-message notifications. */
  slackBotToken: string | undefined;
  /** Teams Workflows webhook URL for channel notifications. */
  teamsWebhookUrl: string | undefined;
  /** RabbitMQ for webhook deliveries. Required in shared mode; local mode processes them in the request. */
  amqpUrl: string | undefined;
  /** Commands from Telegram (a bot from @BotFather; polled, no public address needed). */
  telegram: { botToken: string } | null;
  /** Commands from WhatsApp (WhatsApp Business Cloud API; needs a public https address for its webhook). */
  whatsapp: { token: string; phoneNumberId: string; number: string; appSecret: string; verifyToken: string; apiVersion: string } | null;
  oidc: { issuer: string; clientId: string; clientSecret: string | undefined; allowedDomains: string[] } | null;
  /** How many runs the background worker works on at once (DITTOLY_RUN_WORKERS; 2 shared, 1 local). */
  runWorkers?: number;
  /** How many plan items the AI drafts at once, apart from runs (DITTOLY_DRAFT_WORKERS; 2). */
  draftWorkers?: number;
  /** How many app and fix steps build and test code at once (DITTOLY_CODE_SANDBOXES; 2 shared, 1 local); more wait their turn. */
  codeSandboxes?: number;
  /** Step images Dittoly pulled are removed after this many hours unused (DITTOLY_SANDBOX_IMAGE_TTL_HOURS; 0: never). */
  sandboxImageTtlHours?: number;
  /** Starting a run is refused (503 server_busy) while this many runs already wait for a slot (DITTOLY_MAX_WAITING_RUNS). */
  maxWaitingRuns?: number;
  /**
   * Where app and fix steps build, test and run code (DITTOLY_CODE_RUNNER): null on this machine (the default),
   * or a code runner machine (`remote`) at DITTOLY_RUNNER_URL, with DITTOLY_RUNNER_TOKEN and, for a certificate
   * that is not publicly trusted, its CA (DITTOLY_RUNNER_CA, a PEM file). See docs/code-runner.md.
   */
  codeRunner?: { url: string; token: string; caFile: string | undefined } | null;
}

export class ConfigError extends Error {}

const envSchema = z.object({
  DITTOLY_MODE: z.enum(['shared', 'local']),
  DATABASE_URL: z.string().min(1),
  DITTOLY_MASTER_KEY: z.string().min(1),
  DITTOLY_AI_PROVIDER: z.enum(AI_PROVIDERS).default('none'),
  DITTOLY_AI_MODEL: z.string().optional(),
  DITTOLY_AI_PROVIDERS: z.string().optional(),
  DITTOLY_OLLAMA_URL: z.string().url().optional(),
  /** A model you run yourself: the largest context to ask Ollama for, and how to sample (Gemma asks for its own). */
  DITTOLY_OLLAMA_NUM_CTX: z.coerce.number().int().min(4096).max(1_000_000).optional(),
  DITTOLY_AI_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  DITTOLY_AI_TOP_P: z.coerce.number().min(0).max(1).optional(),
  DITTOLY_AI_TOP_K: z.coerce.number().int().min(1).max(1000).optional(),
  DITTOLY_SANDBOX: z.enum(SANDBOX_BACKENDS).optional(),
  // Which container engine runs the sandboxes (src/sandbox/engine.ts); unset: Docker, else Podman, whichever answers.
  DITTOLY_CONTAINER_ENGINE: z.enum(CONTAINER_ENGINES).optional(),
  DITTOLY_SANDBOX_IMAGE: z.string().default('node:26-alpine'),
  DITTOLY_INSECURE_HTTP_HOSTS: z.string().optional(),
  DITTOLY_INTERNAL_HOSTS: z.string().optional(),
  DITTOLY_BROWSER_IMAGE: z.string().optional(),
  DITTOLY_BROWSER_PATH: z.string().optional(),
  DITTOLY_PUBLIC_URL: z.string().url().optional(),
  DITTOLY_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  DITTOLY_RUN_WORKERS: z.coerce.number().int().min(1).max(32).optional(),
  DITTOLY_DRAFT_WORKERS: z.coerce.number().int().min(1).max(8).optional(),
  DITTOLY_CODE_SANDBOXES: z.coerce.number().int().min(1).max(64).optional(),
  DITTOLY_SANDBOX_IMAGE_TTL_HOURS: z.coerce.number().int().min(0).max(24 * 365).default(24),
  DITTOLY_MAX_WAITING_RUNS: z.coerce.number().int().min(1).max(100_000).default(500),
  DITTOLY_CODE_RUNNER: z.enum(['local', 'remote']).default('local'),
  DITTOLY_RUNNER_URL: z.string().url().optional(),
  DITTOLY_RUNNER_TOKEN: z.string().optional(),
  DITTOLY_RUNNER_CA: z.string().optional(),
  DITTOLY_SMTP_URL: z.string().optional(),
  DITTOLY_SLACK_BOT_TOKEN: z.string().regex(/^xoxb-/, 'must be a Slack bot token (xoxb-...)').optional(),
  DITTOLY_TEAMS_WEBHOOK_URL: z.string().url().startsWith('https://').optional(),
  DITTOLY_AMQP_URL: z.string().regex(/^amqps?:\/\//, 'must be an amqp:// or amqps:// URL').optional(),
  DITTOLY_TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'must be a Telegram bot token from @BotFather (123456:ABC...)').optional(),
  DITTOLY_WHATSAPP_TOKEN: z.string().min(20).optional(),
  DITTOLY_WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d{5,20}$/, 'must be the numeric phone number ID').optional(),
  DITTOLY_WHATSAPP_NUMBER: z.string().regex(/^\d{6,15}$/, 'must be the business phone number in digits with country code, e.g. 4915112345678').optional(),
  DITTOLY_WHATSAPP_APP_SECRET: z.string().min(16).optional(),
  DITTOLY_WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
  DITTOLY_WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'like v26.0').default('v26.0'),
  DITTOLY_EMAIL_FROM: z.string().default('Dittoly <dittoly@localhost>'),
  DITTOLY_OIDC_ISSUER: z.string().url().optional(),
  DITTOLY_OIDC_CLIENT_ID: z.string().optional(),
  DITTOLY_OIDC_CLIENT_SECRET: z.string().optional(),
  DITTOLY_OIDC_ALLOWED_DOMAINS: z.string().optional(),
  // A host name or IP address to listen on (0.0.0.0: every address); no scheme or port.
  HOST: z.string().regex(/^(\[?[0-9a-fA-F:]+\]?|[A-Za-z0-9.-]+)$/, 'a host name or IP address, like 0.0.0.0').default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8080),
});

/**
 * `--host` and `--port` from the command line win over HOST and PORT, in either form:
 * `npm start -- --host=0.0.0.0` passes them as arguments; `npm start --host=0.0.0.0` makes npm
 * set npm_config_host instead (npm 11 warns that this form will stop working in its next major version).
 */
export function listenOverrides(argv: string[], env: NodeJS.ProcessEnv): { HOST?: string; PORT?: string } {
  const flag = (name: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
      if (a === `--${name}` && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
    }
    return undefined;
  };
  const host = flag('host') ?? env.npm_config_host;
  const port = flag('port') ?? env.npm_config_port;
  return { ...(host ? { HOST: host } : {}), ...(port ? { PORT: port } : {}) };
}

/** Listening on every address: 0.0.0.0 (IPv4) or :: (IPv6). */
export const isWildcardHost = (host: string) => host === '0.0.0.0' || host === '::' || host === '[::]';

/** An address other machines on the network can reach this one at (the first non-internal IPv4), for links and QR codes. */
function networkAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}

/**
 * `argv` is given only by `npm start` (src/main.ts): then --host/--port (and npm's npm_config_host/port)
 * win over HOST/PORT. Other callers, like the local launcher that always stays on 127.0.0.1, pass none.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The address links, QR codes and sign-in links use: DITTOLY_PUBLIC_URL, else this host and port.
 * Listening on every address, it is never 0.0.0.0, and a localhost DITTOLY_PUBLIC_URL (the .env
 * template's) gives way to the network address when --host asked for it, because other devices cannot open localhost.
 * With single sign-on it stays: the identity provider only accepts the registered return address.
 */
function publicUrlFor(e: { DITTOLY_PUBLIC_URL?: string | undefined; HOST: string; PORT: number; DITTOLY_OIDC_ISSUER?: string | undefined }, hostFromCommandLine: boolean): string {
  const own = (host: string) => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${e.PORT}`;
  const wildcard = isWildcardHost(e.HOST);
  let url = e.DITTOLY_PUBLIC_URL ?? (wildcard ? own(networkAddress()) : own(e.HOST));
  // Only when asked on the command line (npm start -- --host=0.0.0.0): with HOST=0.0.0.0 in a container,
  // localhost reaches it through a port mapping, and the container's own address would not.
  if (wildcard && hostFromCommandLine && e.DITTOLY_PUBLIC_URL && !e.DITTOLY_OIDC_ISSUER && LOOPBACK.has(new URL(e.DITTOLY_PUBLIC_URL).hostname)) url = own(networkAddress());
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv?: string[]): Config {
  // An empty setting (`DITTOLY_OIDC_ISSUER=` in a .env template) means "not set".
  const overrides = argv ? listenOverrides(argv, env) : {};
  const set = { ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')), ...overrides };
  const parsed = envSchema.safeParse(set);
  if (!parsed.success) {
    // Say what is wrong with each one, and what was read, so nobody has to guess which character the server
    // disliked. A value that may hold a secret is named but never shown.
    const secret = /KEY|SECRET|TOKEN|PASSWORD|URL|DSN/i;
    const fields = parsed.error.issues
      .map((i) => {
        const name = i.path.join('.');
        const got = (set as Record<string, string | undefined>)[name];
        const shown = got === undefined || secret.test(name) ? '' : ` (read: "${String(got).slice(0, 60)}")`;
        return `${name}: ${i.message}${shown}`;
      })
      .join('; ');
    throw new ConfigError(`invalid or missing configuration: ${fields}`);
  }
  const e = parsed.data;
  const masterKey = Buffer.from(e.DITTOLY_MASTER_KEY, 'base64');
  if (masterKey.length !== 32) {
    throw new ConfigError('DITTOLY_MASTER_KEY must be 32 bytes, base64 encoded');
  }
  const config: Config = {
    mode: e.DITTOLY_MODE,
    databaseUrl: e.DATABASE_URL,
    masterKey,
    aiProvider: e.DITTOLY_AI_PROVIDER,
    aiModel: e.DITTOLY_AI_MODEL,
    aiExtraProviders: extraProviders(e.DITTOLY_AI_PROVIDERS, e.DITTOLY_MODE),
    ollamaUrl: e.DITTOLY_OLLAMA_URL,
    ollama: {
      ...(e.DITTOLY_OLLAMA_NUM_CTX !== undefined ? { maxContext: e.DITTOLY_OLLAMA_NUM_CTX } : {}),
      ...(e.DITTOLY_AI_TEMPERATURE !== undefined ? { temperature: e.DITTOLY_AI_TEMPERATURE } : {}),
      ...(e.DITTOLY_AI_TOP_P !== undefined ? { topP: e.DITTOLY_AI_TOP_P } : {}),
      ...(e.DITTOLY_AI_TOP_K !== undefined ? { topK: e.DITTOLY_AI_TOP_K } : {}),
    },
    sandbox: e.DITTOLY_SANDBOX ?? (e.DITTOLY_MODE === 'shared' ? 'docker' : 'process'),
    sandboxImage: e.DITTOLY_SANDBOX_IMAGE,
    insecureHttpHosts: (e.DITTOLY_INSECURE_HTTP_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    internalHosts: (e.DITTOLY_INTERNAL_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    browserImage: e.DITTOLY_BROWSER_IMAGE,
    browserPath: e.DITTOLY_BROWSER_PATH,
    host: e.HOST.replace(/^\[(.*)\]$/, '$1'),
    port: e.PORT,
    retry: { autoRetries: 2, backoffMs: 2000 },
    webhook: { toleranceSeconds: 300, rateLimitPerMinute: 60 },
    delegationTtlHours: 24,
    publicUrl: publicUrlFor(e, overrides.HOST !== undefined),
    sessionTtlHours: e.DITTOLY_SESSION_TTL_HOURS,
    runWorkers: e.DITTOLY_RUN_WORKERS ?? (e.DITTOLY_MODE === 'shared' ? 2 : 1),
    draftWorkers: e.DITTOLY_DRAFT_WORKERS ?? 2,
    codeSandboxes: e.DITTOLY_CODE_SANDBOXES ?? (e.DITTOLY_MODE === 'shared' ? 2 : 1),
    sandboxImageTtlHours: e.DITTOLY_SANDBOX_IMAGE_TTL_HOURS,
    maxWaitingRuns: e.DITTOLY_MAX_WAITING_RUNS,
    codeRunner: e.DITTOLY_CODE_RUNNER === 'remote' ? remoteRunner(e.DITTOLY_RUNNER_URL, e.DITTOLY_RUNNER_TOKEN, e.DITTOLY_RUNNER_CA) : null,
    smtpUrl: e.DITTOLY_SMTP_URL,
    emailFrom: e.DITTOLY_EMAIL_FROM,
    amqpUrl: e.DITTOLY_AMQP_URL,
    slackBotToken: e.DITTOLY_SLACK_BOT_TOKEN,
    teamsWebhookUrl: e.DITTOLY_TEAMS_WEBHOOK_URL,
    telegram: e.DITTOLY_TELEGRAM_BOT_TOKEN ? { botToken: e.DITTOLY_TELEGRAM_BOT_TOKEN } : null,
    whatsapp: null,
    oidc: null,
  };
  const wa = [e.DITTOLY_WHATSAPP_TOKEN, e.DITTOLY_WHATSAPP_PHONE_NUMBER_ID, e.DITTOLY_WHATSAPP_NUMBER, e.DITTOLY_WHATSAPP_APP_SECRET, e.DITTOLY_WHATSAPP_VERIFY_TOKEN];
  if (wa.some(Boolean)) {
    if (!wa.every(Boolean)) {
      throw new ConfigError(
        'WhatsApp needs all of DITTOLY_WHATSAPP_TOKEN, DITTOLY_WHATSAPP_PHONE_NUMBER_ID, DITTOLY_WHATSAPP_NUMBER, DITTOLY_WHATSAPP_APP_SECRET and DITTOLY_WHATSAPP_VERIFY_TOKEN',
      );
    }
    config.whatsapp = {
      token: e.DITTOLY_WHATSAPP_TOKEN!,
      phoneNumberId: e.DITTOLY_WHATSAPP_PHONE_NUMBER_ID!,
      number: e.DITTOLY_WHATSAPP_NUMBER!,
      appSecret: e.DITTOLY_WHATSAPP_APP_SECRET!,
      verifyToken: e.DITTOLY_WHATSAPP_VERIFY_TOKEN!,
      apiVersion: e.DITTOLY_WHATSAPP_API_VERSION,
    };
  }
  if (e.DITTOLY_OIDC_ISSUER || e.DITTOLY_OIDC_CLIENT_ID) {
    if (!e.DITTOLY_OIDC_ISSUER || !e.DITTOLY_OIDC_CLIENT_ID) {
      throw new ConfigError('OIDC needs both DITTOLY_OIDC_ISSUER and DITTOLY_OIDC_CLIENT_ID');
    }
    config.oidc = {
      issuer: e.DITTOLY_OIDC_ISSUER,
      clientId: e.DITTOLY_OIDC_CLIENT_ID,
      clientSecret: e.DITTOLY_OIDC_CLIENT_SECRET,
      allowedDomains: (e.DITTOLY_OIDC_ALLOWED_DOMAINS ?? '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    };
  }
  if (config.aiProvider === 'ollama' && !config.aiModel) {
    throw new ConfigError('the ollama provider needs DITTOLY_AI_MODEL (a model pulled on the Ollama server)');
  }
  if (config.mode === 'shared' && !config.amqpUrl) {
    throw new ConfigError('shared mode needs DITTOLY_AMQP_URL (RabbitMQ) for webhook deliveries');
  }
  assertModeRules(config);
  return config;
}

/** At least 32 characters: the code runner's shared secret (`openssl rand -base64 32`). */
export const MIN_RUNNER_TOKEN = 32;

/** A code runner at an https address (http only on this machine), with its shared secret. */
export function runnerUrl(url: string | undefined, variable: string): string {
  if (!url) throw new ConfigError(`DITTOLY_CODE_RUNNER=remote needs ${variable}`);
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new ConfigError(`${variable} must be an https:// address (plain http only on this machine)`);
  }
  if (u.username || u.password || u.search || u.hash) throw new ConfigError(`${variable} must be the runner's address only, like https://runner.example.com:8443`);
  return u.origin;
}

function remoteRunner(url: string | undefined, token: string | undefined, caFile: string | undefined): NonNullable<Config['codeRunner']> {
  const origin = runnerUrl(url, 'DITTOLY_RUNNER_URL');
  if (!token || token.length < MIN_RUNNER_TOKEN) throw new ConfigError(`DITTOLY_CODE_RUNNER=remote needs DITTOLY_RUNNER_TOKEN (at least ${MIN_RUNNER_TOKEN} characters, the same as the runner's)`);
  return { url: origin, token, caFile };
}

/** Providers that can be added for an admin to switch to; each needs its own login or key, as for DITTOLY_AI_PROVIDER. */
const EXTRA_PROVIDERS: ReadonlySet<string> = new Set(['claude-cli', 'codex-cli', 'anthropic', 'openai']);

function extraProviders(list: string | undefined, mode: DeploymentMode): AiProviderId[] {
  const ids = [...new Set((list ?? '').split(',').map((p) => p.trim()).filter(Boolean))];
  for (const id of ids) {
    if (!EXTRA_PROVIDERS.has(id)) throw new ConfigError(`DITTOLY_AI_PROVIDERS: '${id}' is not one of ${[...EXTRA_PROVIDERS].join(', ')}`);
    if (mode === 'shared' && LOCAL_ONLY_PROVIDERS.has(id as AiProviderId)) {
      throw new ConfigError(`AI provider '${id}' runs under one person's CLI login and is only allowed in local mode`);
    }
  }
  return ids as AiProviderId[];
}

/**
 * Rules that the system enforces, not just documents.
 * Called at startup and again by the AI provider and sandbox factories.
 */
export function assertModeRules(config: Pick<Config, 'mode' | 'aiProvider' | 'sandbox' | 'insecureHttpHosts'>): void {
  if (config.mode !== 'shared') return;
  if (LOCAL_ONLY_PROVIDERS.has(config.aiProvider)) {
    throw new ConfigError(
      `AI provider '${config.aiProvider}' runs under one person's CLI login and is only allowed in local mode`,
    );
  }
  if (config.sandbox !== 'docker') {
    throw new ConfigError(
      "shared mode requires the 'docker' sandbox; Node's permission model alone is not a security boundary",
    );
  }
  if (config.insecureHttpHosts.length > 0) {
    throw new ConfigError('DITTOLY_INSECURE_HTTP_HOSTS is only allowed in local mode');
  }
}

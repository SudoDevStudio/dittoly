import { purgeExpiredChats } from './plans/chats.js';
import type { Config } from './config.js';
import { FlowTests } from './flows/tests.js';
import { proposeRunFix } from './modules/run-fix.js';
import { narrator } from './engine/commentary.js';
import { Tables } from './tables/service.js';
import { McpServer } from './mcp/server.js';
import { McpAuthServer } from './mcp/authserver.js';
import { Gateway } from './mcp/gateway.js';
import { Undo } from './engine/undo.js';
import { sweepApprovalDeadlines } from './governance/approvals.js';
import { createProvider } from './ai/factory.js';
import { Followups } from './engine/followups.js';
import type { AiProvider } from './ai/provider.js';
import { Cipher } from './core/crypto.js';
import { SlackNotifier, TeamsNotifier } from './core/chat-notify.js';
import { createMailer, NotificationDelivery, type Mailer } from './core/delivery.js';
import type { NotificationKind } from './core/notify.js';
import { costForecast, forecastText } from './ai/costs.js';
import { TeamChannels } from './core/channels.js';
import { guardedFetch } from './runtime/egress.js';
import { Vault } from './core/vault.js';
import type { Db } from './db/db.js';
import { Engine } from './engine/engine.js';
import { Workers } from './engine/jobs.js';
import { Scheduler } from './engine/scheduler.js';
import { FlowChat } from './flows/chat.js';
import { FlowService } from './flows/service.js';
import { Marketplace } from './marketplace/service.js';
import { McpService } from './mcp/mcp.js';
import { StdioSandbox } from './mcp/stdio.js';
import { McpOAuth } from './mcp/oauth.js';
import { ModuleChat } from './modules/chat.js';
import { ModuleRegistry } from './modules/registry.js';
import { Plans } from './plans/service.js';
import { FlowEndpoints } from './endpoints/service.js';
import { Devices } from './devices/service.js';
import { DeviceCommands } from './devices/commands.js';
import { ScopeChecker } from './governance/scopes.js';
import { MeteredProvider } from './ai/metering.js';
import { OrgAi } from './ai/org-model.js';
import { ModelChanges } from './ai/model-changes.js';
import { GitSync } from './git-sync/service.js';
import { pumpStreams, type StreamDeps } from './governance/audit-stream.js';
import { sendDailyAnchors, type AnchorDeps } from './governance/evidence.js';
import { Watches } from './watches/service.js';
import { ImapSource, type MailSource } from './watches/imap.js';
import { ChatChannels } from './channels/chat.js';
import { TelegramBot } from './channels/telegram.js';
import { WhatsApp } from './channels/whatsapp.js';
import { sealAudit } from './governance/audit-chain.js';
import { sweepReviews } from './governance/reviews.js';
import { pruneAutoStopEvents } from './governance/auto-stop.js';
import { detectDrift } from './modules/health.js';
import { runSelfFix } from './modules/self-fix.js';
import { approvalQueue } from './api/queries.js';
import { runnableFlows } from './api/runnable.js';
import type { FetchLike } from './sandbox/broker.js';
import { createRunner, type SandboxRunner } from './sandbox/runner.js';
import { createBrowserLauncher, type BrowserLauncher } from './sandbox/browser.js';
import { LiveHub } from './sandbox/live.js';
import { AppRunner, getDirectCode, type CodeRunner } from './engine/apps.js';
import { RemoteCodeRunner } from './engine/remote-runner.js';
import { outcomeSentence } from './engine/outcome.js';
import { appImpact } from './team-apps/service.js';
import { Views } from './views/views.js';
import { RabbitWebhookQueue, type WebhookQueue } from './webhooks/queue.js';
import { pruneWebhookState, WebhookService } from './webhooks/service.js';
import { purgeExpiredRunData } from './core/retention.js';
import { heartbeat, recordImageUse, removeUnusedImages, sweep } from './engine/sandbox-housekeeping.js';

export interface App {
  config: Config;
  db: Db;
  cipher: Cipher;
  vault: Vault;
  runner: SandboxRunner;
  modules: ModuleRegistry;
  moduleChat: ModuleChat;
  flows: FlowService;
  flowChat: FlowChat;
  marketplace: Marketplace;
  mcp: McpService;
  mcpOAuth: McpOAuth;
  views: Views;
  delivery: NotificationDelivery;
  teamChannels: TeamChannels;
  engine: Engine;
  worker: Workers;
  scheduler: Scheduler;
  followups: Followups;
  browser: BrowserLauncher;
  live: LiveHub;
  apps: CodeRunner;
  /** Plans uploaded as PDFs: read by the AI, drafted into modules and Flows. */
  plans: Plans;
  /** Flow URLs: start runs from other systems with an x-sflow-token. */
  endpoints: FlowEndpoints;
  /** Dittoly as an MCP server: approved Flows as tools for AI assistants. */
  mcpServer: McpServer;
  /** OAuth sign-in for /mcp: AI apps connect by signing the person in. */
  mcpAuth: McpAuthServer;
  undo: Undo;
  /** Teams' data tables, read and written by table steps and in the portal. */
  tables: Tables;
  /** Flow tests played with recorded answers. */
  flowTests: FlowTests;
  /** Phones (and glasses through them) paired with a QR code. */
  devices: Devices;
  /** Spoken or typed commands from a paired phone. */
  deviceCommands: DeviceCommands;
  /** Least privilege: which scopes stored tokens have, against what modules need. */
  scopes: ScopeChecker;
  /** Commands from Telegram and WhatsApp chats (linked like phones). */
  chat: ChatChannels;
  telegram: TelegramBot | null;
  whatsapp: WhatsApp | null;
  /** Where the daily audit hash goes. */
  evidence: AnchorDeps;
  streams: StreamDeps;
  /** Start a Flow for each new item, email or file. */
  watches: Watches;
  /** Periodic work: fire due schedules, remind and expire delegations. */
  maintenance(now?: Date): Promise<void>;
  webhooks: WebhookService;
  /** RabbitMQ webhook queue (shared server); null when deliveries are processed in the request. */
  webhookQueue: WebhookQueue | null;
  ai: AiProvider | null;
  /** The organization's model ("provider:model"), or null without an organization AI. An admin may change it. */
  readonly aiModel: string | null;
  /** The organization's AI: its providers, and the model an admin chose (org-model.ts). */
  orgAi: OrgAi | null;
  /** Checks of approved Flows against a new organization model, and switching them. */
  modelChanges: ModelChanges;
  /** Approved modules, Flows and apps written to a connected git repository as pull requests. */
  gitSync: GitSync;
}

export interface AppOverrides {
  runner?: SandboxRunner;
  ai?: AiProvider | null;
  /** Test hook: more providers an admin may switch the organization to (DITTOLY_AI_PROVIDERS). */
  aiProviders?: AiProvider[];
  fetchImpl?: FetchLike;
  actionTimeoutMs?: number;
  mailer?: Mailer | null;
  webhookQueue?: WebhookQueue | null;
  /** Local (stdio) MCP sandbox; tests pass one with a different image. */
  stdio?: StdioSandbox;
  /** Headless browser for browser scripts. */
  browser?: BrowserLauncher;
  /** How AI apps' metadata documents are fetched (OAuth sign-in for /mcp); default: through the egress guard. */
  mcpAuthFetch?: FetchLike;
  /** Builds and runs apps from git branches; tests pass one with a fake clone. */
  apps?: CodeRunner;
  /** Test hook: where email watches read mail (IMAP by default). */
  mail?: MailSource;
  /** Test hook: the AI built from a runner's own key in AI and browse steps. */
  runnerAi?: (provider: 'openai' | 'anthropic', apiKey: string) => AiProvider;
  /** How long an MCP tool call waits for its run to finish (tests use 0). */
  mcpWaitMs?: number;
  /** Extra trusted CA for syslog streaming (tests). */
  tlsCa?: string;
  /** Test hook: git sync may push to file:// repositories. */
  gitFileRemotes?: boolean;
}

/** Notifications about a Flow version waiting for approval: they carry its cost forecast. */
const FORECAST_KINDS = new Set<NotificationKind>(['flow_approval_needed', 'approval_reminder', 'approval_escalated']);

export function buildApp(config: Config, db: Db, overrides: AppOverrides = {}): App {
  const cipher = new Cipher(config.masterKey);
  const vault = new Vault(db, cipher);
  const runner = overrides.runner ?? createRunner(config.sandbox, config.sandboxImage);
  const browser = overrides.browser ?? createBrowserLauncher(config);
  const live = new LiveHub();
  const apps =
    overrides.apps ??
    // DITTOLY_CODE_RUNNER=remote: app and fix steps build, test and run on the code runner machine (docs/code-runner.md).
    (config.codeRunner
      ? new RemoteCodeRunner({ url: config.codeRunner.url, token: config.codeRunner.token, caFile: config.codeRunner.caFile, browser: config.sandbox })
      : new AppRunner({ mode: config.mode, internalHosts: config.internalHosts, directAllowed: () => getDirectCode(db), onImage: (image) => recordImageUse(db, image) }));
  const rawAi = overrides.ai !== undefined ? overrides.ai : createProvider(config.mode, config.aiProvider, { model: config.aiModel, ollamaUrl: config.ollamaUrl, ollama: config.ollama });
  // More providers an admin may switch the organization to without a restart.
  const extraAi = !rawAi
    ? []
    : overrides.ai !== undefined
      ? (overrides.aiProviders ?? [])
      : (config.aiExtraProviders ?? []).filter((id) => id !== rawAi.id).map((id) => createProvider(config.mode, id, { ollamaUrl: config.ollamaUrl, ollama: config.ollama })!);
  // Every call to the organization's AI is counted per team, and stops at a team's monthly budget.
  const orgAi = rawAi ? new OrgAi(db, new Map([rawAi, ...extraAi].map((p) => [p.id, new MeteredProvider(db, p, 'organization')])), config.aiModel) : null;
  const ai: AiProvider | null = orgAi;
  // The organization's model ("provider:model"): Flow versions are pinned to the one they were approved with.
  const aiModel = () => orgAi?.model ?? null;
  const modules = new ModuleRegistry(db, runner, config.mode, config.insecureHttpHosts, browser, config.internalHosts);
  const flows = new FlowService(db, modules, config.mode, aiModel);
  const mcpOAuth = new McpOAuth(db, cipher, vault, {
    publicUrl: config.publicUrl,
    insecureHttpHosts: config.insecureHttpHosts,
    internalHosts: config.internalHosts,
    fetchImpl: overrides.fetchImpl,
  });
  const secrets = (memberId: string, service: string) => mcpOAuth.resolve(memberId, service);
  const mcp = new McpService(db, modules, vault, secrets, {
    insecureHttpHosts: config.insecureHttpHosts,
    internalHosts: config.internalHosts,
    fetchImpl: overrides.fetchImpl,
    timeoutMs: overrides.actionTimeoutMs,
    mode: config.mode,
    stdio: config.mode === 'local' ? (overrides.stdio ?? new StdioSandbox({ allowPrivate: config.internalHosts })) : undefined,
  });
  const tables = new Tables(db, cipher);
  const engine = new Engine({
    tables,
    mcp,
    secrets,
    db,
    cipher,
    vault,
    flows,
    runner,
    browser,
    live,
    apps,
    ai,
    aiModel,
    runnerAi: overrides.runnerAi,
    config,
    fetchImpl: overrides.fetchImpl,
    actionTimeoutMs: overrides.actionTimeoutMs,
  });
  // Slack and Teams calls go through the same egress guard as module traffic.
  const chatFetch = overrides.fetchImpl ?? guardedFetch({ internalHosts: config.internalHosts, loopbackHosts: config.insecureHttpHosts });
  const teamChannels = new TeamChannels(db, modules, engine);
  const mailer = overrides.mailer !== undefined ? overrides.mailer : createMailer(config.smtpUrl, config.emailFrom);
  const watches = new Watches({
    db,
    cipher,
    flows,
    modules,
    engine,
    mail: overrides.mail ?? new ImapSource({ internalHosts: config.internalHosts, loopbackHosts: config.insecureHttpHosts }),
    fetchImpl: chatFetch,
    secretsFor: (memberId, teamId, moduleName) => engine.secretResolver(teamId, moduleName, memberId),
  });
  const evidence: AnchorDeps = { db, cipher, mailer, fetchImpl: chatFetch, publicUrl: config.publicUrl, insecureHttpHosts: config.insecureHttpHosts };
  const streams: StreamDeps = {
    db, cipher, fetchImpl: chatFetch, publicUrl: config.publicUrl, insecureHttpHosts: config.insecureHttpHosts,
    egress: { internalHosts: config.internalHosts, loopbackHosts: config.insecureHttpHosts },
    ...(overrides.tlsCa ? { tlsCa: overrides.tlsCa } : {}),
  };
  const delivery = new NotificationDelivery(
    db,
    {
      mailer,
      slack: config.slackBotToken ? new SlackNotifier(config.slackBotToken, chatFetch) : null,
      teams: config.teamsWebhookUrl ? new TeamsNotifier(config.teamsWebhookUrl, chatFetch) : null,
      teamsPersonal: { cipher, fetchFn: chatFetch },
      teamChannels,
    },
    config.publicUrl,
    // A Flow version waiting for approval: its approvers read what one run is expected to spend on AI.
    async ({ kind, flowVersionId, runId }) => {
      // A run's notification says how it ended (no step names or data: see outcomeSentence).
      if (runId && (kind === 'run_paused' || kind === 'run_failed' || kind === 'run_succeeded')) return outcomeSentence(db, runId);
      if (!flowVersionId || !FORECAST_KINDS.has(kind)) return null;
      const f = await costForecast(db, flows, flowTests, flowVersionId, app.aiModel);
      return f ? forecastText(f) : null;
    },
  );
  const gitSync = new GitSync({ db, cipher, fetch: chatFetch, internalHosts: config.internalHosts, allowFileRemote: overrides.gitFileRemotes === true, app: () => app });
  const worker = new Workers(db, async (job, heartbeat) => {
    if (job.kind === 'deliver_notification' && job.payload.notificationId) await delivery.deliver(job.payload.notificationId);
    else if (job.kind === 'reverse' && job.payload.reversalId) await undo.execute(job.payload.reversalId);
    else if (job.kind.startsWith('plan_') || job.kind === 'module_decided' || job.kind === 'flow_decided') {
      // A module the AI fixed from a stopped run: once approved, that run's Flow gets a version that uses it.
      if (job.kind === 'module_decided' && job.payload.moduleVersionId) {
        const fixed = await proposeRunFix({ db, flows, flowTests, flowChat, cipher }, job.payload.moduleVersionId);
        // The run that asked for the fix hears what came of it, on its own page.
        if (fixed) {
          const say = narrator(db, cipher, fixed.runId, null);
          say.say(
            fixed.status === 'proposed'
              ? `Version ${fixed.version} of this Flow ${fixed.redrafted ? 'was drafted for the fixed module (its steps changed) and ' : 'uses the fixed module and '}waits for an approver; once approved, this run can continue on it`
              : `The fixed module is approved, but this Flow was not proposed on it (${fixed.reason.replace(/_/g, ' ')}): change the Flow yourself, or start it again once it fits`,
          );
          await say.flush();
        }
      }
      await plans.handleJob(job, heartbeat);
    }
    else if (job.kind === 'model_change_check') await modelChanges.handleJob(job);
    else if (job.kind.startsWith('git_')) await gitSync.handleJob(job);
    else await engine.handleJob(job, heartbeat);
  }, {
    runs: config.runWorkers ?? 1,
    drafts: config.draftWorkers ?? 2,
    // A plan item whose drafting job was given up says so, instead of showing "queued" forever.
    onExhausted: async (job) => {
      if (job.kind.startsWith('plan_')) await plans.jobGaveUp(job);
    },
  });
  const webhookQueue =
    overrides.webhookQueue !== undefined ? overrides.webhookQueue : config.amqpUrl ? new RabbitWebhookQueue(config.amqpUrl) : null;
  const webhooks = new WebhookService(db, cipher, flows, engine, config, webhookQueue ?? undefined);
  const moduleChat = new ModuleChat(db, modules, ai, chatFetch, cipher);
  const scheduler = new Scheduler(db, cipher, flows, engine);
  const followups = new Followups(db, cipher, flows);
  const flowChat = new FlowChat(db, modules, flows, ai, cipher);
  const plans = new Plans(db, cipher, ai, modules, moduleChat, flowChat);
  const endpoints = new FlowEndpoints(db, flows, engine, config.publicUrl);
  const flowTests = new FlowTests(db, cipher, flows, engine);
  // The drafting side keeps and plays the examples the AI writes with a Flow; it is built before this one.
  flowChat.useTests(flowTests);
  const modelChanges = new ModelChanges({ db, cipher, flows, tests: flowTests, ai, aiModel, mode: config.mode });
  const mcpServer = new McpServer(db, flows, engine, cipher, { publicUrl: config.publicUrl, ...(overrides.mcpWaitMs !== undefined ? { waitMs: overrides.mcpWaitMs } : {}) }, {
    db, flows, flowChat, modules, moduleChat, flowTests, publicUrl: config.publicUrl,
  }, new Gateway(db, modules, engine, cipher));
  // Metadata documents of AI apps signing in are fetched through the egress guard, like module traffic.
  const mcpAuth = new McpAuthServer(db, mcpServer, { publicUrl: config.publicUrl, insecureHttpHosts: config.insecureHttpHosts, internalHosts: config.internalHosts, fetchImpl: overrides.mcpAuthFetch });
  const undo = new Undo(db, cipher, modules, engine, config.mode);
  const devices = new Devices(db, config.publicUrl);
  const marketplace = new Marketplace(db, modules, flows, ai);
  const views = new Views(db, ai);
  // Chats call back into the commands, which are built once the app exists.
  const chat = new ChatChannels(db, () => app.deviceCommands);
  const telegram = config.telegram ? new TelegramBot(config.telegram.botToken, chatFetch, db, chat) : null;
  const whatsapp = config.whatsapp ? new WhatsApp(config.whatsapp, chatFetch, chat) : null;
  if (telegram) chat.senders.set('telegram', telegram);
  if (whatsapp) chat.senders.set('whatsapp', whatsapp);
  const maintenance = async (now = new Date()) => {
    await scheduler.tick(now);
    await engine.sweepDelegations(now);
    await sweepApprovalDeadlines(db, now);
    await pruneWebhookState(db);
    await purgeExpiredRunData(db, now, cipher);
    await purgeExpiredChats(db, now);
    await undo.expire();
    await mcpAuth.prune();
    await sweepReviews(db);
    await detectDrift(db, now);
    await pruneAutoStopEvents(db);
    await runSelfFix({ db, modules, moduleChat, flows, flowTests, aiConfigured: ai !== null, cipher }, now);
    await sealAudit(db);
    await pumpStreams(streams);
    await chat.tick();
    await sendDailyAnchors(evidence, now);
    await watches.tick(now);
    // An admin's model choice made on another server of the organization.
    await orgAi?.refresh();
    await modelChanges.detect();
    await gitSync.scheduleImports(now);
    await tidySandboxes(now);
  };
  // Code sandboxes: this process stays known as alive; every 10 minutes, what crashed servers left is
  // removed and step images unused for a day (DITTOLY_SANDBOX_IMAGE_TTL_HOURS) go.
  let lastTidy = 0;
  const tidySandboxes = async (now: Date) => {
    await heartbeat(db);
    if (now.getTime() - lastTidy < 10 * 60_000) return;
    lastTidy = now.getTime();
    const docker = await apps.dockerAvailable().catch(() => false);
    await sweep(db, { docker: docker ? undefined : null });
    if (docker) await removeUnusedImages(db, config.sandboxImageTtlHours ?? 24);
  };
  const app: App = { config, db, cipher, vault, runner, modules, moduleChat, flows, flowChat, marketplace, mcp, mcpOAuth, views, delivery, teamChannels, engine, worker, scheduler, followups, browser, live, apps, plans, endpoints, devices, mcpServer, mcpAuth, undo, tables, flowTests, deviceCommands: undefined as unknown as DeviceCommands, scopes: new ScopeChecker(db, chatFetch, config.insecureHttpHosts), chat, telegram, whatsapp, evidence, streams, watches, maintenance, webhooks, webhookQueue, ai, get aiModel() { return aiModel(); }, orgAi, modelChanges, gitSync };
  // Commands look up what the person may run and decide, through the same queries the portal uses.
  app.deviceCommands = new DeviceCommands(db, cipher, ai, engine, flows, {
    runnable: (member) => runnableFlows(app, member),
    approvals: (member) => approvalQueue(db, member, config.mode),
  });
  // Approving a Flow version checks the pages of the apps that follow it (src/team-apps/service.ts).
  flows.appImpact = (flowId, definition) => appImpact(app, flowId, definition);
  return app;
}

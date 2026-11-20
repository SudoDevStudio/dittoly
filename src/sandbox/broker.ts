import type { Transports } from '../runtime/protocols.js';
import { endpointCaller } from '../runtime/endpoint-calls.js';
import { ALL_TRANSPORTS } from '../runtime/transports.js';
import { guardedFetch } from '../runtime/egress.js';
import { googleAccessToken } from '../runtime/google-auth.js';
import { Broker as BaseBroker, type BrokerContext as BaseContext, type CallOutcome } from '../runtime/broker.js';
import type { Manifest } from '../modules/manifest.js';
import type { BrowserLauncher, BrowserSession, CannedPage } from './browser.js';
import type { LiveHub } from './live.js';

export { CALL_KINDS, type BrokerOutcome, type BrokerRequest, type BrokerResponse, type CallKind, type CallOutcome, type FetchLike, type MultipartPart } from '../runtime/broker.js';

/**
 * Dittoly's broker: the runtime's broker (src/runtime/broker.ts: declared hosts, credentials
 * attached outside module code, endpoint calls), plus the headless browser that browser modules
 * drive and the live view a member can take over. Any denial is a manifest violation: the step
 * fails and an audit record is written.
 */

export interface BrokerContext extends Omit<BaseContext, 'manifest' | 'calls'> {
  manifest: Manifest;
  /** Test hook: replaces the SMTP, AMQP, MQTT, WebSocket and SSE transports. */
  transports?: Partial<Transports>;
  /** Starts the headless browser for modules with a "browser" section. */
  browser?: BrowserLauncher;
  /** Sandbox tests: the browser is answered from these pages, with no network. */
  cannedPages?: CannedPage[];
  /** Run steps: the browser can be watched live by the run's member, who can take over when the script asks. */
  live?: {
    hub: LiveHub;
    owner: string;
    runId: string;
    stepId: string;
    /** Called while waiting for the member, so the step's lease does not run out. */
    keepAlive: () => Promise<void>;
    /** Tell the member the script is waiting for them. */
    askMember: () => Promise<void>;
  };
}

/** How long a script waits for the member to take over and press Continue. */
export const HELP_TIMEOUT_MS = 15 * 60_000;
/** How many times one action may ask the member for help (the runner also limits the action's total time). */
export const MAX_HELP_REQUESTS = 2;

/** What a browser script may ask for; the driver checks the details again. */
const BROWSER_OPS = new Set([
  'newPage', 'expect', 'fillSecret', 'askForHelp',
  'goto', 'reload', 'goBack', 'goForward', 'url', 'title', 'content', 'waitForURL', 'waitForLoadState', 'waitForTimeout', 'screenshot', 'setViewportSize', 'keyboard.press', 'keyboard.type',
  'click', 'dblclick', 'fill', 'press', 'pressSequentially', 'check', 'uncheck', 'selectOption', 'hover', 'focus', 'clear',
  'textContent', 'innerText', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isChecked', 'isEnabled', 'isDisabled', 'count',
  'allTextContents', 'allInnerTexts', 'waitFor', 'scrollIntoViewIfNeeded',
]);
const MAX_BROWSER_OPS = 500;
/** After any of these, a failed write action may have changed the site, so it is not retried automatically. */
const BROWSER_WRITES = new Set(['click', 'dblclick', 'press', 'keyboard.press', 'keyboard.type', 'fill', 'fillSecret', 'check', 'uncheck', 'selectOption', 'pressSequentially', 'clear']);

export class Broker extends BaseBroker {
  /** Hosts a browser page tried to load and was refused (not violations: pages load third-party content). */
  browserBlocked: string[] = [];
  private browserSession: Promise<BrowserSession> | null = null;
  private liveId: string | null = null;
  private browserOps = 0;
  private helpRequests = 0;
  private readonly full: BrokerContext;

  constructor(ctx: BrokerContext) {
    super({
      ...ctx,
      googleToken: ctx.googleToken ?? ((k, sc) => googleAccessToken(k, sc, ctx.fetchImpl ?? guardedFetch({ internalHosts: [], loopbackHosts: [] }))),
      calls: endpointCaller(ALL_TRANSPORTS, ctx.transports),
    });
    this.full = ctx;
  }

  override async call(kind: string, req: Record<string, unknown>): Promise<CallOutcome> {
    if (kind !== 'browser') return super.call(kind, req);
    const action = this.full.manifest.actions.find((a) => a.name === this.full.action);
    if (!action) return this.deny('unknown_action');
    return this.browserCall(action, req);
  }


  /**
   * One operation of a browser script. The page may load only the manifest's
   * browser hosts; a secret is resolved here and typed by the driver only into
   * a page on the credential's hosts, and never returned to the script.
   */
  private async browserCall(action: Manifest['actions'][number], req: Record<string, unknown>): Promise<CallOutcome> {
    const browser = this.full.manifest.browser;
    if (!browser) return this.deny('browser_denied');
    const op = typeof req.op === 'string' ? req.op : '';
    if (!BROWSER_OPS.has(op)) return this.deny('browser_unsupported');
    if (browser.hosts.some((h) => /^\{\{settings\./.test(h))) return { ok: false, error: 'module_settings_missing', retryable: false, violation: false };
    if (!this.full.browser) return { ok: false, error: 'browser_unavailable', retryable: false, violation: false };
    if (++this.browserOps > MAX_BROWSER_OPS) return this.deny('too_many_requests');
    if (BROWSER_WRITES.has(op)) this.writeSent = true;

    const forward: Record<string, unknown> = { op, page: req.page, chain: req.chain, args: req.args, name: req.name, not: req.not, timeout: req.timeout };
    if (op === 'fillSecret') {
      const cred = this.full.manifest.credentials.find((c) => c.id === req.credential);
      if (!cred || !action.credentials.includes(cred.id)) return this.deny('credential_denied');
      if (cred.placement.type === 'env' || cred.placement.type === 'google_service_account') return this.deny('credential_placement_unsupported');
      const secret = await this.full.resolveSecret(cred.service);
      if (secret === null) return { ok: false, error: 'credential_missing', retryable: false, violation: false };
      // A "username:password" (basic) credential can be typed one part at a time.
      const i = secret.indexOf(':');
      const part = req.part === 'username' || req.part === 'password' ? req.part : 'whole';
      forward.secret = part === 'whole' || i === -1 ? secret : part === 'username' ? secret.slice(0, i) : secret.slice(i + 1);
      forward.hosts = cred.hosts;
      forward.args = [];
    }
    this.browserSession ??= this.full.browser
      .start({
        hosts: browser.hosts,
        plainHttp: this.full.insecureHttpHosts ?? [],
        allowPrivate: this.full.internalHosts ?? [],
        canned: this.full.cannedPages,
        publicRead: this.full.manifest.publicWeb === 'read',
      })
      .then((s) => {
        const live = this.full.live;
        if (live) this.liveId = live.hub.registerStep(s, live.owner, live.runId, live.stepId);
        return s;
      });
    let session: BrowserSession;
    try {
      session = await this.browserSession;
    } catch {
      this.browserSession = null;
      return { ok: false, error: 'browser_start_failed', retryable: true, violation: false };
    }
    if (op === 'askForHelp') return this.askForHelp(session, req);
    const reply = await session.send(forward);
    for (const h of reply.blocked ?? []) if (!this.browserBlocked.includes(h)) this.browserBlocked.push(h);
    if (reply.ok) return { ok: true, result: reply.result ?? null };
    const error = typeof reply.error === 'string' && /^[a-z0-9_]{1,40}$/.test(reply.error) ? reply.error : 'browser_error';
    // Navigating to an undeclared host, or typing a secret into the wrong site, is a manifest violation.
    if (error === 'browser_host_denied' || error === 'credential_denied_host' || error === 'browser_unsupported') return this.deny(error);
    return { ok: false, error, retryable: reply.retryable === true, violation: false };
  }

  /**
   * The script asks the run's member to take over (sign in, solve a captcha...).
   * The run waits, with its lease kept alive, until they press Continue in the
   * live view. Sandbox tests carry on at once; without a member to ask it fails.
   */
  private async askForHelp(session: BrowserSession, req: Record<string, unknown>): Promise<CallOutcome> {
    if (++this.helpRequests > MAX_HELP_REQUESTS) return { ok: false, error: 'help_limit_reached', retryable: false, violation: false };
    if (this.full.cannedPages) return { ok: true, result: null };
    const live = this.full.live;
    if (!live || !this.liveId) return { ok: false, error: 'help_unavailable', retryable: false, violation: false };
    const message = typeof req.message === 'string' && req.message.trim() ? req.message.trim().slice(0, 300) : 'The script needs you to do something on this page, then press Continue.';
    const waiting = live.hub.waitForHelp(this.liveId, message);
    await live.askMember().catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const keep = setInterval(() => void live.keepAlive().catch(() => undefined), 30_000);
    try {
      const outcome = await Promise.race([waiting.then(() => 'done' as const), new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), HELP_TIMEOUT_MS)))]);
      if (outcome === 'timeout') {
        live.hub.cancelHelp(this.liveId);
        return { ok: false, error: 'help_timeout', retryable: false, violation: false };
      }
    } finally {
      clearTimeout(timer);
      clearInterval(keep);
    }
    // What the member typed is now a secret: blanked out of anything returned to the script.
    await session.send({ op: 'live.done' });
    return { ok: true, result: null };
  }

  /** Stop the browser, if this invocation started one. Always call after the action finishes. */
  override async close(): Promise<void> {
    if (this.liveId) this.full.live?.hub.unregister(this.liveId);
    this.liveId = null;
    const s = this.browserSession;
    this.browserSession = null;
    if (s) await s.then((x) => x.close(), () => undefined);
  }

}

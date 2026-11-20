import { randomUUID } from 'node:crypto';
import { AppError, badRequest, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { BrowserLauncher, BrowserSession, LiveFrame } from './browser.js';

/**
 * Live browser views. A browser step's page, or a page a member opens
 * themselves, can be streamed to that member's portal and, at the moments that
 * allow it, driven by their clicks and keys:
 *
 * - a running browser step: watch it; when its script asks for help
 *   (page.askForHelp), the run waits and the member takes control until they
 *   press Continue;
 * - an opened page: the member browses one of the approved browser modules'
 *   sites and takes screenshots.
 *
 * Only the member the run runs as (or who opened the page) can see a session;
 * to anyone else it does not exist. Sessions live in this server process.
 */

export type LiveEvent = { type: 'frame'; frame: LiveFrame } | { type: 'state'; help: string | null; closed: boolean };

interface Entry {
  id: string;
  owner: string;
  kind: 'step' | 'page';
  runId: string | null;
  stepId: string | null;
  session: BrowserSession;
  help: string | null;
  resume: (() => void) | null;
  lastFrame: LiveFrame | null;
  viewers: Set<(e: LiveEvent) => void>;
  idle: NodeJS.Timeout | null;
}

export interface LiveSummary {
  id: string;
  kind: 'step' | 'page';
  runId: string | null;
  stepId: string | null;
  /** What the script asked the member to do, while it waits; null when it is running on its own. */
  help: string | null;
  url: string | null;
}

/** An opened page closes this long after its last viewer leaves. */
const PAGE_IDLE_MS = 5 * 60_000;
const MAX_PAGES_PER_MEMBER = 2;

export class LiveHub {
  private readonly entries = new Map<string, Entry>();

  /** A browser step's session; the broker unregisters it when the step ends. */
  registerStep(session: BrowserSession, owner: string, runId: string, stepId: string): string {
    const id = randomUUID();
    this.entries.set(id, { id, owner, kind: 'step', runId, stepId, session, help: null, resume: null, lastFrame: null, viewers: new Set(), idle: null });
    return id;
  }

  unregister(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.idle) clearTimeout(e.idle);
    e.resume?.();
    for (const v of e.viewers) v({ type: 'state', help: null, closed: true });
    e.viewers.clear();
    e.session.onFrame(null);
  }

  /** Called by the broker: the script asked for help. Resolves when the member presses Continue. */
  waitForHelp(id: string, message: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve();
    e.help = message;
    this.broadcast(e);
    return new Promise((resolve) => {
      e.resume = () => {
        e.help = null;
        e.resume = null;
        this.broadcast(e);
        resolve();
      };
    });
  }

  /** Stop waiting without the member (timeout). */
  cancelHelp(id: string): void {
    const e = this.entries.get(id);
    if (e) {
      e.help = null;
      e.resume = null;
      this.broadcast(e);
    }
  }

  private broadcast(e: Entry): void {
    for (const v of e.viewers) v({ type: 'state', help: e.help, closed: false });
  }

  private own(id: string, member: Member): Entry {
    const e = this.entries.get(id);
    // Someone else's session does not exist, as far as anyone else can tell.
    if (!e || e.owner !== member.id) throw notFound('live_session');
    return e;
  }

  assertOwner(id: string, member: Member): void {
    this.own(id, member);
  }

  forRun(runId: string, member: Member): LiveSummary[] {
    return [...this.entries.values()].filter((e) => e.runId === runId && e.owner === member.id).map((e) => this.summary(e));
  }

  mine(member: Member): LiveSummary[] {
    return [...this.entries.values()].filter((e) => e.owner === member.id).map((e) => this.summary(e));
  }

  private summary(e: Entry): LiveSummary {
    return { id: e.id, kind: e.kind, runId: e.runId, stepId: e.stepId, help: e.help, url: e.lastFrame?.url ?? null };
  }

  /** Watch: frames and state changes. The screencast runs only while someone watches. */
  subscribe(id: string, member: Member, viewer: (e: LiveEvent) => void): () => void {
    const e = this.own(id, member);
    e.viewers.add(viewer);
    if (e.idle) {
      clearTimeout(e.idle);
      e.idle = null;
    }
    viewer({ type: 'state', help: e.help, closed: false });
    if (e.lastFrame) viewer({ type: 'frame', frame: e.lastFrame });
    if (e.viewers.size === 1) {
      e.session.onFrame((frame) => {
        e.lastFrame = frame;
        for (const v of e.viewers) v({ type: 'frame', frame });
      });
      void e.session.send({ op: 'live.start' });
    }
    return () => {
      if (!e.viewers.delete(viewer) || e.viewers.size > 0) return;
      void e.session.send({ op: 'live.stop' });
      e.session.onFrame(null);
      if (e.kind === 'page' && this.entries.has(e.id)) e.idle = setTimeout(() => void this.close(e.id, member).catch(() => undefined), PAGE_IDLE_MS);
    };
  }

  /** A click, keys, scrolling or navigation from the member. */
  async input(id: string, member: Member, body: Record<string, unknown>): Promise<unknown> {
    const e = this.own(id, member);
    // A running script is in charge of its page, except while it waits for help.
    if (e.kind === 'step' && e.help === null) throw new AppError('live_not_waiting', 409);
    const type = String(body.type ?? '');
    const ops: Record<string, Record<string, unknown>> = {
      click: { op: 'live.click', x: body.x, y: body.y },
      type: { op: 'live.type', text: body.text },
      key: { op: 'live.key', key: body.key },
      scroll: { op: 'live.scroll', dy: body.dy },
      goto: { op: 'live.goto', url: body.url },
      back: { op: 'live.back' },
    };
    const op = ops[type];
    if (!op) throw badRequest('invalid_input', 'type: click, type, key, scroll, goto or back');
    const r = await e.session.send(op);
    if (!r.ok) throw new AppError(r.error ?? 'browser_error', r.error === 'browser_host_denied' ? 403 : 502);
    return r.result ?? null;
  }

  continue(id: string, member: Member): void {
    const e = this.own(id, member);
    if (!e.resume) throw new AppError('live_not_waiting', 409);
    e.resume();
  }

  // ---------------------------------------------------------------- pages a member opens

  async open(member: Member, url: string, launcher: BrowserLauncher, o: { hosts: string[]; plainHttp: readonly string[]; allowPrivate: readonly string[] }): Promise<{ id: string }> {
    if ([...this.entries.values()].filter((e) => e.owner === member.id && e.kind === 'page').length >= MAX_PAGES_PER_MEMBER) {
      throw new AppError('too_many_live_pages', 429);
    }
    if (!o.hosts.length) throw badRequest('no_browser_sites', 'no site is allowed yet: an admin adds them on the Dittoly Browser page, or approves a browser module');
    const session = await launcher.start({ hosts: o.hosts, plainHttp: o.plainHttp, allowPrivate: o.allowPrivate });
    const r = await session.send({ op: 'live.goto', url });
    if (!r.ok) {
      await session.close();
      throw new AppError(r.error === 'browser_host_denied' ? 'site_not_allowed' : (r.error ?? 'browser_error'), r.error === 'browser_host_denied' ? 403 : 502);
    }
    const id = randomUUID();
    const entry: Entry = { id, owner: member.id, kind: 'page', runId: null, stepId: null, session, help: null, resume: null, lastFrame: null, viewers: new Set(), idle: null };
    entry.idle = setTimeout(() => void this.close(id, member).catch(() => undefined), PAGE_IDLE_MS);
    this.entries.set(id, entry);
    return { id };
  }

  async screenshot(id: string, member: Member): Promise<string> {
    const e = this.own(id, member);
    if (e.kind !== 'page') throw new AppError('live_not_a_page', 409);
    const r = await e.session.send({ op: 'live.screenshot' });
    if (!r.ok || typeof r.result !== 'string') throw new AppError(r.error ?? 'browser_error', 502);
    return r.result;
  }

  async close(id: string, member: Member): Promise<void> {
    const e = this.own(id, member);
    if (e.kind !== 'page') throw new AppError('live_not_a_page', 409);
    this.unregister(id);
    await e.session.close();
  }

  /** Server shutdown. */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    for (const e of all) this.unregister(e.id);
    await Promise.all(all.filter((e) => e.kind === 'page').map((e) => e.session.close()));
  }
}

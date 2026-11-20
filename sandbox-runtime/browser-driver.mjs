// Dittoly browser driver. Runs one headless Chromium for one module action.
//
// The module's script never gets this browser. It sends plain-data operations
// ("click the button named Save") through the sandbox protocol to the broker,
// which checks them and forwards them here over stdin/stdout. This driver:
// - lets the page load only the hosts the manifest declares: every request and
//   WebSocket is checked here, and all traffic also goes through the Dittoly
//   egress proxy, which refuses other hosts and private addresses;
// - types secrets the broker hands it only into pages on the credential's hosts,
//   and blanks them out of anything it returns (also URL-encoded and HTML-escaped);
// - treats a field a secret went into (by fillSecret, or typed by a person during
//   askForHelp) as sealed for the session: the script cannot read it, edit it,
//   test its value or see it in a screenshot; it can only submit it;
// - turns WebRTC off, whose UDP traffic would not go through the proxy;
// - never writes files (no screenshot paths, uploads or downloads).
//
// Plain JavaScript on purpose: it runs as-is locally or inside the browser container.

import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';

const emit = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) console[k] = () => {};

const MAX_TIMEOUT = 30_000;
const MAX_SCREENSHOTS = 10;
const MAX_TEXT = 500_000;
const IDLE_EXIT_MS = 120_000;

/** Builders return a narrower locator; they never act on the page. */
const BUILDERS = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByAltText', 'getByTitle', 'first', 'last', 'nth', 'filter']);
const LOCATOR_OPS = new Set([
  'click', 'dblclick', 'fill', 'press', 'pressSequentially', 'check', 'uncheck', 'selectOption', 'hover', 'focus', 'clear',
  'textContent', 'innerText', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isChecked', 'isEnabled', 'isDisabled', 'count',
  'allTextContents', 'allInnerTexts', 'waitFor', 'screenshot', 'scrollIntoViewIfNeeded',
]);
const PAGE_OPS = new Set(['snapshot', 'goto', 'reload', 'goBack', 'goForward', 'url', 'title', 'content', 'waitForURL', 'waitForLoadState', 'waitForTimeout', 'screenshot', 'setViewportSize', 'keyboard.press', 'keyboard.type']);
/** Expectations that test an element's value, text or attributes. */
const VALUE_EXPECTS = new Set(['toHaveValue', 'toHaveAttribute', 'toHaveText', 'toContainText']);
const EXPECTS = new Set(['toBeVisible', 'toBeHidden', 'toBeChecked', 'toBeEnabled', 'toBeDisabled', 'toHaveText', 'toContainText', 'toHaveValue', 'toHaveCount', 'toHaveAttribute', 'toHaveTitle', 'toHaveURL']);

class DriverError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

let config = null;
let browser = null;
let context = null;
const pages = new Map();
let nextPage = 1;
const secrets = new Set();
let screenshots = 0;
/** Elements a secret went into, as { page, handle }: see "sealed fields" below. */
const sealed = [];
/** Marks sealed elements in their page, so screenshots can mask them. */
const SEALED_ATTR = 'data-dittoly-sealed';

// ------------------------------------------------------------------ host rules

function hostAllowed(hostname, port, protocol, patterns = config.hosts) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const p = port || (protocol === 'http:' ? '80' : '443');
  const keys = [h, `${h}:${p}`];
  if (protocol === 'http:' && !keys.some((k) => config.plainHttp.includes(k))) return false;
  return patterns.some((pattern) => {
    const [ph, pp] = pattern.includes(':') ? pattern.split(':') : [pattern, null];
    if (pp && pp !== p) return false;
    return ph.startsWith('*.') ? h.endsWith(ph.slice(1)) && h.length > ph.length - 1 : h === ph;
  });
}

function urlAllowed(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || raw === 'about:blank') return true;
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return hostAllowed(u.hostname, u.port, u.protocol === 'ws:' ? 'http:' : 'https:');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  return hostAllowed(u.hostname, u.port, u.protocol);
}

/**
 * Modules allowed to read the public web may also load any https page (GET or HEAD only;
 * private addresses are refused by the egress proxy). Forms and other requests that
 * send data, and WebSockets, still go only to the declared hosts.
 */
function publicRead(raw, method) {
  if (!config.publicRead || (method !== 'GET' && method !== 'HEAD')) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && raw.length <= 2048;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ values

/** Arguments cross the boundary as JSON; a regular expression travels as { $regex, flags }. */
function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if (typeof v.$regex === 'string') {
      if (v.$regex.length > 500) throw new DriverError('browser_bad_argument');
      return new RegExp(v.$regex, typeof v.flags === 'string' ? v.flags.replace(/[^gimsuy]/g, '') : '');
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      // Nothing may write a file or reach another frame's internals.
      if (k === 'path' || k === '__proto__') continue;
      out[k] = k === 'timeout' && typeof x === 'number' ? Math.min(x, MAX_TIMEOUT) : revive(x);
    }
    return out;
  }
  return v;
}

/** Blank out any secret typed in this session from what goes back to the script. */
function redact(v) {
  if (typeof v === 'string') {
    let s = v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
    for (const secret of secrets) if (secret) s = s.replace(secretPattern(secret), '••••••');
    return s;
  }
  if (Array.isArray(v)) return v.map(redact);
  return v;
}

const patterns = new Map();
const reEscape = (c) => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const anyCase = (hex) => hex.replace(/[a-f]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const HTML_NAMED = { '&': ['&amp;'], '<': ['&lt;'], '>': ['&gt;'], '"': ['&quot;'], "'": ['&apos;'] };

/**
 * A secret in any of the spellings a page, URL or HTML can hold it in, even mixed: as typed,
 * percent-encoded (encodeURIComponent, form-encoded with + for a space, either hex case),
 * HTML-escaped (named and numeric character references) or JSON-escaped.
 */
function secretPattern(secret) {
  let re = patterns.get(secret);
  if (re) return re;
  const parts = [...secret].map((c) => {
    const cp = c.codePointAt(0);
    const forms = [reEscape(c)];
    if (c === ' ') forms.push('\\+');
    forms.push([...Buffer.from(c, 'utf8')].map((b) => '%' + anyCase(b.toString(16).padStart(2, '0'))).join(''));
    forms.push(`&#0*${cp};`, `&#[xX]0*${anyCase(cp.toString(16))};`, ...(HTML_NAMED[c] ?? []));
    if (cp <= 0xffff) forms.push(`\\\\[uU]${anyCase(cp.toString(16).padStart(4, '0'))}`);
    if (c === '"' || c === '\\' || c === '/') forms.push(`\\\\${reEscape(c)}`);
    return `(?:${forms.join('|')})`;
  });
  re = new RegExp(parts.join(''), 'g');
  patterns.set(secret, re);
  return re;
}

function matches(actual, expected) {
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual);
  return actual === expected;
}

// ------------------------------------------------------------------ sealed fields
//
// Blanking out a secret is not enough once it sits in a field: the script could change one
// character and read the rest, or test the value against patterns. So a field a secret went
// into is sealed for the session. The script may still click it, wait for it, check that it
// is visible and press Enter in it (to submit), but nothing that reads, tests, edits or shows it.

/** What the script may still do with a sealed element. */
const SEALED_OK = new Set(['click', 'hover', 'focus', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isChecked', 'count', 'waitFor', 'scrollIntoViewIfNeeded']);
const SUBMIT_KEYS = new Set(['Enter', 'NumpadEnter', 'Tab']);

async function seal(page, handle) {
  if (!handle) return;
  for (const s of sealed) if (await sameElement(s.handle, handle)) return handle.dispose().catch(() => undefined);
  sealed.push({ page, handle });
  await handle.evaluate((e, attr) => e.setAttribute(attr, ''), SEALED_ATTR).catch(() => undefined);
}

function sameElement(a, b) {
  return a.evaluate((x, y) => x === y, b).catch(() => false);
}

/** Sealed elements still in a document (an element from a page that navigated away is let go). */
async function liveSealed(page) {
  const out = [];
  for (let i = sealed.length - 1; i >= 0; i--) {
    const s = sealed[i];
    const connected = await s.handle.evaluate((e) => e.isConnected).catch(() => null);
    if (connected === null) {
      sealed.splice(i, 1);
      continue;
    }
    if (connected && (!page || s.page === page)) out.push(s);
  }
  return out;
}

/**
 * True when the locator's elements include a sealed one, are inside one (a sealed editable
 * element's text is its value), or contain one whose value is part of their text (text a
 * person typed into an editable element; an input's value is never part of its parent's text).
 */
async function touchesSealed(page, loc) {
  const live = await liveSealed(page);
  if (!live.length) return false;
  const handles = await loc.elementHandles().catch(() => []);
  if (!handles.length) return false;
  try {
    for (const s of live) {
      // A locator's elements are all in one frame; a sealed element in another frame is not among them.
      const hit = await s.handle
        .evaluate((e, els) => els.some((el) => e.contains(el) || (el.contains(e) && e.isContentEditable)), handles)
        .catch(() => false);
      if (hit) return true;
    }
    return false;
  } finally {
    for (const h of handles) h.dispose().catch(() => undefined);
  }
}

/** True when a sealed element has the keyboard focus (in its own document). */
async function sealedFocused(page) {
  for (const s of await liveSealed(page)) {
    const focused = await s.handle
      .evaluate((e) => {
        let a = e.ownerDocument.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        return a === e;
      })
      .catch(() => false);
    if (focused) return true;
  }
  return false;
}

/** The element a person's typing goes into, in whichever frame has the focus. */
async function focusedElement(page) {
  for (const frame of page.frames()) {
    const h = await frame
      .evaluateHandle(() => {
        if (!document.hasFocus()) return null;
        let a = document.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        return a && a !== document.body && a.tagName !== 'IFRAME' && a.tagName !== 'FRAME' ? a : null;
      })
      .catch(() => null);
    const el = h?.asElement();
    if (el) return el;
    await h?.dispose().catch(() => undefined);
  }
  return null;
}

const sealedError = () => new DriverError('browser_secret_field');

// ------------------------------------------------------------------ browser

async function ensureContext() {
  if (context) return context;
  browser = await chromium.launch({
    headless: true,
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    ...(config.proxy ? { proxy: { server: config.proxy } } : {}),
    args: [
      '--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync',
      // WebRTC sends UDP straight out, past the egress proxy: only proxied traffic is allowed.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  });
  context = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 720 },
    javaScriptEnabled: true,
  });
  // And pages get no WebRTC at all (in every frame).
  await context.addInitScript(() => {
    for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
      try {
        Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false });
      } catch {
        // already locked
      }
    }
  });
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(MAX_TIMEOUT);
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (config.canned) {
      const page = config.canned.find((c) => url.startsWith(c.urlPrefix));
      if (page) return route.fulfill({ status: page.status ?? 200, contentType: page.contentType ?? 'text/html; charset=utf-8', body: page.body ?? '' });
      return route.abort('blockedbyclient');
    }
    if (!urlAllowed(url) && !publicRead(url, route.request().method())) {
      blocked.add(safeHost(url));
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.routeWebSocket(/.*/, (ws) => {
    if (!config.canned && urlAllowed(ws.url())) ws.connectToServer();
    else ws.close({ code: 1008, reason: 'blocked by Dittoly' });
  });
  context.on('page', async (p) => {
    // Popups the page opens are not the script's to drive; close them.
    if (await p.opener().catch(() => null)) p.close().catch(() => undefined);
  });
  return context;
}

const blocked = new Set();
function safeHost(raw) {
  try {
    return new URL(raw).host;
  } catch {
    return 'invalid';
  }
}

function pageOf(id) {
  const p = pages.get(id);
  if (!p) throw new DriverError('browser_no_page');
  return p;
}

function buildLocator(page, chain) {
  let target = page;
  for (const step of chain) {
    if (!Array.isArray(step) || !BUILDERS.has(step[0])) throw new DriverError('browser_unsupported');
    const args = revive(step[1] ?? []);
    if (step[0] === 'filter') {
      const o = args[0] ?? {};
      target = target.filter({ ...(o.hasText !== undefined ? { hasText: o.hasText } : {}), ...(o.hasNotText !== undefined ? { hasNotText: o.hasNotText } : {}) });
    } else target = target[step[0]](...args);
  }
  return target;
}

/**
 * A screenshot for the script. Sealed fields are masked; it is refused while a sealed field
 * sits in a frame masking cannot reach, or while a secret shows anywhere in the page's text
 * (blanking text out of a picture is not possible).
 */
async function screenshotOf(target, options, page = target) {
  if (++screenshots > MAX_SCREENSHOTS) throw new DriverError('browser_too_many_screenshots');
  if (secrets.size) {
    for (const s of await liveSealed(page)) {
      const frame = await s.handle.ownerFrame().catch(() => null);
      if (frame !== page.mainFrame()) throw sealedError();
      await s.handle.evaluate((e, attr) => e.setAttribute(attr, ''), SEALED_ATTR).catch(() => undefined);
    }
    const html = await page.content();
    for (const secret of secrets) if (secret && (secretPattern(secret).lastIndex = 0, secretPattern(secret).test(html))) throw sealedError();
  }
  const buf = await target.screenshot({
    type: 'jpeg',
    quality: 60,
    fullPage: options?.fullPage === true && target.goto ? true : undefined,
    animations: 'disabled',
    timeout: MAX_TIMEOUT,
    ...(sealed.length ? { mask: [page.locator(`[${SEALED_ATTR}]`)], maskColor: '#000000' } : {}),
  });
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function expectation(page, chain, name, args, not, timeout) {
  if (!EXPECTS.has(name)) throw new DriverError('browser_unsupported');
  const [expected, options] = revive(args);
  const onPage = chain.length === 0;
  const loc = onPage ? null : buildLocator(page, chain);
  if (secrets.size) {
    // Once a secret is in the session a pattern could test it piece by piece, and a sealed field's value is not the script's to test.
    if (expected instanceof RegExp || options instanceof RegExp) throw new DriverError('browser_secret_pattern');
    if (loc && VALUE_EXPECTS.has(name) && (await touchesSealed(page, loc))) throw sealedError();
  }
  const check = async () => {
    switch (name) {
      case 'toHaveTitle': return matches(redact(await page.title()), expected);
      case 'toHaveURL': return matches(redact(page.url()), expected);
      case 'toBeVisible': return loc.first().isVisible();
      case 'toBeHidden': return !(await loc.first().isVisible());
      case 'toBeChecked': return loc.first().isChecked();
      case 'toBeEnabled': return loc.first().isEnabled();
      case 'toBeDisabled': return loc.first().isDisabled();
      case 'toHaveCount': return (await loc.count()) === expected;
      case 'toHaveValue': return matches(redact(await loc.first().inputValue()), expected);
      case 'toHaveAttribute': {
        const v = await loc.first().getAttribute(expected);
        return args.length < 2 ? v !== null : matches(v === null ? null : redact(v), options);
      }
      case 'toHaveText': {
        const t = redact(((await loc.first().textContent()) ?? '').trim());
        return expected instanceof RegExp ? expected.test(t) : t === String(expected).trim();
      }
      case 'toContainText': {
        const t = redact((await loc.first().textContent()) ?? '');
        return expected instanceof RegExp ? expected.test(t) : t.includes(String(expected));
      }
    }
    return false;
  };
  const deadline = Date.now() + Math.min(timeout ?? 5_000, MAX_TIMEOUT);
  for (;;) {
    let ok = false;
    try {
      ok = (await check()) === !not;
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() > deadline) throw new DriverError('expectation_failed');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ------------------------------------------------------------------ live view
//
// The page can be streamed to the member's run view (Chrome's screencast) and,
// while the script waits for help, driven by the member's clicks and keys.
// Text a person types is added to the secrets that are blanked out of anything
// returned to the script: it may be a password.

let screencast = null;
let typed = '';

async function livePage() {
  const all = [...pages.values()];
  if (all.length) return all[all.length - 1];
  const ctx = await ensureContext();
  const p = await ctx.newPage();
  pages.set(nextPage++, p);
  return p;
}

function flushTyped() {
  if (typed.length >= 4) secrets.add(typed);
  typed = '';
}

async function live(msg) {
  const page = await livePage();
  switch (msg.op) {
    case 'live.start': {
      if (screencast) return null;
      const cdp = await page.context().newCDPSession(page);
      cdp.on('Page.screencastFrame', (f) => {
        emit({ type: 'frame', data: f.data, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight, url: redact(page.url()) });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720 });
      screencast = cdp;
      return null;
    }
    case 'live.stop': {
      const cdp = screencast;
      screencast = null;
      await cdp?.send('Page.stopScreencast').catch(() => undefined);
      await cdp?.detach().catch(() => undefined);
      return null;
    }
    case 'live.click': {
      flushTyped();
      const x = Math.max(0, Math.min(Number(msg.x) || 0, 2560));
      const y = Math.max(0, Math.min(Number(msg.y) || 0, 2560));
      await page.mouse.click(x, y);
      return null;
    }
    case 'live.type': {
      const text = String(msg.text ?? '').slice(0, 1000);
      typed += text;
      // What a person types may be a password: the field it goes into is sealed like a filled secret.
      await seal(page, await focusedElement(page));
      await page.keyboard.type(text);
      return null;
    }
    case 'live.key': {
      const key = String(msg.key ?? '');
      if (!/^(Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(key)) throw new DriverError('browser_unsupported');
      if (key === 'Backspace') typed = typed.slice(0, -1);
      else if (key === 'Enter' || key === 'Tab') flushTyped();
      await page.keyboard.press(key);
      return null;
    }
    case 'live.scroll':
      await page.mouse.wheel(0, Math.max(-5000, Math.min(Number(msg.dy) || 0, 5000)));
      return null;
    case 'live.goto': {
      flushTyped();
      if (!urlAllowed(String(msg.url)) && !publicRead(String(msg.url), 'GET')) throw new DriverError('browser_host_denied');
      await page.goto(String(msg.url), { waitUntil: 'load', timeout: MAX_TIMEOUT });
      return redact(page.url());
    }
    case 'live.back':
      await page.goBack({ timeout: MAX_TIMEOUT }).catch(() => null);
      return redact(page.url());
    case 'live.screenshot': {
      // For the person in the live view, not the script: nothing to mask.
      if (++screenshots > MAX_SCREENSHOTS) throw new DriverError('browser_too_many_screenshots');
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, animations: 'disabled', timeout: MAX_TIMEOUT });
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
    case 'live.url':
      return redact(page.url());
    case 'live.done':
      // The person handed control back: whatever they typed is a secret from now on.
      flushTyped();
      return null;
  }
  throw new DriverError('browser_unsupported');
}

async function handle(msg) {
  if (typeof msg.op === 'string' && msg.op.startsWith('live.')) return live(msg);
  if (msg.op === 'newPage') {
    const ctx = await ensureContext();
    const id = nextPage++;
    const p = await ctx.newPage();
    pages.set(id, p);
    return id;
  }
  const page = pageOf(msg.page);
  const chain = Array.isArray(msg.chain) ? msg.chain : [];
  const args = revive(Array.isArray(msg.args) ? msg.args : []);

  if (msg.op === 'expect') return expectation(page, chain, msg.name, msg.args ?? [], msg.not === true, msg.timeout);

  if (msg.op === 'fillSecret') {
    // The secret goes only into a page on the credential's own hosts.
    const u = new URL(page.url());
    const hosts = Array.isArray(msg.hosts) ? msg.hosts.map((h) => String(h).toLowerCase()) : [];
    if (!hostAllowed(u.hostname, u.port, u.protocol, hosts)) throw new DriverError('credential_denied_host');
    secrets.add(msg.secret);
    const target = buildLocator(page, chain);
    await target.fill(msg.secret);
    await seal(page, await target.elementHandle({ timeout: 1_000 }).catch(() => null));
    return null;
  }

  if (chain.length === 0) {
    if (!PAGE_OPS.has(msg.op)) throw new DriverError('browser_unsupported');
    switch (msg.op) {
      case 'goto': {
        if (!urlAllowed(String(args[0])) && !publicRead(String(args[0]), 'GET')) throw new DriverError('browser_host_denied');
        const res = await page.goto(String(args[0]), { waitUntil: args[1]?.waitUntil ?? 'load', timeout: Math.min(args[1]?.timeout ?? MAX_TIMEOUT, MAX_TIMEOUT) });
        return res ? { status: res.status(), url: redact(page.url()) } : null;
      }
      case 'reload': case 'goBack': case 'goForward': {
        const res = await page[msg.op]({ timeout: MAX_TIMEOUT });
        return res ? { status: res.status(), url: redact(page.url()) } : null;
      }
      case 'url': return redact(page.url());
      // What is on the page, as an accessibility tree (roles, names, texts), for an AI to read.
      case 'snapshot': return redact((await page.locator('body').ariaSnapshot({ timeout: 10_000 })).slice(0, 30_000));
      case 'title': return redact(await page.title());
      case 'content': return redact(await page.content());
      case 'waitForURL': return page.waitForURL(args[0], { timeout: Math.min(args[1]?.timeout ?? MAX_TIMEOUT, MAX_TIMEOUT) }).then(() => null);
      case 'waitForLoadState': return page.waitForLoadState(args[0] ?? 'load', { timeout: MAX_TIMEOUT }).then(() => null);
      case 'waitForTimeout': return page.waitForTimeout(Math.min(Number(args[0]) || 0, MAX_TIMEOUT)).then(() => null);
      case 'screenshot': return screenshotOf(page, args[0]);
      case 'setViewportSize': return page.setViewportSize({ width: Math.min(args[0]?.width ?? 1280, 2560), height: Math.min(args[0]?.height ?? 720, 2560) }).then(() => null);
      // Keys go to the focused element: into a sealed field, only the keys that submit or leave it.
      case 'keyboard.press':
        if (!SUBMIT_KEYS.has(String(args[0])) && (await sealedFocused(page))) throw sealedError();
        return page.keyboard.press(String(args[0])).then(() => null);
      case 'keyboard.type':
        if (await sealedFocused(page)) throw sealedError();
        return page.keyboard.type(String(args[0])).then(() => null);
    }
  }

  if (!LOCATOR_OPS.has(msg.op)) throw new DriverError('browser_unsupported');
  const loc = buildLocator(page, chain);
  if (msg.op === 'screenshot') return screenshotOf(loc, args[0], page);
  if (!SEALED_OK.has(msg.op) && !(msg.op === 'press' && SUBMIT_KEYS.has(String(args[0]))) && (await touchesSealed(page, loc))) throw sealedError();
  const out = await loc[msg.op](...args);
  return redact(out === undefined ? null : out);
}

function errorCode(err) {
  if (err instanceof DriverError) return { error: err.code, retryable: err.retryable };
  const name = err?.name ?? '';
  if (name === 'TimeoutError') return { error: 'browser_timeout', retryable: true };
  const m = String(err?.message ?? '');
  if (m.includes('net::ERR_BLOCKED_BY_CLIENT')) return { error: 'browser_host_denied', retryable: false };
  if (m.includes('strict mode violation')) return { error: 'browser_ambiguous_locator', retryable: false };
  if (m.includes('net::')) return { error: 'browser_network_error', retryable: true };
  return { error: 'browser_error', retryable: false };
}

let idle = setTimeout(shutdown, IDLE_EXIT_MS);
async function shutdown() {
  try {
    await browser?.close();
  } finally {
    process.exit(0);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  clearTimeout(idle);
  idle = setTimeout(shutdown, IDLE_EXIT_MS);
  if (msg.type === 'init') {
    config = {
      hosts: Array.isArray(msg.hosts) ? msg.hosts.map((h) => String(h).toLowerCase()) : [],
      plainHttp: Array.isArray(msg.plainHttp) ? msg.plainHttp.map((h) => String(h).toLowerCase()) : [],
      proxy: typeof msg.proxy === 'string' ? msg.proxy : null,
      executablePath: typeof msg.executablePath === 'string' ? msg.executablePath : null,
      canned: Array.isArray(msg.canned) ? msg.canned : null,
      publicRead: msg.publicRead === true,
    };
    emit({ type: 'ready' });
    return;
  }
  if (msg.type === 'close') return shutdown();
  if (!config) return emit({ id: msg.id, ok: false, error: 'browser_not_started', retryable: false });
  try {
    const result = await handle(msg);
    emit({ id: msg.id, ok: true, result: result ?? null, blocked: [...blocked] });
  } catch (err) {
    // Error messages can quote page text, so they are only shown when debugging the driver by hand.
    if (process.env.DTY_DEBUG) process.stderr.write(`${err?.stack ?? err}\n`);
    emit({ id: msg.id, ok: false, ...errorCode(err), blocked: [...blocked] });
  }
});
rl.on('close', shutdown);

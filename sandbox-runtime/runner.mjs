// Dittoly sandbox runner. Runs inside the isolated process or container.
//
// It loads one Super-Module and runs one action (or, with --serve, one action after another:
// the warm workers of an exported app). The only way out is the
// newline-delimited JSON protocol on stdin/stdout; every HTTP request goes to
// the engine's broker, which enforces the manifest and attaches credentials.
// The module never sees a secret.
//
// Plain JavaScript on purpose: it is copied into the sandbox as-is.

import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const send = process.stdout.write.bind(process.stdout);
const emit = (msg) => send(JSON.stringify(msg) + '\n');

// Modules get no environment at all (the process backend already starts with an empty one;
// a container adds defaults such as PATH and HOSTNAME).
for (const k of Object.keys(process.env)) delete process.env[k];

// Module output may contain personal data; it is never logged.
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) console[k] = () => {};

class ActionError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

// Modules may not signal other processes (the process backend runs as the server's own user,
// so process.kill(process.ppid) would stop the server). process.kill calls process._kill.
for (const k of ['kill', '_kill']) {
  Object.defineProperty(process, k, {
    value: () => {
      throw new ActionError('process_signal_denied');
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

const pending = new Map();
let nextId = 1;

/** A multipart part: { name, value } for text, or { name, filename, dataUrl } for a file (e.g. a screenshot). */
function part(p) {
  const m = typeof p?.dataUrl === 'string' ? /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(p.dataUrl) : null;
  if (m) return { name: String(p.name), filename: String(p.filename ?? 'file'), contentType: m[1], data: m[2] };
  return { name: String(p?.name), value: String(p?.value ?? '') };
}

function request(req) {
  const id = nextId++;
  const outbound = {
    method: String(req?.method ?? 'GET').toUpperCase(),
    url: String(req?.url ?? ''),
    headers: req?.headers && typeof req.headers === 'object' ? req.headers : {},
    credential: req?.credential ?? null,
    body: req?.json !== undefined ? JSON.stringify(req.json) : req?.body ?? null,
    json: req?.json !== undefined,
    multipart: Array.isArray(req?.multipart) ? req.multipart.map(part) : null,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    emit({ type: 'http', id, request: outbound });
  });
}

/** SMTP, AMQP, MQTT, WebSocket and SSE calls: the broker checks and makes them. */
function call(kind, req) {
  const id = nextId++;
  // Only plain data crosses the boundary.
  const request = JSON.parse(JSON.stringify(req ?? {}));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    emit({ type: 'call', id, kind, request });
  });
}

// ------------------------------------------------------------------ browser scripts
//
// ctx.page looks like a Playwright page, but every call is a plain-data request
// to the broker, which owns the real browser. Locators are recorded as a chain
// of builder calls and replayed there.

const BUILDERS = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByAltText', 'getByTitle', 'first', 'last', 'nth', 'filter'];
const LOCATOR_OPS = [
  'click', 'dblclick', 'fill', 'press', 'pressSequentially', 'check', 'uncheck', 'selectOption', 'hover', 'focus', 'clear',
  'textContent', 'innerText', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isChecked', 'isEnabled', 'isDisabled', 'count',
  'allTextContents', 'allInnerTexts', 'waitFor', 'screenshot', 'scrollIntoViewIfNeeded',
];
const PAGE_OPS = ['goto', 'reload', 'goBack', 'goForward', 'url', 'title', 'content', 'waitForURL', 'waitForLoadState', 'waitForTimeout', 'screenshot', 'setViewportSize'];

function wire(v) {
  if (v instanceof RegExp) return { $regex: v.source, flags: v.flags };
  if (Array.isArray(v)) return v.map(wire);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)]));
  return v;
}

function makeLocator(pageId, chain) {
  const loc = { __page: pageId, __chain: chain };
  for (const b of BUILDERS) loc[b] = (...a) => makeLocator(pageId, [...chain, [b, wire(a)]]);
  for (const op of LOCATOR_OPS) loc[op] = async (...a) => call('browser', { op, page: await pageId(), chain, args: wire(a) });
  /** Type the member's own credential; the script never sees it. part: 'username' | 'password' for a username:password credential. */
  loc.fillSecret = async (credential, options = {}) => call('browser', { op: 'fillSecret', page: await pageId(), chain, credential, part: options.part });
  return Object.freeze(loc);
}

function makePage() {
  let id = null;
  const pageId = async () => (id ??= call('browser', { op: 'newPage' }));
  const page = { __page: pageId, __chain: [] };
  for (const b of BUILDERS.slice(0, 8)) page[b] = (...a) => makeLocator(pageId, [[b, wire(a)]]);
  for (const op of PAGE_OPS) page[op] = async (...a) => call('browser', { op, page: await pageId(), chain: [], args: wire(a) });
  /** Ask the run's member to take over in the live view (sign in, solve a captcha...); waits until they press Continue. */
  page.askForHelp = async (message) => {
    await pageId();
    return call('browser', { op: 'askForHelp', message: String(message ?? '') });
  };
  page.keyboard = Object.freeze({
    press: async (key) => call('browser', { op: 'keyboard.press', page: await pageId(), chain: [], args: [key] }),
    type: async (text) => call('browser', { op: 'keyboard.type', page: await pageId(), chain: [], args: [text] }),
  });
  return Object.freeze(page);
}

const BROWSER_MATCHERS = ['toBeVisible', 'toBeHidden', 'toBeChecked', 'toBeEnabled', 'toBeDisabled', 'toHaveText', 'toContainText', 'toHaveValue', 'toHaveCount', 'toHaveAttribute', 'toHaveTitle', 'toHaveURL'];

function fail() {
  throw new ActionError('expectation_failed');
}

/** expect(locator | page) checks in the browser, retrying until a timeout; expect(value) checks plain values. */
function expect(target, options = {}) {
  const build = (not) => {
    const m = {};
    if (target && typeof target === 'object' && typeof target.__page === 'function') {
      for (const name of BROWSER_MATCHERS) {
        m[name] = async (...a) => {
          const last = a.length && a[a.length - 1] && typeof a[a.length - 1] === 'object' && !(a[a.length - 1] instanceof RegExp) ? a[a.length - 1] : {};
          await call('browser', { op: 'expect', page: await target.__page(), chain: target.__chain, name, args: wire(a), not, timeout: last.timeout ?? options.timeout });
        };
      }
    } else {
      const check = (ok) => (ok !== not ? undefined : fail());
      m.toBe = (x) => check(Object.is(target, x));
      m.toEqual = (x) => check(JSON.stringify(target) === JSON.stringify(x));
      m.toBeTruthy = () => check(!!target);
      m.toBeFalsy = () => check(!target);
      m.toBeDefined = () => check(target !== undefined);
      m.toBeNull = () => check(target === null);
      m.toContain = (x) => check(typeof target === 'string' ? target.includes(x) : Array.isArray(target) && target.includes(x));
      m.toMatch = (x) => check(typeof target === 'string' && (x instanceof RegExp ? x.test(target) : target.includes(x)));
      m.toHaveLength = (n) => check(target?.length === n);
      m.toBeGreaterThan = (n) => check(target > n);
      m.toBeGreaterThanOrEqual = (n) => check(target >= n);
      m.toBeLessThan = (n) => check(target < n);
      m.toBeLessThanOrEqual = (n) => check(target <= n);
    }
    return m;
  };
  const matchers = build(false);
  matchers.not = Object.freeze(build(true));
  return Object.freeze(matchers);
}

function toResponse(r) {
  return {
    status: r.status,
    headers: r.headers,
    body: r.body,
    ok: r.status >= 200 && r.status < 300,
    json() {
      return JSON.parse(r.body);
    },
  };
}

const safeCode = (c) => (typeof c === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c.toLowerCase() : 'module_error');

const SERVE = process.argv[3] === '--serve';

async function invoke(msg) {
  let mod;
  try {
    mod = await import(pathToFileURL(process.argv[2]).href);
  } catch {
    emit({ type: 'error', errorType: 'module_load_failed', retryable: false });
    return;
  }
  const actions = mod.actions;
  if (!actions || typeof actions !== 'object') {
    emit({ type: 'error', errorType: 'module_has_no_actions', retryable: false });
    return;
  }
  if (msg.action === '__describe') {
    emit({ type: 'result', output: { actions: Object.keys(actions).filter((k) => typeof actions[k] === 'function') } });
    return;
  }
  const fn = actions[msg.action];
  if (typeof fn !== 'function') {
    emit({ type: 'error', errorType: 'unknown_action', retryable: false });
    return;
  }
  const settings = Object.freeze({ ...(msg.settings && typeof msg.settings === 'object' ? msg.settings : {}) });
  let page = null;
  const ctx = Object.freeze({
    http: Object.freeze({ request }),
    smtp: Object.freeze({ send: (m) => call('smtp.send', m) }),
    amqp: Object.freeze({ publish: (m) => call('amqp.publish', m) }),
    mqtt: Object.freeze({ publish: (m) => call('mqtt.publish', m) }),
    ws: Object.freeze({ exchange: (m) => call('ws.exchange', m) }),
    sse: Object.freeze({ read: (m) => call('sse.read', m) }),
    db: Object.freeze({ query: (m) => call('db.query', m) }),
    // A browser page is started on first use, only for modules with a "browser" section.
    get page() {
      return (page ??= makePage());
    },
    expect,
    settings,
    ActionError,
  });
  try {
    const output = await fn(msg.input, ctx);
    emit({ type: 'result', output: output === undefined ? null : output });
  } catch (err) {
    emit({ type: 'error', errorType: safeCode(err?.code), retryable: err?.retryable === true });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'invoke') {
    // A warm worker waits for the next action; a one-shot runner exits.
    if (SERVE) invoke(msg);
    else
      invoke(msg).finally(() => {
        rl.close();
        // Give stdout a moment to flush, then exit.
        setImmediate(() => process.exit(0));
      });
  } else if (msg.type === 'http_result' || msg.type === 'http_error' || msg.type === 'call_result') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'http_result') p.resolve(toResponse(msg.response));
    else if (msg.type === 'call_result') p.resolve(msg.result);
    else p.reject(new ActionError(msg.error, { retryable: msg.retryable === true }));
  }
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest, reviewSummary, type Manifest } from '../src/modules/manifest.js';
import { playwrightToModule } from '../src/modules/playwright-import.js';
import { validateModule } from '../src/modules/validate.js';
import { LocalBrowserLauncher, proxyAllowList } from '../src/sandbox/browser.js';
import { Broker } from '../src/sandbox/broker.js';
import { ProcessRunner } from '../src/sandbox/runner.js';
import { makeWorld, runStatus } from './helpers.js';

/**
 * Browser scripts: the module drives ctx.page, but the browser belongs to the
 * broker. Pages load only declared hosts, secrets are typed only on the
 * credential's hosts and never come back to the script.
 */
const CHROMIUM = process.env.DITTOLY_CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = new LocalBrowserLauncher(CHROMIUM);
const runner = new ProcessRunner();

const LOGIN_PAGE = `<!doctype html><title>Sign in</title>
<form onsubmit="event.preventDefault(); document.querySelector('#out').textContent = 'Welcome, ' + document.querySelector('#user').value; document.title = 'Dashboard'">
<label>Email <input id="user"></label><label>Password <input id="pw" type="password"></label>
<button>Sign in</button></form><p id="out"></p>`;

const manifest = (hosts: string[]) => ({
  name: 'portal-check',
  version: '1.0.0',
  title: 'Portal check',
  description: 'Signs in to the portal and checks the dashboard. Needs your portal login.',
  hosts: [],
  browser: { hosts },
  credentials: [{ id: 'login', service: 'portal', label: 'Portal email and password', hosts: [hosts[0]!], placement: { type: 'basic' } }],
  actions: [
    {
      name: 'sign_in',
      title: 'Sign in and check',
      description: 'Signs in and returns the greeting.',
      effect: 'read',
      credentials: ['login'],
      input: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      output: {
        type: 'object',
        properties: { greeting: { type: 'string' }, title: { type: 'string' }, typed: { type: 'string' }, shot: { type: 'string' } },
        required: ['greeting', 'title'],
      },
    },
  ],
});

const code = `export const actions = {
  async sign_in(input, { page, expect }) {
    await page.goto(input.url);
    await expect(page).toHaveTitle('Sign in');
    await page.getByLabel('Email').fillSecret('login', { part: 'username' });
    await page.getByLabel('Password').fillSecret('login', { part: 'password' });
    // A field a secret went into cannot be read back.
    const typed = await page.getByLabel('Password').inputValue().catch((e) => e.code);
    // Sealed fields are masked in screenshots.
    const shot = await page.screenshot();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#out')).toContainText('Welcome');
    await expect(page).toHaveTitle('Dashboard');
    return { greeting: await page.locator('#out').textContent(), title: await page.title(), typed, shot };
  },
};`;

describe('browser modules', () => {
  it('declare the sites the browser may load; the approver reads them and where secrets may be typed', () => {
    const m = (parseManifest(manifest(['portal.example.com', '*.cdn.example.com'])) as { manifest: Manifest }).manifest;
    const summary = reviewSummary(m);
    expect(summary).toContain('It drives a headless BROWSER that may load pages only from: portal.example.com, *.cdn.example.com');
    expect(summary).toContain('It can type the running member\'s own "Portal email and password" into pages on portal.example.com');
    expect(parseManifest({ ...manifest(['portal.example.com']), browser: { hosts: ['https://x.com/'] } }).ok).toBe(false);
    expect(proxyAllowList({ hosts: ['a.example.com', '*.b.example.com', 'c.local:8080'], plainHttp: ['a.example.com'] })).toEqual(['a.example.com:443', 'a.example.com:80', '**.b.example.com:443', 'c.local:8080']);
    // Reading the public web: any host on 443 at the proxy (which still refuses private addresses).
    expect(proxyAllowList({ hosts: ['a.example.com'], plainHttp: [], publicRead: true })).toEqual(['*:443', 'a.example.com:443']);
  });

  it('sandbox tests run the script in a real browser against canned pages; secrets are typed but never returned', async () => {
    const tests = [
      {
        name: 'signs in',
        action: 'sign_in',
        input: { url: 'https://portal.example.com/login' },
        http: [],
        expectOk: true,
        pages: [{ urlPrefix: 'https://portal.example.com/login', status: 200, contentType: 'text/html', body: LOGIN_PAGE }],
      },
    ];
    const { report } = await validateModule(runner, manifest(['portal.example.com']), code, tests, { browser });
    expect(report.tests[0]).toMatchObject({ passed: true });
  }, 60_000);

  describe('against live pages through the egress proxy', () => {
    let site: http.Server;
    let other: http.Server;
    let host: string;
    let otherHost: string;
    const otherHits: string[] = [];
    beforeAll(async () => {
      other = http.createServer((req, res) => {
        otherHits.push(req.url ?? '');
        res.end('tracker');
      });
      await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
      otherHost = `127.0.0.1:${(other.address() as AddressInfo).port}`;
      site = http.createServer((req, res) => {
        res.setHeader('content-type', 'text/html');
        if (req.url === '/login') res.end(LOGIN_PAGE.replace('<p id="out">', `<img src="http://${otherHost}/pixel.gif"><p id="out">`));
        else res.end('<title>Elsewhere</title>');
      });
      await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
      host = `127.0.0.1:${(site.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      site.close();
      other.close();
    });

    const broker = (hosts: string[]) =>
      new Broker({
        manifest: (parseManifest(manifest(hosts)) as { manifest: Manifest }).manifest,
        action: 'sign_in',
        resolveSecret: async () => 'jane@example.com:hunter2-secret',
        insecureHttpHosts: [host, otherHost],
        internalHosts: [host, otherHost],
        browser,
      });

    it('runs the script; undeclared hosts the page asks for are blocked and reported, never reached', async () => {
      const b = broker([host]);
      const r = await runner.invoke({ code, action: 'sign_in', input: { url: `http://${host}/login` }, broker: b, timeoutMs: 45_000 }).finally(() => b.close());
      // Both parts of the login were typed by the broker, so neither comes back to the script.
      expect(r).toMatchObject({ ok: true, output: { greeting: 'Welcome, ••••••', title: 'Dashboard', typed: 'browser_secret_field' } });
      expect((r as { output: { shot: string } }).output.shot).toMatch(/^data:image\/jpeg;base64,\/9j\//);
      expect(b.violations).toEqual([]);
      expect(b.browserBlocked).toEqual([otherHost]);
      expect(otherHits).toEqual([]);
    }, 60_000);

    it('navigating to an undeclared host is a violation', async () => {
      const b = broker([host]);
      const r = await runner.invoke({ code, action: 'sign_in', input: { url: `http://${otherHost}/login` }, broker: b, timeoutMs: 45_000 }).finally(() => b.close());
      expect(r.ok).toBe(false);
      expect({ r, violations: b.violations }).toMatchObject({ violations: ['browser_host_denied'] });
      expect(otherHits).toEqual([]);
    }, 60_000);

    it('a secret is typed only into a page on the credential\'s own hosts', async () => {
      // The browser may load both sites, but the credential belongs to the first.
      const m = manifest([otherHost, host]);
      const b = new Broker({
        manifest: (parseManifest(m) as { manifest: Manifest }).manifest,
        action: 'sign_in',
        resolveSecret: async () => 'jane@example.com:hunter2-secret',
        insecureHttpHosts: [host, otherHost],
        internalHosts: [host, otherHost],
        browser,
      });
      const r = await runner.invoke({ code, action: 'sign_in', input: { url: `http://${host}/login` }, broker: b, timeoutMs: 45_000 }).finally(() => b.close());
      expect(r.ok).toBe(false);
      expect({ r, violations: b.violations }).toMatchObject({ violations: ['credential_denied_host'] });
    }, 60_000);

    it('runs as a Flow step with the member\'s own login, and the screenshot is kept with the step output', async () => {
      const w = await makeWorld({ mode: 'local', insecureHttpHosts: [host, otherHost], internalHosts: [host, otherHost] }, { browser });
      try {
        const mv = await w.app.modules.createDraft(
          {
            manifest: manifest([host]),
            code,
            tests: [{ name: 'signs in', action: 'sign_in', input: { url: `http://${host}/login` }, http: [], expectOk: true, pages: [{ urlPrefix: `http://${host}/login`, body: LOGIN_PAGE }] }],
            origin: 'seed',
          },
          w.alice,
        );
        expect(mv.validationReport?.passed).toBe(true);
        await w.app.modules.submit(mv.id, w.alice);
        await w.app.modules.decide(mv.id, w.admin, 'approved');
        const v = await w.app.flows.create('Check the portal', { steps: [{ id: 'check', type: 'action', module: 'portal-check@1.0.0', action: 'sign_in', input: { url: `http://${host}/login` } }] }, w.alice);
        await w.app.flows.decide(v.id, w.approver, 'approved');
        await w.app.vault.put(w.alice.id, 'portal', 'alice@example.com:alice-pw');
        const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
        await w.app.worker.drain();
        const run = await runStatus(w, runId, w.alice);
        expect(run.status).toBe('succeeded');
        const out = run.steps.find((s) => s.id === 'check')!.output as { title: string; shot: string };
        expect(out.title).toBe('Dashboard');
        expect(out.shot).toMatch(/^data:image\/jpeg;base64,/);
      } finally {
        await w.db.end();
      }
    }, 90_000);
  });
});

describe('secrets in the browser stay out of the script\'s reach', () => {
  // Characters that encode differently in URLs, forms and HTML.
  const USER = "jane+o'neil@example.com";
  const PASSWORD = 'p&ss <w>xq"1';
  const PAGE = `<!doctype html><title>Sign in</title>
<form action="https://portal.example.com/done" method="get">
<label>Email <input id="user" name="u"></label><label>Password <input id="pw" name="p" type="password"></label>
<button type="button" id="remember" onclick="document.querySelector('#echo').textContent = document.querySelector('#user').value; document.querySelector('#echo').setAttribute('data-p', document.querySelector('#pw').value)">Remember me</button>
<button>Sign in</button></form><div id="echo"></div>`;
  const DONE = `<!doctype html><title>Done</title><h1>Signed in</h1><p id="rtc"></p>
<script>document.querySelector('#rtc').textContent = [typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof RTCDataChannel].join(',')</script>`;
  const probe = `export const actions = {
  async sign_in(input, { page, expect }) {
    const tryIt = (p) => p.then(() => 'ok', (e) => e.code);
    await page.goto(input.url);
    await page.getByLabel('Email').fillSecret('login', { part: 'username' });
    const pw = page.getByLabel('Password');
    await pw.fillSecret('login', { part: 'password' });
    const out = {
      read: await tryIt(pw.inputValue()),
      attribute: await tryIt(pw.getAttribute('value')),
      backspace: await tryIt(pw.press('Backspace')),
      fill: await tryIt(pw.fill('x')),
      clear: await tryIt(pw.clear()),
      focus: await tryIt(pw.focus()),
      typeInto: await tryIt(page.keyboard.type('x')),
      arrow: await tryIt(page.keyboard.press('ArrowLeft')),
      selectAll: await tryIt(page.keyboard.press('Control+A')),
      pattern: await tryIt(expect(pw).toHaveValue(/^p/)),
      exact: await tryIt(expect(pw).toHaveValue(${JSON.stringify(PASSWORD)})),
      titlePattern: await tryIt(expect(page).toHaveTitle(/Sign/)),
      title: await tryIt(expect(page).toHaveTitle('Sign in')),
      fieldShot: await tryIt(pw.screenshot()),
      visible: await tryIt(expect(pw).toBeVisible()),
    };
    await page.locator('#remember').click();
    out.echo = await page.locator('#echo').textContent();
    out.echoAttr = await page.locator('#echo').getAttribute('data-p');
    out.echoPattern = await tryIt(expect(page.locator('#echo')).toHaveText(/jane/));
    out.content = await page.content();
    out.pageShot = await tryIt(page.screenshot());
    // Submitting is fine: Enter in the field, or the button.
    await pw.press('Enter');
    await page.waitForURL('https://portal.example.com/done**');
    out.url = await page.url();
    out.heading = await page.locator('h1').textContent();
    out.rtc = await page.locator('#rtc').textContent();
    return out;
  },
};`;

  it('sealed fields cannot be read, edited or tested; encoded copies are blanked out; WebRTC is off', async () => {
    const m = (parseManifest(manifest(['portal.example.com'])) as { manifest: Manifest }).manifest;
    const b = new Broker({
      manifest: m,
      action: 'sign_in',
      resolveSecret: async () => `${USER}:${PASSWORD}`,
      browser,
      cannedPages: [
        { urlPrefix: 'https://portal.example.com/login', body: PAGE },
        { urlPrefix: 'https://portal.example.com/done', body: DONE },
      ],
    });
    const r = await runner.invoke({ code: probe, action: 'sign_in', input: { url: 'https://portal.example.com/login' }, broker: b, timeoutMs: 45_000 }).finally(() => b.close());
    expect(r.ok).toBe(true);
    const out = (r as { output: Record<string, string> }).output;
    expect(out).toMatchObject({
      read: 'browser_secret_field',
      attribute: 'browser_secret_field',
      backspace: 'browser_secret_field',
      fill: 'browser_secret_field',
      clear: 'browser_secret_field',
      focus: 'ok',
      typeInto: 'browser_secret_field',
      arrow: 'browser_secret_field',
      selectAll: 'browser_secret_field',
      pattern: 'browser_secret_pattern',
      exact: 'browser_secret_field',
      titlePattern: 'browser_secret_pattern',
      title: 'ok',
      fieldShot: 'ok',
      visible: 'ok',
      echo: '••••••',
      echoAttr: '••••••',
      echoPattern: 'browser_secret_pattern',
      pageShot: 'browser_secret_field',
      heading: 'Signed in',
      rtc: 'undefined,undefined,undefined',
    });
    // The form put both parts in the URL, form-encoded; the page holds them HTML-escaped.
    expect(out.url).toBe('https://portal.example.com/done?u=••••••&p=••••••');
    for (const text of [out.url, out.content]) {
      for (const secret of [USER, PASSWORD]) {
        for (const form of [secret, encodeURIComponent(secret), new URLSearchParams({ x: secret }).toString().slice(2), secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')]) {
          expect(text).not.toContain(form);
        }
      }
      expect(text).not.toContain('neil');
      expect(text).not.toContain('xq');
    }
  }, 60_000);

  it('a field a person typed into while helping is sealed the same way', async () => {
    const session = await browser.start({ hosts: ['portal.example.com'], plainHttp: [], allowPrivate: [], canned: [{ urlPrefix: 'https://portal.example.com/login', body: PAGE }] });
    try {
      const page = (await session.send({ op: 'newPage' })).result;
      await session.send({ op: 'goto', page, chain: [], args: ['https://portal.example.com/login'] });
      const pw = [['locator', ['#pw']]];
      // The person clicks into the field and types (the live view), then hands back.
      await session.send({ op: 'focus', page, chain: pw, args: [] });
      expect(await session.send({ op: 'live.type', text: 'typed-by-hand' })).toMatchObject({ ok: true });
      await session.send({ op: 'live.done' });
      expect(await session.send({ op: 'inputValue', page, chain: pw, args: [] })).toMatchObject({ ok: false, error: 'browser_secret_field' });
      expect(await session.send({ op: 'expect', page, chain: pw, name: 'toHaveValue', args: [{ $regex: '^t' }] })).toMatchObject({ ok: false, error: 'browser_secret_pattern' });
      expect(await session.send({ op: 'keyboard.press', page, chain: [], args: ['Backspace'] })).toMatchObject({ ok: false, error: 'browser_secret_field' });
      // Other fields are the script's as before.
      await session.send({ op: 'fill', page, chain: [['locator', ['#user']]], args: ['someone'] });
      expect(await session.send({ op: 'inputValue', page, chain: [['locator', ['#user']]], args: [] })).toMatchObject({ ok: true, result: 'someone' });
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe('pasted Playwright scripts', () => {
  let shop: http.Server;
  let shopHost: string;
  beforeAll(async () => {
    shop = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/cart') res.end('<title>Cart</title><p>Your cart is empty</p>');
      else res.end('<title>Acme Shop</title><a href="/cart">Cart</a>');
    });
    await new Promise<void>((r) => shop.listen(0, '127.0.0.1', r));
    shopHost = `127.0.0.1:${(shop.address() as AddressInfo).port}`;
  });
  afterAll(() => shop.close());

  const script = (h: string) => `import { test, expect } from '@playwright/test';

test.describe('shop', () => {
  test('has title', async ({ page }) => {
    await page.goto('http://${h}/');
    await expect(page).toHaveTitle(/Shop/);
  });

  test('empty cart', async ({ page }) => {
    await page.goto('http://${h}/');
    await test.step('open the cart', async () => {
      await page.getByRole('link', { name: 'Cart' }).click();
    });
    await expect(page.getByText('Your cart is empty')).toBeVisible();
  });
});
`;

  it('become a browser module with one action per test, checked live against the sites it visits', async () => {
    const w = await makeWorld({ mode: 'local', insecureHttpHosts: [shopHost], internalHosts: [shopHost] }, { browser });
    const api = (await import('../src/api/server.js')).buildServer(w.app);
    try {
      const res = await api.inject({
        method: 'POST',
        url: '/api/modules/import-playwright',
        headers: { authorization: `Bearer ${w.tokens.alice}` },
        payload: { name: 'shop-smoke', title: 'Shop smoke test', script: script(shopHost) },
      });
      expect(res.statusCode).toBe(201);
      const review = res.json();
      expect(review.manifest.browser).toEqual({ hosts: [shopHost] });
      expect(review.manifest.actions.map((a: { name: string }) => a.name)).toEqual(['has_title', 'empty_cart']);
      expect(review.validationReport.passed).toBe(true);
      expect(review.validationReport.tests).toEqual([
        expect.objectContaining({ name: 'has title (live)', passed: true, live: true }),
        expect.objectContaining({ name: 'empty cart (live)', passed: true, live: true }),
      ]);
      expect(review.summary).toContain(`It drives a headless BROWSER that may load pages only from: ${shopHost}`);

      // A failing expectation fails the live test.
      const broken = await api.inject({
        method: 'POST',
        url: '/api/modules/import-playwright',
        headers: { authorization: `Bearer ${w.tokens.alice}` },
        payload: { name: 'shop-broken', title: 'Broken', script: script(shopHost).replace('/Shop/', '/Nope/') },
      });
      expect(broken.json().validationReport.tests[0]).toMatchObject({ passed: false, errorType: 'expectation_failed' });

      const refused = await api.inject({
        method: 'POST',
        url: '/api/modules/import-playwright',
        headers: { authorization: `Bearer ${w.tokens.alice}` },
        payload: { name: 'shop-eval', title: 'Eval', script: `test('x', async ({ page }) => { await page.goto('https://a.example.com/'); await page.evaluate(() => 1); });` },
      });
      expect(refused.json()).toMatchObject({ error: 'script_unsupported' });
    } finally {
      await api.close();
      await w.db.end();
    }
  }, 120_000);

  it('a plain script loses its own browser setup; sign-in scripts are sent to the AI path', () => {
    const { manifest: m, code: c } = playwrightToModule({
      name: 'plain',
      title: 'Plain',
      script: `const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://example.com/');
  await browser.close();
})();`,
    });
    expect((m as { actions: { name: string }[] }).actions.map((a) => a.name)).toEqual(['run']);
    expect(c).not.toContain('chromium.launch');
    expect(c).toContain("await page.goto('https://example.com/');");
    expect(() => playwrightToModule({ name: 'login', title: 'L', script: `test('l', async ({ page }) => { await page.goto('https://a.example.com/'); await page.fill('#password', 'hunter2'); });` })).toThrow(/signing in/);
  });
});

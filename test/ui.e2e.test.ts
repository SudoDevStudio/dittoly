import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { buildApp } from '../src/app.js';
import { createMember, type Member } from '../src/core/members.js';
import { putTeamCredential, setCredentialMode } from '../src/core/team-credentials.js';
import { defaultTeamFor } from '../src/core/teams.js';
import type { App } from '../src/app.js';
import { LocalBrowserLauncher } from '../src/sandbox/browser.js';
import { approveExampleModules, FakeApps, freshDb, pdfOf, releaseFlow, testConfig, type World } from './helpers.js';
import { readFile } from 'node:fs/promises';
import http from 'node:http';

/**
 * Drives the built portal in a real browser against a real server (local mode:
 * one member who is also admin and approver). Needs `npm run web:build` first
 * and a Chromium; skipped otherwise.
 */
const WEB_ROOT = path.resolve(import.meta.dirname, '..', 'dist', 'web');
const CHROMIUM = process.env.DITTOLY_CHROMIUM ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env.DITTOLY_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
const ready = existsSync(path.join(WEB_ROOT, 'index.html')) && existsSync(CHROMIUM);
/** Where a failed test leaves its screenshot, URL, browser errors and Playwright trace (CI uploads them). */
const ARTIFACTS = path.resolve(process.env.DITTOLY_TEST_ARTIFACTS ?? path.join(import.meta.dirname, '..', 'test-artifacts'));
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);

describe.skipIf(!ready)('web portal (browser)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let base: string;
  let token: string;
  let close: () => Promise<void>;
  const browserErrors: string[] = [];
  /** Console errors (the page's error screen logs what crashed there); only reported when a test explains a failure. */
  const consoleErrors: string[] = [];
  let appRef: App;
  let meRef: Member;
  const ai = new MockProvider();
  const fake = new FakeApps();
  // A site for browser scripts to test, on a local address the server is told to allow.
  let shop: http.Server;
  let shopHost: string;

  beforeAll(async () => {
    shop = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url === '/cart' ? '<title>Cart</title><p>Your cart is empty</p>' : '<title>Acme Shop</title><a href="/cart">Cart</a>');
    });
    await new Promise<void>((r) => shop.listen(0, '127.0.0.1', r));
    shopHost = `127.0.0.1:${(shop.address() as AddressInfo).port}`;
    const db = await freshDb();
    const app = buildApp(testConfig({ mode: 'local', insecureHttpHosts: [shopHost], internalHosts: [shopHost] }), db, {
      ai,
      fetchImpl: fake.fetch,
      actionTimeoutMs: 30_000,
      browser: new LocalBrowserLauncher(CHROMIUM),
      gitFileRemotes: true,
    });
    const me = await createMember(db, 'me', 'admin', null);
    token = me.token;
    appRef = app;
    meRef = me.member;
    // Example modules approved, and the member's own credentials.
    await approveExampleModules({ app, db, admin: me.member, alice: me.member } as unknown as World);
    for (const [svc, secret] of [['jira', 'me@acme.test:t'], ['gitlab', 'glpat-me'], ['slack', 'xoxb-me']]) await app.vault.put(me.member.id, svc!, secret!);
    const f = await releaseFlow();
    await app.flows.create('Release coordination', f.definition, me.member);

    const server = buildServer(app, { webRoot: WEB_ROOT });
    await server.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    app.worker.start(50);
    browser = await chromium.launch({ executablePath: CHROMIUM });
    context = await browser.newContext();
    // Traced throughout; each test's part is kept only when that test fails (afterEach).
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 500)); });
    close = async () => {
      await browser.close();
      await app.worker.stop();
      await server.close();
      await db.end();
      shop.close();
    };
  }, 60_000);
  afterAll(async () => close?.());

  // Every test signs in if it has to, so one can run on its own (vitest -t '…'); only the first checks signed-out.
  beforeEach(async (ctx) => {
    // Every test starts with no AI answers queued: one that stopped early cannot hand its answers to the next tests.
    const left = ai.clear();
    if (left) console.warn(`[ui.e2e] ${left} unused AI answer(s) from an earlier test dropped before "${ctx.task.name}"`);
    await context.tracing.startChunk({ title: ctx.task.name });
    if (ctx.task.name === 'shows the sign-in screen without a session') return;
    if (!(await context.cookies(base)).length) await page.goto(`${base}/auth/local?token=${token}&returnTo=/`);
  });
  afterEach(async (ctx) => {
    if (ctx.task.result?.state !== 'fail') return context.tracing.stopChunk();
    // Synthetic test data only; the Vitest error is printed next to it.
    const dir = path.join(ARTIFACTS, slug(ctx.task.name));
    mkdirSync(dir, { recursive: true });
    await context.tracing.stopChunk({ path: path.join(dir, 'trace.zip') });
    await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true }).catch(() => undefined);
    writeFileSync(path.join(dir, 'page.json'), JSON.stringify({ url: page.url(), browserErrors }, null, 2));
  });

  it('shows the sign-in screen without a session', async () => {
    await page.goto(`${base}/flows`);
    await page.getByText('Open the sign-in link that Dittoly printed').waitFor();
  });

  it('signs in with the local launcher link and shows the home page', async () => {
    await page.goto(`${base}/auth/local?token=${token}&returnTo=/`);
    // The home page opens on the chat; the work that needs you is under it.
    await page.getByRole('heading', { name: 'What do you want to automate, me?' }).waitFor();
    await page.getByRole('textbox', { name: 'What do you want to automate?' }).waitFor();
    await page.getByRole('navigation', { name: 'Needs you' }).getByText('awaiting your decision').waitFor();
    await page.getByRole('heading', { name: 'Pending Signoffs & Approvals' }).waitFor();
    await shot(page, '1-home');
  });

  it('groups the menu: Home and Create, then Build and Run, with the rest folded under More and Oversight; a hint on each entry', async () => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const g of ['Build', 'Run', 'More', 'Oversight']) await nav.getByRole('button', { name: g }).waitFor();
    await nav.getByRole('link', { name: 'Create', exact: true }).waitFor();
    // Less used pages start folded under More.
    await expect(nav.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).resolves.toBe('false');
    await expect(nav.getByRole('link', { name: 'Marketplace' }).isVisible()).resolves.toBe(false);
    await expect(nav.getByRole('link', { name: 'Modules', exact: true }).getAttribute('title')).resolves.toBe('Modules: Connections to your apps, reviewed before use');
    // Oversight starts folded; unfolding it is remembered.
    const oversight = nav.getByRole('button', { name: 'Oversight' });
    await expect(oversight.getAttribute('aria-expanded')).resolves.toBe('false');
    await expect(nav.getByRole('link', { name: 'Model changes' }).isVisible()).resolves.toBe(false);
    await oversight.click();
    await nav.getByRole('link', { name: 'Model changes' }).waitFor();
    await shot(page, '0-menu');
    await page.reload();
    await nav.getByRole('link', { name: 'Model changes' }).waitFor();
    // Folding Build hides its entries, but the group of the page you are on stays open.
    await nav.getByRole('button', { name: 'Build' }).click();
    await expect(nav.getByRole('link', { name: 'Flows', exact: true }).isVisible()).resolves.toBe(false);
    await page.goto(`${base}/flows`);
    await nav.getByRole('link', { name: 'Flows', exact: true }).waitFor();
    await nav.getByRole('button', { name: 'Build' }).waitFor();
    await expect(nav.getByRole('button', { name: 'Build' }).isDisabled()).resolves.toBe(true);
    await page.goto(`${base}/`);
    await nav.getByRole('button', { name: 'Build' }).click();
    await nav.getByRole('link', { name: 'Flows', exact: true }).waitFor();
  });

  it('serves the Dittoly mark as the favicon and shows it in the header', async () => {
    const icon = await page.request.get(`${base}/favicon.svg`);
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toContain('image/svg+xml');
    expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe('/favicon.svg');
    await page.locator('.brand .brand-mark svg path[d^="M22 18"]').waitFor();
  });

  it('approves a Flow, runs it, signs off the gate, and shows every step succeeded', async () => {
    await page.getByRole('link', { name: 'Flows', exact: true }).click();
    await page.getByRole('link', { name: 'Release coordination' }).click();
    await page.getByText('What it does').waitFor();
    // The approver reads the capability rows first; the step-by-step prose is one click under them.
    await expect(page.getByText('Changes data: Merge a merge request').isVisible()).resolves.toBe(true);
    await page.getByText(/^Step by step/).click();
    await expect(page.getByText('GitLab "Merge a merge request" CHANGES data').isVisible()).resolves.toBe(true);
    await shot(page, '2-flow-review');
    await page.getByRole('button', { name: 'Approve this version' }).click();
    await page.getByRole('heading', { name: 'Run v1 as yourself' }).waitFor();

    await page.locator('#f-release').fill('2.4');
    await page.locator('#f-jql').fill('fixVersion = 2.4');
    await page.locator('#f-project').fill('acme/app');
    await page.locator('#f-channel').fill('C-rel');
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.waitForURL(/\/runs\//);

    // The run page updates itself: wait for the gate without clicking Refresh.
    await page.getByRole('button', { name: 'Approve', exact: true }).waitFor({ timeout: 15_000 });
    await shot(page, '3-run-waiting-gate');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.locator('.page-head .badge', { hasText: 'succeeded' }).waitFor({ timeout: 15_000 });
    await expect(page.locator('.page-head .badge').innerText()).resolves.toBe('succeeded');
    await expect(page.locator('.steps .badge').allInnerTexts()).resolves.toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(fake.merged).toEqual([7, 8]);
  });

  it('shows each step\'s output readably after the run ends, with paths to use in later steps', async () => {
    await page.getByText('Inputs and outputs are kept, encrypted, until').waitFor();
    await page.getByRole('heading', { name: 'Inputs' }).waitFor();
    await page.getByRole('button', { name: 'inputs.release', exact: true }).waitFor();
    const first = page.locator('.steps > li').first();
    await first.locator('.output-view').waitFor();
    expect(await first.locator('.path-chip').count()).toBeGreaterThan(0);
    expect((await first.locator('.path-chip').first().innerText()).startsWith('steps.')).toBe(true);
    await first.getByRole('tab', { name: 'Raw JSON' }).click();
    await expect(first.locator('.output-view pre').innerText()).resolves.toContain('{');
    await shot(page, '3b-run-outputs');
  });

  it('changes the run view by chat: "hide merge requests" hides the GitLab steps only', async () => {
    ai.enqueue({ configJson: JSON.stringify({ hideModules: ['gitlab'], hideStatuses: [], showOutputs: true, compact: false }), reply: 'Done.' });
    await page.getByPlaceholder('How should run pages look?').fill('hide merge requests');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByText('2 hidden by your view').waitFor();
    await shot(page, '4-run-custom-view');
    await expect(page.locator('.steps li').count()).resolves.toBe(3);
    await page.getByRole('button', { name: 'Reset view' }).click();
    await page.locator('.steps li').nth(4).waitFor();
    await expect(page.getByText('hidden by your view').count()).resolves.toBe(0);
  });

  it('stores a credential without ever showing it again', async () => {
    await page.getByRole('link', { name: 'My credentials' }).click();
    await page.locator('#svc').fill('github');
    await page.getByLabel('Token or secret').fill('ghp_supersecret');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('github', { exact: true }).waitFor();
    await expect(page.content()).resolves.not.toContain('ghp_supersecret');
  });

  it('persists the day theme and finds Flows through workspace search', async () => {
    await page.getByRole('button', { name: 'Switch to day theme' }).click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    await page.reload();
    await page.getByRole('heading', { name: 'My credentials & webhooks' }).waitFor();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    await page.getByRole('button', { name: 'Search your workspace…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search workspace' });
    await dialog.getByRole('textbox').fill('Release coordination');
    await dialog.getByRole('button', { name: 'Release coordination' }).click();
    await page.getByRole('heading', { name: 'Flow review' }).waitFor();
    expect(await page.locator('.graph-node').count()).toBe(5);
    // What the person said is readable in day mode too: the bubble's own background, not a night-only colour.
    const bubble = page.locator('.bubble.user').first();
    if (await bubble.count()) {
      const seen = await bubble.evaluate((el) => {
        const s = getComputedStyle(el);
        const rgb = (v: string) => (v.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
        const lum = (c: number[]) => c.map((x) => x / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((a, b, i) => a + b * [0.2126, 0.7152, 0.0722][i]!, 0);
        const a = lum(rgb(s.backgroundColor));
        const b = lum(rgb(s.color));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(seen).toBeGreaterThan(4.5);
    }
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  });

  it('an approver reads what approving allows as rows, and what it can never do', async () => {
    await page.goto(`${base}/flows`);
    await page.locator('table').getByRole('link', { name: 'Release coordination' }).first().click();
    await page.getByRole('heading', { name: 'Flow review' }).waitFor();
    const caps = page.getByRole('region', { name: 'What approving this allows' });
    // The apps it talks to, what it changes out there, and whose access it runs with.
    await caps.getByText('Talks to example.atlassian.net').waitFor();
    await expect.poll(() => caps.getByText(/^Changes data:/).count()).toBeGreaterThan(0);
    await caps.getByText(/Uses the runner's own jira access/).waitFor();
    // And what the runtime never allows, whatever the steps say.
    await caps.getByText(/^What it can never do/).click();
    await caps.getByText('Reach any host but the ones above').waitFor();
    await shot(page, 'flow-capabilities');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('creates, lists, and rotates a webhook while showing each secret only once', async () => {
    await page.getByRole('link', { name: 'My credentials', exact: true }).click();
    await page.getByRole('button', { name: 'Create Webhook' }).click();
    await page.locator('#trigger-flow').selectOption({ label: 'Release coordination' });
    await page.getByRole('button', { name: 'Create & Show Signing Secret' }).click();
    await page.getByRole('heading', { name: 'Save this webhook secret now' }).waitFor();
    const secret = await page.locator('.manifest-box .pre').innerText();
    expect(secret).toMatch(/^whsec_/);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    expect(await page.content()).not.toContain(secret);
    await page.getByRole('button', { name: 'Rotate Secret' }).click();
    await page.getByRole('heading', { name: 'Save this webhook secret now' }).waitFor();
    const rotated = await page.locator('.manifest-box .pre').innerText();
    expect(rotated).not.toBe(secret);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await shot(page, '5-vault-webhooks');
  });

  it('filters executions and exports the matching data as CSV', async () => {
    await page.getByRole('link', { name: 'Runs', exact: true }).click();
    const search = page.getByPlaceholder('Filter by Flow name or run ID…');
    await search.fill('no-such-workflow');
    await page.getByText('No runs match your filters.').waitFor();
    expect(await page.getByRole('button', { name: 'Export CSV' }).isDisabled()).toBe(true);
    await search.fill('Release coordination');
    await page.getByRole('link', { name: 'Release coordination v1' }).waitFor();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    expect((await download).suggestedFilename()).toBe('dittoly-runs.csv');
    await page.getByRole('button', { name: 'Failed', exact: true }).click();
    await page.getByText('No runs match your filters.').waitFor();
  });

  it('renders all desktop pages and mobile navigation without horizontal overflow', async () => {
    const routes = ['/', '/flows', '/runs', '/delegations', '/plans', '/modules', '/marketplace', '/credentials', '/admin'];
    for (const route of routes) {
      await page.goto(base + route);
      await page.locator('.page-head, .home-chat').first().waitFor();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await shot(page, `desktop-${route.slice(1) || 'home'}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of routes) {
      await page.goto(base + route);
      await page.locator('.page-head, .home-chat').first().waitFor();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await shot(page, `mobile-${route.slice(1) || 'home'}`);
    }
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('link', { name: 'Flows', exact: true }).click();
    await page.getByRole('heading', { name: 'Flows', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded')).toBe('false');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }, 60_000);

  it('renders the day theme on every screen without browser errors', async () => {
    await page.getByRole('button', { name: 'Switch to day theme' }).click();
    for (const route of ['/', '/flows', '/runs', '/delegations', '/plans', '/modules', '/marketplace', '/credentials', '/admin']) {
      await page.goto(base + route);
      await page.locator('.page-head, .home-chat').first().waitFor();
      await page.waitForLoadState('networkidle');
      expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await shot(page, `day-${route.slice(1) || 'home'}`);
    }
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('asks how to send email before building, then shows the answer and the SMTP permission to the reviewer', async () => {
    const q = { id: 'delivery', question: 'Send through a provider like Mailchimp or SendGrid, or your own SMTP server?', options: ['Provider API', 'Our SMTP server'] };
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Emails the team about a release.', category: 'email', protocols: ['smtp', 'email-api'], questions: [q] }) });
    await page.goto(`${base}/modules`);
    await page.getByRole('textbox', { name: /GitHub: list open pull requests/ }).fill('Email the team when a release ships');
    await page.getByRole('button', { name: 'Draft module' }).click();
    await page.getByText('Before building: Email').waitFor();
    await expect(page.locator('.protocol-list li').allInnerTexts()).resolves.toEqual([expect.stringContaining('SMTP'), expect.stringContaining('Email provider API')]);
    await shot(page, 'classify-questions');
    await page.getByRole('button', { name: 'Our SMTP server' }).click();
    // Building classifies again with the answer; this time there is nothing more to ask.
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Emails the team through the SMTP server.', category: 'email', protocols: ['smtp'], questions: [] }) });
    ai.enqueue({
      manifestJson: JSON.stringify({
        name: 'release-mailer', version: '1.0.0', title: 'Release mailer', description: 'Emails the team.', hosts: [],
        settings: [{ id: 'smtp_host', type: 'host', label: 'SMTP server', pattern: '*.acme.test:587', default: 'smtp.acme.test:587' }],
        credentials: [{ id: 'login', service: 'smtp', label: 'SMTP login', hosts: ['{{settings.smtp_host}}'], placement: { type: 'basic' } }],
        endpoints: [{ id: 'mail', protocol: 'smtp', host: '{{settings.smtp_host}}', credential: 'login', from: 'releases@acme.test' }],
        actions: [{ name: 'send_release_email', title: 'Send release email', description: 'Emails the team.', effect: 'write', credentials: ['login'], input: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } } }, required: ['to'] }, output: { type: 'object' } }],
      }),
      code: `export const actions = { async send_release_email(i, ctx) { return ctx.smtp.send({ endpoint: 'mail', to: i.to, subject: 'Released', text: 'Shipped.' }); } };`,
      testsJson: JSON.stringify([{ name: 'sends', action: 'send_release_email', input: { to: ['team@acme.test'] }, http: [] }]),
    });
    await page.getByRole('button', { name: 'Build with these answers' }).click();
    await page.waitForURL(/\/modules\/[0-9a-f-]{36}/);
    await page.getByText('It can SEND EMAIL through the SMTP server').waitFor();
    await page.getByText('Our SMTP server', { exact: true }).waitFor();
    await page.getByText(/Send through a provider like Mailchimp/).waitFor();
    await expect(page.locator('p', { hasText: 'Classified as' }).innerText()).resolves.toContain('Classified as Email using smtp.');
    await shot(page, 'classify-review');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('Create: one place to automate a task or connect an app, with the same questions before drafting', async () => {
    await page.goto(`${base}/`);
    await page.getByRole('main').getByRole('link', { name: 'Create', exact: true }).click();
    await page.getByRole('heading', { name: 'Create', exact: true }).waitFor();
    const how = await page.getByRole('list', { name: 'How it works' }).locator('strong').allInnerTexts();
    expect(how).toEqual(['Describe', 'Review', 'Approve', 'Run']);
    // Automate a task is chosen first; a Flow that needs a missing module says so, like on the Flows page.
    await expect(page.getByRole('radio', { name: /Automate a task/ }).getAttribute('aria-checked')).resolves.toBe('true');
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Post the newest video.', category: 'web_api', protocols: ['https'], questions: [], missing: [{ capability: 'read YouTube videos', moduleRequest: 'Read the newest videos of a YouTube channel' }] }) });
    await page.getByRole('textbox', { name: /every morning, get the newest video/ }).fill('Post our newest YouTube video to Slack');
    await page.getByRole('button', { name: 'Draft the Flow' }).click();
    await page.getByText('No approved module can do this yet:').waitFor();
    await shot(page, 'create');
    // Connect an app switches the box to drafting a module.
    await page.getByRole('radio', { name: /Connect an app/ }).click();
    await page.getByRole('button', { name: 'Draft the module' }).waitFor();
    await expect(page.getByText('No approved module can do this yet:').count()).resolves.toBe(0);
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('when a module lacks part of a Flow, it offers choices instead of an error: add it to the module, or draft without it', async () => {
    const missing = [{ capability: 'list merge request comments', moduleRequest: 'An action that lists the comments of a merge request', module: 'gitlab' }];
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Review MRs.', category: 'web_api', protocols: [], questions: [], missing }) });
    await page.goto(`${base}/flows`);
    await page.getByRole('textbox', { name: /gather approved Jira tickets/ }).fill('Review merge requests and skip comments made before');
    await page.getByRole('button', { name: 'Draft Flow' }).click();
    await page.getByRole('button', { name: 'Add it to gitlab' }).waitFor();
    await page.getByRole('button', { name: 'Draft without it' }).waitFor();
    // Trying all of it anyway: the AI cannot, and says why; the same choices are offered, not an error.
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Review MRs.', category: 'web_api', protocols: [], questions: [], missing }) });
    ai.enqueue({ name: 'MR review', definitionJson: 'null', explanation: 'gitlab cannot list the comments of a merge request yet.' });
    await page.getByRole('button', { name: 'Try to build all of it' }).click();
    await page.getByText('Not all of it can be built yet').waitFor();
    await page.getByText('gitlab cannot list the comments of a merge request yet.').waitFor();
    await shot(page, 'cannot-draft-choices');
    // Draft without it: the Flow is drafted, leaving that part out.
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Review MRs.', category: 'web_api', protocols: [], questions: [], missing }) });
    ai.enqueue({ name: 'MR review', definitionJson: JSON.stringify((await releaseFlow()).definition), explanation: 'Leaves out: skipping earlier comments.' });
    await page.getByRole('button', { name: 'Draft without it' }).click();
    await page.waitForURL(/\/flows\/[0-9a-f-]{36}$/);
    expect(ai.requests.at(-1)!.prompt).toContain('LEAVE OUT (the person chose to draft without these, because no approved action can do them yet):\n- list merge request comments');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('a Flow that needs a missing module offers to build that module', async () => {
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Email after merging.', category: 'email', protocols: ['smtp'], questions: [], missing: [{ capability: 'send email', moduleRequest: 'Send email through our SMTP server' }] }) });
    await page.goto(`${base}/flows`);
    await page.getByRole('textbox', { name: /gather approved Jira tickets/ }).fill('Merge ready MRs and email the team');
    await page.getByRole('button', { name: 'Draft Flow' }).click();
    await page.getByText('No approved module can do this yet:').waitFor();
    await page.getByRole('button', { name: 'Build a new module' }).click();
    await page.getByRole('heading', { name: 'Modules', exact: true }).waitFor();
    await expect(page.getByRole('textbox', { name: /GitHub: list open pull requests/ }).inputValue()).resolves.toBe('Send email through our SMTP server');
  }, 60_000);

  it('lists what can be run, fills the run form with live choices, and answers the run\'s question mid-way', async () => {
    for (const mr of fake.mrs) mr.state = 'opened';
    fake.merged.length = 0;
    const definition = {
      description: 'Merge the merge requests you pick.',
      inputs: { type: 'object', properties: { project: { type: 'string' }, focus: { type: 'integer' } }, required: ['project'] },
      form: {
        intro: 'Choose a project.',
        fields: [
          { name: 'project', label: 'Project', widget: 'text', placeholder: 'acme/app', help: 'GitLab project path' },
          { name: 'focus', label: 'Look at first', widget: 'select', options: { module: 'gitlab@1.0.0', action: 'list_merge_requests', input: { project: '{{ inputs.project }}' }, items: 'mergeRequests', value: 'iid', label: 'title' } },
        ],
      },
      steps: [
        { id: 'mrs', type: 'action', module: 'gitlab@1.0.0', action: 'list_merge_requests', input: { project: '{{ inputs.project }}' } },
        { id: 'pick', type: 'input', title: 'Choose what to merge', fields: [{ name: 'iids', label: 'Merge requests', widget: 'multiselect', required: true, options: { fromStep: '{{ steps.mrs.output.mergeRequests }}', value: 'iid', label: 'title' } }] },
        { id: 'merge', type: 'action', module: 'gitlab@1.0.0', action: 'merge_merge_request', input: { project: '{{ inputs.project }}', iid: '{{ item }}' }, forEach: '{{ steps.pick.output.iids }}' },
      ],
    };
    const headers = { authorization: `Bearer ${token}` };
    const created = await (await page.request.post(`${base}/api/flows`, { headers, data: { name: 'Pick and merge', definition } })).json();
    await page.request.post(`${base}/api/flow-versions/${created.id}/decision`, { headers, data: { decision: 'approved' } });

    await page.goto(`${base}/run`);
    const card = page.locator('.runnable-card', { hasText: 'Pick and merge' });
    await card.getByText('Ready').waitFor();
    await expect(card.innerText()).resolves.toContain('asks you during the run');
    await card.getByRole('link', { name: 'Open' }).click();
    await page.getByRole('heading', { name: 'Pick and merge' }).waitFor();
    await page.getByText('Fill in Project first.').waitFor();
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.getByText('Required.').waitFor();
    await page.getByLabel('Project').fill('acme/app');
    await page.locator('#f-focus option', { hasText: 'Fix login' }).waitFor({ state: 'attached' });
    await page.getByLabel('Look at first').selectOption({ label: 'Fix login' });
    await shot(page, 'run-form');
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.waitForURL(/\/runs\//);

    await page.getByRole('button', { name: 'Continue the run' }).waitFor({ timeout: 15_000 });
    await shot(page, 'run-input-step');
    await page.getByRole('button', { name: 'Continue the run' }).click();
    await page.locator('.input-step', { hasText: 'Required.' }).waitFor();
    await page.getByRole('checkbox', { name: 'Add export' }).check();
    await page.getByRole('button', { name: 'Continue the run' }).click();
    await page.locator('.page-head .badge', { hasText: 'succeeded' }).waitFor({ timeout: 15_000 });
    expect(fake.merged).toEqual([7]);
    expect(browserErrors).toEqual([]);
  }, 90_000);

  it('plays a YouTube link from a run inside the page; other links stay links unless their host is allowed', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const definition = {
      inputs: { type: 'object', properties: { video: { type: 'string' }, page: { type: 'string' } }, required: ['video'] },
      steps: [{ id: 'watch', type: 'approval', title: 'Watch it' }],
    };
    const created = await (await page.request.post(`${base}/api/flows`, { headers, data: { name: 'Watch a video', definition } })).json();
    await page.request.post(`${base}/api/flow-versions/${created.id}/decision`, { headers, data: { decision: 'approved' } });
    const { runId } = await (
      await page.request.post(`${base}/api/flow-versions/${created.id}/runs`, { headers, data: { inputs: { video: 'https://youtu.be/dQw4w9WgXcQ?t=42', page: 'https://example.com/clip.mp4' } } })
    ).json();
    await page.goto(`${base}/runs/${runId}`);
    const player = page.locator('.media-frame.video iframe');
    await player.waitFor({ state: 'attached' });
    expect(await player.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42');
    expect(await player.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    // example.com is not an allowed media host: a plain link, no player.
    await page.getByRole('link', { name: 'https://example.com/clip.mp4' }).waitFor();
    expect(await page.locator('video').count()).toBe(0);
    await shot(page, 'media-youtube');
  }, 60_000);

  it('turns a pasted Playwright test into a browser module, runs it after another Flow, and shows its screenshot', async () => {
    const headers = { authorization: `Bearer ${token}` };
    await page.goto(`${base}/modules`);
    await page.getByLabel('Script').fill(`import { test, expect } from '@playwright/test';\n\ntest('empty cart', async ({ page }) => {\n  await page.goto('http://${shopHost}/');\n  await page.getByRole('link', { name: 'Cart' }).click();\n  await expect(page.getByText('Your cart is empty')).toBeVisible();\n});\n`);
    await page.locator('#pw-name').fill('shop-smoke');
    await page.locator('#pw-title').fill('Shop smoke test');
    await page.getByRole('button', { name: 'Create browser module' }).click();
    await page.getByText('ran against the real site').waitFor({ timeout: 45_000 });
    await page.getByText(`It drives a headless BROWSER that may load pages only from: ${shopHost}`).waitFor();
    await shot(page, 'browser-module-review');
    await page.getByRole('button', { name: 'Submit for admin review' }).click();
    await page.locator('.toast-success', { hasText: 'Submitted for admin review' }).waitFor();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.locator('.toast-success', { hasText: 'Module approved' }).waitFor();
    await shot(page, 'toast-success');
    await page.getByText('approved').first().waitFor();

    // A Flow with the browser step, approved.
    const definition = { steps: [{ id: 'smoke', type: 'action', module: 'shop-smoke@1.0.0', action: 'empty_cart', input: {} }] };
    const smoke = await (await page.request.post(`${base}/api/flows`, { headers, data: { name: 'Shop smoke', definition } })).json();
    await page.request.post(`${base}/api/flow-versions/${smoke.id}/decision`, { headers, data: { decision: 'approved' } });

    // "Watch a video" (approved earlier) is followed by the smoke test.
    const flows = await (await page.request.get(`${base}/api/flows`, { headers })).json();
    const watch = flows.find((f: { name: string }) => f.name === 'Watch a video');
    await page.goto(`${base}/flows/${watch.id}`);
    await page.getByLabel('Flow to run').selectOption({ label: 'Shop smoke (v1)' });
    await page.getByRole('button', { name: 'Add follow-up' }).click();
    await page.getByText('When it succeeds, run').waitFor();
    await shot(page, 'flow-followup');

    const { runId } = await (await page.request.post(`${base}/api/flow-versions/${watch.approvedVersionId}/runs`, { headers, data: { inputs: { video: 'https://youtu.be/dQw4w9WgXcQ' } } })).json();
    await page.waitForTimeout(500);
    expect((await page.request.post(`${base}/api/runs/${runId}/steps/watch/gate`, { headers, data: { decision: 'approved' } })).status()).toBe(202);
    let followRun: string | null = null;
    for (let i = 0; i < 100 && !followRun; i++) {
      const list = await (await page.request.get(`${base}/api/followups?flow=${watch.id}`, { headers })).json();
      followRun = list[0]?.lastRunId ?? null;
      if (!followRun) await page.waitForTimeout(200);
    }
    expect(followRun).toBeTruthy();
    await page.goto(`${base}/runs/${followRun}`);
    const img = page.locator('img.out-shot');
    await img.waitFor({ timeout: 45_000 });
    expect(await img.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
    // The page the script ended on is also shown live; the site is an approved browser module's, so the CSP allows it.
    const live = page.locator('.media-frame.live iframe');
    await live.waitFor();
    expect(await live.getAttribute('src')).toBe(`http://${shopHost}/cart`);
    await page.frameLocator('.media-frame.live iframe').getByText('Your cart is empty').waitFor();
    const csp = (await page.request.get(`${base}/health`)).headers()['content-security-policy'];
    expect(csp).toContain(`frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com http://${shopHost}`);
    await shot(page, 'browser-run-screenshot');
  }, 120_000);

  it('opens an approved site in the Dittoly browser, drives it live and takes a screenshot', async () => {
    await page.goto(`${base}/browser?url=${encodeURIComponent(`http://${shopHost}/`)}`);
    await page.getByRole('button', { name: 'Open' }).click();
    const screen = page.locator('.live-screen img');
    await screen.waitFor({ timeout: 30_000 });
    expect(await screen.getAttribute('alt')).toBe(`Live browser showing http://${shopHost}/`);
    // The shop's "Cart" link is at the top left of the page: click it through the live view.
    const box = (await screen.boundingBox())!;
    await page.mouse.click(box.x + (box.width / 1280) * 18, box.y + (box.height / 720) * 17);
    await page.waitForFunction(() => document.querySelector('.live-screen img')?.getAttribute('alt')?.endsWith('/cart'), null, { timeout: 15_000 });
    await page.getByRole('button', { name: 'Screenshot' }).click();
    await page.locator('.live-shots img').waitFor();
    await shot(page, 'dittoly-browser');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForURL(`${base}/browser`);
  }, 60_000);

  it('shows the checks an AI step proposed, lets the person edit them, and passes the approved list on', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const definition = {
      inputs: { type: 'object', properties: { ticket: { type: 'string' } }, required: ['ticket'] },
      steps: [
        { id: 'plan', type: 'ai', ai: 'organization', output: 'checklist', instruction: 'Plan browser checks.', input: { t: '{{ inputs.ticket }}' } },
        { id: 'approve', type: 'input', intro: 'Check the plan.', fields: [{ name: 'checks', label: 'Checks to run', widget: 'checklist', required: true, default: '{{ steps.plan.output.checks }}' }] },
      ],
    };
    const created = await (await page.request.post(`${base}/api/flows`, { headers, data: { name: 'Plan checks', definition } })).json();
    await page.request.post(`${base}/api/flow-versions/${created.id}/decision`, { headers, data: { decision: 'approved' } });
    ai.enqueue({ checksJson: JSON.stringify([{ check: 'Open the cart', expect: 'Cart is empty' }, { check: 'See the logo', expect: 'Acme' }]) });
    const { runId } = await (await page.request.post(`${base}/api/flow-versions/${created.id}/runs`, { headers, data: { inputs: { ticket: 'Cart broken' } } })).json();
    await page.goto(`${base}/runs/${runId}`);
    await page.getByLabel('Check 1', { exact: true }).waitFor({ timeout: 15_000 });
    expect(await page.getByLabel('Check 1', { exact: true }).inputValue()).toBe('Open the cart');
    await page.getByLabel('Remove check 2').click();
    await page.getByRole('button', { name: 'Add a check' }).click();
    await page.getByLabel('Check 2', { exact: true }).fill('Checkout button is visible');
    await page.getByLabel('Expected result 2').fill('Checkout');
    await shot(page, 'checklist-approval');
    await page.getByRole('button', { name: 'Continue the run' }).click();
    let out: unknown = null;
    for (let i = 0; i < 50 && !out; i++) {
      const run = await (await page.request.get(`${base}/api/runs/${runId}`, { headers })).json();
      out = run.steps.find((st: { id: string }) => st.id === 'approve')?.output ?? null;
      if (!out) await page.waitForTimeout(200);
    }
    expect(out).toEqual({ checks: [{ check: 'Open the cart', expect: 'Cart is empty' }, { check: 'Checkout button is visible', expect: 'Checkout' }] });
  }, 60_000);

  it('reads an uploaded plan, asks its question, drafts a module for review and the Flow after approval, with a message at each step', async () => {
    await page.goto(`${base}/plans`);
    await page.getByRole('heading', { name: 'Plans', exact: true }).waitFor();
    const input = page.getByLabel('Plan PDF');
    // A scanned PDF (no text) is refused with a message that says what to do.
    await input.setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: pdfOf([]) });
    await page.getByRole('button', { name: 'Upload and read' }).click();
    await page.locator('.toast-error', { hasText: 'text recognition (OCR)' }).waitFor();

    ai.enqueue({ planJson: JSON.stringify({ title: 'Release notes', summary: 'Posts release notes to the team chat.', questions: [{ id: 'chat', question: 'Which chat tool does the team use?', options: ['Slack', 'Microsoft Teams'] }] }) });
    await input.setInputFiles({ name: 'release-plan.pdf', mimeType: 'application/pdf', buffer: pdfOf(['Release notes plan', 'Post the release notes to the team chat when a release is approved.']) });
    await page.getByRole('button', { name: 'Upload and read' }).click();
    await page.locator('.toast-success', { hasText: 'Plan uploaded' }).waitFor();
    await page.waitForURL(/\/plans\/[0-9a-f-]{36}/);
    await page.getByRole('heading', { name: 'Questions before building' }).waitFor({ timeout: 20_000 });
    await page.getByText('Posts release notes to the team chat.').waitFor();
    await shot(page, 'plan-questions');

    const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    ai.enqueue({ planJson: JSON.stringify({ title: 'Release notes', summary: 'Posts release notes to Slack.', modules: [{ key: 'notes', title: 'Release notes poster', request: 'Post a message to a Slack channel.' }], flows: [{ key: 'post', title: 'Post release notes', request: 'Post the notes.', needs: ['notes'] }] }) });
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, name: 'notes-poster', title: 'Release notes poster' }), code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8') });
    await page.getByRole('button', { name: 'Slack', exact: true }).click();
    await page.getByRole('button', { name: 'Build with these answers' }).click();
    await page.locator('.toast-success', { hasText: 'Answers sent' }).waitFor();
    await page.locator('.plan-item', { hasText: 'Drafted and sent to an admin for review' }).waitFor({ timeout: 30_000 });
    await page.locator('.plan-item', { hasText: 'Drafted once what it needs is approved' }).waitFor();
    await shot(page, 'plan-waiting');

    // The admin approves the module; the plan drafts its Flow on its own.
    const flow = { steps: [{ id: 'post', type: 'action', module: 'notes-poster@1.0.0', action: 'post_message', input: { channel: 'C-release', text: 'Release notes' } }] };
    ai.enqueue({ name: 'Post release notes', definitionJson: JSON.stringify(flow), explanation: 'Posts the notes.' });
    const planUrl = page.url();
    await page.getByRole('link', { name: 'Release notes poster' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.locator('.toast-success', { hasText: 'Module approved' }).waitFor();
    await page.goto(planUrl);
    await page.getByText('Everything is drafted.').waitFor({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Post release notes' }).waitFor();
    await shot(page, 'plan-done');
    expect(browserErrors).toEqual([]);
  }, 90_000);

  it('the home chat takes speech: what is said is written into the box to check, nothing is sent by itself', async () => {
    // A fake recognizer (no microphone here): it "hears" two parts, live, then stops.
    await page.addInitScript(() => {
      class FakeRec {
        lang = ''; interimResults = false; continuous = false; maxAlternatives = 1;
        onresult: ((e: unknown) => void) | null = null; onerror: unknown = null; onend: (() => void) | null = null;
        start() {
          (window as unknown as { heardLang: string }).heardLang = this.lang;
          setTimeout(() => this.onresult?.({ results: [{ 0: { transcript: 'har subah' }, isFinal: true }] }), 50);
          setTimeout(() => this.onresult?.({ results: [{ 0: { transcript: 'har subah' }, isFinal: true }, { 0: { transcript: ' open PRs Slack te bhejo' }, isFinal: true }] }), 100);
          setTimeout(() => this.onend?.(), 150);
        }
        stop() { this.onend?.(); }
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRec;
    });
    await page.goto(`${base}/`);
    const box = page.getByRole('textbox', { name: 'What do you want to automate?' });
    await box.fill('Sun:');
    const before = ai.requests.length;
    await page.locator('#home-chat').getByRole('button', { name: 'Speak instead of typing' }).click();
    await expect.poll(() => box.inputValue()).toBe('Sun: har subah open PRs Slack te bhejo');
    await page.locator('#home-chat').getByRole('button', { name: 'Speak instead of typing' }).waitFor();
    // It listened in the browser's language and sent nothing: the person checks the text first.
    expect(await page.evaluate(() => (window as unknown as { heardLang: string }).heardLang)).toBe(await page.evaluate(() => navigator.language));
    expect(ai.requests.length).toBe(before);
    await box.fill('');
    expect(browserErrors).toEqual([]);
  });

  it('the home chat shows its plan first, takes corrections, and builds it in one click', async () => {
    // Newer Chromium returns a Promise from scrollIntoView; the chat once returned it from an effect and crashed.
    await page.addInitScript(() => {
      const scroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element, ...a: Parameters<typeof scroll>) {
        scroll.apply(this, a);
        return Promise.resolve() as unknown as void;
      };
    });
    await page.goto(`${base}/`);
    const plan = (p: Record<string, unknown>) => ({
      reply: 'Here is my plan.',
      planJson: JSON.stringify({
        title: 'Release notes to chat',
        summary: 'Posts the release notes when a release is approved. Assuming: Slack; the #release channel; no sign-off',
        questions: [],
        modules: [{ key: 'poster', title: 'Chat poster', request: 'Slack: post a message to a channel (write).' }],
        flows: [{ key: 'post', title: 'Post release notes', request: '1 post the notes to #release (poster post_message).', needs: ['poster'] }],
        reuse: [],
        superFlow: null,
        ...p,
      }),
    });
    // Each answer goes only to the request it is for (by the fields the request asks for): a background job of an
    // earlier test cannot take it.
    const asks = (...keys: string[]) => (req: { schema: unknown }) => keys.every((k) => k in (((req.schema as { properties?: object }).properties) ?? {}));
    const chatTurn = asks('reply', 'planJson');
    ai.enqueueFor(chatTurn, plan({}));
    const box = page.getByRole('textbox', { name: 'What do you want to automate?' });
    await box.fill('post release notes to chat when a release is approved');
    // Wait for the server's answer to this turn; when there is none, say what the page shows instead (CI log).
    const answered = page.waitForResponse((r) => r.url().endsWith('/api/chat/plan'), { timeout: 30_000 }).catch(async (err: Error) => {
      throw new Error(`no answer to the chat turn (${err.message}); the chat shows: ${await page.locator('#home-chat').innerText()}; AI requests: ${ai.requests.length}, last: ${ai.requests.at(-1)?.system.slice(0, 80) ?? 'none'}`);
    });
    await page.locator('#home-chat').getByRole('button', { name: 'Send', exact: true }).click();
    const res = await answered;
    if (!res.ok()) throw new Error(`the chat turn answered ${res.status()}: ${await res.text()}`);
    const answer = (await res.json()) as { reply?: string; plan?: { title?: string } | null };
    const card = page.getByRole('article', { name: 'The plan' });
    await card.getByText('Release notes to chat').waitFor().catch(async (err: Error) => {
      throw new Error(`no plan card (${err.message}); the server answered reply=${JSON.stringify(answer.reply)} plan=${JSON.stringify(answer.plan?.title ?? answer.plan)}; url ${page.url()}; the page shows: ${(await page.locator('#main-content').innerText({ timeout: 5000 }).catch(() => '?')).slice(0, 1500)}; console errors: ${consoleErrors.slice(-5).join(' | ') || 'none'}; browser errors: ${browserErrors.join(' | ') || 'none'}; AI requests: ${ai.requests.map((r) => Object.keys(((r.schema as { properties?: object }).properties) ?? {}).join('+')).join(', ')}`);
    });
    // The plan comes first: what it assumed, what it builds, the Flow.
    await expect.poll(() => card.locator('.plan-assumed li').allInnerTexts()).toEqual(['Slack', 'the #release channel', 'no sign-off']);
    await card.getByText('Chat poster').waitFor();
    await card.getByText('Post release notes').waitFor();
    await page.getByText('Here is my plan.').waitFor();
    await shot(page, 'home-chat-plan');

    // A correction revises it; the chat sent the whole conversation.
    ai.enqueueFor(chatTurn, { ...plan({ summary: 'Posts the release notes when a release is approved. Assuming: Slack; the #dev channel; no sign-off' }), reply: 'Changed the channel to #dev.' });
    const more = page.getByRole('textbox', { name: 'Correct the plan or ask something' });
    await more.fill('post to #dev instead');
    await more.press('Enter');
    await page.getByText('Changed the channel to #dev.').waitFor();
    await card.getByText('the #dev channel').waitFor();
    expect(ai.requests.at(-1)!.prompt).toContain('PERSON: post release notes to chat when a release is approved\n\nYOU: Here is my plan.\n\nPERSON: post to #dev instead');
    // The chat is kept: its link brings it back after a reload, and it is listed under Recent chats.
    await page.waitForURL(/[?&]chat=[0-9a-f-]{36}/);
    await page.reload();
    await page.getByText('Changed the channel to #dev.').waitFor();
    await page.getByRole('article', { name: 'The plan' }).getByText('the #dev channel').waitFor();

    // Several questions are asked at once and answered at once: one message back, not one per question.
    ai.enqueueFor(chatTurn, plan({
      questions: [
        { id: 'who', question: 'Who signs off?', options: ['A release manager', 'Nobody'] },
        { id: 'when', question: 'How often?', options: ['Every day', 'Every week'] },
      ],
    }));
    await page.getByRole('textbox', { name: 'Correct the plan or ask something' }).fill('ask me what you need');
    await page.locator('#home-chat').getByRole('button', { name: 'Send' }).click();
    const planCard = page.getByRole('article', { name: 'The plan' });
    await planCard.getByText('2 THINGS TO DECIDE').waitFor();
    await planCard.getByRole('button', { name: 'A release manager' }).click();
    await planCard.getByRole('button', { name: 'Every week' }).click();
    ai.enqueueFor(chatTurn, plan({ summary: 'Weekly, a release manager signs off.' }));
    await planCard.getByRole('button', { name: 'Send these answers' }).click();
    // Both answers travelled in one message.
    await expect.poll(() => ai.requests.at(-1)!.prompt).toContain('Who signs off? A release manager');
    expect(ai.requests.at(-1)!.prompt).toContain('How often? Every week');
    await planCard.getByText('Weekly, a release manager signs off.').waitFor();

    // One click drafts everything; local mode approves from here, one click per item.
    const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    ai.enqueueFor(asks('manifestJson', 'code'), { manifestJson: JSON.stringify({ ...manifest, name: 'chat-poster', title: 'Chat poster' }), code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8') });
    await card.getByRole('button', { name: 'Build it' }).click();
    const building = page.getByRole('article', { name: 'Building' });
    await building.getByText('Waits for an admin to approve').waitFor({ timeout: 30_000 });
    await building.getByText('Drafted once what it needs is approved').waitFor();
    // Every part is a link, the ones not drafted yet too: they open their part of the plan.
    const waiting = building.getByRole('link', { name: 'Post release notes' });
    await expect.poll(() => waiting.getAttribute('href')).toMatch(/^\/plans\/[0-9a-f-]{36}#item-[0-9a-f-]{36}$/);
    await waiting.click();
    await page.waitForURL(/\/plans\/[0-9a-f-]{36}#item-/);
    await page.locator('.plan-item.just-opened').waitFor();
    await page.goBack();
    await building.getByText('Waits for an admin to approve').waitFor();
    const flow = { steps: [{ id: 'post', type: 'action', module: 'chat-poster@1.0.0', action: 'post_message', input: { channel: '#dev', text: 'Release notes' } }] };
    ai.enqueueFor(asks('definitionJson'), { name: 'Post release notes', definitionJson: JSON.stringify(flow), explanation: 'Posts the notes.' });
    await building.getByRole('button', { name: 'Approve' }).click();
    await page.locator('.toast-success', { hasText: 'Chat poster approved' }).waitFor();
    await building.getByText('Waits for an approver').waitFor({ timeout: 30_000 });
    await building.getByRole('button', { name: 'Approve' }).click();
    await page.locator('.toast-success', { hasText: 'Post release notes approved' }).waitFor();
    await building.getByRole('link', { name: 'Post release notes' }).waitFor();
    await shot(page, 'home-chat-built');
    expect(browserErrors).toEqual([]);
  }, 90_000);

  it('creates a Flow URL, shows its token once, and a call with x-sflow-token starts a run', async () => {
    await page.goto(`${base}/flows`);
    await page.locator('table').getByRole('link', { name: 'Release coordination' }).first().click();
    await page.getByRole('heading', { name: 'Flow URLs' }).waitFor();
    await page.getByLabel('Name', { exact: true }).fill('CI pipeline');
    await page.getByRole('button', { name: 'Create URL' }).click();
    await page.locator('.toast-success', { hasText: 'Flow URL created' }).waitFor();
    const reveal = page.getByRole('region', { name: 'New token' });
    const token = (await reveal.locator('pre').first().innerText()).trim();
    expect(token).toMatch(/^sflow_/);
    const url = (await reveal.locator('code').first().innerText()).trim();
    await expect(reveal.locator('pre').nth(1).innerText()).resolves.toContain(`-H 'x-sflow-token: ${token}'`);
    await shot(page, 'flow-url-token');

    const started = await page.request.post(url, { headers: { 'x-sflow-token': token }, data: { release: '2.4', jql: 'fixVersion = 2.4', project: 'acme/app', channel: 'C-releases' } });
    expect(started.status()).toBe(202);
    const { runId, statusUrl } = await started.json();
    expect(statusUrl).toContain(`/runs/${runId}`);
    const wrong = await page.request.post(url, { headers: { 'x-sflow-token': 'sflow_nope' }, data: {} });
    expect(wrong.status()).toBe(401);

    await page.getByRole('button', { name: 'I saved it' }).click();
    expect(await page.getByRole('region', { name: 'New token' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Disable' }).click();
    await page.locator('.toast-success', { hasText: 'URL disabled' }).waitFor();
    const off = await page.request.post(url, { headers: { 'x-sflow-token': token }, data: {} });
    expect(await off.json()).toEqual({ error: 'endpoint_disabled' });
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('connects two approved Flows into a Super Flow that runs them at the same time, and links the child runs', async () => {
    const write = { 'x-dittoly-request': '1' };
    for (const [name, channel] of [['Notify A', 'C-a'], ['Notify B', 'C-b']]) {
      const def = { inputs: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel, text: '{{ inputs.text }}' } }] };
      const v = await (await page.request.post(`${base}/api/flows`, { headers: write, data: { name, definition: def } })).json();
      expect((await page.request.post(`${base}/api/flow-versions/${v.id}/decision`, { headers: write, data: { decision: 'approved' } })).status()).toBe(200);
    }
    await page.goto(`${base}/flows`);
    // Super Flows is under More in the menu, folded unless opened earlier.
    const more = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' });
    if ((await more.getAttribute('aria-expanded')) === 'false') await more.click();
    await page.getByRole('link', { name: 'Super Flows', exact: true }).click();
    await page.getByRole('heading', { name: 'Super Flows', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Connect Flows into a Super Flow' }).waitFor();
    await page.getByLabel('Super Flow name').fill('Notify everyone');
    const pick = page.getByLabel('Add a Flow to stage 1');
    await pick.locator('option', { hasText: 'Notify A (v1)' }).waitFor({ state: 'attached' });
    await pick.selectOption({ label: 'Notify A (v1)' });
    await page.locator('.sf-stage').getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('.sf-child', { hasText: 'Notify A' }).waitFor();
    await pick.selectOption({ label: 'Notify B (v1)' });
    await page.locator('.sf-stage').getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('STAGE 1 · RUN AT THE SAME TIME').waitFor();
    await page.getByText('It will ask for:').waitFor();
    await shot(page, 'super-flow-builder');
    await page.getByRole('button', { name: 'Create Super Flow' }).click();
    await page.locator('.toast-success', { hasText: 'Super Flow created' }).waitFor();
    await page.waitForURL(/\/flows\/[0-9a-f-]{36}/);
    await page.getByRole('heading', { name: /Flows it runs/ }).waitFor();
    await page.locator('.flow-node', { hasText: '2 FLOWS AT ONCE' }).waitFor();
    await page.getByText(/^Step by step/).click();
    await page.getByText(/RUNS 2 Flows at the same time: "Notify A" v1, "Notify B" v1/).waitFor();
    await page.getByRole('button', { name: 'Approve this version' }).click();
    await page.locator('.toast-success', { hasText: 'Flow version approved' }).waitFor();
    await page.locator('#f-text').fill('Release 2.4 is out');
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.waitForURL(/\/runs\//);
    await page.locator('.page-head .badge', { hasText: 'succeeded' }).waitFor({ timeout: 20_000 });
    await page.locator('.page-head [data-eyebrow="EXECUTION PORTAL / SUPER FLOW RUN"]').waitFor();
    await shot(page, 'super-flow-run');
    // Undo: both child runs' posts can be reversed from the Super Flow run, after a sign-off.
    const undo = page.locator('.card', { hasText: 'Changes whose module says how to reverse them' });
    await undo.getByText('2 can be reversed').waitFor();
    await undo.getByLabel('Why reverse it?').fill('Announced the release too early.');
    await undo.getByRole('button', { name: 'Ask to reverse' }).click();
    await page.locator('.toast-success', { hasText: 'Asked an approver to sign off' }).waitFor();
    await undo.getByText('Waiting for sign-off').waitFor();
    // The request covers both posts: the form to ask is gone until it is decided.
    expect(await undo.getByRole('button', { name: 'Ask to reverse' }).count()).toBe(0);
    await shot(page, 'undo-request');
    await undo.getByRole('button', { name: 'Sign off and reverse' }).click();
    await page.locator('.toast-success', { hasText: 'Signed off: reversing now' }).waitFor();
    await expect.poll(() => fake.deleted.map((d) => d.channel).sort(), { timeout: 15_000 }).toEqual(['C-a', 'C-b']);
    await page.reload();
    await undo.getByText('Reversed', { exact: true }).first().waitFor();
    await page.locator('.child-runs').getByRole('link', { name: 'Notify B v1' }).click();
    await page.getByText('Started by the Super Flow “Notify everyone”.').waitFor();
    expect(fake.messages.filter((m) => m.text === 'Release 2.4 is out').map((m) => m.channel).sort()).toEqual(['C-a', 'C-b']);
    expect(browserErrors).toEqual([]);
  }, 90_000);

  it('pairs a phone with a one-time QR code, and the phone runs a Flow after a yes and says when it finished', async () => {
    await page.goto(`${base}/credentials`);
    await page.getByRole('button', { name: 'Connect a phone' }).click();
    await page.getByRole('img', { name: 'QR code to connect a phone' }).waitFor();
    const link = (await page.locator('.pairing a').getAttribute('href'))!;
    expect(link).toMatch(new RegExp(`^${base}/m/pair#[A-Za-z0-9_-]{32}$`));
    await shot(page, 'phone-pairing');

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15' });
    // Newer browsers return a Promise from scrollIntoView; act like them whatever Chromium runs the test.
    await phoneContext.addInitScript(() => {
      const scroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<Element['scrollIntoView']>) {
        scroll.apply(this, args);
        return Promise.resolve();
      } as Element['scrollIntoView'];
    });
    const phone = await phoneContext.newPage();
    phone.on('pageerror', (error) => browserErrors.push(error.message));
    await phone.goto(link);
    await phone.getByText(/^Hi me\./).waitFor();
    expect(new URL(phone.url()).hash).toBe(''); // the code does not stay in the address bar
    // The portal notices the phone.
    await page.locator('.toast-success', { hasText: 'iPhone connected' }).waitFor();

    const notifyA = (await (await page.request.get(`${base}/api/runnable`)).json()).find((f: { name: string }) => f.name === 'Notify A');
    ai.enqueue({ commandJson: JSON.stringify({ action: 'run_flow', versionId: notifyA.versionId, inputs: { text: 'Shipped from my glasses' }, say: '' }) });
    await phone.getByLabel('Command', { exact: true }).fill('run notify A, say shipped from my glasses');
    await phone.getByRole('button', { name: 'Send' }).click();
    await phone.getByRole('group', { name: 'Confirm' }).getByText('Run Notify A with text Shipped from my glasses.').waitFor();
    await shot(phone, 'phone-confirm');
    await phone.getByRole('button', { name: 'Yes', exact: true }).click();
    await phone.getByText("Started. I'll tell you when it finishes.").waitFor();
    await phone.getByText('Notify A finished successfully.').waitFor({ timeout: 20_000 });
    await shot(phone, 'phone-done');
    expect(fake.messages.some((m) => m.text === 'Shipped from my glasses')).toBe(true);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // The phone cannot reach the rest of the portal.
    expect((await (await phone.request.get(`${base}/api/flows`)).json())).toEqual({ error: 'device_not_allowed' });

    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.locator('.toast-success', { hasText: 'iPhone disconnected' }).waitFor();
    await phone.reload();
    await phone.getByText(/To connect this phone/).waitFor();
    await phoneContext.close();
    expect(browserErrors).toEqual([]);
  }, 90_000);

  it('a paused run says what stopped it and links to the exact fix', async () => {
    await appRef.vault.remove(meRef.id, 'slack');
    const def = { inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', title: 'Post to Slack', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text: 'hi' } }] };
    const v = await appRef.flows.create('Post hi', def, meRef);
    await appRef.flows.decide(v.id, meRef, 'approved');
    const runId = await appRef.engine.startRun(v.id, meRef.id, {});
    try {
      await page.goto(`${base}/runs/${runId}`);
      const card = page.getByRole('region', { name: 'What to do' });
      await card.getByText('A credential this step needs is not stored.').waitFor();
      await card.getByRole('link', { name: 'Add your "slack" credential' }).click();
      await page.waitForURL(/\/credentials\?add=slack$/);
      expect(await page.locator('#svc').inputValue()).toBe('slack');
    } finally {
      await appRef.vault.put(meRef.id, 'slack', 'xoxb-me');
    }
    await page.goto(`${base}/runs/${runId}`);
    await page.getByRole('region', { name: 'What to do' }).getByText('It seems stored now: retry the step.').waitFor();
    await page.getByRole('region', { name: 'What to do' }).getByRole('button', { name: 'Retry after adding it' }).click();
    await expect.poll(async () => (await appRef.engine.runView(runId, meRef)).status, { timeout: 20_000 }).toBe('succeeded');
  }, 60_000);

  it('a failed step can be got past: type in its result, or skip it, and the run goes on', async () => {
    await appRef.vault.remove(meRef.id, 'slack');
    const def = {
      inputs: { type: 'object', properties: {} },
      steps: [
        { id: 'post', title: 'Post to Slack', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text: 'hi' } },
        { id: 'again', title: 'Post again', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text: 'after {{ steps.post.output.ts }}' } },
      ],
    };
    const v = await appRef.flows.create('Post twice', def, meRef);
    await appRef.flows.decide(v.id, meRef, 'approved');
    const runId = await appRef.engine.startRun(v.id, meRef.id, {});
    try {
      await page.goto(`${base}/runs/${runId}`);
      const card = page.getByRole('region', { name: 'What to do' });
      // Local mode: the single member approves their own, so no approver is asked for.
      await card.getByRole('button', { name: 'Type in its result and continue' }).click();
      // A draft in the shape later steps expect is there to edit, with its fields named.
      await expect.poll(() => card.getByLabel(/What the step would have returned/).inputValue()).toContain('"ts"');
      await card.getByText(/Its fields: .*ts \(string/).waitFor();
      await shot(page, 'run-result-draft');
      await card.getByLabel(/What the step would have returned/).fill('{"tickets": 1}');
      await card.getByRole('button', { name: 'Continue with this result' }).click();
      await card.getByText(/does not have the shape the next steps expect/).waitFor();
      await card.getByLabel(/What the step would have returned/).fill('{"ts": "123.4"}');
      await card.getByRole('button', { name: 'Continue with this result' }).click();
      await page.locator('.toast-success', { hasText: 'Result given' }).waitFor();
      // The second step fails the same way (no Slack credential): skip it.
      await expect.poll(async () => (await appRef.engine.runView(runId, meRef)).status, { timeout: 20_000 }).toBe('paused');
      await page.reload();
      await page.getByRole('region', { name: 'What to do' }).getByText('Stopped at').waitFor();
      await page.getByRole('region', { name: 'What to do' }).getByRole('button', { name: 'Skip this step' }).click();
      await expect.poll(async () => (await appRef.engine.runView(runId, meRef)).status, { timeout: 20_000 }).toBe('succeeded');
      await page.reload();
      await page.getByText('Result typed in by me after it failed').waitFor();
      await page.getByText('Skipped by me after it failed').waitFor();
      // One click removes a step from the Flow: a new version without it. A step later steps use goes through the AI.
      await page.goto(`${base}/flows/${v.flowId}`);
      // On each node of the graph: one used by a later step goes through the AI.
      await page.locator('.graph-node', { hasText: 'Post to Slack' }).getByRole('button', { name: 'Remove step Post to Slack from the Flow' }).getByText('✕ Remove with AI').waitFor();
      await shot(page, 'flow-remove-step');
      // It asks first: cancelling changes nothing.
      const removeAgain = page.locator('.graph-node', { hasText: 'Post again' }).getByRole('button', { name: 'Remove step Post again from the Flow' });
      let asked = '';
      page.once('dialog', (d) => ((asked = d.message()), void d.dismiss()));
      await removeAgain.click();
      await expect.poll(() => asked).toContain('Remove "Post again" from the Flow?');
      const before = await (await page.request.get(`${base}/api/flows/${v.flowId}/versions`)).json();
      expect(before.at(-1).definition.steps.map((x: { id: string }) => x.id)).toEqual(['post', 'again']);
      page.once('dialog', (d) => void d.accept());
      await removeAgain.click();
      await page.locator('.toast-success', { hasText: '"Post again" removed' }).waitFor();
      const after = await (await page.request.get(`${base}/api/flows/${v.flowId}/versions`)).json();
      expect(after.at(-1).definition.steps.map((x: { id: string }) => x.id)).toEqual(['post']);
      // The module on a graph node is a link to its page, which lists the Flows that use it.
      await page.reload();
      await page.locator('.graph-node', { hasText: 'Post to Slack' }).getByRole('link', { name: 'slack@1.0.0' }).click();
      await page.getByRole('heading', { name: 'slack@1.0.0' }).waitFor();
      await page.getByRole('list', { name: 'Flows that use this module' }).getByRole('link').first().waitFor();
    } finally {
      await appRef.vault.put(meRef.id, 'slack', 'xoxb-me');
    }
  }, 60_000);

  it('the Building page is in the menu and says when nothing is being built', async () => {
    await page.goto(`${base}/`);
    await page.getByRole('link', { name: 'Building' }).first().click();
    await page.getByRole('heading', { name: 'Building' }).waitFor();
    await page.getByText('Nothing is being built right now.').waitFor();
    // An admin may switch to everyone's builds.
    await page.getByRole('button', { name: "Everyone's" }).click();
    await page.getByText('Nothing is being built right now.').waitFor();
    await shot(page, 'building');
  });

  it('an approved module offers to draft a Flow around it', async () => {
    const slack = (await (await page.request.get(`${base}/api/modules`)).json()).find((m: { name: string; status: string }) => m.name === 'slack' && m.status === 'approved');
    await page.goto(`${base}/modules/${slack.id}`);
    await page.getByRole('link', { name: 'Draft a Flow with this module' }).click();
    await page.waitForURL(/\/flows\?module=slack$/);
    await page.getByText('Using module slack').waitFor();
    // The example and suggestions come from the module's own actions, not a fixed example about another app.
    const box = page.getByPlaceholder(/What should the Flow do with slack\?/);
    await expect.poll(() => box.getAttribute('placeholder')).toContain('post a message');
    expect(await box.getAttribute('placeholder')).not.toContain('video');
    await page.locator('.suggestions').getByRole('button', { name: 'Post a message' }).waitFor();
    await page.getByRole('button', { name: "Don't use it" }).click();
    await expect.poll(() => page.getByText('Using module slack').count()).toBe(0);
  }, 60_000);

  it("a module's page says what each action takes, what it gives back, and the step a Flow writes", async () => {
    const jira = (await (await page.request.get(`${base}/api/modules`)).json()).find((m: { name: string; status: string }) => m.name === 'jira' && m.status === 'approved');
    await page.goto(`${base}/modules/${jira.id}`);
    const card = page.locator('.card').filter({ hasText: 'What each action takes, and what it gives back' });
    await card.getByText('Search issues', { exact: true }).waitFor();
    // What it takes, with the shape and whether the Flow must give it.
    const takes = card.getByRole('list', { name: 'What the action takes' });
    await takes.getByText('jql', { exact: true }).waitFor();
    await expect.poll(() => takes.getByText('required').count()).toBeGreaterThan(0);
    // What later steps can read.
    await card.getByRole('list', { name: 'What the action gives back' }).getByText('{{ steps.<id>.output.issues }}').waitFor();
    // And the step itself, ready to copy: the site the Flow tells it, and the input as a template.
    const step = await card.locator('pre').first().innerText();
    expect(step).toContain('"moduleSettings"');
    expect(step).toContain('"module": "jira@1.1.0"');
    expect(step).toContain('"jql": "{{ inputs.jql }}"');
    await shot(page, 'module-action-io');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('suggests tags when listing a module, and the marketplace filters by tag chips', async () => {
    const slack = (await (await page.request.get(`${base}/api/modules`)).json()).find((m: { name: string; status: string }) => m.name === 'slack' && m.status === 'approved');
    await page.goto(`${base}/modules/${slack.id}`);
    const picker = page.locator('.tag-picker');
    await picker.getByRole('button', { name: '#slack' }).waitFor();
    await picker.getByRole('button', { name: '#changes-data' }).click();
    await picker.getByLabel('Add a tag').fill('Team Chat');
    await picker.getByLabel('Add a tag').press('Enter');
    await picker.getByRole('button', { name: 'Remove tag team-chat' }).waitFor();
    await picker.getByRole('button', { name: '#slack' }).click();
    await shot(page, 'tags-publish');
    await page.getByRole('button', { name: 'List in marketplace' }).click();
    await page.locator('.toast-success', { hasText: 'Listed in the marketplace' }).waitFor();

    await page.goto(`${base}/marketplace`);
    const chips = page.getByRole('group', { name: 'Filter by tag' });
    await chips.getByRole('button', { name: /#team-chat/ }).waitFor();
    await chips.getByRole('button', { name: /#team-chat/ }).click();
    await expect.poll(() => page.locator('.market-grid .card').count()).toBe(1);
    await page.locator('.market-grid .card', { hasText: 'Slack' }).waitFor();
    await shot(page, 'tags-marketplace');
    // Typing narrows the chips to matching tags.
    await chips.getByRole('button', { name: 'Clear tag' }).click();
    await page.getByPlaceholder('Filter by name, service, or tag…').fill('chan');
    await page.getByText('Matching tags:').waitFor();
    await chips.getByRole('button', { name: /#changes-data/ }).waitFor();
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('creates a team; the top bar switches between teams and lists follow it', async () => {
    await page.goto(`${base}/teams`);
    await page.getByRole('heading', { name: 'Teams', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Default' }).waitFor();
    expect(await page.getByRole('combobox', { name: 'Team', exact: true }).count()).toBe(0); // one team: no switcher
    await page.getByLabel('New team').fill('Payments');
    await page.getByRole('button', { name: 'Create team' }).click();
    await page.getByRole('heading', { name: 'Payments: members' }).waitFor();
    await page.getByRole('heading', { name: 'Payments: credentials' }).waitFor();
    await page.getByRole('combobox', { name: 'Whose access for GitLab gitlab' }).selectOption('team');
    await page.getByRole('textbox', { name: 'Team secret for gitlab' }).waitFor();
    await shot(page, 'teams-credentials');
    await page.getByRole('heading', { name: 'Payments: notification channels' }).waitFor();
    await page.getByLabel('Add a channel: module action').selectOption({ label: 'Slack: Post a message (slack@1.0.0)' });
    expect(await page.locator('#channel-in-text').inputValue()).toBe('{{ message.text }} {{ message.url }}');
    await page.locator('#channel-in-channel').fill('C-payments');
    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.locator('#main-content').getByText('channel_needs_team_credentials', { exact: false }).waitFor();
    await shot(page, 'teams-channels');
    await page.getByRole('combobox', { name: 'Team', exact: true }).selectOption({ label: 'Payments' });
    await page.goto(`${base}/run`);
    await page.getByText('No approved Flows yet.').waitFor();
    await page.getByRole('combobox', { name: 'Team', exact: true }).selectOption({ label: 'All my teams' });
    await page.locator('.runnable-card').first().waitFor();
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('admins add a rule in a form; a Flow shows whose access it uses, and a dry run skips everything that changes data', async () => {
    await page.goto(`${base}/admin`);
    await page.getByLabel('Rule', { exact: true }).selectOption({ label: 'Daily run limit per person' });
    await page.getByLabel('Runs per person per day').fill('500');
    await page.getByLabel('Note (why; optional)').fill('Runaway schedules');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByRole('list', { name: 'Rules' }).getByText('At most 500 runs per person per day.').waitFor();
    await page.getByText('Audit chain intact').waitFor();
    expect(await page.getByRole('link', { name: 'Download CSV' }).getAttribute('href')).toContain('/api/admin/audit-report?');
    await shot(page, 'governance-admin');

    await page.goto(`${base}/flows`);
    await page.getByRole('link', { name: 'Release coordination' }).first().click();
    const before = page.getByRole('list', { name: 'Steps and access' });
    await before.waitFor();
    await before.getByText('your own gitlab').first().waitFor();
    await page.getByText('At most 500 runs per person per day.').waitFor();
    await shot(page, 'governance-access-preview');
    await page.locator('#f-release').fill('2.5');
    await page.locator('#f-jql').fill('fixVersion = 2.5');
    await page.locator('#f-project').fill('acme/app');
    await page.locator('#f-channel').fill('C-dry');
    const merged = fake.merged.length;
    await page.getByRole('button', { name: 'Dry run' }).click();
    await page.waitForURL(/\/runs\//);
    await page.locator('.page-head .badge', { hasText: 'Dry run' }).waitFor();
    await page.locator('.page-head .badge', { hasText: 'succeeded' }).waitFor({ timeout: 20_000 });
    expect(fake.merged.length).toBe(merged);
    expect(fake.messages.some((m) => m.channel === 'C-dry')).toBe(false);
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('builds a Flow by dragging steps onto the canvas and filling in the selected step', async () => {
    await page.goto(`${base}/flows`);
    await page.getByRole('button', { name: 'Build a Flow visually' }).click();
    // Why the button is off is said next to it; the link puts the cursor in the name.
    await expect.poll(() => page.getByRole('button', { name: 'Create Flow' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: '(Name, at the top)' }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('editor-name');
    await page.getByLabel('Name', { exact: true }).fill('Dragged release note');
    await page.getByText('Add at least one step first.').waitFor();
    await page.getByLabel('Instructions for its AI steps (optional)').fill('Keep it short.');
    await page.getByRole('button', { name: 'Add an input' }).click();
    await page.getByLabel('Input 1 name').fill('release');
    const palette = page.getByRole('complementary', { name: 'Steps you can add' });
    await palette.getByLabel('Filter steps').fill('post');
    await palette.locator('.palette-item', { hasText: 'Post a message' }).filter({ hasText: 'Slack' }).first().dragTo(page.getByTestId('drop-0'));
    await palette.getByLabel('Filter steps').fill('');
    await palette.locator('.palette-item', { hasText: 'Sign-off' }).dragTo(page.getByTestId('drop-0'));
    const steps = page.getByRole('list', { name: 'Steps in order' });
    await expect.poll(() => steps.locator('.editor-step').allInnerTexts()).toEqual([expect.stringContaining('Sign-off'), expect.stringContaining('Post a message')]);
    // Drag the message above the sign-off, then back down with the buttons.
    await steps.locator('.editor-step', { hasText: 'Post a message' }).dragTo(page.getByTestId('drop-0'));
    await expect.poll(() => steps.locator('.editor-step strong').allInnerTexts()).toEqual(['Post a message', 'Sign-off']);
    await page.getByRole('button', { name: 'Move Post a message down' }).click();
    await expect.poll(() => steps.locator('.editor-step strong').allInnerTexts()).toEqual(['Sign-off', 'Post a message']);
    await steps.locator('.editor-step', { hasText: 'Post a message' }).click();
    const form = page.getByRole('region', { name: 'Selected step' });
    await form.locator('#in-post_message-channel').fill('C-drag');
    await form.getByLabel('Use a value for text').selectOption({ label: 'Run form: release' });
    expect(await form.locator('#in-post_message-text').inputValue()).toBe('{{ inputs.release }}');
    await shot(page, 'visual-editor');
    await page.getByRole('button', { name: 'Create Flow' }).click();
    await page.waitForURL(/\/flows\/[0-9a-f-]{36}$/);
    await page.getByText('What it does').waitFor();
    const flowId = page.url().split('/').pop();
    const versions = await (await page.request.get(`${base}/api/flows/${flowId}/versions`)).json();
    expect(versions[0].definition.steps.map((x: { type: string }) => x.type)).toEqual(['approval', 'action']);
    expect(versions[0].definition.steps[1].input).toEqual({ channel: 'C-drag', text: '{{ inputs.release }}' });
    expect(versions[0].definition.instructions).toBe('Keep it short.');
    // Editing an existing Flow opens the same editor and saves a new version, with the changes listed for review.
    await page.getByRole('button', { name: 'Edit visually' }).click();
    await page.getByRole('button', { name: 'Remove Sign-off' }).click();
    // The old version's review answering after the new one's (as on a slow machine) must not put the old one back.
    await page.route(`**/api/flow-versions/${versions[0].id}/review`, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Save as new version' }).click();
    await page.locator('.toast-success', { hasText: 'New version drafted' }).waitFor();
    await page.getByRole('list', { name: 'Flow changes' }).getByText('Step "Sign-off" was removed.').waitFor();
    await page.waitForTimeout(1700);
    await page.getByRole('list', { name: 'Flow changes' }).getByText('Step "Sign-off" was removed.').waitFor({ timeout: 1000 });
    await page.unroute(`**/api/flow-versions/${versions[0].id}/review`);
    // Re-draft from JSON: a whole template file pasted becomes a new version of the same Flow.
    await page.getByRole('button', { name: 'Or replace the definition (JSON)' }).click();
    const replaced = { name: 'Template', definition: { ...versions[0].definition, inputs: { type: 'object', properties: { release: { type: 'string' }, payload: {} }, required: ['release'] } } };
    await page.getByLabel('Definition').fill(JSON.stringify(replaced));
    await page.getByRole('button', { name: 'Save JSON as new version' }).click();
    await page.locator('.toast-success', { hasText: 'New version drafted' }).nth(0).waitFor();
    await expect.poll(async () => (await (await page.request.get(`${base}/api/flows/${flowId}/versions`)).json()).length).toBe(3);
    const latest = (await (await page.request.get(`${base}/api/flows/${flowId}/versions`)).json()).at(-1);
    expect(latest.definition.inputs).toEqual({ type: 'object', properties: { release: { type: 'string' }, payload: {} }, required: ['release'] });
    // The visual editor keeps an input that takes any JSON as it is.
    await page.getByRole('button', { name: 'v3' }).waitFor();
    await page.getByRole('button', { name: 'Edit visually' }).click();
    const kinds = await page.locator('.row:has(input[aria-label$="name"])').evaluateAll((rows) => rows.map((r) => [(r.querySelector('input') as HTMLInputElement).value, (r.querySelector('select') as HTMLSelectElement).value]));
    expect(Object.fromEntries(kinds)).toEqual({ payload: 'any', release: 'string' });
    // Delete: the Flow leaves the list and is restored from Deleted Flows.
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Delete Flow' }).click();
    await page.waitForURL(/\/flows$/);
    await page.locator('.toast-success', { hasText: 'deleted' }).waitFor();
    const deleted = page.locator('.card', { hasText: 'Deleted Flows' });
    await deleted.getByRole('button', { name: 'Show' }).click();
    await deleted.getByRole('button', { name: 'Restore' }).first().click();
    await page.locator('.toast-success', { hasText: 'restored' }).waitFor();
    expect((await (await page.request.get(`${base}/api/flows/${flowId}/archived`)).json()).archived).toBe(false);
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('shows a heads-up layout on a small square display, navigated with arrow keys and Enter', async () => {
    await page.goto(`${base}/credentials`);
    await page.getByRole('button', { name: 'Connect a phone' }).click();
    const link = (await page.locator('.pairing a').getAttribute('href'))!;
    const glasses = await browser.newContext({ viewport: { width: 600, height: 600 } });
    const hud = await glasses.newPage();
    hud.on('pageerror', (error) => browserErrors.push(error.message));
    await hud.goto(link);
    await hud.locator('main.hud').waitFor();
    await hud.getByText(/^Hi me\./).waitFor();
    expect(await hud.evaluate(() => getComputedStyle(document.querySelector('main.hud')!).backgroundColor)).toBe('rgb(0, 0, 0)');
    expect(await hud.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    expect(await hud.getByRole('button', { name: "What's waiting" }).evaluate((b) => b === document.activeElement)).toBe(true);
    await hud.keyboard.press('Enter');
    await expect.poll(() => hud.locator('.hud-line').innerText()).not.toMatch(/^Hi me\./);
    await shot(hud, 'glasses-hud');
    await glasses.close();
    await page.goto(`${base}/credentials`);
    await page.getByRole('button', { name: 'Disconnect' }).first().click();
    await page.locator('.toast-success', { hasText: 'disconnected' }).waitFor();
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('shows run insights, lets the owner set the time a run takes by hand, and shows AI use', async () => {
    await page.goto(`${base}/insights`);
    const table = page.getByRole('table', { name: 'Flow insights' });
    await table.getByRole('link', { name: 'Release coordination' }).first().waitFor();
    const minutes = page.getByLabel('Minutes by hand for Release coordination').first();
    await minutes.fill('45');
    await minutes.blur();
    await page.locator('.toast-success', { hasText: 'Manual time saved' }).waitFor();
    await page.getByRole('list', { name: 'Waits' }).getByText('Sign-offs').waitFor();
    await page.getByRole('heading', { name: 'AI usage' }).waitFor();
    await page.getByRole('list', { name: 'Team budgets' }).getByText('Default').waitFor();
    await page.getByLabel('Monthly token budget for Default').fill('500000');
    await page.getByRole('button', { name: 'Set budget' }).first().click();
    await page.getByRole('meter', { name: 'Default budget used' }).waitFor();
    await shot(page, 'insights');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('adds a watch that starts a Flow for each new merge request', async () => {
    await page.goto(`${base}/flows`);
    await page.getByRole('link', { name: 'Release coordination' }).first().click();
    await page.getByRole('heading', { name: 'Watches' }).waitFor();
    await page.getByLabel('Add a watch').selectOption('app');
    await page.locator('#watch-name').fill('New MRs');
    await page.getByLabel('Read action').selectOption({ label: 'GitLab: List merge requests (gitlab@1.0.0)' });
    await page.getByLabel('Action input (JSON)').fill('{"project": "acme/app"}');
    await page.getByLabel('List in the result').fill('mergeRequests');
    await page.getByLabel('Field that tells items apart').fill('iid');
    await page.locator('#watch-in-release').fill('MR {{ item.iid }}');
    await page.locator('#watch-in-jql').fill('key = {{ item.iid }}');
    await page.locator('#watch-in-project').fill('acme/app');
    await page.locator('#watch-in-channel').fill('C-watch');
    await page.getByRole('button', { name: 'Add watch' }).click();
    await page.locator('.toast-success', { hasText: 'Watch added' }).waitFor();
    const watches = page.getByRole('list', { name: 'Watches of this Flow' });
    await watches.getByText('New MRs').waitFor();
    await watches.getByRole('button', { name: 'Check now' }).click();
    await page.locator('.toast-success', { hasText: 'Looked' }).waitFor();
    await watches.getByText('0 run(s)').waitFor();
    await shot(page, 'watches');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('admins add a place for the daily audit hash and see the controls each report line supports', async () => {
    await page.goto(`${base}/admin`);
    await page.getByLabel('Send the hash by').selectOption('webhook');
    await page.getByLabel('Send the hash to').fill('https://audit.example.com/dittoly');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Signing key (shown once').waitFor();
    await page.getByRole('list', { name: 'Audit hash copies' }).getByText('https://audit.example.com/dittoly').waitFor();
    const report = await (await page.request.get(`${base}/api/admin/audit-report`)).json();
    expect(report.controls.some((c: { id: string }) => c.id === 'CC8.1')).toBe(true);
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('a Flow an AI assistant saved over MCP shows who drafted it and why', async () => {
    const mcpToken = (await (await fetch(`${base}/api/me/mcp-tokens`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Claude Code on my laptop', scopes: { tools: {}, drafting: true } }) })).json()).token;
    const definition = {
      inputs: { type: 'object', properties: { project: { type: 'string', description: 'Jira project key', examples: ['OPS'] } }, required: ['project'] },
      // The Flow tells the module which site to work with; the module keeps no configuration.
      moduleSettings: { jira: { site: 'example.atlassian.net' } },
      steps: [{ id: 'bugs', type: 'action', module: 'jira@1.1.0', action: 'search_issues', input: { jql: 'project = {{ inputs.project }} AND type = Bug' } }],
    };
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_as_flow', arguments: { name: 'Open bugs from Claude', explanation: 'Lists the open bugs of a project. It changes nothing.', definition, assistant: 'Claude Code' } } }),
    });
    const saved = JSON.parse((await res.json()).result.content[0].text);
    expect(saved.saved).toBe(true);
    await page.goto(`${base}/flows/${saved.flow.id}`);
    const note = page.getByRole('note');
    await note.getByText('Claude Code', { exact: true }).waitFor();
    await note.getByText('Lists the open bugs of a project. It changes nothing.').waitFor();
    await shot(page, 'assistant-flow');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('the Agents page makes an agent with the tools picked, shows its token once, lists it and revokes it', async () => {
    await page.goto(`${base}/agents`);
    await page.getByLabel('Name').fill('Cursor at work');
    await page.getByLabel('May save its work as draft Flows').check();
    await page.getByRole('button', { name: 'Make agent' }).click();
    await page.getByText('Copy this token now').waitFor();
    const row = page.getByRole('list', { name: 'Agents' }).getByRole('listitem').filter({ hasText: 'Cursor at work' });
    await row.getByText('0 tools, drafts Flows').waitFor();
    await shot(page, 'agents');
    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.locator('.toast-success', { hasText: 'Agent revoked' }).waitFor();
    await row.getByText('Revoked', { exact: true }).waitFor();
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('admins offer an approved module action to agents from the Agents page, and people can then pick it', async () => {
    await page.goto(`${base}/agents`);
    const card = page.locator('.card', { hasText: 'App actions offered to agents' });
    await card.getByLabel('Approved module').selectOption({ label: 'Jira Cloud (jira@1.1.0)' });
    await card.getByLabel('Action').selectOption('search_issues');
    // What the module is told here, as a Flow would tell it.
    await card.getByLabel('Your Jira Cloud site').fill('example.atlassian.net');
    await card.getByRole('button', { name: 'Offer to agents' }).click();
    await page.locator('.toast-success', { hasText: 'Offered to agents' }).waitFor();
    await card.getByRole('list', { name: 'Offered app actions' }).getByText('app_jira_search_issues').waitFor();
    await page.getByRole('list', { name: 'Tools this agent may use' }).first().getByText('Jira Cloud: Search issues').waitFor();
    await shot(page, 'agents-gateway');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('shows what Flows saved by not asking an AI every time, and owners set the baseline', async () => {
    await page.goto(`${base}/insights`);
    const card = page.locator('.card', { hasText: 'Saved by not asking an AI every time' });
    await card.getByText('AI tokens not spent').waitFor();
    const row = card.getByRole('row', { name: /Open bugs from Claude/ });
    await row.getByRole('button', { name: 'Set baseline' }).click();
    await row.getByLabel('Input tokens').fill('40000');
    await row.getByLabel('Output tokens').fill('2000');
    await row.getByLabel('Model').fill('claude-x');
    await row.getByRole('button', { name: 'Save' }).click();
    await page.locator('.toast-success', { hasText: 'Baseline saved' }).waitFor();
    await row.getByText('set by its owner').waitFor();
    await shot(page, 'savings');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('admins see and switch self-fixing on the modules page', async () => {
    await page.goto(`${base}/modules`);
    const card = page.locator('.card', { hasText: 'Self-fixing Flows' });
    await card.getByText('on', { exact: true }).waitFor();
    await card.getByLabel('Fixes a day, at most').fill('5');
    await card.getByRole('button', { name: 'Save' }).click();
    await page.locator('.toast-success', { hasText: 'Self-fixing is on' }).waitFor();
    await card.getByRole('button', { name: 'Turn off' }).click();
    await page.locator('.toast-success', { hasText: 'Self-fixing is off' }).waitFor();
    await card.getByText('off', { exact: true }).waitFor();
    const s = await (await fetch(`${base}/api/admin/self-fix`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(s).toMatchObject({ enabled: false, perDay: 5 });
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('admins stream audit events to a SIEM, and can pause it', async () => {
    await page.goto(`${base}/admin`);
    await page.getByLabel('SIEM').selectOption('splunk');
    await page.getByLabel('Stream name').fill('Security Splunk');
    await page.getByLabel('HEC address').fill('https://splunk.example.com:8088');
    await page.getByLabel('HEC token').fill('hec-secret');
    await page.getByRole('button', { name: 'Add stream' }).click();
    await page.locator('.toast-success', { hasText: 'Stream added' }).waitFor();
    const streams = page.getByRole('list', { name: 'Audit streams' });
    await streams.getByText('Security Splunk').waitFor();
    await streams.getByText('https://splunk.example.com:8088').waitFor();
    await streams.getByRole('button', { name: 'Pause' }).click();
    await streams.getByText('paused').waitFor();
    await shot(page, 'audit-streams');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('the top bar shows the AI in use, and an admin switches the model there', async () => {
    ai.models = ['m1', 'm2'];
    await page.goto(`${base}/`);
    const chip = page.getByRole('button', { name: /^AI in use: mock/ });
    await chip.waitFor();
    await chip.click();
    const menu = page.getByRole('dialog', { name: 'Switch the AI model' });
    // The provider's models are a list to pick from; one not listed can still be typed.
    const models = menu.getByRole('combobox', { name: /^Model/ });
    await expect.poll(() => models.locator('option').allTextContents()).toEqual(['Choose a model…', 'm1', 'm2', 'Other model…']);
    await models.selectOption('__other');
    await menu.getByLabel('Model name').waitFor();
    await models.selectOption('m2');
    await menu.getByRole('combobox', { name: /^Effort/ }).selectOption('low');
    await shot(page, 'ai-model-switch');
    await menu.getByRole('button', { name: 'Switch' }).click();
    await page.locator('.toast-success', { hasText: 'Now using mock:m2 at low effort' }).waitFor();
    await page.getByRole('button', { name: 'AI in use: mock · m2, low effort (click to switch)' }).waitFor();
    // Back to the server configuration, so later tests run as configured.
    await page.getByRole('button', { name: /^AI in use: mock · m2/ }).click();
    await page.getByRole('dialog', { name: 'Switch the AI model' }).getByRole('button', { name: 'Use server configuration' }).click();
    await page.locator('.toast-success', { hasText: 'Back to the server configuration' }).waitFor();
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('builds an app over a Flow, approves it, opens it and runs its form on the team key', async () => {
    const notify = {
      inputs: { type: 'object', properties: { text: { type: 'string', description: 'What to post', examples: ['Deploy done'] } }, required: ['text'] },
      steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-ops', text: '{{ inputs.text }}' } }],
    };
    const v = await appRef.flows.create('Notify ops', notify, meRef);
    await appRef.flows.decide(v.id, meRef, 'approved');
    const teamId = await defaultTeamFor(appRef.db, meRef.id);
    await setCredentialMode(appRef.db, meRef, teamId, 'slack', 'slack', 'team');
    await putTeamCredential(appRef.db, appRef.cipher, meRef, teamId, 'slack', 'xoxb-team');

    await page.goto(`${base}/team-apps`);
    await page.getByRole('heading', { name: 'Apps', exact: true }).waitFor();
    await page.locator('#app-name').fill('Ops desk');
    await page.getByRole('checkbox', { name: 'Notify ops' }).check();
    await page.getByRole('button', { name: 'Make the default layout' }).click();
    await page.getByRole('figure', { name: 'Layout sketch' }).waitFor();
    await page.locator('input[id^="pt-"]').first().fill('Post to ops');
    await expect(page.getByRole('figure', { name: 'Layout sketch' }).getByRole('heading', { name: 'Post to ops' }).isVisible()).resolves.toBe(true);
    await shot(page, '40-app-builder');
    await page.getByRole('button', { name: 'Save the app' }).click();
    await page.waitForURL(/\/team-apps\/[0-9a-f-]{36}$/);
    // Local mode: the one member approves their own app.
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('link', { name: 'Open app' }).waitFor();
    await shot(page, '41-app-page');

    // The app opens on its own page (the portal opens it in a new tab).
    const tab = page;
    await tab.goto(page.url().replace('/team-apps/', '/a/') + '/');
    await tab.getByRole('heading', { name: 'Post to ops' }).waitFor();
    await tab.locator('#f-text').fill('hello team');
    await tab.getByRole('button', { name: 'Run' }).click();
    await tab.getByText('Done', { exact: true }).waitFor({ timeout: 15_000 });
    await shot(tab, '42-app-open');
    expect(fake.messages.at(-1)).toMatchObject({ text: 'hello team', auth: 'Bearer xoxb-team' });
    // The app's own Runs page lists it for the team.
    await tab.getByRole('link', { name: 'Runs' }).click();
    await tab.getByRole('cell', { name: 'Notify ops' }).waitFor();
    // Back to Dittoly from the bar above the app.
    await tab.getByRole('link', { name: '← Dittoly' }).click();
    await page.getByRole('heading', { name: 'Ops desk' }).waitFor();
  }, 60_000);

  it('connects the organization to a git repository and writes everything approved to a branch', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'dty-e2e-git-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    g('init', '-q', '--bare', '-b', 'main', 'repo.git');
    g('clone', '-q', 'repo.git', 'seed');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start'], { cwd: path.join(dir, 'seed') });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: path.join(dir, 'seed') });

    await page.goto(`${base}/admin`);
    const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Git sync' }) });
    await card.getByRole('button', { name: 'Connect a repository' }).click();
    await card.getByLabel('Host').selectOption('git');
    await card.getByLabel('Repository URL').fill(`file://${dir}/repo.git`);
    await card.getByLabel('Access token').fill('token');
    await card.getByRole('button', { name: 'Connect' }).click();
    await card.getByText('Nothing written yet').waitFor();
    await card.getByRole('button', { name: 'Export everything approved now' }).click();
    await card.getByText('Everything approved in Dittoly').waitFor();
    await expect.poll(async () => { await card.getByRole('button', { name: 'Refresh' }).click(); return card.getByText('Branch pushed').count(); }, { timeout: 15_000 }).toBeGreaterThan(0);
    await shot(page, '43-git-sync');
    expect(g('--git-dir', 'repo.git', 'branch', '--format=%(refname:short)')).toMatch(/dittoly\/sync-/);

    // Someone merges it and changes a Flow in git: it comes back as a version waiting for approval.
    const seed = path.join(dir, 'seed');
    const w = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@acme.test', ...args], { cwd: seed, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    w('fetch', '-q', 'origin');
    const sync = w('branch', '-r', '--format=%(refname:short)').split('\n').find((b) => b.includes('dittoly/sync-'))!.trim();
    w('merge', '-q', '--ff-only', sync);
    const { readFile, writeFile } = await import('node:fs/promises');
    const file = path.join(seed, 'dittoly/flows/default/notify-ops/flow.json');
    const flow = JSON.parse(await readFile(file, 'utf8'));
    flow.definition.steps[0].input.channel = 'C-team';
    await writeFile(file, JSON.stringify(flow, null, 2));
    w('commit', '-q', '-am', 'Post to the team channel');
    w('push', '-q', 'origin', 'HEAD:main');
    await card.getByRole('button', { name: 'Sync from git now' }).click();
    await expect.poll(async () => { await card.getByRole('button', { name: 'Refresh' }).click(); return card.getByText('1 waiting for approval').count(); }, { timeout: 15_000 }).toBeGreaterThan(0);
    await card.getByText('Flow Notify ops v2').waitFor();
    await shot(page, '44-git-import');
  }, 60_000);

  it('serves the portal for deep links and keeps API 404s as JSON', async () => {
    const deep = await page.request.get(`${base}/runs/does-not-exist`);
    expect(deep.headers()['content-type']).toContain('text/html');
    expect(deep.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    const api404 = await page.request.get(`${base}/api/nope`);
    expect(api404.status()).toBe(404);
  });
});

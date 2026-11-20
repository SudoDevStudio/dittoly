import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { LocalBrowserLauncher } from '../src/sandbox/browser.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * Live browser views: the run's member watches a browser step, takes over when
 * the script asks for help, and can open approved sites themselves.
 */
const CHROMIUM = process.env.DITTOLY_CHROMIUM ?? '/opt/pw-browsers/chromium';
const LOGIN_PAGE = `<!doctype html><title>Sign in</title>
<form onsubmit="event.preventDefault(); document.querySelector('#out').textContent = 'Welcome back'; document.title = 'Dashboard'">
<input id="user" placeholder="Email" style="position:absolute;left:20px;top:20px;width:300px;height:30px">
<input id="pw" type="password" placeholder="Password" style="position:absolute;left:20px;top:80px;width:300px;height:30px">
<button style="position:absolute;left:20px;top:140px">Sign in</button></form><p id="out" style="position:absolute;top:200px"></p>`;

let w: World;
let api: ReturnType<typeof buildServer>;
let site: http.Server;
let host: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const manifest = (h: string) => ({
  name: 'portal-help',
  version: '1.0.0',
  title: 'Portal (asks you to sign in)',
  description: 'Opens the portal and asks the member to sign in. Needs no key.',
  hosts: [],
  browser: { hosts: [h] },
  credentials: [],
  actions: [
    {
      name: 'check',
      title: 'Check the dashboard',
      description: 'Asks you to sign in, then reads the greeting.',
      effect: 'read',
      credentials: [],
      input: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      output: { type: 'object', properties: { greeting: { type: 'string' }, typed: { type: 'string' } }, required: ['greeting'] },
    },
  ],
});
const code = `export const actions = {
  async check(input, { page, expect }) {
    await page.goto(input.url);
    await page.askForHelp('Sign in, then press Continue');
    await expect(page).toHaveTitle('Dashboard');
    // What the member typed is sealed: the script cannot read it back.
    return { greeting: await page.locator('#out').textContent(), typed: await page.locator('#pw').inputValue().catch((e) => e.code) };
  },
};`;

beforeAll(async () => {
  site = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(LOGIN_PAGE);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  host = `127.0.0.1:${(site.address() as AddressInfo).port}`;
  w = await makeWorld({ mode: 'local', insecureHttpHosts: [host], internalHosts: [host] }, { browser: new LocalBrowserLauncher(CHROMIUM), actionTimeoutMs: 30_000 });
  api = buildServer(w.app);
  const mv = await w.app.modules.createDraft(
    {
      manifest: manifest(host),
      code,
      tests: [{ name: 'carries on in tests', action: 'check', input: { url: `http://${host}/` }, http: [], expectOk: false, pages: [{ urlPrefix: `http://${host}/`, body: LOGIN_PAGE }] }],
      origin: 'seed',
    },
    w.alice,
  );
  expect(mv.validationReport?.tests[0]).toMatchObject({ passed: true, errorType: 'expectation_failed' });
  await w.app.modules.submit(mv.id, w.alice);
  await w.app.modules.decide(mv.id, w.admin, 'approved');
}, 60_000);
afterAll(async () => {
  await w.app.live.closeAll();
  await api.close();
  await w.db.end();
  site.close();
});

const until = async <T>(f: () => T | Promise<T>, ms = 30_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('a browser step that asks for help', () => {
  it('waits for the run\'s member, who takes over in the live view; what they type stays secret', async () => {
    const v = await w.app.flows.create('Portal check', { steps: [{ id: 'check', type: 'action', module: 'portal-help@1.0.0', action: 'check', input: { url: `http://${host}/` } }] }, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    const draining = w.app.worker.drain();

    const session = await until(async () => {
      const list = (await api.inject({ method: 'GET', url: `/api/live?run=${runId}`, headers: auth(w.tokens.alice) })).json();
      return list.find((s: { help: string | null }) => s.help);
    });
    expect(session).toMatchObject({ kind: 'step', stepId: 'check', help: 'Sign in, then press Continue' });
    // Nobody else can see or touch it.
    expect((await api.inject({ method: 'GET', url: `/api/live?run=${runId}`, headers: auth(w.tokens.bob) })).json()).toEqual([]);
    expect((await api.inject({ method: 'POST', url: `/api/live/${session.id}/continue`, headers: auth(w.tokens.bob) })).statusCode).toBe(404);
    expect((await api.inject({ method: 'GET', url: `/api/live/${session.id}/stream`, headers: auth(w.tokens.bob) })).statusCode).toBe(404);
    const note = await w.db.query(`SELECT 1 FROM notifications WHERE member_id = $1 AND kind = 'input_needed' AND run_id = $2`, [w.alice.id, runId]);
    expect(note.rowCount).toBe(1);

    // The member watches: frames arrive while someone is subscribed.
    const frames: string[] = [];
    const stop = w.app.live.subscribe(session.id, w.alice, (e) => {
      if (e.type === 'frame') frames.push(e.frame.data);
    });
    await until(() => frames.length > 0);
    expect(Buffer.from(frames[0]!, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8'); // a JPEG

    const input = (body: object) => api.inject({ method: 'POST', url: `/api/live/${session.id}/input`, headers: auth(w.tokens.alice), payload: body });
    expect((await input({ type: 'click', x: 100, y: 35 })).statusCode).toBe(200);
    await input({ type: 'type', text: 'jane@example.com' });
    await input({ type: 'click', x: 100, y: 95 });
    await input({ type: 'type', text: 'hunter2-secret' });
    expect((await input({ type: 'key', key: 'Enter' })).statusCode).toBe(200);
    expect((await input({ type: 'goto', url: 'https://example.com/' })).json()).toMatchObject({ error: 'browser_host_denied' });
    expect((await api.inject({ method: 'POST', url: `/api/live/${session.id}/continue`, headers: auth(w.tokens.alice) })).statusCode).toBe(204);
    await draining;
    stop();

    const run = await runStatus(w, runId, w.alice);
    expect(run.status).toBe('succeeded');
    // The script reads the page, but never what the member typed.
    expect(run.steps[0]!.output).toEqual({ greeting: 'Welcome back', typed: 'browser_secret_field' });
    expect(w.app.live.forRun(runId, w.alice)).toEqual([]);
  }, 90_000);

  it('a running script\'s page cannot be driven unless it asks', async () => {
    const slow = { ...manifest(host), name: 'portal-slow', actions: [{ ...manifest(host).actions[0]!, name: 'look' }] };
    const mv = await w.app.modules.createDraft(
      {
        manifest: slow,
        code: `export const actions = { async look(input, { page }) { await page.goto(input.url); await page.waitForTimeout(3000); return { greeting: await page.title() }; } };`,
        tests: [{ name: 't', action: 'look', input: { url: `http://${host}/` }, http: [], expectOk: true, pages: [{ urlPrefix: `http://${host}/`, body: LOGIN_PAGE }] }],
        origin: 'seed',
      },
      w.alice,
    );
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
    const v = await w.app.flows.create('Slow look', { steps: [{ id: 'look', type: 'action', module: 'portal-slow@1.0.0', action: 'look', input: { url: `http://${host}/` } }] }, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    const draining = w.app.worker.drain();
    const session = await until(() => w.app.live.forRun(runId, w.alice)[0]);
    expect(session.help).toBeNull();
    expect((await api.inject({ method: 'POST', url: `/api/live/${session.id}/input`, headers: auth(w.tokens.alice), payload: { type: 'click', x: 1, y: 1 } })).json()).toMatchObject({ error: 'live_not_waiting' });
    await draining;
    expect((await runStatus(w, runId, w.alice)).status).toBe('succeeded');
  }, 60_000);
});

describe('the sites the Dittoly Browser opens', () => {
  it('lists the approved browser modules\' sites and those an admin adds; only admins change the list', async () => {
    const get = async (token: string) => (await api.inject({ method: 'GET', url: '/api/browser-sites', headers: auth(token) })).json();
    const put = (token: string, hosts: string[]) => api.inject({ method: 'PUT', url: '/api/browser-sites', headers: auth(token), payload: { hosts } });
    expect(await get(w.tokens.bob)).toMatchObject({ fromModules: expect.arrayContaining([host]), added: [] });
    expect((await put(w.tokens.bob, ['example.org'])).statusCode).toBe(403);
    expect((await put(w.tokens.admin, ['not a host'])).json()).toMatchObject({ error: 'invalid_browser_sites' });
    expect((await put(w.tokens.admin, ['https://Status.Example.org/', '*.example.net', 'status.example.org'])).json()).toEqual({ added: ['status.example.org', '*.example.net'] });
    expect((await get(w.tokens.bob)).added).toEqual(['status.example.org', '*.example.net']);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'org.browser_sites_updated'`)).rowCount).toBe(1);
    expect((await put(w.tokens.admin, [])).json()).toEqual({ added: [] });
  });
});

describe('opening a page yourself', () => {
  it('opens only approved browser sites, takes screenshots, and streams over Server-Sent Events', async () => {
    const open = (url: string) => api.inject({ method: 'POST', url: '/api/live', headers: auth(w.tokens.bob), payload: { url } });
    expect((await open('https://example.com/')).json()).toMatchObject({ error: 'site_not_allowed' });
    const res = await open(`http://${host}/`);
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    expect((await api.inject({ method: 'GET', url: '/api/live', headers: auth(w.tokens.alice) })).json()).toEqual([]);
    const shot = (await api.inject({ method: 'POST', url: `/api/live/${id}/screenshot`, headers: auth(w.tokens.bob) })).json();
    expect(shot.screenshot).toMatch(/^data:image\/jpeg;base64,/);

    await api.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/live/${id}/stream`, { headers: auth(w.tokens.bob), signal: ctrl.signal });
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const reader = stream.body!.getReader();
    let text = '';
    while (!text.includes('"type":"frame"')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('data: {"type":"state","help":null,"closed":false}');
    ctrl.abort();

    expect((await api.inject({ method: 'DELETE', url: `/api/live/${id}`, headers: auth(w.tokens.bob) })).statusCode).toBe(204);
    expect((await api.inject({ method: 'POST', url: `/api/live/${id}/screenshot`, headers: auth(w.tokens.bob) })).statusCode).toBe(404);
  }, 60_000);
});

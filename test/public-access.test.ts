import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { optionalServicesFor, parseManifest, reviewSummary, servicesFor, type Manifest } from '../src/modules/manifest.js';
import { validateModule } from '../src/modules/validate.js';
import { Broker, type FetchLike } from '../src/sandbox/broker.js';
import { ProcessRunner } from '../src/sandbox/runner.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * Public data needs no key: a credential marked optional is attached when the
 * member has stored it (higher limits, private data) and left off otherwise.
 */
const manifest = {
  name: 'github-public',
  version: '1.0.0',
  title: 'GitHub (public)',
  description: 'Lists pull requests. Reads public repositories without a key; a stored GitHub token raises rate limits and adds private repositories.',
  hosts: ['api.github.com'],
  credentials: [{ id: 'gh', service: 'github', label: 'GitHub personal access token', hosts: ['api.github.com'], placement: { type: 'bearer' }, optional: true }],
  actions: [
    {
      name: 'list_pull_requests',
      title: 'List pull requests',
      description: 'Open pull requests of a repository.',
      effect: 'read',
      credentials: ['gh'],
      input: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
      output: { type: 'object', properties: { titles: { type: 'array', items: { type: 'string' } } }, required: ['titles'] },
    },
  ],
};
const code = `export const actions = {
  async list_pull_requests(input, ctx) {
    const res = await ctx.http.request({ method: 'GET', url: 'https://api.github.com/repos/' + input.repo + '/pulls', credential: 'gh' });
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new ctx.ActionError('needs_credential', { retryable: false });
    if (!res.ok) throw new ctx.ActionError('github_' + res.status, { retryable: res.status === 429 || res.status >= 500 });
    return { titles: res.json().map((p) => p.title) };
  },
};`;
const tests = [
  { name: 'with a token', action: 'list_pull_requests', input: { repo: 'nodejs/node' }, http: [{ method: 'GET', urlPrefix: 'https://api.github.com/repos/nodejs/node/pulls', status: 200, json: [{ title: 'Fix' }] }], expectOk: true },
  { name: 'without a key', action: 'list_pull_requests', input: { repo: 'nodejs/node' }, http: [{ method: 'GET', urlPrefix: 'https://api.github.com/repos/nodejs/node/pulls', status: 200, json: [{ title: 'Fix' }] }], expectOk: true, withoutCredentials: true },
];

const parsed = () => (parseManifest(manifest) as { manifest: Manifest }).manifest;

describe('optional credentials', () => {
  it('are not required to run, and the approver is told the module works without them', () => {
    const m = parsed();
    expect(servicesFor(m, 'list_pull_requests')).toEqual([]);
    expect(optionalServicesFor(m, 'list_pull_requests')).toEqual(['github']);
    expect(reviewSummary(m)).toContain('It is OPTIONAL: without it the module works with public data only.');
    // Manifests without the flag stay as they were (and keep their approval hash).
    const { optional: _, ...withoutFlag } = manifest.credentials[0]!;
    const plain = (parseManifest({ ...manifest, credentials: [withoutFlag] }) as { manifest: Manifest }).manifest;
    expect(plain.credentials[0]).not.toHaveProperty('optional');
    expect(servicesFor(plain, 'list_pull_requests')).toEqual(['github']);
  });

  it('the broker attaches a stored one and sends the request without it otherwise; a required one still stops', async () => {
    const seen: (string | null)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(new Headers(init.headers).get('authorization'));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const req = { method: 'GET', url: 'https://api.github.com/repos/a/b/pulls', headers: {}, credential: 'gh', body: null, json: false };
    const m = parsed();
    expect(await new Broker({ manifest: m, action: 'list_pull_requests', resolveSecret: async () => 'ghp_x', fetchImpl }).handle(req)).toMatchObject({ ok: true });
    expect(await new Broker({ manifest: m, action: 'list_pull_requests', resolveSecret: async () => null, fetchImpl }).handle(req)).toMatchObject({ ok: true });
    expect(seen).toEqual(['Bearer ghp_x', null]);
    const required = { ...m, credentials: [{ ...m.credentials[0]!, optional: false }] };
    expect(await new Broker({ manifest: required, action: 'list_pull_requests', resolveSecret: async () => null, fetchImpl }).handle(req)).toMatchObject({ ok: false, error: 'credential_missing' });
  });

  it('sandbox tests can run as a member with no stored credentials', async () => {
    const { report } = await validateModule(new ProcessRunner(), manifest, code, tests);
    expect(report.passed).toBe(true);
    const required = { ...manifest, credentials: [{ ...manifest.credentials[0]!, optional: false }] };
    const strict = await validateModule(new ProcessRunner(), required, code, tests);
    expect(strict.report.tests[1]).toMatchObject({ passed: false });
  }, 30_000);
});

describe('a Flow on public data', () => {
  let w: World;
  let api: ReturnType<typeof buildServer>;
  const calls: (string | null)[] = [];
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  beforeAll(async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      if (!url.startsWith('https://api.github.com/')) return new Response('{}', { status: 404 });
      calls.push(new Headers(init.headers).get('authorization'));
      return new Response(JSON.stringify([{ title: 'Add tests' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    w = await makeWorld({}, { fetchImpl });
    api = buildServer(w.app);
    const mv = await w.app.modules.createDraft({ manifest, code, tests, origin: 'seed' }, w.alice);
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
  });
  afterAll(async () => {
    await api.close();
    await w.db.end();
  });

  it('is ready and runs for a member with no key, and uses the key of a member who stored one', async () => {
    const def = {
      inputs: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
      steps: [{ id: 'prs', type: 'action', module: 'github-public@1.0.0', action: 'list_pull_requests', input: { repo: '{{ inputs.repo }}' } }],
    };
    const v = await w.app.flows.create('Open PRs', def, w.alice);
    expect((await w.app.flows.review(v.id)).summary).toContain('reads data (using their own github access if stored, else public data only)');
    await w.app.flows.decide(v.id, w.approver, 'approved');

    const runnable = (await api.inject({ method: 'GET', url: '/api/runnable', headers: auth(w.tokens.bob) })).json();
    expect(runnable.find((r: { versionId: string }) => r.versionId === v.id)).toMatchObject({ ready: true, missing: [] });
    const needed = (await api.inject({ method: 'GET', url: '/api/me/credentials/needed', headers: auth(w.tokens.bob) })).json();
    expect(needed).toEqual([expect.objectContaining({ service: 'github', optional: true, stored: false })]);

    const bobRun = await w.app.engine.startRun(v.id, w.bob.id, { repo: 'nodejs/node' });
    await w.app.worker.drain();
    expect(await runStatus(w, bobRun, w.bob)).toMatchObject({ status: 'succeeded' });
    await w.app.vault.put(w.alice.id, 'github', 'ghp_alice');
    const aliceRun = await w.app.engine.startRun(v.id, w.alice.id, { repo: 'nodejs/node' });
    await w.app.worker.drain();
    expect(await runStatus(w, aliceRun, w.alice)).toMatchObject({ status: 'succeeded' });
    expect(calls).toEqual([null, 'Bearer ghp_alice']);
  });
});

describe('reading any public website', () => {
  const reader = {
    name: 'article-reader',
    version: '1.0.0',
    title: 'Article reader',
    description: 'Reads any public article. Needs no key.',
    hosts: ['api.example.com'],
    publicWeb: 'read',
    credentials: [{ id: 'tok', service: 'example', label: 'Example token', hosts: ['api.example.com'], placement: { type: 'bearer' } }],
    actions: [{ name: 'fetch', title: 'Fetch', description: 'Fetches a page.', effect: 'read', credentials: ['tok'], input: {}, output: {} }],
  };
  const parsedReader = () => (parseManifest(reader) as { manifest: Manifest }).manifest;
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return new Response('<h1>News</h1>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const broker = () => new Broker({ manifest: parsedReader(), action: 'fetch', resolveSecret: async () => 'secret', fetchImpl });
  const req = (over: Partial<{ method: string; url: string; headers: Record<string, unknown>; credential: string | null; body: string | null }>) => ({
    method: 'GET', url: 'https://news.example.org/story?id=1', headers: {}, credential: null, body: null, json: false, ...over,
  });

  it('lets a module GET any public https page, sending nothing of its own', async () => {
    const b = broker();
    const ok = await b.handle(req({ headers: { accept: 'text/html', 'x-leak': 'data', authorization: 'Bearer x' } }));
    expect(ok).toMatchObject({ ok: true, response: { status: 200, body: '<h1>News</h1>' } });
    expect(seen.at(-1)!.headers).toEqual({ accept: 'text/html' });
    expect(reviewSummary(parsedReader())).toContain('It may also READ ANY PUBLIC WEBSITE');
  });

  it('refuses writes, credentials, bodies, plain http and long addresses to sites it was not approved for', async () => {
    const b = broker();
    expect(await b.handle(req({ method: 'POST', body: 'x' }))).toMatchObject({ ok: false, error: 'public_web_read_only' });
    expect(await b.handle(req({ credential: 'tok' }))).toMatchObject({ ok: false, error: 'credential_denied_host' });
    expect(await b.handle(req({ url: 'http://news.example.org/' }))).toMatchObject({ ok: false, error: 'egress_denied_scheme' });
    expect(await b.handle(req({ url: `https://news.example.org/?q=${'a'.repeat(2100)}` }))).toMatchObject({ ok: false, error: 'public_web_url_too_long' });
    // The declared host keeps full access, with its credential.
    expect(await b.handle(req({ method: 'POST', url: 'https://api.example.com/v1', credential: 'tok', body: '{}' }))).toMatchObject({ ok: true });
    // Without "publicWeb", undeclared hosts stay closed.
    const strict = new Broker({ manifest: { ...parsedReader(), publicWeb: undefined }, action: 'fetch', resolveSecret: async () => null, fetchImpl });
    expect(await strict.handle(req({}))).toMatchObject({ ok: false, error: 'egress_denied_host' });
  });

  it('never reaches private addresses through the public web', async () => {
    const b = new Broker({ manifest: parsedReader(), action: 'fetch', resolveSecret: async () => null, internalHosts: ['10.0.0.5'] });
    expect(await b.handle(req({ url: 'https://10.0.0.5/' }))).toMatchObject({ ok: false, error: 'egress_denied_ip' });
  });
});

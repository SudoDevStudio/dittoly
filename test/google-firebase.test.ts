import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseManifest, resolveManifest, reviewSummary, type Manifest } from '../src/modules/manifest.js';
import { Broker, type FetchLike } from '../src/sandbox/broker.js';
import { clearGoogleTokenCache, googleAccessToken, GOOGLE_TOKEN_URL, parseServiceAccountKey, signAssertion } from '../src/runtime/google-auth.js';
import { makeWorld, type World } from './helpers.js';

/** Google service account keys stay with Dittoly; requests carry short-lived, scope-limited tokens. Firebase over HTTPS. */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyFile = JSON.stringify({
  type: 'service_account',
  project_id: 'demo-shop',
  private_key_id: 'abc',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'dittoly@demo-shop.iam.gserviceaccount.com',
  // A key file cannot send the signed assertion anywhere else: this is ignored.
  token_uri: 'https://evil.example.com/token',
});
const DATASTORE = 'https://www.googleapis.com/auth/datastore';

/** A fake Google: the token endpoint, and Firestore that wants the token it issued. */
function fakeGoogle(log: { url: string; init: RequestInit }[], status = 200): FetchLike {
  let n = 0;
  return async (url, init) => {
    log.push({ url, init });
    if (url === GOOGLE_TOKEN_URL) {
      if (status !== 200) return new Response('{"error":"invalid_grant"}', { status });
      return Response.json({ access_token: `ya29.token-${++n}`, expires_in: 3599, token_type: 'Bearer' });
    }
    const auth = new Headers(init.headers).get('authorization');
    if (!auth?.startsWith('Bearer ya29.')) return new Response('{}', { status: 401 });
    return Response.json({ documents: [{ name: 'projects/demo-shop/databases/(default)/documents/orders/1', fields: { status: { stringValue: 'new' } } }] });
  };
}

beforeEach(() => clearGoogleTokenCache());

describe('the token exchange', () => {
  it('signs a one-hour RS256 assertion for the declared scopes, sent only to Google\'s token endpoint', async () => {
    const jwt = signAssertion(parseServiceAccountKey(keyFile), [DATASTORE], 1_800_000_000);
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({ iss: 'dittoly@demo-shop.iam.gserviceaccount.com', scope: DATASTORE, aud: GOOGLE_TOKEN_URL, iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);

    const log: { url: string; init: RequestInit }[] = [];
    const t1 = await googleAccessToken(keyFile, [DATASTORE], fakeGoogle(log));
    expect(t1).toBe('ya29.token-1');
    expect(log.map((l) => l.url)).toEqual([GOOGLE_TOKEN_URL]);
    const form = new URLSearchParams(String(log[0]!.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')!.split('.')).toHaveLength(3);
    // Reused until shortly before it expires; a different scope set gets its own token.
    expect(await googleAccessToken(keyFile, [DATASTORE], fakeGoogle(log))).toBe('ya29.token-1');
    expect(await googleAccessToken(keyFile, [DATASTORE], fakeGoogle(log), Date.now() + 3_500_000)).toBe('ya29.token-1');
    expect(log).toHaveLength(1);
    // Within a minute of expiry it is renewed.
    await googleAccessToken(keyFile, [DATASTORE], fakeGoogle(log), Date.now() + 3_560_000);
    expect(log).toHaveLength(2);
  });

  it('a bad or revoked key is a clear error', async () => {
    await expect(googleAccessToken('not json', [DATASTORE], fakeGoogle([]))).rejects.toMatchObject({ code: 'credential_invalid' });
    await expect(googleAccessToken(JSON.stringify({ type: 'authorized_user', client_email: 'x' }), [DATASTORE], fakeGoogle([]))).rejects.toMatchObject({ code: 'credential_invalid' });
    await expect(googleAccessToken(keyFile, [DATASTORE], fakeGoogle([], 400))).rejects.toMatchObject({ code: 'credential_rejected' });
    await expect(googleAccessToken(keyFile, [DATASTORE], fakeGoogle([], 503))).rejects.toMatchObject({ code: 'google_token_unavailable', retryable: true });
  });
});

const firestoreManifest = () => ({
  name: 'firestore-orders',
  version: '1.0.0',
  title: 'Firestore orders',
  description: 'Reads orders from Cloud Firestore.',
  hosts: ['firestore.googleapis.com'],
  settings: [{ id: 'project', type: 'text', label: 'Firebase project id', default: 'demo-shop' }],
  credentials: [{ id: 'sa', service: 'firebase', label: 'Firebase service account', hosts: ['firestore.googleapis.com'], placement: { type: 'google_service_account', scopes: [DATASTORE] } }],
  actions: [
    {
      name: 'list_orders',
      title: 'List orders',
      description: 'Orders by status.',
      effect: 'read',
      credentials: ['sa'],
      input: { type: 'object', properties: { status: { type: 'string', enum: ['new', 'shipped'] } }, required: ['status'], additionalProperties: false },
      output: { type: 'object' },
    },
  ],
});

describe('the manifest and broker', () => {
  it('the review says the key stays with Dittoly, and which scopes the tokens get', () => {
    const r = parseManifest(firestoreManifest());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(reviewSummary((r as { manifest: Manifest }).manifest)).toContain(
      'It uses the running member\'s own Google service account key "Firebase service account" (service "firebase"). Dittoly keeps the key and sends only short-lived access tokens, limited to datastore, and only to firestore.googleapis.com.',
    );
    const bad = firestoreManifest();
    (bad.credentials[0]!.placement as any).scopes = ['https://evil.example.com/scope'];
    expect(parseManifest(bad).ok).toBe(false);
  });

  it('requests get a token; the code never sees the key; other hosts never get it', async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const m = resolveManifest((parseManifest(firestoreManifest()) as { manifest: Manifest }).manifest, {}, { useDefaults: true }).manifest;
    const broker = new Broker({ manifest: m, action: 'list_orders', resolveSecret: async () => keyFile, fetchImpl: fakeGoogle(log) });
    const res = await broker.handle({ method: 'POST', url: 'https://firestore.googleapis.com/v1/projects/demo-shop/databases/(default)/documents:runQuery', headers: {}, credential: 'sa', body: '{}', json: true });
    expect(res).toMatchObject({ ok: true, response: { status: 200 } });
    expect(log.map((l) => l.url)).toEqual([GOOGLE_TOKEN_URL, 'https://firestore.googleapis.com/v1/projects/demo-shop/databases/(default)/documents:runQuery']);
    expect(new Headers(log[1]!.init.headers).get('authorization')).toBe('Bearer ya29.token-1');
    expect(JSON.stringify(res)).not.toContain('PRIVATE KEY');
    // The token endpoint is the broker's own call, not a host the module may reach.
    expect(await broker.handle({ method: 'POST', url: GOOGLE_TOKEN_URL, headers: {}, credential: null, body: 'x', json: false })).toMatchObject({ ok: false, error: 'egress_denied_host', violation: true });
    // A key that does not parse fails the step clearly, without calling Google.
    const broken = new Broker({ manifest: m, action: 'list_orders', resolveSecret: async () => 'pasted the wrong thing', fetchImpl: fakeGoogle([]) });
    expect(await broken.handle({ method: 'GET', url: 'https://firestore.googleapis.com/v1/x', headers: {}, credential: 'sa', body: null, json: false })).toMatchObject({ ok: false, error: 'credential_invalid', violation: false });
  });
});

describe('module review', () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
  });
  afterAll(async () => {
    await w.db.end();
  });
  it('sandbox tests use a dummy token and canned Firestore answers', async () => {
    const code = `export const actions = {
  async list_orders(input, ctx) {
    const project = encodeURIComponent(ctx.settings.project);
    const res = await ctx.http.request({
      method: 'POST',
      url: 'https://firestore.googleapis.com/v1/projects/' + project + '/databases/(default)/documents:runQuery',
      credential: 'sa',
      json: { structuredQuery: { from: [{ collectionId: 'orders' }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: input.status } } }, limit: 50 } },
    });
    if (!res.ok) throw new ctx.ActionError('firestore_' + res.status, { retryable: res.status >= 500 || res.status === 429 });
    const rows = await res.json();
    return { orders: rows.filter((r) => r.document).map((r) => ({ id: r.document.name.split('/').pop(), status: r.document.fields.status?.stringValue ?? null })) };
  },
};`;
    const tests = [
      {
        name: 'lists',
        action: 'list_orders',
        input: { status: 'new' },
        http: [{ method: 'POST', urlPrefix: 'https://firestore.googleapis.com/v1/projects/demo-shop/databases/(default)/documents:runQuery', json: [{ document: { name: 'projects/demo-shop/databases/(default)/documents/orders/A1', fields: { status: { stringValue: 'new' } } } }] }],
      },
      { name: 'refuses other statuses', action: 'list_orders', input: { status: 'lost' }, expectOk: false },
    ];
    const d = await w.app.modules.createDraft({ manifest: firestoreManifest(), code, tests, origin: 'seed' } as any, w.alice);
    expect(d.validationReport!.passed, JSON.stringify(d.validationReport)).toBe(true);
    expect(d.validationReport!.tests[0]!.requests).toEqual(['POST https://firestore.googleapis.com/v1/projects/demo-shop/databases/(default)/documents:runQuery → 200']);
  });
});

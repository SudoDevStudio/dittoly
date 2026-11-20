import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { auth, type FetchLike as McpFetch, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createSession } from '../src/core/members.js';
import { guardedFetch } from '../src/runtime/egress.js';
import { allowedBy, CLAUDE_CODE_CLIENT, type AllowedApps } from '../src/mcp/authserver.js';
import { setFlowMcp, toolName } from '../src/mcp/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, type World } from './helpers.js';

/**
 * Dittoly as the OAuth authorization server for its own /mcp: discovery, the 401 challenge,
 * apps identified by a metadata document (served here from loopback) or registered dynamically,
 * the admins' list of allowed apps, PKCE, exact redirects, consent making an agent, code and
 * refresh token rules, and the agent's scopes and revocation applying to OAuth tokens.
 */
const PUBLIC = 'https://dittoly.test';
const RESOURCE = `${PUBLIC}/mcp`;
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const SDK_CLIENT = 'https://sdk-client.example/oauth/client.json';
const SDK_REDIRECT = 'http://127.0.0.1:43999/callback';
const sdkDocument = { client_id: SDK_CLIENT, client_name: 'SDK client', redirect_uris: [SDK_REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
let docs: Server;
let docBase = '';
let clientUrl = '';
const documents = new Map<string, unknown>();
let w: World;
let api: ReturnType<typeof buildServer>;
let aliceCookie = '';
let bobCookie = '';
let flowId = '';
let flowTool = '';

const asAlice = (cookie = aliceCookie) => ({ cookie: `dty_session=${cookie}`, 'x-dittoly-request': '1' });
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const authorize = (q: Record<string, string>) => api.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams(q)}`, headers: { cookie: `dty_session=${aliceCookie}` } });
const form = (url: string, body: Record<string, string>) =>
  api.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });
let rpcId = 1;
const mcp = (token: string, method: string, params: unknown = {}) =>
  api.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: rpcId++, method, params } });
const scopesOnlyFlow = () => ({ tools: { [`flow:${flowId}`]: 'run' as const }, drafting: false });

/** Authorize, approve on the consent page as alice, and return the code from the redirect. */
async function signIn(clientId: string, redirectUri: string, scopes: { tools: Record<string, 'run' | 'ask'>; drafting: boolean } = scopesOnlyFlow()) {
  const { verifier, challenge } = pkce();
  const r = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE, scope: 'mcp offline_access' });
  expect(r.statusCode).toBe(302);
  const requestId = /^\/connect\/([0-9a-f-]{36})$/.exec(r.headers.location as string)![1]!;
  const approved = await api.inject({ method: 'POST', url: `/api/oauth/requests/${requestId}/approve`, headers: asAlice(), payload: { name: 'My app', scopes, expiresInDays: 30 } });
  expect(approved.statusCode).toBe(200);
  const back = new URL(approved.json().redirectTo);
  expect(back.searchParams.get('state')).toBe('st-1');
  expect(back.searchParams.get('iss')).toBe(PUBLIC);
  return { code: back.searchParams.get('code')!, verifier, requestId, back };
}

async function tokens(clientId: string, redirectUri: string, scopes?: { tools: Record<string, 'run' | 'ask'>; drafting: boolean }) {
  const { code, verifier } = await signIn(clientId, redirectUri, scopes);
  const r = await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId, resource: RESOURCE });
  expect(r.statusCode).toBe(200);
  return r.json() as { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
}

async function register(body: unknown) {
  return api.inject({ method: 'POST', url: '/oauth/register', headers: { 'content-type': 'application/json' }, payload: body as object });
}

beforeAll(async () => {
  docs = createServer((req, res) => {
    const doc = documents.get(req.url ?? '');
    if (doc === undefined) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(typeof doc === 'string' ? doc : JSON.stringify(doc));
  });
  await new Promise<void>((r) => docs.listen(0, '127.0.0.1', r));
  docBase = `http://127.0.0.1:${(docs.address() as AddressInfo).port}`;
  clientUrl = `${docBase}/client.json`;
  documents.set('/client.json', { client_id: clientUrl, client_name: 'Local Agent', redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'], token_endpoint_auth_method: 'none' });
  documents.set('/wrong-id.json', { client_id: 'https://elsewhere.example/client.json', client_name: 'Wrong', redirect_uris: ['http://127.0.0.1/callback'] });
  documents.set('/secret.json', { client_id: `${docBase}/secret.json`, client_name: 'Secret', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'client_secret_basic' });
  documents.set('/big.json', JSON.stringify({ client_id: `${docBase}/big.json`, client_name: 'x'.repeat(20_000), redirect_uris: ['http://127.0.0.1/callback'] }));
  // Loopback is allowed for this test's document server only, as in other tests.
  const guarded = guardedFetch({ internalHosts: [], loopbackHosts: [new URL(docBase).host] });
  // The SDK only takes https metadata URLs: that one document is answered here, everything else goes through the egress guard.
  const mcpAuthFetch = async (url: string, init: RequestInit) => (url === SDK_CLIENT ? Response.json(sdkDocument) : guarded(url, init));
  w = await makeWorld({ publicUrl: PUBLIC, insecureHttpHosts: [new URL(docBase).host] }, { mcpWaitMs: 0, mcpAuthFetch });
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  const f = await approvedReleaseFlow(w);
  flowId = f.flowId;
  await setFlowMcp(w.db, w.alice, flowId, true);
  flowTool = toolName('Release coordination', flowId);
  api = buildServer(w.app);
  aliceCookie = await createSession(w.db, w.alice.id, 1);
  bobCookie = await createSession(w.db, w.bob.id, 1);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
  await new Promise((r) => docs.close(r));
});

describe('discovery', () => {
  it('serves protected resource metadata at both paths and authorization server metadata', async () => {
    for (const url of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const r = await api.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [PUBLIC], bearer_methods_supported: ['header'] });
      expect(r.json().scopes_supported).toContain('mcp');
    }
    const m = (await api.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(m).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/oauth/authorize`,
      token_endpoint: `${PUBLIC}/oauth/token`,
      registration_endpoint: `${PUBLIC}/oauth/register`,
      revocation_endpoint: `${PUBLIC}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    });
    expect(m.scopes_supported).toContain('offline_access');
  });

  it('answers /mcp without a valid token with 401 and the pointer to the metadata', async () => {
    for (const headers of [{}, { authorization: 'Bearer dty_oat_nope' }]) {
      const r = await api.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', ...headers }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } });
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
    }
  });
});

describe('apps an admin allows', () => {
  it('allows nothing until an admin switches presets on; only admins change it', async () => {
    const s = (await api.inject({ method: 'GET', url: '/api/settings/mcp-apps', headers: { authorization: `Bearer ${w.tokens.admin}` } })).json();
    expect(s).toMatchObject({ presets: { claude: false, chatgpt: false, copilot: false }, custom: [] });
    const { challenge } = pkce();
    const r = await authorize({ response_type: 'code', client_id: clientUrl, redirect_uri: 'http://127.0.0.1:5000/callback', state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('has not allowed this app');
    const body = { presets: { claude: true, chatgpt: false, copilot: false }, custom: [{ kind: 'client_id', value: clientUrl }] };
    expect((await api.inject({ method: 'PUT', url: '/api/settings/mcp-apps', headers: { authorization: `Bearer ${w.tokens.alice}` }, payload: body })).statusCode).toBe(403);
    expect((await api.inject({ method: 'PUT', url: '/api/settings/mcp-apps', headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: { ...body, custom: [{ kind: 'redirect_host', value: 'not a host!' }] } })).statusCode).toBe(400);
    const saved = await api.inject({ method: 'PUT', url: '/api/settings/mcp-apps', headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: body });
    expect(saved.json()).toMatchObject({ presets: { claude: true }, custom: [{ kind: 'client_id', value: clientUrl }], updatedBy: 'admin' });
  });

  it('matches presets by where the code goes, not by the name an app gives itself', () => {
    const apps: AllowedApps = { presets: { claude: true, chatgpt: true, copilot: true }, custom: [{ kind: 'redirect_host', value: '*.example.org' }], updatedAt: null, updatedBy: null };
    expect(allowedBy(apps, 'dty_client_x', 'https://claude.ai/api/mcp/auth_callback')).toBe('Claude');
    expect(allowedBy(apps, 'dty_client_x', 'https://claude.com/api/mcp/auth_callback')).toBe('Claude');
    expect(allowedBy(apps, CLAUDE_CODE_CLIENT, 'http://localhost:4567/callback')).toBe('Claude Code');
    expect(allowedBy(apps, 'dty_client_x', 'http://localhost:4567/callback')).toBeNull();
    expect(allowedBy(apps, 'dty_client_x', 'https://chatgpt.com/connector/oauth/abc')).toBe('ChatGPT');
    expect(allowedBy(apps, 'dty_client_x', 'https://chatgpt.com.evil.example/cb')).toBeNull();
    expect(allowedBy(apps, 'dty_client_x', 'https://global.consent.azure-apim.net/redirect/x')).toBe('Copilot Studio');
    expect(allowedBy(apps, 'dty_client_x', 'https://app.example.org/cb')).toBe('*.example.org');
    expect(allowedBy(apps, 'dty_client_x', 'http://app.example.org/cb')).toBeNull();
    expect(allowedBy({ ...apps, presets: { claude: false, chatgpt: false, copilot: false } }, 'dty_client_x', CLAUDE)).toBeNull();
  });
});

describe('an app with a client id metadata document', () => {
  let access = '';
  let refresh = '';

  it('signs in end to end: consent shows the app and warns about loopback, approving makes an agent', async () => {
    const { verifier, challenge } = pkce();
    // A loopback redirect on any port matches the document's portless one.
    const redirect = 'http://127.0.0.1:43123/callback';
    const r = await authorize({ response_type: 'code', client_id: clientUrl, redirect_uri: redirect, state: 'abc', code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE });
    expect(r.statusCode).toBe(302);
    const id = /^\/connect\/(.+)$/.exec(r.headers.location as string)![1]!;
    const view = await api.inject({ method: 'GET', url: `/api/oauth/requests/${id}`, headers: asAlice() });
    expect(view.json()).toMatchObject({ client: { id: clientUrl, name: 'Local Agent', kind: 'metadata' }, redirectHost: '127.0.0.1:43123', loopback: true });
    // Someone else cannot see or answer it.
    expect((await api.inject({ method: 'GET', url: `/api/oauth/requests/${id}`, headers: asAlice(bobCookie) })).statusCode).toBe(404);
    // The consent POST is a cookie write: it needs the CSRF header.
    expect((await api.inject({ method: 'POST', url: `/api/oauth/requests/${id}/approve`, headers: { cookie: `dty_session=${aliceCookie}` }, payload: { name: 'x', scopes: scopesOnlyFlow(), expiresInDays: 30 } })).statusCode).toBe(403);
    const approved = await api.inject({ method: 'POST', url: `/api/oauth/requests/${id}/approve`, headers: asAlice(), payload: { name: 'Local Agent', scopes: scopesOnlyFlow(), expiresInDays: 30 } });
    const back = new URL(approved.json().redirectTo);
    expect(back.origin + back.pathname).toBe(redirect);
    const code = back.searchParams.get('code')!;
    const t = await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: clientUrl, resource: RESOURCE });
    expect(t.statusCode).toBe(200);
    expect(t.headers['cache-control']).toBe('no-store');
    expect(t.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    access = t.json().access_token;
    refresh = t.json().refresh_token;
    const agents = (await api.inject({ method: 'GET', url: '/api/agents', headers: asAlice() })).json() as { name: string; oauthApp: string | null; scopes: unknown }[];
    expect(agents.find((a) => a.name === 'Local Agent')).toMatchObject({ oauthApp: 'Local Agent', scopes: scopesOnlyFlow() });
    // The request is answered: it cannot be approved again.
    expect((await api.inject({ method: 'GET', url: `/api/oauth/requests/${id}`, headers: asAlice() })).statusCode).toBe(404);
    const events = (await w.db.query<{ action: string }>(`SELECT action FROM audit_events WHERE action LIKE 'mcp.oauth%'`)).rows.map((e) => e.action);
    expect(events).toContain('mcp.oauth_granted');
    expect(JSON.stringify((await w.db.query(`SELECT * FROM mcp_oauth_tokens`)).rows)).not.toContain(access);
  });

  it('the access token works on /mcp with exactly the agent\'s tools', async () => {
    const list = await mcp(access, 'tools/list');
    expect(list.statusCode).toBe(200);
    const names = (list.json().result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain(flowTool);
    expect(names).not.toContain('save_as_flow');
    const r = await mcp(access, 'tools/call', { name: 'save_as_flow', arguments: {} });
    expect(r.json().error.message).toContain('Unknown tool');
  });

  it('rotates refresh tokens; a used one presented again revokes the whole grant and its agent', async () => {
    const r1 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientUrl });
    expect(r1.statusCode).toBe(200);
    const next = r1.json();
    expect(next.refresh_token).not.toBe(refresh);
    expect((await mcp(next.access_token, 'ping')).statusCode).toBe(200);
    // Another client cannot use it (and does not burn it).
    expect((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: 'dty_client_other' })).json().error).toBe('invalid_grant');
    const reused = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientUrl });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error).toBe('invalid_grant');
    expect((await mcp(next.access_token, 'ping')).statusCode).toBe(401);
    expect((await mcp(access, 'ping')).statusCode).toBe(401);
    expect((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: clientUrl })).json().error).toBe('invalid_grant');
    const agents = (await api.inject({ method: 'GET', url: '/api/agents', headers: asAlice() })).json() as { name: string; state: string }[];
    expect(agents.find((a) => a.name === 'Local Agent')!.state).toBe('revoked');
    const reuse = (await w.db.query(`SELECT error_type FROM audit_events WHERE action = 'mcp.oauth_token_reused'`)).rows;
    expect(reuse).toEqual([{ error_type: 'refresh_token_reused' }]);
  });

  it('refuses documents that are not the app\'s own, ask for a secret, or are too large', async () => {
    for (const [path, text] of [['/wrong-id.json', 'client_id is not its own'], ['/secret.json', 'client secret'], ['/big.json', 'larger than'], ['/missing.json', 'answered 404']]) {
      await w.db.query(`UPDATE org_settings SET value = jsonb_set(value, '{custom}', $1) WHERE key = 'mcp_oauth_apps'`, [JSON.stringify([{ kind: 'client_id', value: clientUrl }, { kind: 'client_id', value: `${docBase}${path}` }])]);
      const r = await authorize({ response_type: 'code', client_id: `${docBase}${path}`, redirect_uri: 'http://127.0.0.1:5000/callback', state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
      expect(r.statusCode, path).toBe(400);
      expect(r.body).toContain(text);
    }
  });
});

describe('the official MCP client SDK', () => {
  it('discovers, picks the metadata document over registration, signs in and refreshes', async () => {
    await api.inject({ method: 'PUT', url: '/api/settings/mcp-apps', headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: { presets: { claude: true, chatgpt: false, copilot: false }, custom: [{ kind: 'client_id', value: SDK_CLIENT }] } });
    // The SDK's requests to https://dittoly.test go to this server.
    const fetchFn: McpFetch = async (url, init) => {
      const req = new Request(url, init);
      const u = new URL(req.url);
      const payload = req.method === 'GET' ? undefined : await req.text();
      const r = await api.inject({ method: req.method as 'GET', url: u.pathname + u.search, headers: Object.fromEntries(req.headers.entries()), ...(payload ? { payload } : {}) });
      return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers as Record<string, string> });
    };
    let authorizationUrl: URL | undefined;
    let verifier = '';
    let info: unknown;
    let saved: { access_token: string; refresh_token?: string } | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: SDK_REDIRECT,
      clientMetadataUrl: SDK_CLIENT,
      clientMetadata: sdkDocument,
      state: () => 'sdk-state',
      clientInformation: () => info,
      saveClientInformation: (i: unknown) => void (info = i),
      tokens: () => saved,
      saveTokens: (t) => void (saved = t),
      redirectToAuthorization: (u) => void (authorizationUrl = u),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
    } as OAuthClientProvider;
    expect(await auth(provider, { serverUrl: RESOURCE, fetchFn })).toBe('REDIRECT');
    expect(authorizationUrl!.searchParams.get('client_id')).toBe(SDK_CLIENT);
    expect(authorizationUrl!.searchParams.get('resource')).toBe(RESOURCE);
    const r = await authorize(Object.fromEntries(authorizationUrl!.searchParams));
    const id = (r.headers.location as string).split('/').pop()!;
    const approved = await api.inject({ method: 'POST', url: `/api/oauth/requests/${id}/approve`, headers: asAlice(), payload: { name: 'SDK agent', scopes: scopesOnlyFlow(), expiresInDays: 1 } });
    const back = new URL(approved.json().redirectTo).searchParams;
    expect(await auth(provider, { serverUrl: RESOURCE, authorizationCode: back.get('code')!, iss: back.get('iss')!, fetchFn })).toBe('AUTHORIZED');
    const first = saved!;
    expect((await mcp(first.access_token, 'ping')).statusCode).toBe(200);
    // With a refresh token in hand, the SDK refreshes (and gets a new refresh token).
    expect(await auth(provider, { serverUrl: RESOURCE, fetchFn })).toBe('AUTHORIZED');
    expect(saved!.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(saved!.access_token, 'ping')).statusCode).toBe(200);
  });
});

describe('an app that registers itself', () => {
  let clientId = '';

  it('registers public clients only, then signs in through the Claude preset', async () => {
    expect((await register({ client_name: 'Claude', redirect_uris: [CLAUDE], token_endpoint_auth_method: 'client_secret_post' })).json().error).toBe('invalid_client_metadata');
    expect((await register({ client_name: 'Claude', redirect_uris: ['http://evil.example/cb'] })).json().error).toBe('invalid_redirect_uri');
    const r = await register({ client_name: 'Claude', redirect_uris: [CLAUDE], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' });
    expect(r.statusCode).toBe(201);
    clientId = r.json().client_id;
    expect(r.json()).toMatchObject({ client_name: 'Claude', redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none' });
    const t = await tokens(clientId, CLAUDE);
    expect((await mcp(t.access_token, 'ping')).statusCode).toBe(200);
  });

  it('a registered app whose address the admins do not allow is refused before consent', async () => {
    const r = await register({ client_name: 'Claude', redirect_uris: ['https://attacker.example/cb'] });
    const q = await authorize({ response_type: 'code', client_id: r.json().client_id, redirect_uri: 'https://attacker.example/cb', state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    expect(q.statusCode).toBe(403);
    expect(q.body).toContain('attacker.example');
  });

  it('requires PKCE S256, state, an exact redirect and this resource', async () => {
    const base = { response_type: 'code', client_id: clientId, redirect_uri: CLAUDE, state: 's' };
    const err = async (q: Record<string, string>) => new URL((await authorize(q)).headers.location as string).searchParams.get('error');
    expect(await err(base)).toBe('invalid_request');
    expect(await err({ ...base, code_challenge: pkce().verifier, code_challenge_method: 'plain' })).toBe('invalid_request');
    const { challenge } = pkce();
    expect(await err({ ...base, state: '', code_challenge: challenge, code_challenge_method: 'S256' })).toBe('invalid_request');
    expect(await err({ ...base, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' })).toBe('invalid_target');
    // claude.com is allowed by the preset, but this app did not register it: shown, never redirected.
    const mismatch = await authorize({ ...base, redirect_uri: 'https://claude.com/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toContain('redirect_uri_mismatch');
  });

  it('refuses a wrong code verifier, a wrong redirect and a code used twice (which revokes what it gave)', async () => {
    let s = await signIn(clientId, CLAUDE);
    const bad = await form('/oauth/token', { grant_type: 'authorization_code', code: s.code, redirect_uri: CLAUDE, code_verifier: pkce().verifier, client_id: clientId });
    expect(bad.json().error).toBe('invalid_grant');
    // The failed try used the code up.
    expect((await form('/oauth/token', { grant_type: 'authorization_code', code: s.code, redirect_uri: CLAUDE, code_verifier: s.verifier, client_id: clientId })).json().error).toBe('invalid_grant');

    s = await signIn(clientId, CLAUDE);
    expect((await form('/oauth/token', { grant_type: 'authorization_code', code: s.code, redirect_uri: 'https://claude.com/api/mcp/auth_callback', code_verifier: s.verifier, client_id: clientId })).json().error).toBe('invalid_grant');

    s = await signIn(clientId, CLAUDE);
    const ok = await form('/oauth/token', { grant_type: 'authorization_code', code: s.code, redirect_uri: CLAUDE, code_verifier: s.verifier, client_id: clientId });
    expect(ok.statusCode).toBe(200);
    expect((await mcp(ok.json().access_token, 'ping')).statusCode).toBe(200);
    const again = await form('/oauth/token', { grant_type: 'authorization_code', code: s.code, redirect_uri: CLAUDE, code_verifier: s.verifier, client_id: clientId });
    expect(again.json().error).toBe('invalid_grant');
    expect((await mcp(ok.json().access_token, 'ping')).statusCode).toBe(401);
    expect((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: ok.json().refresh_token, client_id: clientId })).json().error).toBe('invalid_grant');
  });

  it('a tool outside what the person consented to is refused and recorded', async () => {
    const t = await tokens(clientId, CLAUDE, { tools: {}, drafting: false });
    const names = ((await mcp(t.access_token, 'tools/list')).json().result.tools as { name: string }[]).map((x) => x.name);
    expect(names).not.toContain(flowTool);
    const r = await mcp(t.access_token, 'tools/call', { name: flowTool, arguments: {} });
    expect(r.json().error.message).toContain('Unknown tool');
    const denied = await w.db.query(`SELECT 1 FROM agent_calls WHERE tool = $1 AND status = 'denied'`, [`flow:${flowId}`]);
    expect(denied.rowCount).toBeGreaterThan(0);
  });

  it('revoking the agent on the Agents page kills its tokens at once', async () => {
    const t = await tokens(clientId, CLAUDE);
    expect((await mcp(t.access_token, 'ping')).statusCode).toBe(200);
    const agent = ((await api.inject({ method: 'GET', url: '/api/agents', headers: asAlice() })).json() as { id: string; state: string; oauthApp: string | null }[]).find((a) => a.state === 'active' && a.oauthApp === 'Claude')!;
    expect((await api.inject({ method: 'DELETE', url: `/api/agents/${agent.id}`, headers: asAlice() })).statusCode).toBe(204);
    expect((await mcp(t.access_token, 'ping')).statusCode).toBe(401);
    expect((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })).json().error).toBe('invalid_grant');
  });

  it('the app revokes its refresh token: the connection ends', async () => {
    const t = await tokens(clientId, CLAUDE);
    expect((await form('/oauth/revoke', { token: t.refresh_token, client_id: clientId })).statusCode).toBe(200);
    expect((await mcp(t.access_token, 'ping')).statusCode).toBe(401);
    expect((await form('/oauth/revoke', { token: 'unknown' })).statusCode).toBe(200);
  });

  it('a person who says no sends the app access_denied', async () => {
    const { challenge } = pkce();
    const r = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE, state: 'z', code_challenge: challenge, code_challenge_method: 'S256' });
    const id = (r.headers.location as string).split('/').pop()!;
    const d = await api.inject({ method: 'POST', url: `/api/oauth/requests/${id}/deny`, headers: asAlice() });
    const back = new URL(d.json().redirectTo);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('z');
  });

  it('refuses unknown grant types and missing client ids per RFC 6749', async () => {
    expect((await form('/oauth/token', { grant_type: 'password', client_id: clientId })).json().error).toBe('unsupported_grant_type');
    expect((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'x' })).statusCode).toBe(401);
  });
});

describe('personal tokens', () => {
  it('still work exactly as before', async () => {
    const made = await api.inject({ method: 'POST', url: '/api/agents', headers: asAlice(), payload: { name: 'Cursor', scopes: scopesOnlyFlow() } });
    const token = made.json().token as string;
    expect(token).toMatch(/^dty_mcp_/);
    expect((await mcp(token, 'ping')).statusCode).toBe(200);
    const names = ((await mcp(token, 'tools/list')).json().result.tools as { name: string }[]).map((x) => x.name);
    expect(names).toContain(flowTool);
  });
});

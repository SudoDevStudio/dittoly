import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import Provider from 'oidc-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../src/api/server.js';
import { createSession, type Member } from '../src/core/members.js';
import { parseOAuthSecret } from '../src/mcp/oauth.js';
import type { FetchLike } from '../src/sandbox/broker.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * End to end: a real authorization server (oidc-provider with dynamic client
 * registration, resource indicators, PKCE and refresh tokens) protects a real
 * MCP server that only accepts access tokens that server issued for it.
 */
const MCP_URL = 'https://mcp.example.com/mcp';
const PUBLIC_URL = 'https://dittoly.test';
let as: Server;
let issuer: string;
let provider: InstanceType<typeof Provider>;
let nextAccount = 'alice-sub';
const seenTokens: string[] = [];

function mcpServer() {
  const server = new McpServer({ name: 'docs', version: '1.0.0' });
  server.registerTool(
    'whoami',
    { description: 'Says who the token belongs to.', inputSchema: z.object({}), outputSchema: z.object({ account: z.string() }), annotations: { readOnlyHint: true } },
    async (_args, ctx) => ({ content: [], structuredContent: { account: String((ctx as { http?: { authInfo?: { extra?: { account?: string } } } }).http?.authInfo?.extra?.account ?? 'unknown') } }),
  );
  return server;
}

const network: FetchLike = async (url, init) => {
  const u = new URL(url);
  if (u.host !== 'mcp.example.com') return fetch(url, init); // the authorization server, on loopback
  if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return Response.json({ resource: MCP_URL, authorization_servers: [issuer], scopes_supported: ['mcp'] });
  }
  const bearer = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '');
  const token = bearer ? await provider.AccessToken.find(bearer) : undefined;
  if (!token || token.isExpired || !String(token.aud ?? '').includes(MCP_URL)) {
    return new Response('{"error":"invalid_token"}', {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` },
    });
  }
  seenTokens.push(bearer!);
  const server = mcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(new Request(url, init as RequestInit), { authInfo: { token: bearer!, clientId: String(token.clientId), scopes: ['mcp'], extra: { account: token.accountId } } });
};

beforeAll(async () => {
  as = createServer();
  await new Promise<void>((r) => as.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;
  provider = new Provider(issuer, {
    scopes: ['openid', 'offline_access', 'mcp'],
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => MCP_URL,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== MCP_URL) throw new Error('unknown resource');
          return { scope: 'mcp', audience: MCP_URL, accessTokenFormat: 'opaque', accessTokenTTL: 600 };
        },
      },
    },
    issueRefreshToken: async () => true,
    interactions: { url: (_ctx, interaction) => `/test-login/${interaction.uid}` },
    async findAccount(_ctx, id) {
      return { accountId: id, claims: async () => ({ sub: id }) };
    },
  });
  const callback = provider.callback();
  as.on('request', (req, res) => {
    if (/^\/test-login\//.test(req.url ?? '')) {
      // The test's "sign-in page": log in as nextAccount, then grant what was asked for.
      (async () => {
        const details = await provider.interactionDetails(req, res);
        if (details.prompt.name === 'login') {
          await provider.interactionFinished(req, res, { login: { accountId: nextAccount } }, { mergeWithLastSubmission: false });
          return;
        }
        const grant = details.grantId
          ? await provider.Grant.find(details.grantId)
          : new provider.Grant({ accountId: details.session!.accountId, clientId: details.params.client_id as string });
        const missing = details.prompt.details as { missingOIDCScope?: string[]; missingResourceScopes?: Record<string, string[]> };
        if (missing.missingOIDCScope) grant!.addOIDCScope(missing.missingOIDCScope.join(' '));
        for (const [resource, scopes] of Object.entries(missing.missingResourceScopes ?? {})) grant!.addResourceScope(resource, scopes.join(' '));
        const grantId = await grant!.save();
        await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
      })().catch(() => res.end());
      return;
    }
    callback(req, res);
  });
});
afterAll(() => new Promise<void>((r) => as.close(() => r())));

let w: World;
let api: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld({ publicUrl: PUBLIC_URL }, { fetchImpl: network });
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

function jar() {
  const cookies = new Map<string, string>();
  return {
    store(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [k, ...v] = c.split(';')[0]!.split('=');
        cookies.set(k!.trim(), v.join('='));
      }
    },
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

/** Connect a member's own account: start, sign in at the authorization server, come back. */
async function connect(member: Member, account: string, service = 'docs') {
  nextAccount = account;
  const session = await createSession(w.db, member.id, 1);
  const cookie = `dty_session=${session}`;
  const start = await api.inject({
    method: 'POST',
    url: '/api/mcp/oauth/start',
    headers: { cookie, 'x-dittoly-request': '1' },
    payload: { url: MCP_URL, service },
  });
  expect(start.statusCode).toBe(200);
  let url: string = start.json().authorizationUrl;
  const j = jar();
  for (let i = 0; i < 10 && url.startsWith(issuer); i++) {
    const res = await fetch(url, { redirect: 'manual', headers: { cookie: j.header() } });
    j.store(res);
    url = new URL(res.headers.get('location')!, url).href;
  }
  expect(url.startsWith(`${PUBLIC_URL}/auth/mcp/callback?`)).toBe(true);
  return { callbackPath: url.slice(PUBLIC_URL.length), cookie };
}

describe('MCP servers protected by OAuth', () => {
  let moduleRef: string;

  it('a member connects their own account; tokens land in their vault only', async () => {
    const { callbackPath, cookie } = await connect(w.alice, 'alice-sub');
    const done = await api.inject({ method: 'GET', url: callbackPath, headers: { cookie } });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/credentials');
    const secret = parseOAuthSecret((await w.app.vault.reveal(w.alice.id, 'docs'))!);
    expect(secret).toMatchObject({ kind: 'oauth', serverUrl: MCP_URL, issuer });
    expect(await w.app.vault.reveal(w.bob.id, 'docs')).toBeNull();
    // One client registration with the authorization server, shared by all members.
    expect((await w.db.query(`SELECT issuer FROM oauth_clients`)).rows).toEqual([{ issuer }]);
  });

  it('the callback only completes for the member who started it, and only once', async () => {
    const { callbackPath, cookie } = await connect(w.bob, 'bob-sub');
    const mallory = `dty_session=${await createSession(w.db, w.approver.id, 1)}`;
    const wrong = await api.inject({ method: 'GET', url: callbackPath, headers: { cookie: mallory } });
    // Someone else's state reads as unknown, and does not spoil bob's connection.
    expect(wrong.json()).toEqual({ error: 'oauth_state_invalid' });
    expect(await w.app.vault.reveal(w.approver.id, 'docs')).toBeNull();
    expect((await api.inject({ method: 'GET', url: callbackPath, headers: { cookie } })).statusCode).toBe(302);
    expect(await w.app.vault.reveal(w.bob.id, 'docs')).not.toBeNull();
    // Used once: it cannot be replayed.
    expect((await api.inject({ method: 'GET', url: callbackPath, headers: { cookie } })).json()).toEqual({ error: 'oauth_state_invalid' });
    await w.app.vault.remove(w.bob.id, 'docs'); // the next test starts with bob not connected
  });

  it('imports the OAuth-protected server with the importer\'s token, and steps run with each member\'s own token', async () => {
    const mv = await w.app.mcp.import({ url: MCP_URL, name: 'docs', credentialService: 'docs' }, w.alice);
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
    moduleRef = `${mv.name}@${mv.version}`;
    const v = await w.app.flows.create(
      'whoami',
      { steps: [{ id: 'who', type: 'action', module: moduleRef, action: 'whoami', input: {} }, { id: 'hold', type: 'approval' }] },
      w.alice,
    );
    const version = await w.app.flows.decide(v.id, w.approver, 'approved');

    const aliceRun = await w.app.engine.startRun(version.id, w.alice.id, {});
    await w.app.worker.drain();
    expect((await runStatus(w, aliceRun, w.alice)).steps[0]).toMatchObject({ status: 'succeeded', output: { account: 'alice-sub' } });

    // Bob has not connected: missing credential, so he can ask Alice to run it for him.
    const bobRun = await w.app.engine.startRun(version.id, w.bob.id, {});
    await w.app.worker.drain();
    expect((await runStatus(w, bobRun, w.bob)).steps[0]).toMatchObject({ errorType: 'missing_credential' });

    // Once Bob connects his own account, his runs use his token.
    const { callbackPath, cookie } = await connect(w.bob, 'bob-sub');
    await api.inject({ method: 'GET', url: callbackPath, headers: { cookie } });
    await w.app.engine.retry(bobRun, w.bob);
    await w.app.worker.drain();
    expect((await runStatus(w, bobRun, w.bob)).steps[0]).toMatchObject({ status: 'succeeded', output: { account: 'bob-sub' } });
  });

  it('refreshes an expired access token with the refresh token and stores the new one', async () => {
    const before = parseOAuthSecret((await w.app.vault.reveal(w.alice.id, 'docs'))!)!;
    await w.app.vault.put(w.alice.id, 'docs', JSON.stringify({ ...before, savedAt: Date.now() - 3600_000 }));
    const token = await w.app.mcpOAuth.resolve(w.alice.id, 'docs');
    const after = parseOAuthSecret((await w.app.vault.reveal(w.alice.id, 'docs'))!)!;
    expect(token).toBe((after.tokens as { access_token: string }).access_token);
    expect(token).not.toBe((before.tokens as { access_token: string }).access_token);
    expect(after.savedAt).toBeGreaterThan(Date.now() - 10_000);
  });

  it('a connection that cannot refresh counts as a missing credential', async () => {
    const s = parseOAuthSecret((await w.app.vault.reveal(w.bob.id, 'docs'))!)!;
    const tokens = { ...(s.tokens as Record<string, unknown>) };
    delete tokens.refresh_token;
    await w.app.vault.put(w.bob.id, 'docs', JSON.stringify({ ...s, tokens, savedAt: Date.now() - 3600_000 }));
    expect(await w.app.mcpOAuth.resolve(w.bob.id, 'docs')).toBeNull();
  });
});

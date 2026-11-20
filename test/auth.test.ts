import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Provider from 'oidc-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { buildApp } from '../src/app.js';
import { listMembers } from '../src/core/members.js';
import { freshDb, testConfig } from './helpers.js';
import type { Db } from '../src/db/db.js';
import { OLD_SESSION_COOKIE } from '../src/core/old-prefixes.js';

/**
 * Full authorization-code sign-in against a real OpenID provider (oidc-provider)
 * running in this process. The provider's login page is replaced by a test route
 * that signs in whichever account the test names.
 */

const PUBLIC_URL = 'http://127.0.0.1:8080';
let idp: Server;
let issuer: string;
let nextAccount = { sub: 'alice-sub', email: 'alice@acme.test', name: 'Alice Doe' };

beforeAll(async () => {
  idp = createServer();
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: 'dittoly',
        client_secret: 'test-secret',
        redirect_uris: [`${PUBLIC_URL}/auth/callback`],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      },
    ],
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'] },
    conformIdTokenClaims: false,
    features: { devInteractions: { enabled: false } },
    interactions: { url: (_ctx, interaction) => `/test-login/${interaction.uid}` },
    async findAccount(_ctx, id) {
      const acct = id === nextAccount.sub ? nextAccount : { sub: id, email: `${id}@acme.test`, name: id };
      return { accountId: id, claims: async () => ({ sub: acct.sub, email: acct.email, email_verified: true, name: acct.name }) };
    },
    async loadExistingGrant(ctx) {
      const grant = new ctx.oidc.provider.Grant({ clientId: ctx.oidc.client!.clientId, accountId: ctx.oidc.session!.accountId! });
      grant.addOIDCScope('openid email profile');
      await grant.save();
      return grant;
    },
  });
  const callback = provider.callback();
  idp.on('request', (req, res) => {
    const m = /^\/test-login\/([^/?]+)/.exec(req.url ?? '');
    if (m) {
      provider.interactionFinished(req, res, { login: { accountId: nextAccount.sub } }, { mergeWithLastSubmission: false }).catch(() => {
        res.statusCode = 500;
        res.end();
      });
      return;
    }
    callback(req, res);
  });
});
afterAll(() => new Promise<void>((r) => idp.close(() => r())));

/** Minimal cookie jar for the identity provider's own cookies. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    store(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [k, ...v] = pair!.split('=');
        cookies.set(k!.trim(), v.join('='));
      }
    },
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

async function world(domains: string[] = []) {
  const db = await freshDb();
  const app = buildApp(
    testConfig({ publicUrl: PUBLIC_URL, oidc: { issuer, clientId: 'dittoly', clientSecret: 'test-secret', allowedDomains: domains } }),
    db,
    { ai: null },
  );
  return { db, server: buildServer(app) };
}

function cookieFrom(setCookie: string | string[] | undefined, name: string): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list) if (c.startsWith(`${name}=`)) return c.split(';')[0]!.slice(name.length + 1);
  return undefined;
}

/** Drive the whole browser round trip. Returns the session cookie, or the failing response. */
async function signIn(server: ReturnType<typeof buildServer>, returnTo = '/runs') {
  const start = await server.inject({ method: 'GET', url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
  expect(start.statusCode).toBe(302);
  const pending = cookieFrom(start.headers['set-cookie'], 'dty_sso')!;
  const j = jar();
  let url = start.headers.location as string;
  for (let i = 0; i < 10 && url.startsWith(issuer); i++) {
    const res = await fetch(url, { redirect: 'manual', headers: { cookie: j.header() } });
    j.store(res);
    url = new URL(res.headers.get('location')!, url).href;
  }
  expect(url.startsWith(`${PUBLIC_URL}/auth/callback?`)).toBe(true);
  const cb = await server.inject({ method: 'GET', url: url.slice(PUBLIC_URL.length), headers: { cookie: `dty_sso=${pending}` } });
  return { response: cb, session: cookieFrom(cb.headers['set-cookie'], 'dty_session') };
}

describe('OIDC sign-in', () => {
  let db: Db;
  let server: ReturnType<typeof buildServer>;
  beforeAll(async () => ({ db, server } = await world()));
  afterAll(async () => {
    await server.close();
    await db.end();
  });

  it('signs a new member in, provisions them as a member, and returns to where they started', async () => {
    nextAccount = { sub: 'alice-sub', email: 'alice@acme.test', name: 'Alice Doe' };
    const { response, session } = await signIn(server, '/runs');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/runs');
    expect(session).toBeTruthy();
    const cookieHeader = String(response.headers['set-cookie']);
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);

    const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: `dty_session=${session}` } });
    expect(me.json()).toMatchObject({ handle: 'alice', role: 'member' });
    // A session cookie under its earlier name (src/core/old-prefixes.ts) still signs in.
    const old = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${OLD_SESSION_COOKIE}=${session}` } });
    expect(old.json()).toMatchObject({ handle: 'alice' });
    const members = await listMembers(db);
    expect(members).toEqual([expect.objectContaining({ handle: 'alice', email: 'alice@acme.test', displayName: 'Alice Doe', sso: true })]);
  });

  it('a second sign-in finds the same member; the role is never taken from the identity provider', async () => {
    await db.query(`UPDATE members SET role = 'approver' WHERE handle = 'alice'`);
    const { session } = await signIn(server);
    const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: `dty_session=${session}` } });
    expect(me.json()).toMatchObject({ handle: 'alice', role: 'approver' });
    expect(await listMembers(db)).toHaveLength(1);
  });

  it('cookie-authenticated writes need the CSRF header', async () => {
    const { session } = await signIn(server);
    const cookie = `dty_session=${session}`;
    const without = await server.inject({ method: 'PUT', url: '/api/me/credentials/gitlab', headers: { cookie }, payload: { secret: 'x' } });
    expect(without.json()).toEqual({ error: 'csrf_header_missing' });
    const withHeader = await server.inject({
      method: 'PUT',
      url: '/api/me/credentials/gitlab',
      headers: { cookie, 'x-dittoly-request': '1' },
      payload: { secret: 'x' },
    });
    expect(withHeader.statusCode).toBe(204);
  });

  it('logout ends the session', async () => {
    const { session } = await signIn(server);
    const cookie = `dty_session=${session}`;
    expect((await server.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, 'x-dittoly-request': '1' } })).statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects a callback without the sign-in state cookie, or with a tampered one', async () => {
    const start = await server.inject({ method: 'GET', url: '/auth/login' });
    expect((await server.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' })).json()).toEqual({ error: 'sso_state_missing' });
    const bad = await server.inject({ method: 'GET', url: '/auth/callback?code=x&state=y', headers: { cookie: 'dty_sso=v1:AAAA' } });
    expect(bad.json()).toEqual({ error: 'sso_state_invalid' });
    expect(start.statusCode).toBe(302);
  });

  it('never redirects off-site after sign-in', async () => {
    const { response } = await signIn(server, '//evil.example/');
    expect(response.headers.location).toBe('/');
  });

  it('a disabled member cannot sign in, and their sessions end', async () => {
    const { session } = await signIn(server);
    await db.query(`UPDATE members SET disabled = true WHERE handle = 'alice'`);
    expect((await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: `dty_session=${session}` } })).statusCode).toBe(401);
    const again = await signIn(server);
    expect(again.response.json()).toEqual({ error: 'member_disabled' });
    await db.query(`UPDATE members SET disabled = false WHERE handle = 'alice'`);
  });
});

describe('email domain allow-list', () => {
  it('only verified emails in the allowed domains may sign in', async () => {
    const { db, server } = await world(['acme.test']);
    nextAccount = { sub: 'mallory-sub', email: 'mallory@other.test', name: 'Mallory' };
    const denied = await signIn(server);
    expect(denied.response.json()).toEqual({ error: 'sso_domain_not_allowed' });
    nextAccount = { sub: 'bob-sub', email: 'bob@acme.test', name: 'Bob' };
    expect((await signIn(server)).session).toBeTruthy();
    await server.close();
    await db.end();
  });
});

describe('member administration', () => {
  it('admins change roles; the last admin can never be removed', async () => {
    const { db, server } = await world();
    const { createMember } = await import('../src/core/members.js');
    const admin = await createMember(db, 'root', 'admin', null);
    const bob = await createMember(db, 'bob', 'member', null);
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });

    expect((await server.inject({ method: 'GET', url: '/api/members', headers: auth(bob.token) })).statusCode).toBe(403);
    const promote = await server.inject({ method: 'PATCH', url: `/api/members/${bob.member.id}`, headers: auth(admin.token), payload: { role: 'approver' } });
    expect(promote.statusCode).toBe(204);
    const demoteLast = await server.inject({ method: 'PATCH', url: `/api/members/${admin.member.id}`, headers: auth(admin.token), payload: { role: 'member' } });
    expect(demoteLast.json()).toEqual({ error: 'last_admin' });
    const disableLast = await server.inject({ method: 'PATCH', url: `/api/members/${admin.member.id}`, headers: auth(admin.token), payload: { disabled: true } });
    expect(disableLast.json()).toEqual({ error: 'last_admin' });

    // Bearer API tokens need no CSRF header (they are not sent automatically by browsers).
    const dir = await server.inject({ method: 'GET', url: '/api/directory', headers: auth(bob.token) });
    expect(dir.json().map((m: { handle: string }) => m.handle)).toEqual(['bob', 'root']);
    await server.close();
    await db.end();
  });

  it('local mode signs the single member in from the launcher link; shared mode has no such route', async () => {
    const db = await freshDb();
    const { createMember } = await import('../src/core/members.js');
    const me = await createMember(db, 'me', 'admin', null);
    const local = buildServer(buildApp(testConfig({ mode: 'local' }), db, { ai: null }));
    const res = await local.inject({ method: 'GET', url: `/auth/local?token=${me.token}&returnTo=/flows` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/flows');
    expect(cookieFrom(res.headers['set-cookie'], 'dty_session')).toBeTruthy();
    expect((await local.inject({ method: 'GET', url: '/auth/local?token=wrong' })).statusCode).toBe(401);
    const shared = buildServer(buildApp(testConfig({ mode: 'shared' }), db, { ai: null }));
    expect((await shared.inject({ method: 'GET', url: `/auth/local?token=${me.token}` })).statusCode).toBe(404);
    await local.close();
    await shared.close();
    await db.end();
  });
});

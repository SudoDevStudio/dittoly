import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import { audit } from '../core/audit.js';
import { AppError } from '../core/errors.js';
import { createSession, deleteSession, memberBySession, memberByToken, memberForOidc } from '../core/members.js';
import { OidcAuth, safeReturnTo } from '../core/oidc.js';
import { DEVICE_COOKIE, DEVICE_DAYS } from '../devices/service.js';
import { OLD_DEVICE_COOKIE, OLD_SESSION_COOKIE } from '../core/old-prefixes.js';

export const SESSION_COOKIE = 'dty_session';
type WithCookies = { cookies: Record<string, string | undefined> };
/** The session cookie, or the one under its name before the dty_ prefix (src/core/old-prefixes.ts). */
export const sessionCookie = (req: WithCookies) => req.cookies[SESSION_COOKIE] ?? req.cookies[OLD_SESSION_COOKIE];
const deviceCookie = (req: WithCookies) => req.cookies[DEVICE_COOKIE] ?? req.cookies[OLD_DEVICE_COOKIE];
const PENDING_COOKIE = 'dty_sso';
/** Browsers cannot send a custom header cross-site without a CORS preflight, which this server never allows. */
export const CSRF_HEADER = 'x-dittoly-request';
const csrfOk = (req: { headers: Record<string, string | string[] | undefined> }) => req.headers[CSRF_HEADER] === '1';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function cookieOptions(app: App, maxAgeSeconds?: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: app.config.publicUrl.startsWith('https://'),
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

async function startSession(app: App, reply: FastifyReply, memberId: string): Promise<void> {
  const token = await createSession(app.db, memberId, app.config.sessionTtlHours);
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(app, app.config.sessionTtlHours * 3600));
}

/**
 * Resolves the member for /api requests: an API token (Authorization: Bearer)
 * or a browser session cookie. Cookie-authenticated writes must carry the CSRF header.
 */
export function authenticate(app: App) {
  return async (req: FastifyRequest): Promise<void> => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      const member = await memberByToken(app.db, h.slice(7));
      if (!member) throw new AppError('unauthenticated', 401);
      req.member = member;
      return;
    }
    const cookie = sessionCookie(req);
    let member = cookie ? await memberBySession(app.db, cookie) : null;
    const deviceToken = deviceCookie(req);
    if (!member && deviceToken) {
      // A paired phone: its session only reaches the command endpoints (and who it is signed in as).
      const device = await app.devices.session(deviceToken);
      if (device) {
        const route = req.routeOptions.url ?? '';
        if (!route.startsWith('/api/m/') && !(route === '/api/me' && req.method === 'GET')) throw new AppError('device_not_allowed', 403);
        member = device.member;
        req.deviceId = device.deviceId;
      }
    }
    if (!member) throw new AppError('unauthenticated', 401);
    if (!SAFE_METHODS.has(req.method) && !csrfOk(req)) throw new AppError('csrf_header_missing', 403);
    req.member = member;
  };
}

export function registerAuthRoutes(server: FastifyInstance, app: App): void {
  const oidc = app.config.oidc
    ? new OidcAuth(
        {
          ...app.config.oidc,
          redirectUri: `${app.config.publicUrl}/auth/callback`,
          // http:// issuers only for an identity provider on this machine (development).
          allowInsecureIssuer: ['localhost', '127.0.0.1'].includes(new URL(app.config.oidc.issuer).hostname),
        },
        app.cipher,
      )
    : null;

  server.get('/auth/config', async () => ({ mode: app.config.mode, sso: oidc !== null }));

  server.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (req, reply) => {
    if (!oidc) throw new AppError('sso_not_configured', 404);
    const { url, sealed } = await oidc.begin(req.query.returnTo ?? '/');
    reply.setCookie(PENDING_COOKIE, sealed, { ...cookieOptions(app, 600), path: '/auth' });
    return reply.redirect(url, 302);
  });

  server.get('/auth/callback', async (req, reply) => {
    if (!oidc) throw new AppError('sso_not_configured', 404);
    reply.clearCookie(PENDING_COOKIE, { path: '/auth' });
    const callbackUrl = new URL(req.url, app.config.publicUrl);
    const { identity, returnTo } = await oidc.finish(callbackUrl, req.cookies[PENDING_COOKIE]);
    const { member, disabled } = await memberForOidc(app.db, identity);
    if (disabled) {
      await audit(app.db, { actorId: member.id, action: 'auth.sign_in', subjectType: 'member', subjectId: member.id, outcome: 'denied', errorType: 'member_disabled' });
      throw new AppError('member_disabled', 403);
    }
    await startSession(app, reply, member.id);
    await audit(app.db, { actorId: member.id, action: 'auth.sign_in', subjectType: 'member', subjectId: member.id, outcome: 'ok' });
    return reply.redirect(returnTo, 302);
  });

  /**
   * Local install only: the launcher prints a one-time sign-in link carrying the
   * single member's API token, so there is no login screen on your own machine.
   */
  server.get<{ Querystring: { token?: string; returnTo?: string } }>('/auth/local', async (req, reply) => {
    if (app.config.mode !== 'local') throw new AppError('not_found', 404);
    const member = req.query.token ? await memberByToken(app.db, req.query.token) : null;
    if (!member) throw new AppError('unauthenticated', 401);
    await startSession(app, reply, member.id);
    return reply.redirect(safeReturnTo(req.query.returnTo), 302);
  });

  /** MCP OAuth: the authorization server sends the member back here. The member must be signed in. */
  server.get<{ Querystring: { code?: string; state?: string; iss?: string } }>('/auth/mcp/callback', async (req, reply) => {
    const cookie = sessionCookie(req);
    const member = cookie ? await memberBySession(app.db, cookie) : null;
    if (!member) throw new AppError('unauthenticated', 401);
    const returnTo = await app.mcpOAuth.finish(member, req.query);
    return reply.redirect(returnTo, 302);
  });

  /**
   * A phone scanned the QR code: the one-time code (from the link's #fragment, so it
   * never reaches logs) becomes a device session of its own.
   */
  server.post<{ Body: { code?: unknown; name?: unknown } }>('/auth/device/pair', async (req, reply) => {
    if (!csrfOk(req)) throw new AppError('csrf_header_missing', 403);
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) throw new AppError('pairing_code_invalid', 401);
    const name = typeof req.body?.name === 'string' ? req.body.name : 'Phone';
    const { token, expiresAt } = await app.devices.pair(code, name);
    reply.setCookie(DEVICE_COOKIE, token, cookieOptions(app, DEVICE_DAYS * 86_400));
    return { paired: true, expiresAt };
  });

  server.post('/auth/logout', async (req, reply) => {
    if (!csrfOk(req)) throw new AppError('csrf_header_missing', 403);
    const cookie = sessionCookie(req);
    if (cookie) await deleteSession(app.db, cookie);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(DEVICE_COOKIE, { path: '/' });
    reply.clearCookie(OLD_SESSION_COOKIE, { path: '/' });
    reply.clearCookie(OLD_DEVICE_COOKIE, { path: '/' });
    return reply.status(204).send();
  });
}

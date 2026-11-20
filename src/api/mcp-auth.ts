import type { FastifyInstance, FastifyReply } from 'fastify';
import type { App } from '../app.js';
import { forbidden } from '../core/errors.js';
import { memberBySession } from '../core/members.js';
import { agentBody } from '../mcp/agents.js';
import { allowedAppsBody, getAllowedApps, setAllowedApps, type AuthPageError, type OAuthReply } from '../mcp/authserver.js';
import { sessionCookie } from './auth.js';
import { me, parse, uuid } from './http.js';

/**
 * OAuth sign-in for /mcp (see src/mcp/authserver.ts). Discovery, authorization, token,
 * registration and revocation endpoints need no member; the consent page's API (under /api)
 * is a member's, with the usual session cookie and CSRF header.
 */
export function registerMcpAuthRoutes(server: FastifyInstance, app: App): void {
  server.register(async (scope) => {
    // RFC 6749: the token and revocation endpoints take form-encoded bodies.
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 20_000 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    const auth = app.mcpAuth;
    const json = (reply: FastifyReply, r: OAuthReply) => reply.status(r.status).header('cache-control', 'no-store').send(r.body);
    // Discovery documents are public, also to browser-based clients.
    const doc = (reply: FastifyReply, body: unknown) => reply.header('access-control-allow-origin', '*').header('cache-control', 'max-age=300').send(body);

    scope.get('/.well-known/oauth-protected-resource', async (_req, reply) => doc(reply, auth.protectedResource()));
    scope.get('/.well-known/oauth-protected-resource/mcp', async (_req, reply) => doc(reply, auth.protectedResource()));
    scope.get('/.well-known/oauth-authorization-server', async (_req, reply) => doc(reply, auth.metadata()));

    scope.get<{ Querystring: Record<string, string | undefined> }>('/oauth/authorize', async (req, reply) => {
      const out = await auth.authorize(req.query);
      if ('page' in out) return reply.status(out.page.status).type('text/html; charset=utf-8').send(errorPage(out.page));
      if (!out.redirect.startsWith('/connect/')) return reply.redirect(out.redirect, 302);
      // Not signed in to the portal: through the portal's own sign-in first, then back to the consent page.
      const cookie = sessionCookie(req);
      const member = cookie ? await memberBySession(app.db, cookie) : null;
      if (!member && app.config.oidc) return reply.redirect(`/auth/login?returnTo=${encodeURIComponent(out.redirect)}`, 302);
      return reply.redirect(out.redirect, 302);
    });

    scope.post('/oauth/token', async (req, reply) => json(reply, await auth.token(body(req.body))));
    scope.post('/oauth/revoke', async (req, reply) => json(reply, await auth.revoke(body(req.body))));
    scope.post('/oauth/register', async (req, reply) => json(reply, await auth.register(req.body)));
  });
}

/** The consent page's API and the admins' list of apps that may connect (inside the /api scope). */
export function registerMcpConsentRoutes(api: FastifyInstance, app: App): void {
  api.get<{ Params: { id: string } }>('/oauth/requests/:id', async (req) => app.mcpAuth.request(me(req), parse(uuid, req.params.id)));
  api.post<{ Params: { id: string } }>('/oauth/requests/:id/approve', async (req) => app.mcpAuth.approve(me(req), parse(uuid, req.params.id), parse(agentBody, req.body)));
  api.post<{ Params: { id: string } }>('/oauth/requests/:id/deny', async (req) => app.mcpAuth.deny(me(req), parse(uuid, req.params.id)));
  api.get('/settings/mcp-apps', async (req) => {
    if (me(req).role !== 'admin') throw forbidden('admin_only');
    return getAllowedApps(app.db);
  });
  api.put('/settings/mcp-apps', async (req) => setAllowedApps(app.db, me(req), parse(allowedAppsBody, req.body), app.config.insecureHttpHosts));
}

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain page for problems the app cannot be told about (it is not allowed, or its address is wrong). */
function errorPage(e: AuthPageError): string {
  const title = e.code === 'app_not_allowed' ? 'This app may not connect' : 'This sign-in cannot continue';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} | Dittoly</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e7e9ee;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:34rem;padding:2rem}h1{font-size:1.4rem}p{color:#b4b9c4}code{color:#8fb4ff}a{color:#8fb4ff}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(e.detail)}</p><p><code>${esc(e.code)}</code></p><p><a href="/">Open Dittoly</a></p></main></body></html>`;
}

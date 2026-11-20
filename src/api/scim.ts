import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { audit } from '../core/audit.js';
import { AppError } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import {
  createScimToken,
  ERROR_SCHEMA,
  GROUP_SCHEMA,
  LIST_SCHEMA,
  MAX_PAGE,
  recordScimError,
  revokeScimToken,
  Scim,
  ScimError,
  scimTokenFor,
  USER_SCHEMA,
  type ScimActor,
} from '../core/scim.js';
import { takeToken } from '../webhooks/service.js';
import { me, parse, uuid } from './http.js';

declare module 'fastify' {
  interface FastifyRequest {
    scim?: ScimActor;
  }
}

/** Requests per minute for the SCIM token; a full Entra ID cycle stays well under it. */
const RATE_PER_MINUTE = 1200;
/** Requests with a missing or wrong token, per minute, for everyone together. */
const REFUSED_PER_MINUTE = 60;
const CONTENT_TYPE = 'application/scim+json; charset=utf-8';

export function scimFor(app: App): Scim {
  return new Scim({
    db: app.db,
    cancelRun: (runId, actor) => app.engine.cancel(runId, actor),
    cancelDelegations: (tx, memberId, actorId) => app.engine.cancelDelegationsOf(tx, memberId, actorId),
    baseUrl: `${app.config.publicUrl}/scim/v2`,
    oidcIssuer: app.config.oidc?.issuer,
  });
}

function scimError(reply: FastifyReply, status: number, scimType: string | null, detail: string) {
  return reply
    .status(status)
    .type(CONTENT_TYPE)
    .send({ schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail });
}

/**
 * The SCIM 2.0 API the identity provider calls (RFC 7644), under /scim/v2. A SCIM token is the only
 * authentication: personal API tokens, sessions and MCP tokens do not work here, and the SCIM token
 * works nowhere else.
 */
export function registerScimRoutes(server: FastifyInstance, app: App): void {
  const scim = scimFor(app);
  server.register(
    async (s) => {
      // Identity providers send application/scim+json; plain JSON is accepted too. A DELETE may carry the
      // content type with no body.
      const json = s.getDefaultJsonParser('error', 'error');
      const lenient = (req: FastifyRequest, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) =>
        body.length === 0 ? done(null, undefined) : json(req, body.toString(), done);
      s.removeContentTypeParser('application/json');
      s.addContentTypeParser(['application/json', 'application/scim+json'], { parseAs: 'string' }, lenient);

      s.addHook('onRequest', async (req, reply) => {
        const h = req.headers.authorization;
        const actor = h && /^bearer /i.test(h) ? await scimTokenFor(app.db, h.slice(7).trim()) : null;
        if (!actor) {
          if (!(await takeToken(app.db, 'scim:refused', REFUSED_PER_MINUTE))) return scimError(reply, 429, null, 'Too many requests.');
          await audit(app.db, { actorId: null, action: 'scim.auth_refused', subjectType: 'org', subjectId: 'scim', outcome: 'denied', errorType: h ? 'invalid_token' : 'missing_token' });
          reply.header('www-authenticate', 'Bearer realm="dittoly-scim"');
          return scimError(reply, 401, null, 'A valid SCIM bearer token is required.');
        }
        if (!(await takeToken(app.db, `scim:${actor.tokenId}`, RATE_PER_MINUTE))) {
          reply.header('retry-after', '60');
          return scimError(reply, 429, null, 'Too many requests; try again in a minute.');
        }
        req.scim = actor;
      });

      // Failed requests are listed on the admin page (codes only, never what was sent).
      s.addHook('onResponse', async (req, reply) => {
        if (reply.statusCode < 400) return;
        const e = (reply as FastifyReply & { scimFailure?: { scimType: string | null; code: string } }).scimFailure;
        await recordScimError(app.db, {
          method: req.method,
          resource: (req.routeOptions.url ?? 'unmatched').replace(/^\/scim\/v2/, ''),
          status: reply.statusCode,
          scimType: e?.scimType ?? null,
          code: e?.code ?? (reply.statusCode === 401 ? 'unauthenticated' : reply.statusCode === 429 ? 'rate_limited' : 'error'),
        }).catch(() => undefined);
      });

      s.setErrorHandler(async (err, req, reply) => {
        let status = 500;
        let scimType: string | null = null;
        let code = 'internal_error';
        let detail = 'Something went wrong in Dittoly.';
        if (err instanceof ScimError) {
          ({ httpStatus: status, scimType, code, detail } = err);
          // The change was rolled back; the refusal itself is kept in the audit log.
          if (err.denied && req.scim) await audit(app.db, { ...err.denied, actorId: req.scim.tokenId, outcome: 'denied' }).catch(() => undefined);
        } else if (err instanceof AppError) {
          status = err.httpStatus;
          code = err.code;
          detail = err.message;
          scimType = status === 409 ? 'uniqueness' : status === 400 ? 'invalidValue' : null;
        } else {
          const s4 = (err as { statusCode?: number }).statusCode;
          if (s4 && s4 >= 400 && s4 < 500) {
            status = s4;
            code = 'bad_request';
            detail = s4 === 415 ? 'Send application/scim+json or application/json.' : 'The request could not be read.';
            scimType = s4 === 400 ? 'invalidSyntax' : null;
          } else log.error('scim_unhandled_error', { errorType: errorType(err) });
        }
        (reply as FastifyReply & { scimFailure?: unknown }).scimFailure = { scimType, code };
        return scimError(reply, status, scimType, detail);
      });
      s.setNotFoundHandler((_req, reply) => scimError(reply, 404, null, 'No such SCIM endpoint.'));

      const send = (reply: FastifyReply, body: unknown, status = 200) => reply.status(status).type(CONTENT_TYPE).send(body);
      const actor = (req: FastifyRequest): ScimActor => req.scim!;
      type Q = { Querystring: { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string } };

      // ---- discovery (RFC 7644 section 4)
      s.get('/ServiceProviderConfig', async (_req, reply) => send(reply, serviceProviderConfig(app.config.publicUrl)));
      s.get('/ResourceTypes', async (_req, reply) => send(reply, { schemas: [LIST_SCHEMA], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: resourceTypes(app.config.publicUrl) }));
      s.get<{ Params: { id: string } }>('/ResourceTypes/:id', async (req, reply) => {
        const t = resourceTypes(app.config.publicUrl).find((r) => r.id === req.params.id);
        if (!t) throw new ScimError(404, null, 'not_found', 'no such resource type');
        return send(reply, t);
      });
      s.get('/Schemas', async (_req, reply) => send(reply, { schemas: [LIST_SCHEMA], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: SCHEMAS }));
      s.get<{ Params: { id: string } }>('/Schemas/:id', async (req, reply) => {
        const sc = SCHEMAS.find((x) => x.id === req.params.id);
        if (!sc) throw new ScimError(404, null, 'not_found', 'no such schema');
        return send(reply, sc);
      });

      // ---- Users
      s.get<Q>('/Users', async (req, reply) => send(reply, await scim.listUsers(req.query)));
      s.get<{ Params: { id: string } }>('/Users/:id', async (req, reply) => send(reply, await scim.getUser(req.params.id)));
      s.post('/Users', async (req, reply) => {
        const { resource, runsToCancel } = await scim.createUser(actor(req), req.body);
        await scim.cancelRuns(actor(req), runsToCancel);
        return send(reply.header('location', resource.meta.location), resource, 201);
      });
      s.put<{ Params: { id: string } }>('/Users/:id', async (req, reply) => {
        const { resource, runsToCancel } = await scim.replaceUser(actor(req), req.params.id, req.body);
        await scim.cancelRuns(actor(req), runsToCancel);
        return send(reply, resource);
      });
      s.patch<{ Params: { id: string } }>('/Users/:id', async (req, reply) => {
        const { resource, runsToCancel } = await scim.patchUser(actor(req), req.params.id, req.body);
        await scim.cancelRuns(actor(req), runsToCancel);
        return send(reply, resource);
      });
      s.delete<{ Params: { id: string } }>('/Users/:id', async (req, reply) => {
        const { runsToCancel } = await scim.deleteUser(actor(req), req.params.id);
        await scim.cancelRuns(actor(req), runsToCancel);
        return reply.status(204).send();
      });

      // ---- Groups
      s.get<Q>('/Groups', async (req, reply) => send(reply, await scim.listGroups(req.query)));
      s.get<{ Params: { id: string }; Querystring: { excludedAttributes?: string } }>('/Groups/:id', async (req, reply) => send(reply, await scim.getGroup(req.params.id, req.query)));
      s.post('/Groups', async (req, reply) => {
        const g = await scim.createGroup(actor(req), req.body);
        return send(reply.header('location', g.meta.location), g, 201);
      });
      s.put<{ Params: { id: string } }>('/Groups/:id', async (req, reply) => send(reply, await scim.replaceGroup(actor(req), req.params.id, req.body)));
      s.patch<{ Params: { id: string } }>('/Groups/:id', async (req, reply) => send(reply, await scim.patchGroup(actor(req), req.params.id, req.body)));
      s.delete<{ Params: { id: string } }>('/Groups/:id', async (req, reply) => {
        await scim.deleteGroup(actor(req), req.params.id);
        return reply.status(204).send();
      });
    },
    { prefix: '/scim/v2' },
  );
}

/** Portal settings for provisioning: the token, group links and role mapping, sync status. Admins only. */
export function registerScimAdminRoutes(api: FastifyInstance, app: App): void {
  const scim = scimFor(app);
  api.get('/admin/scim', async (req) => scim.overview(me(req)));
  api.post('/admin/scim/token', async (req, reply) => {
    if (app.config.mode === 'local') throw new AppError('single_user_install', 409);
    const { token } = await createScimToken(app.db, me(req));
    return reply.status(201).send({ token, baseUrl: `${app.config.publicUrl}/scim/v2` });
  });
  api.delete('/admin/scim/token', async (req, reply) => {
    await revokeScimToken(app.db, me(req));
    return reply.status(204).send();
  });
  api.put<{ Params: { id: string } }>('/admin/scim/groups/:id', async (req, reply) => {
    const body = parse(z.object({ teamId: uuid.optional(), grantsRole: z.enum(['admin', 'approver']).nullable().optional() }).strict(), req.body);
    await scim.configureGroup(me(req), parse(uuid, req.params.id), body);
    return reply.status(204).send();
  });
  api.put<{ Params: { id: string } }>('/admin/scim/members/:id/link', async (req, reply) => {
    const body = parse(z.object({ userName: z.string().min(1).max(256) }).strict(), req.body);
    await scim.linkMember(me(req), parse(uuid, req.params.id), body.userName);
    return reply.status(204).send();
  });
}

// ---------------------------------------------------------------- discovery documents

function serviceProviderConfig(publicUrl: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: `${publicUrl}/docs/scim`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      { type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'The SCIM token an admin creates in Dittoly (Members & Access, Provisioning).', primary: true },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${publicUrl}/scim/v2/ServiceProviderConfig` },
  };
}

function resourceTypes(publicUrl: string) {
  return [
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', description: 'A Dittoly member', schema: USER_SCHEMA, meta: { resourceType: 'ResourceType', location: `${publicUrl}/scim/v2/ResourceTypes/User` } },
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', description: 'A group, kept as a Dittoly team', schema: GROUP_SCHEMA, meta: { resourceType: 'ResourceType', location: `${publicUrl}/scim/v2/ResourceTypes/Group` } },
  ];
}

const a = (name: string, more: Record<string, unknown> = {}) => ({
  name,
  type: 'string',
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...more,
});

/** The attributes Dittoly keeps; others an identity provider sends are accepted and ignored. */
const SCHEMAS = [
  {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: USER_SCHEMA,
    name: 'User',
    description: 'A Dittoly member',
    attributes: [
      a('userName', { required: true, uniqueness: 'server' }),
      a('externalId', { caseExact: true }),
      a('displayName'),
      a('name', { type: 'complex', subAttributes: [a('givenName'), a('familyName'), a('formatted')] }),
      a('emails', { type: 'complex', multiValued: true, subAttributes: [a('value'), a('type'), a('primary', { type: 'boolean' })] }),
      a('active', { type: 'boolean' }),
      a('groups', { type: 'complex', multiValued: true, mutability: 'readOnly', subAttributes: [a('value', { mutability: 'readOnly' }), a('display', { mutability: 'readOnly' })] }),
    ],
    meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${USER_SCHEMA}` },
  },
  {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: GROUP_SCHEMA,
    name: 'Group',
    description: 'A group, kept as a Dittoly team',
    attributes: [
      a('displayName', { required: true, uniqueness: 'server' }),
      a('externalId', { caseExact: true }),
      a('members', { type: 'complex', multiValued: true, subAttributes: [a('value', { mutability: 'immutable' }), a('display', { mutability: 'readOnly' })] }),
    ],
    meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${GROUP_SCHEMA}` },
  },
];

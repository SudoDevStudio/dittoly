import { memberTeamIds } from '../core/teams.js';
import { canApprove } from '../core/members.js';
import { narrator } from '../engine/commentary.js';
import { currentBuilds, tracked } from '../core/builds.js';
import { setFlowMcp, toolName } from '../mcp/server.js';
import { agentBody, agentUpdateBody, scopesBody } from '../mcp/agents.js';
import { offerBody } from '../mcp/gateway.js';
import { getUndoWindow, reversalBody, setUndoWindow } from '../engine/undo.js';
import { apiSourceSchema } from '../ai/api-source.js';
import { getDirectCode, setDirectCode } from '../engine/apps.js';
import { outcomeSentences } from '../engine/outcome.js';
import { egressCeiling, orgEgress, setOrgEgress, setTeamEgress, teamEgress } from '../core/egress-policy.js';
import { playwrightToModule } from '../modules/playwright-import.js';
import { getAiInstructions, setAiInstructions } from '../core/org-settings.js';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WEB_ROOT } from '../paths.js';
import { z } from 'zod';
import type { App } from '../app.js';
import { audit } from '../core/audit.js';
import { listTeamCredentials, putTeamCredential, removeTeamCredential, setCredentialMode } from '../core/team-credentials.js';
import { assertTeamMember, createTeam, listTeams, removeTeamMember, renameTeam, setRunLimit, setTeamMember, teamMembers } from '../core/teams.js';
import { contentSecurityPolicy, embeddable, getBrowserSites, getMediaHosts, setBrowserSites, setMediaHosts } from '../core/media.js';
import { getRetention, setRetention } from '../core/retention.js';
import { chatRetentionDays, setChatRetentionDays } from '../plans/chats.js';
import { answersSchema } from '../ai/classify.js';
import { itemHelpBody } from '../plans/service.js';
import { inputMapSchema, TOKEN_HEADER } from '../endpoints/service.js';
import { teamsWebhookAad } from '../core/delivery.js';
import { AppError, badRequest, forbidden } from '../core/errors.js';
import { exhaustedJobs, queueStats, retryJob } from '../engine/jobs.js';
import { slotUse } from '../engine/sandbox-housekeeping.js';
import { readiness } from '../core/readiness.js';
import { errorType, log } from '../core/log.js';
import { createMember, listMembers, ROLES, revokeApiToken, rotateApiToken, updateMember, type Member } from '../core/members.js';
import { authenticate, registerAuthRoutes } from './auth.js';
import { approvalQueue, listFlows, listRuns, neededCredentials } from './queries.js';
import { runnableFlows } from './runnable.js';
import { me, parse, uuid } from './http.js';
import { registerGovernanceRoutes } from './governance.js';
import { registerModuleSafetyRoutes } from './module-safety.js';
import { registerChannelRoutes } from './channels.js';
import { registerInsightRoutes } from './insights.js';
import { registerAiModelRoutes } from './ai-models.js';
import { costForecast } from '../ai/costs.js';
import { registerExportRoutes } from './exports.js';
import { registerWatchRoutes } from './watches.js';
import { registerTableRoutes } from './tables.js';
import { registerOnboardingRoutes } from './onboarding.js';
import { registerMcpAuthRoutes, registerMcpConsentRoutes } from './mcp-auth.js';
import { registerScimAdminRoutes, registerScimRoutes } from './scim.js';
import { grantRunAs } from '../governance/breakglass.js';
import { enterAiContext } from '../ai/metering.js';
import { archiveFlow, archiveModule, isFlowArchived, restoreFlow, restoreModule } from '../flows/archive.js';
import { answerAppStep, appInbox, appInfo, appRun, appRuns, archiveApp, createApp, decideApp, decideAppStep, draftLayout, getApp, listApps, openApp, startAppRun, updateApp } from '../team-apps/service.js';
import { appShell, APP_UI_FILES } from '../team-apps/shell.js';
import { themeCss } from '../export/theme.js';
import { markRunFix } from '../modules/run-fix.js';
import { assertMayReadJournal, deleteEntry, journal, journalOf, supersedeEntry } from '../ai/build-memory.js';
import { assertMaySeeDecisions, forgetDecision, teamDecisions } from '../ai/decisions.js';
import { updateModules } from '../flows/module-updates.js';

declare module 'fastify' {
  interface FastifyRequest {
    member?: Member;
    /** Set when a paired phone made the request. */
    deviceId?: string;
  }
}

const decisionBody = z.object({ decision: z.enum(['approved', 'rejected']), valuesSha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
/** A Flow version's decision; the approver may accept prompt-injection paths, each with a reason. */
const flowDecisionBody = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    accept: z.array(z.object({ sink: z.string().min(1).max(40), reason: z.string().trim().min(10).max(500) }).strict()).max(50).optional(),
    /** The approver saw which App pages this version breaks and accepts it. */
    acceptAppBreaks: z.boolean().optional(),
  })
  .strict();

const moduleName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);

export function buildServer(app: App, options: { webRoot?: string } = {}): FastifyInstance {
  // Fastify's own logger is off: it would log client addresses and URLs. We log allow-listed fields only.
  const server = Fastify({ logger: false, bodyLimit: 1_000_000 });

  server.addHook('onResponse', async (req, reply) => {
    log.info('http', {
      method: req.method,
      route: req.routeOptions.url ?? 'unmatched',
      httpStatus: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      // Too many runs waiting: callers (webhook senders, scripts) may try again after a minute.
      if (err.code === 'server_busy') reply.header('retry-after', '60');
      return reply.status(err.httpStatus).send({ error: err.code, ...(err.message !== err.code ? { detail: err.message } : {}), ...(err.raw ? { aiRaw: err.raw } : {}) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: 'bad_request' });
    log.error('unhandled_error', { errorType: errorType(err) });
    return reply.status(500).send({ error: 'internal_error' });
  });

  // ---- webhooks: raw body, no member auth (the signature is the authentication)
  server.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post<{ Params: { id: string } }>('/hooks/:id', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const r = await app.webhooks.receive(req.params.id, req.headers, raw);
      if (r.duplicate) return reply.status(200).send({ duplicate: true });
      return reply.status(202).send(r.queued ? { accepted: true } : { runId: r.runId });
    });
    // WhatsApp Business Cloud API webhook (signed with the app secret).
    scope.get('/channels/whatsapp', async (req, reply) => {
      const challenge = app.whatsapp?.verify(req.query as Record<string, string | undefined>) ?? null;
      if (challenge === null) return reply.status(403).send({ error: 'forbidden' });
      return reply.type('text/plain').send(challenge);
    });
    scope.post('/channels/whatsapp', async (req, reply) => {
      if (!app.whatsapp) return reply.status(404).send({ error: 'not_found' });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = req.headers['x-hub-signature-256'];
      const r = app.whatsapp.receive(raw, typeof sig === 'string' ? sig : undefined);
      if (!r.ok) return reply.status(401).send({ error: 'bad_signature' });
      // Answered after the 200: Meta expects a quick response, and replies go out through the API.
      void r.done;
      return reply.status(200).send({ ok: true });
    });
  });

  // Liveness: the process answers. Readiness: it can do its work (src/core/readiness.ts).
  server.get('/health', async () => ({ ok: true, mode: app.config.mode }));
  server.get('/ready', async (_req, reply) => {
    const r = await readiness(app);
    return reply.status(r.ready ? 200 : 503).send(r);
  });

  // ---- Flow URLs: no member session; the x-sflow-token header is the authentication
  server.post<{ Params: { id: string } }>('/sflow/:id', async (req, reply) => {
    const token = req.headers[TOKEN_HEADER];
    const inputs = req.body === undefined || req.body === null || req.body === '' ? {} : req.body;
    if (typeof inputs !== 'object' || Array.isArray(inputs)) throw badRequest('invalid_inputs', 'send the inputs as a JSON object');
    return reply.status(202).send(await app.endpoints.call(req.params.id, typeof token === 'string' ? token : undefined, inputs));
  });
  server.get<{ Params: { id: string; runId: string } }>('/sflow/:id/runs/:runId', async (req) => {
    const token = req.headers[TOKEN_HEADER];
    return app.endpoints.status(req.params.id, typeof token === 'string' ? token : undefined, parse(uuid, req.params.runId));
  });

  // ---- MCP server for AI assistants: no member session; a personal MCP token is the authentication
  server.all('/mcp', async (req, reply) => {
    const r = await app.mcpServer.handle({ method: req.method, headers: req.headers, body: req.body });
    for (const [k, v] of Object.entries(r.headers ?? {})) reply.header(k, v);
    return r.body === undefined ? reply.status(r.status).send() : reply.status(r.status).send(r.body);
  });

  // Basic hardening for every response. Only media (players, files, images, frames) may come from
  // elsewhere: the known video players and the hosts an admin allows (src/core/media.ts).
  server.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    // An app's pages (/a/...) may be framed by Dittoly itself, for the editor's preview; nothing else is framed.
    const appPage = req.url.startsWith('/a/');
    reply.header('x-frame-options', appPage ? 'SAMEORIGIN' : 'DENY');
    const csp = await contentSecurityPolicy(app.db, app.config.insecureHttpHosts);
    reply.header('content-security-policy', appPage ? csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : csp);
  });

  // Apps opened inside Dittoly: a page shell and the export's own renderer; the pages call /api/apps/... with the
  // member's session. /a/<app>/... is the live version, /a/<app>/v/<version>/... a preview.
  for (const [file, f] of Object.entries(APP_UI_FILES)) server.get(`/app-ui/${file}`, async (_req, reply) => reply.type(f.type).header('cache-control', 'no-cache').send(f.body));
  const shell = async (req: { params: { id: string; ver?: string } }, reply: { type: (t: string) => { send: (b: string) => unknown } }) =>
    reply.type('text/html; charset=utf-8').send(appShell(parse(uuid, req.params.id), req.params.ver ? parse(uuid, req.params.ver) : null));
  server.get<{ Params: { id: string } }>('/a/:id', shell);
  server.get<{ Params: { id: string } }>('/a/:id/*', async (req, reply) => {
    const m = /^\/a\/[^/]+\/v\/([0-9a-f-]{36})(\/|$)/.exec(req.url.split('?')[0] ?? '');
    return shell({ params: { id: req.params.id, ...(m ? { ver: m[1]! } : {}) } }, reply);
  });

  // The web portal (built with `npm run web:build`), with history-API fallback.
  const webRoot = options.webRoot ?? WEB_ROOT;
  if (existsSync(path.join(webRoot, 'index.html'))) {
    server.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false, index: ['index.html'] });
    server.setNotFoundHandler((req, reply) => {
      const p = req.url.split('?')[0] ?? '/';
      if (req.method === 'GET' && !/^\/(api|auth|hooks|health|sflow|mcp|scim)(\/|$)/.test(p) && !path.extname(p)) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found' });
    });
  }

  server.register(cookie);
  server.register(async (scope) => registerAuthRoutes(scope, app));
  registerMcpAuthRoutes(server, app);
  // ---- SCIM provisioning for the identity provider: a SCIM token is the authentication
  registerScimRoutes(server, app);

  // ---- everything under /api needs a member: API token or browser session
  server.register(
    async (api) => {
      api.addHook('preHandler', authenticate(app));
      // AI calls made while handling this request are counted for this member (and their team).
      api.addHook('preHandler', (req, _reply, done) => {
        const url = req.routeOptions.url ?? '';
        const purpose = url.startsWith('/api/modules') ? 'module' : url.startsWith('/api/flows') ? 'flow' : url.startsWith('/api/plans') ? 'plan' : url.startsWith('/api/m/') ? 'command' : 'other';
        const team = (req.body as { teamId?: unknown } | undefined)?.teamId;
        // A tally per request: what a draft made here cost, and which model actually answered, so the version
        // it stores can say so (src/modules/registry.ts draftedByLabel).
        enterAiContext({ memberId: req.member?.id, teamId: typeof team === 'string' && /^[0-9a-f-]{36}$/.test(team) ? team : undefined, purpose, tally: { input: 0, output: 0 } }, done);
      });

      api.get('/me', async (req) => me(req));
      api.get('/me/settings', async (req) => {
        const { rows } = await app.db.query<{ notify_email: boolean; notify_slack: boolean; notify_teams: boolean; notify_team_channels: boolean; email: string | null; teams_personal: boolean }>(
          `SELECT notify_email, notify_slack, notify_teams, notify_team_channels, email, teams_webhook_enc IS NOT NULL AS teams_personal FROM members WHERE id = $1`,
          [me(req).id],
        );
        const r = rows[0]!;
        return {
          email: r.email,
          emailNotifications: r.notify_email,
          emailConfigured: app.config.smtpUrl !== undefined,
          slackNotifications: r.notify_slack,
          slackConfigured: app.config.slackBotToken !== undefined,
          teamsNotifications: r.notify_teams,
          teamsConfigured: app.config.teamsWebhookUrl !== undefined,
          /** Whether the member set their own Teams chat; the URL itself is never returned. */
          teamsPersonal: r.teams_personal,
          /** Messages through your teams' own channels (Teams page). */
          teamChannelNotifications: r.notify_team_channels,
        };
      });
      api.put('/me/settings', async (req, reply) => {
        const body = parse(
          z
            .object({
              emailNotifications: z.boolean().optional(),
              slackNotifications: z.boolean().optional(),
              teamsNotifications: z.boolean().optional(),
              teamChannelNotifications: z.boolean().optional(),
              /** The member's own Teams Workflows webhook URL; null removes it. */
              teamsWebhookUrl: z
                .string()
                .max(2048)
                .url()
                .refine((u) => new URL(u).protocol === 'https:', 'must be an https URL')
                .nullable()
                .optional(),
            })
            .strict(),
          req.body,
        );
        if (body.teamsWebhookUrl !== undefined) {
          const id = me(req).id;
          const enc = body.teamsWebhookUrl === null ? null : app.cipher.encrypt(body.teamsWebhookUrl, teamsWebhookAad(id));
          await app.db.query(`UPDATE members SET teams_webhook_enc = $2 WHERE id = $1`, [id, enc]);
          await audit(app.db, { actorId: id, action: enc ? 'member.teams_chat_set' : 'member.teams_chat_removed', subjectType: 'member', subjectId: id, outcome: 'ok' });
        }
        await app.db.query(
          `UPDATE members SET notify_email = COALESCE($2, notify_email), notify_slack = COALESCE($3, notify_slack), notify_teams = COALESCE($4, notify_teams),
             notify_team_channels = COALESCE($5, notify_team_channels)
           WHERE id = $1`,
          [me(req).id, body.emailNotifications ?? null, body.slackNotifications ?? null, body.teamsNotifications ?? null, body.teamChannelNotifications ?? null],
        );
        return reply.status(204).send();
      });

      // Teammates to delegate to: names only, for any member.
      api.get('/directory', async () =>
        (await listMembers(app.db)).filter((m) => !m.disabled).map((m) => ({ id: m.id, handle: m.handle, displayName: m.displayName })),
      );
      api.get('/members', async (req) => {
        if (me(req).role !== 'admin') throw forbidden('admin_only');
        return listMembers(app.db);
      });
      api.patch<{ Params: { id: string } }>('/members/:id', async (req, reply) => {
        const body = parse(z.object({ role: z.enum(ROLES as [string, ...string[]]).optional(), disabled: z.boolean().optional() }).strict(), req.body);
        await updateMember(app.db, me(req), parse(uuid, req.params.id), body as { role?: Member['role']; disabled?: boolean });
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string } }>('/members/:id/token', async (req) => ({
        token: await rotateApiToken(app.db, me(req), parse(uuid, req.params.id)),
      }));
      api.delete<{ Params: { id: string } }>('/members/:id/token', async (req, reply) => {
        await revokeApiToken(app.db, me(req), parse(uuid, req.params.id));
        return reply.status(204).send();
      });

      api.post('/members', async (req, reply) => {
        const actor = me(req);
        if (actor.role !== 'admin') throw forbidden('admin_only');
        if (app.config.mode === 'local') throw new AppError('single_user_install', 409);
        const body = parse(z.object({ handle: z.string(), role: z.enum(['admin', 'approver', 'member']) }).strict(), req.body);
        const { member, token } = await createMember(app.db, body.handle, body.role, actor.id);
        return reply.status(201).send({ member, token });
      });

      // ---- personal credential vault
      api.get('/me/credentials', async (req) => app.vault.list(me(req).id));
      // Standing instructions for AI generation: anyone can read them (they shape drafts they review); admins set them.
      api.get('/ai/instructions', async () => getAiInstructions(app.db));
      api.put('/ai/instructions', async (req) => {
        const body = parse(z.object({ modules: z.string().optional(), flows: z.string().optional() }).strict(), req.body);
        return setAiInstructions(app.db, me(req), body);
      });
      api.get('/me/credentials/needed', async (req) => neededCredentials(app.db, me(req)));
      api.put<{ Params: { service: string } }>('/me/credentials/:service', async (req, reply) => {
        const body = parse(z.object({ secret: z.string() }).strict(), req.body);
        await app.vault.put(me(req).id, req.params.service, body.secret);
        await app.scopes.checkPersonal(me(req).id, req.params.service, body.secret);
        return reply.status(204).send();
      });
      api.delete<{ Params: { service: string } }>('/me/credentials/:service', async (req, reply) => {
        await app.vault.remove(me(req).id, req.params.service);
        return reply.status(204).send();
      });

      // ---- Media in run views: hosts whose files, images and pages may be shown (admins change it)
      api.get('/settings/media', async () => ({
        ...(await getMediaHosts(app.db)),
        players: ['youtube', 'vimeo'],
        // Sites approved browser modules open: their pages may be shown live in run views.
        pages: (await embeddable(app.db, app.config.insecureHttpHosts)).pages,
      }));
      api.put('/settings/media', async (req) => {
        const body = parse(z.object({ hosts: z.array(z.string().max(255)).max(100) }).strict(), req.body);
        return setMediaHosts(app.db, me(req), body.hosts);
      });

      // ---- How long finished runs keep their inputs and outputs (admins change it)
      api.get('/settings/run-retention', async () => getRetention(app.db, app.config.mode));
      api.put('/settings/run-retention', async (req) => {
        const body = parse(z.object({ days: z.number().int() }).strict(), req.body);
        return setRetention(app.db, me(req), body.days, app.config.mode, app.cipher);
      });

      // ---- Super-Modules
      api.get('/modules', async () => app.modules.list());
      // Delete = archive: every version of the module, kept for history; refused while a Flow uses it.
      api.delete<{ Params: { name: string } }>('/modules/by-name/:name', async (req, reply) => {
        await archiveModule(app.db, req.params.name, me(req));
        return reply.status(204).send();
      });
      api.post<{ Params: { name: string } }>('/modules/by-name/:name/restore', async (req, reply) => {
        await restoreModule(app.db, req.params.name, me(req));
        return reply.status(204).send();
      });
      api.post('/modules/generate', async (req, reply) => {
        const body = parse(z.object({ request: z.string(), source: apiSourceSchema.optional(), answers: answersSchema.optional() }).strict(), req.body);
        const out = await tracked(app, { memberId: me(req).id, kind: 'module', source: 'chat', title: body.request }, () => app.moduleChat.generate(body.request, me(req), body.source, body.answers));
        // Questions first: nothing is built until every question has an answer (needsPerson).
        if ('questions' in out) return reply.status(200).send({ needsAnswers: true, classification: out.questions });
        return reply.status(201).send(await app.modules.review(out.draft.id));
      });
      api.post('/modules/import-playwright', async (req, reply) => {
        const body = parse(
          z
            .object({
              name: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'lowercase letters, digits and dashes'),
              title: z.string().min(1).max(80),
              script: z.string().min(1).max(100_000),
              hosts: z.array(z.string().max(253)).max(20).optional(),
            })
            .strict(),
          req.body,
        );
        const draft = await app.modules.createDraft({ ...playwrightToModule(body), origin: 'script' }, me(req));
        return reply.status(201).send(await app.modules.review(draft.id));
      });
      // A Flow needs an action an approved module does not have: draft a new version of that module with it.
      api.post<{ Params: { name: string } }>('/modules/by-name/:name/extend', async (req, reply) => {
        const body = parse(z.object({ request: z.string().trim().min(1).max(2000) }).strict(), req.body);
        const name = parse(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), req.params.name);
        const mv = await tracked(app, { memberId: me(req).id, kind: 'module', source: 'extend', title: `${name}: ${body.request}` }, () => app.moduleChat.extend(name, body.request, me(req)));
        return reply.status(201).send(await app.modules.review(mv.id));
      });
      api.post<{ Params: { id: string } }>('/modules/:id/revise', async (req, reply) => {
        const body = parse(z.object({ feedback: z.string(), forRun: uuid.optional() }).strict(), req.body);
        const id = parse(uuid, req.params.id);
        // From a stopped run: once the fix is approved, the run's Flow gets a version that uses it (src/modules/run-fix.ts).
        const fromRef = body.forRun ? await app.engine.runFixTarget(body.forRun, id, me(req)) : null;
        if (!body.forRun || !fromRef) {
          const ref = (await app.db.query<{ name: string }>(`SELECT name FROM module_versions WHERE id = $1`, [id])).rows[0]?.name ?? 'module';
          const mv = await tracked(app, { memberId: me(req).id, kind: 'module', source: 'revise', title: `${ref}: ${body.feedback}`, link: `/modules/${id}` }, () => app.moduleChat.revise(id, body.feedback, me(req)));
          return reply.status(201).send(await app.modules.review(mv.id));
        }
        // Drafted from a stopped run: what the AI does is said in the run's commentary (the Live panel and the run page).
        const say = narrator(app.db, app.cipher, body.forRun, null);
        const name = fromRef.slice(0, fromRef.lastIndexOf('@'));
        say.say(`The AI is drafting a fixed version of ${name} (${fromRef})`);
        let mv;
        try {
          mv = await tracked(
            app,
            { memberId: me(req).id, kind: 'module', source: 'run_fix', title: `Fix ${name} for a run`, link: `/runs/${body.forRun}` },
            () => app.moduleChat.revise(id, body.feedback, me(req)),
            (p) => say.say(`AI fixing ${name}: ${p.detail ?? `${p.step} (${p.percent}%)`}`),
          );
        } catch (err) {
          say.say(`The AI could not draft a fix for ${name}: ${err instanceof AppError ? err.code.replace(/_/g, ' ') : 'unexpected error'}`);
          await say.flush();
          throw err;
        }
        await markRunFix(app.db, mv.id, body.forRun, fromRef);
        say.say(`Fixed version ${name}@${mv.version} drafted${mv.validationReport?.passed ? '' : ' (its tests do not pass yet)'}: an admin reviews it on its module page; once approved, this Flow gets a new version that uses it`);
        await say.flush();
        return reply.status(201).send(await app.modules.review(mv.id));
      });
      api.get<{ Params: { id: string } }>('/modules/:id/review', async (req) => {
        const review = await app.modules.review(parse(uuid, req.params.id));
        // The Flows that use this module (any version), newest version each: only those of the person's teams (admins: all).
        const actor = me(req);
        const name = review.ref.slice(0, review.ref.lastIndexOf('@'));
        const teams = actor.role === 'admin' ? null : await memberTeamIds(app.db, actor.id);
        const { rows } = await app.db.query<{ flow_id: string; name: string; version: number; status: string; definition: unknown }>(
          `SELECT DISTINCT ON (f.id) f.id AS flow_id, f.name, v.version, v.status, v.definition
           FROM flows f JOIN flow_versions v ON v.flow_id = f.id
           WHERE f.archived_at IS NULL AND strpos(v.definition::text, $1) > 0 AND ($2::uuid[] IS NULL OR f.team_id = ANY($2))
           ORDER BY f.id, v.version DESC LIMIT 50`,
          [`"${name}@`, teams],
        );
        const usedBy = rows
          .map((r) => ({ flowId: r.flow_id, name: r.name, version: r.version, status: r.status, uses: (JSON.stringify(r.definition).match(new RegExp(`"(${name.replace(/[-]/g, '\\-')}@[0-9.]+)"`)) ?? [])[1] ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { ...review, usedBy };
      });
      api.post<{ Params: { id: string } }>('/modules/:id/submit', async (req, reply) => {
        await app.modules.submit(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string } }>('/modules/:id/decision', async (req, reply) => {
        const { decision } = parse(decisionBody, req.body);
        const id = parse(uuid, req.params.id);
        const mv = await app.modules.get(app.db, id);
        await app.modules.decide(id, me(req), decision);
        // What an approver decided, kept with the module: a later draft is told it, and cannot quietly undo it.
        if (mv) await journal(app.db, app.cipher, { type: 'module', id: mv.name }, { kind: 'decision', origin: 'approved', text: `Version ${mv.version} was ${decision}.`, versionRef: mv.version, by: me(req).id });
        return reply.status(204).send();
      });

      // ---- Flows
      api.post('/flows', async (req, reply) => {
        const body = parse(z.object({ name: z.string(), definition: z.unknown(), teamId: uuid.optional() }).strict(), req.body);
        return reply.status(201).send(await app.flows.create(body.name, body.definition, me(req), undefined, body.teamId));
      });
      api.put<{ Params: { id: string } }>('/flows/:id', async (req, reply) => {
        const body = parse(z.object({ definition: z.unknown() }).strict(), req.body);
        return reply.status(201).send(await app.flows.update(parse(uuid, req.params.id), body.definition, me(req)));
      });
      api.get('/catalog', async () => app.flowChat.catalog());
      api.post('/flows/generate', async (req, reply) => {
        const body = parse(
          z.object({ request: z.string(), answers: answersSchema.optional(), teamId: uuid.optional(), module: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(), leaveOut: z.array(z.string().trim().min(1).max(300)).max(5).optional() }).strict(),
          req.body,
        );
        const out = await tracked(app, { memberId: me(req).id, kind: 'flow', source: 'chat', title: body.request }, () => app.flowChat.draft(body.request, me(req), body.answers, body.teamId, body.module, body.leaveOut));
        if ('questions' in out) return reply.status(200).send({ needsAnswers: true, classification: out.questions });
        // Not an error: the person picks what to do (add the action to a module, build one, or draft without it).
        if ('cannotDraft' in out) return reply.status(200).send({ cannotDraft: true, ...out.cannotDraft });
        return reply.status(201).send({ ...(await app.flows.review(out.version.id)), explanation: out.explanation });
      });
      api.post<{ Params: { id: string } }>('/flows/:id/revise', async (req, reply) => {
        const body = parse(z.object({ feedback: z.string() }).strict(), req.body);
        const flowId = parse(uuid, req.params.id);
        const { version, explanation } = await tracked(app, { memberId: me(req).id, kind: 'flow', source: 'revise', title: body.feedback, link: `/flows/${flowId}` }, () => app.flowChat.revise(flowId, body.feedback, me(req)));
        return reply.status(201).send({ ...(await app.flows.review(version.id)), explanation });
      });
      /** "Draft it again": the same Flow written once more, on the newest modules and against Dittoly's review. */
      api.post<{ Params: { id: string } }>('/flows/:id/redraft', async (req, reply) => {
        const flowId = parse(uuid, req.params.id);
        const { version, explanation } = await tracked(
          app,
          { memberId: me(req).id, kind: 'flow', source: 'revise', title: 'Draft it again', link: `/flows/${flowId}` },
          () => app.flowChat.redraftNow(flowId, me(req)),
        );
        return reply.status(201).send({ ...(await app.flows.review(version.id)), explanation });
      });

      /**
       * Move this Flow to the newest approved version of the modules named (all of them when none are): a new
       * version its approvers decide on, like any change. The approved one keeps running until then.
       */
      api.post<{ Params: { id: string }; Body: unknown }>('/flows/:id/update-modules', async (req, reply) => {
        const flowId = parse(uuid, req.params.id);
        const body = parse(z.object({ modules: z.array(z.string().min(1).max(100)).max(50).optional() }).strict(), req.body ?? {});
        const out = await updateModules({ db: app.db, flows: app.flows, flowTests: app.flowTests, flowChat: app.flowChat }, flowId, me(req), body.modules);
        return reply.status(201).send({ versionId: out.version.id, version: out.version.version, updated: out.updated, tests: out.tests, redrafted: out.redrafted });
      });

      api.get<{ Params: { versionId: string } }>('/flow-versions/:versionId/review', async (req) => {
        const versionId = parse(uuid, req.params.versionId);
        await app.flows.assertCanSee(app.db, me(req), { versionId });
        return {
          ...(await app.flows.review(versionId)),
          /** The organization's model now, and every switch of this version's pinned model. */
          modelPins: await app.modelChanges.pinView(versionId),
          /** What one run is expected to spend on AI, and its cap. */
          costForecast: await costForecast(app.db, app.flows, app.flowTests, versionId, app.aiModel),
          /** Apps of this Flow: which of their live pages this version breaks, and those pinned to another version. */
          appImpact: await (async () => {
            const v = await app.flows.getVersion(app.db, versionId);
            return v && app.flows.appImpact ? app.flows.appImpact(v.flowId, v.definition) : [];
          })(),
        };
      });
      api.get<{ Params: { id: string } }>('/flows/:id/versions', async (req) => {
        const flowId = parse(uuid, req.params.id);
        await app.flows.assertCanSee(app.db, me(req), { flowId });
        return app.flows.versions(flowId);
      });
      // Delete = archive (a Super Flow too): it never runs again, its history stays; refused while in use.
      api.delete<{ Params: { id: string } }>('/flows/:id', async (req, reply) => {
        const flowId = parse(uuid, req.params.id);
        await app.flows.assertCanSee(app.db, me(req), { flowId });
        await archiveFlow(app.db, flowId, me(req));
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string } }>('/flows/:id/restore', async (req, reply) => {
        await restoreFlow(app.db, parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });
      api.get<{ Params: { id: string } }>('/flows/:id/archived', async (req) => {
        const flowId = parse(uuid, req.params.id);
        await app.flows.assertCanSee(app.db, me(req), { flowId });
        const name = (await app.db.query<{ name: string }>(`SELECT name FROM flows WHERE id = $1`, [flowId])).rows[0]?.name ?? '';
        return { name, archived: await isFlowArchived(app.db, flowId) };
      });
      api.post<{ Params: { versionId: string } }>('/flow-versions/:versionId/decision', async (req) => {
        const { decision, accept, acceptAppBreaks } = parse(flowDecisionBody, req.body);
        const decided = await app.flows.decide(parse(uuid, req.params.versionId), me(req), decision, { ...(accept ? { accept } : {}), ...(acceptAppBreaks ? { acceptAppBreaks } : {}) });
        const team = (await app.db.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [decided.flowId])).rows[0]?.team_id;
        // An approver's decision, and what they accepted with it: a later draft is told, and cannot undo it quietly.
        const accepted = accept?.length ? ` Accepted: ${accept.map((a) => `${a.sink} (${a.reason})`).join('; ')}.` : '';
        await journal(app.db, app.cipher, { type: 'flow', id: decided.flowId, teamId: team }, { kind: 'decision', origin: 'approved', text: `Version ${decided.version} was ${decision}.${accepted}`, versionRef: `v${decided.version}`, by: me(req).id });
        return decided;
      });

      // ---- Runs
      api.post<{ Params: { versionId: string } }>('/flow-versions/:versionId/runs', async (req, reply) => {
        const body = parse(
          z.object({ inputs: z.record(z.string(), z.unknown()).default({}), dryRun: z.boolean().optional(), breakglassId: uuid.optional(), model: z.string().max(250).optional() }).strict(),
          req.body ?? {},
        );
        const actor = me(req);
        // Manual runs run as the member who starts them, or, under break-glass, as the person the grant names.
        const runAs = body.breakglassId ? await grantRunAs(app.db, actor, body.breakglassId) : actor.id;
        const runId = await app.engine.startRun(parse(uuid, req.params.versionId), runAs, body.inputs, {
          actorId: actor.id,
          dry: body.dryRun,
          breakglassId: body.breakglassId,
          aiModel: body.model,
        });
        return reply.status(202).send({ runId });
      });
      api.get('/runs/live', async (req) => app.engine.liveRuns(me(req)));
      api.get<{ Params: { id: string } }>('/runs/:id', async (req) => app.engine.runView(parse(uuid, req.params.id), me(req)));
      // ---- Undo: what a run changed that can be reversed, and reversals (asked by its person, signed off by an approver)
      api.get<{ Params: { id: string } }>('/runs/:id/undo', async (req) => {
        const id = parse(uuid, req.params.id);
        await app.engine.runView(id, me(req));
        return app.undo.forRun(id);
      });
      api.post('/reversals', async (req, reply) => reply.status(201).send(await app.undo.request(me(req), parse(reversalBody, req.body))));
      api.get<{ Params: { id: string } }>('/reversals/:id', async (req) => app.undo.get(me(req), parse(uuid, req.params.id)));
      api.post<{ Params: { id: string } }>('/reversals/:id/decision', async (req) =>
        app.undo.decide(me(req), parse(uuid, req.params.id), parse(z.object({ decision: z.enum(['approved', 'rejected']) }).strict(), req.body).decision),
      );
      api.get('/undo-window', async () => ({ days: await getUndoWindow(app.db) }));
      api.put('/undo-window', async (req) => ({ days: await setUndoWindow(app.db, me(req), parse(z.object({ days: z.number().int() }).strict(), req.body).days) }));
      // What this member can run, and whether they are ready to.
      api.get<{ Querystring: { team?: string } }>('/runnable', async (req) => runnableFlows(app, me(req), req.query.team ? parse(uuid, req.query.team) : undefined));
      // Live choices for a run-form field (an approved read action, run as the member).
      api.post<{ Params: { versionId: string } }>('/flow-versions/:versionId/choices', async (req) => {
        const body = parse(z.object({ field: z.string().max(64), values: z.record(z.string(), z.unknown()).default({}) }).strict(), req.body);
        return { choices: await app.engine.formChoices(parse(uuid, req.params.versionId), body.field, body.values, me(req)) };
      });
      // Input steps: live choices, and the member's answers.
      api.post<{ Params: { id: string; stepId: string } }>('/runs/:id/steps/:stepId/choices', async (req) => {
        const body = parse(z.object({ field: z.string().max(64) }).strict(), req.body);
        return { choices: await app.engine.inputChoices(parse(uuid, req.params.id), req.params.stepId, body.field, me(req)) };
      });
      api.post<{ Params: { id: string; stepId: string } }>('/runs/:id/steps/:stepId/input', async (req, reply) => {
        const body = parse(z.object({ values: z.record(z.string(), z.unknown()) }).strict(), req.body);
        await app.engine.submitInput(parse(uuid, req.params.id), req.params.stepId, me(req), body.values);
        return reply.status(202).send();
      });
      api.post<{ Params: { id: string } }>('/runs/:id/retry', async (req, reply) => {
        await app.engine.retry(parse(uuid, req.params.id), me(req));
        return reply.status(202).send();
      });
      // Get past a failed step without retrying it: skip it, or continue with a result typed in (read steps at once;
      // steps that change data wait for an approver, who decides with /resolution).
      api.post<{ Params: { id: string; stepId: string } }>('/runs/:id/steps/:stepId/resolve', async (req, reply) => {
        const body = parse(z.discriminatedUnion('kind', [z.object({ kind: z.literal('skip') }).strict(), z.object({ kind: z.literal('result'), output: z.unknown() }).strict()]), req.body);
        const out = await app.engine.resolveStep(parse(uuid, req.params.id), req.params.stepId, me(req), body.kind === 'skip' ? { kind: 'skip' } : { kind: 'result', output: body.output ?? null });
        return reply.status(202).send(out);
      });
      api.post<{ Params: { id: string; stepId: string } }>('/runs/:id/steps/:stepId/resolution', async (req, reply) => {
        const { decision } = parse(z.object({ decision: z.enum(['approved', 'rejected']) }).strict(), req.body);
        await app.engine.decideResolution(parse(uuid, req.params.id), req.params.stepId, me(req), decision);
        return reply.status(202).send();
      });
      // A paused run goes on with the newest approved version of its Flow (or starts again there): the run that goes on.
      api.post<{ Params: { id: string } }>('/runs/:id/continue', async (req, reply) => {
        return reply.status(202).send(await app.engine.continueOnNewest(parse(uuid, req.params.id), me(req)));
      });
      api.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
        await app.engine.cancel(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string; stepId: string } }>('/runs/:id/steps/:stepId/gate', async (req, reply) => {
        const { decision, valuesSha256 } = parse(decisionBody, req.body);
        await app.engine.decideGate(parse(uuid, req.params.id), req.params.stepId, me(req), decision, valuesSha256);
        return reply.status(202).send();
      });
      api.post<{ Params: { id: string; stepId: string } }>('/runs/:id/steps/:stepId/delegate', async (req, reply) => {
        const body = parse(z.object({ delegateId: uuid }).strict(), req.body);
        const id = await app.engine.requestDelegation(parse(uuid, req.params.id), req.params.stepId, me(req), body.delegateId);
        return reply.status(201).send({ delegationId: id });
      });

      // ---- Delegation
      api.get('/delegations', async (req) => app.engine.listDelegations(me(req)));
      api.get<{ Params: { id: string } }>('/delegations/:id', async (req) => app.engine.delegationDetails(parse(uuid, req.params.id), me(req)));
      api.post<{ Params: { id: string } }>('/delegations/:id/decision', async (req, reply) => {
        const { decision } = parse(decisionBody, req.body);
        await app.engine.decideDelegation(parse(uuid, req.params.id), me(req), decision);
        return reply.status(202).send();
      });

      api.post<{ Params: { id: string } }>('/delegations/:id/reassign', async (req, reply) => {
        const body = parse(z.object({ delegateId: uuid }).strict(), req.body);
        const id = await app.engine.reassignDelegation(parse(uuid, req.params.id), me(req), body.delegateId);
        return reply.status(201).send({ delegationId: id });
      });
      api.post<{ Params: { id: string } }>('/delegations/:id/cancel', async (req, reply) => {
        await app.engine.cancelDelegation(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });

      // ---- Git sync: approved modules, Flows and apps written to a connected repository (src/git-sync/service.ts)
      api.get<{ Querystring: { team?: string } }>('/git-connection', async (req) => app.gitSync.get(me(req), req.query.team ? parse(uuid, req.query.team) : null));
      api.put('/git-connection', async (req) => app.gitSync.save(me(req), req.body));
      api.delete<{ Params: { id: string } }>('/git-connections/:id', async (req, reply) => {
        await app.gitSync.remove(me(req), parse(uuid, req.params.id));
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string } }>('/git-connections/:id/export-all', async (req, reply) => reply.status(202).send(await app.gitSync.exportAll(me(req), parse(uuid, req.params.id))));
      api.post<{ Params: { id: string } }>('/git-connections/:id/sync', async (req, reply) => {
        await app.gitSync.syncNow(me(req), parse(uuid, req.params.id));
        return reply.status(202).send();
      });
      api.post<{ Params: { id: string } }>('/git-exports/:id/retry', async (req, reply) => {
        await app.gitSync.retry(me(req), parse(uuid, req.params.id));
        return reply.status(202).send();
      });

      // ---- Background work that failed every attempt (src/engine/jobs.ts): admins see it and retry it.
      api.get('/jobs/queue', async (req) => {
        if (me(req).role !== 'admin') throw forbidden('admin_only');
        // With the code sandboxes: in use, and runs waiting for one.
        return { ...(await queueStats(app.db)), sandboxes: await slotUse(app.db, app.config.codeSandboxes ?? 1) };
      });
      api.get('/jobs/exhausted', async (req) => {
        if (me(req).role !== 'admin') throw forbidden('admin_only');
        return exhaustedJobs(app.db);
      });
      api.post<{ Params: { id: string } }>('/jobs/:id/retry', async (req, reply) => {
        await retryJob(app.db, me(req), req.params.id);
        return reply.status(202).send();
      });

      // ---- Apps: pages over a team's Flows, opened inside Dittoly (src/team-apps/service.ts)
      api.get<{ Querystring: { team?: string } }>('/apps', async (req) => listApps(app, me(req), req.query.team ? parse(uuid, req.query.team) : undefined));
      api.post('/apps', async (req, reply) => reply.status(201).send(await createApp(app, me(req), req.body)));
      api.post('/apps/layout', async (req) => draftLayout(app, me(req), req.body));
      api.get<{ Params: { id: string } }>('/apps/:id', async (req) => getApp(app, me(req), parse(uuid, req.params.id)));
      api.post<{ Params: { id: string } }>('/apps/:id/versions', async (req, reply) => reply.status(201).send(await updateApp(app, me(req), parse(uuid, req.params.id), req.body)));
      api.delete<{ Params: { id: string } }>('/apps/:id', async (req, reply) => {
        await archiveApp(app, me(req), parse(uuid, req.params.id));
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string } }>('/app-versions/:id/decision', async (req, reply) => {
        await decideApp(app, me(req), parse(uuid, req.params.id), parse(decisionBody, req.body).decision);
        return reply.status(204).send();
      });
      // The API an app's pages call (the same one an exported app serves), for its live version or a preview.
      type AppParams = { appId: string; ver: string };
      const opened = (req: { params: AppParams }, m: Member) => openApp(app, m, parse(uuid, req.params.appId), req.params.ver);
      api.get<{ Params: AppParams }>('/apps/:appId/v/:ver/api/app', async (req) => appInfo(app, await opened(req, me(req))));
      api.get<{ Params: AppParams }>('/apps/:appId/v/:ver/theme.css', async (req, reply) => {
        const info = await appInfo(app, await opened(req, me(req)));
        return reply.type('text/css').send(themeCss(info.theme));
      });
      api.post<{ Params: AppParams & { key: string }; Querystring: { wait?: string } }>('/apps/:appId/v/:ver/api/flows/:key/runs', async (req, reply) => {
        const body = parse(z.object({ inputs: z.record(z.string(), z.unknown()).default({}) }).strict(), req.body ?? {});
        const m = me(req);
        return reply.status(201).send(await startAppRun(app, m, await opened(req, m), req.params.key, body.inputs, Number(req.query.wait ?? 0) || 0));
      });
      api.get<{ Params: AppParams; Querystring: { flow?: string; limit?: string } }>('/apps/:appId/v/:ver/api/runs', async (req) =>
        appRuns(app, await opened(req, me(req)), req.query.flow, Number(req.query.limit ?? 20) || 20),
      );
      api.get<{ Params: AppParams & { runId: string } }>('/apps/:appId/v/:ver/api/runs/:runId', async (req) => {
        const m = me(req);
        return appRun(app, m, await opened(req, m), parse(uuid, req.params.runId));
      });
      api.get<{ Params: AppParams }>('/apps/:appId/v/:ver/api/inbox', async (req) => {
        const m = me(req);
        return appInbox(app, m, await opened(req, m));
      });
      api.post<{ Params: AppParams & { runId: string; stepId: string } }>('/apps/:appId/v/:ver/api/runs/:runId/steps/:stepId/decision', async (req, reply) => {
        const m = me(req);
        const body = parse(decisionBody, req.body);
        await decideAppStep(app, m, await opened(req, m), parse(uuid, req.params.runId), req.params.stepId, body.decision, body.valuesSha256);
        return reply.status(204).send();
      });
      api.post<{ Params: AppParams & { runId: string; stepId: string } }>('/apps/:appId/v/:ver/api/runs/:runId/steps/:stepId/input', async (req, reply) => {
        const m = me(req);
        const body = parse(z.object({ values: z.record(z.string(), z.unknown()) }).strict(), req.body);
        await answerAppStep(app, m, await opened(req, m), parse(uuid, req.params.runId), req.params.stepId, body.values);
        return reply.status(204).send();
      });

      // ---- Portal lists
      api.get<{ Querystring: { team?: string; archived?: string; kind?: string } }>('/flows', async (req) =>
        listFlows(
          app.db,
          me(req),
          req.query.team ? parse(uuid, req.query.team) : undefined,
          req.query.archived === 'true',
          req.query.kind ? parse(z.enum(['super', 'flow']), req.query.kind) : undefined,
        ),
      );

      // ---- Teams
      api.get('/teams', async (req) => listTeams(app.db, me(req)));
      /** What this team already answered while drafting, which later drafts are given instead of asking again. */
      api.get<{ Params: { id: string } }>('/teams/:id/decisions', async (req) => {
        const teamId = parse(uuid, req.params.id);
        await assertMaySeeDecisions(app.db, me(req), teamId);
        const { decisions, unreadable } = await teamDecisions(app.db, app.cipher, teamId);
        // Never a silent gap: the team sees that some answers cannot be read with the key in use.
        return { decisions, unreadable };
      });
      api.delete<{ Params: { id: string; decisionId: string } }>('/teams/:id/decisions/:decisionId', async (req, reply) => {
        await forgetDecision(app.db, me(req), parse(uuid, req.params.id), parse(uuid, req.params.decisionId));
        return reply.status(204).send();
      });
      /** How a Flow or a module came to be what it is: what was asked for, decided, and found (src/ai/build-memory.ts). */
      api.get<{ Params: { type: string; id: string } }>('/journal/:type/:id', async (req) => {
        const artifact = { type: parse(z.enum(['module', 'flow']), req.params.type), id: req.params.id.slice(0, 200) };
        await assertMayReadJournal(app.db, me(req), artifact);
        // Never a silent gap: entries this key cannot read are counted, not dropped.
        return journalOf(app.db, app.cipher, artifact);
      });
      /** Corrected without being rewritten: it stops being given to drafts and stays where it is. */
      api.post<{ Params: { type: string; id: string; entryId: string } }>('/journal/:type/:id/:entryId/supersede', async (req, reply) => {
        const artifact = { type: parse(z.enum(['module', 'flow']), req.params.type), id: req.params.id.slice(0, 200) };
        await supersedeEntry(app.db, me(req), artifact, parse(uuid, req.params.entryId));
        return reply.status(204).send();
      });
      api.delete<{ Params: { type: string; id: string; entryId: string } }>('/journal/:type/:id/:entryId', async (req, reply) => {
        const artifact = { type: parse(z.enum(['module', 'flow']), req.params.type), id: req.params.id.slice(0, 200) };
        await deleteEntry(app.db, me(req), artifact, parse(uuid, req.params.entryId));
        return reply.status(204).send();
      });
      api.put<{ Params: { id: string } }>('/teams/:id/run-limit', async (req, reply) => {
        const body = parse(z.object({ runLimit: z.number().int().min(1).max(100).nullable() }).strict(), req.body);
        await setRunLimit(app.db, me(req), parse(uuid, req.params.id), body.runLimit);
        return reply.status(204).send();
      });
      api.post('/teams', async (req, reply) => {
        const body = parse(z.object({ name: z.string().max(60) }).strict(), req.body);
        return reply.status(201).send(await createTeam(app.db, me(req), body.name));
      });
      api.patch<{ Params: { id: string } }>('/teams/:id', async (req, reply) => {
        const body = parse(z.object({ name: z.string().max(60) }).strict(), req.body);
        await renameTeam(app.db, me(req), parse(uuid, req.params.id), body.name);
        return reply.status(204).send();
      });
      api.get<{ Params: { id: string } }>('/teams/:id/members', async (req) => teamMembers(app.db, me(req), parse(uuid, req.params.id)));
      api.put<{ Params: { id: string; memberId: string } }>('/teams/:id/members/:memberId', async (req, reply) => {
        const body = parse(z.object({ role: z.enum(['admin', 'member']) }).strict(), req.body);
        await setTeamMember(app.db, me(req), parse(uuid, req.params.id), parse(uuid, req.params.memberId), body.role);
        return reply.status(204).send();
      });
      // Team credentials: whose access each module credential uses in the team, and the shared secrets.
      api.get<{ Params: { id: string } }>('/teams/:id/credentials', async (req) => listTeamCredentials(app.db, me(req), parse(uuid, req.params.id)));
      api.put<{ Params: { id: string } }>('/teams/:id/credential-modes', async (req, reply) => {
        const body = parse(z.object({ module: moduleName, service: z.string().max(40), mode: z.enum(['personal', 'team']) }).strict(), req.body);
        await setCredentialMode(app.db, me(req), parse(uuid, req.params.id), body.module, body.service, body.mode);
        return reply.status(204).send();
      });
      api.put<{ Params: { id: string; service: string } }>('/teams/:id/credentials/:service', async (req, reply) => {
        const body = parse(z.object({ secret: z.string().min(1).max(10_000) }).strict(), req.body);
        const teamId = parse(uuid, req.params.id);
        await putTeamCredential(app.db, app.cipher, me(req), teamId, req.params.service, body.secret);
        await app.scopes.checkTeam(teamId, req.params.service, body.secret);
        return reply.status(204).send();
      });
      api.delete<{ Params: { id: string; service: string } }>('/teams/:id/credentials/:service', async (req, reply) => {
        await removeTeamCredential(app.db, me(req), parse(uuid, req.params.id), req.params.service);
        return reply.status(204).send();
      });
      // Team notification channels (module actions run with the team's credentials).
      api.get<{ Params: { id: string } }>('/teams/:id/channels', async (req) => app.teamChannels.list(me(req), parse(uuid, req.params.id)));
      api.post<{ Params: { id: string } }>('/teams/:id/channels', async (req, reply) => {
        const body = parse(z.object({ name: z.string(), module: z.string().max(80), action: z.string().max(64), input: z.record(z.string(), z.unknown()) }).strict(), req.body);
        return reply.status(201).send(await app.teamChannels.create(me(req), parse(uuid, req.params.id), body));
      });
      api.patch<{ Params: { id: string; channelId: string } }>('/teams/:id/channels/:channelId', async (req, reply) => {
        const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
        await app.teamChannels.setEnabled(me(req), parse(uuid, req.params.id), parse(uuid, req.params.channelId), body.enabled);
        return reply.status(204).send();
      });
      api.delete<{ Params: { id: string; channelId: string } }>('/teams/:id/channels/:channelId', async (req, reply) => {
        await app.teamChannels.remove(me(req), parse(uuid, req.params.id), parse(uuid, req.params.channelId));
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string; channelId: string } }>('/teams/:id/channels/:channelId/test', async (req, reply) => {
        await app.teamChannels.test(me(req), parse(uuid, req.params.id), parse(uuid, req.params.channelId), app.config.publicUrl);
        return reply.status(204).send();
      });
      api.delete<{ Params: { id: string; memberId: string } }>('/teams/:id/members/:memberId', async (req, reply) => {
        await removeTeamMember(app.db, me(req), parse(uuid, req.params.id), parse(uuid, req.params.memberId));
        return reply.status(204).send();
      });
      api.get<{ Querystring: { limit?: string } }>('/runs', async (req) => listRuns(app.db, me(req), Number(req.query.limit ?? 50)));
      api.get('/approvals', async (req) => approvalQueue(app.db, me(req), app.config.mode));
      api.get('/schedules/mine', async (req) => app.scheduler.list(me(req)));

      // ---- Custom views (display only)
      api.get<{ Params: { page: string } }>('/views/:page', async (req) => app.views.get(me(req), req.params.page));
      api.put<{ Params: { page: string } }>('/views/:page', async (req) => app.views.set(me(req), req.params.page, req.body));
      api.delete<{ Params: { page: string } }>('/views/:page', async (req) => app.views.reset(me(req), req.params.page));
      api.post<{ Params: { page: string } }>('/views/:page/chat', async (req) => {
        const body = parse(z.object({ request: z.string() }).strict(), req.body);
        return app.views.chat(me(req), req.params.page, body.request);
      });

      // ---- MCP import: a remote MCP server becomes a draft module for admin review
      api.post('/mcp/import', async (req, reply) => {
        const mv = await app.mcp.import(req.body, me(req));
        return reply.status(201).send(await app.modules.review(mv.id));
      });

      // ---- MCP OAuth: connect your own account to an MCP server
      api.post('/mcp/oauth/start', async (req) => {
        const body = parse(z.object({ url: z.string().url(), service: z.string(), returnTo: z.string().optional() }).strict(), req.body);
        return app.mcpOAuth.start(me(req), body);
      });
      api.get('/mcp/oauth/connections', async (req) => app.mcpOAuth.connections(me(req).id));

      // ---- Marketplace (this organization only)
      api.get<{ Querystring: { kind?: string; q?: string; tag?: string } }>('/marketplace', async (req) => app.marketplace.list(req.query));
      api.get('/marketplace/tags', async () => app.marketplace.tags());
      api.get<{ Querystring: { moduleVersionId?: string; flowVersionId?: string } }>('/marketplace/tag-suggestions', async (req) => {
        if (req.query.flowVersionId) await app.flows.assertCanSee(app.db, me(req), { versionId: parse(uuid, req.query.flowVersionId) });
        return {
        tags: await app.marketplace.suggestTags({
          moduleVersionId: req.query.moduleVersionId ? parse(uuid, req.query.moduleVersionId) : undefined,
          flowVersionId: req.query.flowVersionId ? parse(uuid, req.query.flowVersionId) : undefined,
        }),
        };
      });
      api.post('/marketplace/tag-suggestions/ai', async (req) => {
        const body = parse(z.object({ title: z.string().min(1).max(120), summary: z.string().max(1000).default('') }).strict(), req.body);
        return { tags: await app.marketplace.suggestTagsWithAi(me(req), body.title, body.summary) };
      });
      api.get<{ Params: { id: string } }>('/marketplace/:id', async (req) => app.marketplace.details(parse(uuid, req.params.id)));
      api.post('/marketplace/modules', async (req, reply) => reply.status(201).send(await app.marketplace.publishModule(req.body, me(req))));
      api.post('/marketplace/templates', async (req, reply) => reply.status(201).send(await app.marketplace.publishTemplate(req.body, me(req))));
      api.post<{ Params: { id: string } }>('/marketplace/:id/deprecate', async (req, reply) => {
        await app.marketplace.deprecate(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string } }>('/marketplace/:id/use', async (req, reply) => {
        const body = parse(z.object({ name: z.string().max(120).optional() }).strict(), req.body ?? {});
        const v = await app.marketplace.useTemplate(parse(uuid, req.params.id), me(req), body.name);
        return reply.status(201).send(await app.flows.review(v.id));
      });
      api.get<{ Params: { versionId: string } }>('/flow-versions/:versionId/upgrades', async (req) => {
        const versionId = parse(uuid, req.params.versionId);
        await app.flows.assertCanSee(app.db, me(req), { versionId });
        return app.marketplace.upgradesFor(versionId);
      });

      // ---- Schedules
      // ---- App steps: may project code run directly on this machine when Docker is missing? (local installs, admin)
      api.get('/settings/app-runner', async () => ({ mode: await app.apps.modeFor(), directAllowed: await getDirectCode(app.db), localInstall: app.config.mode === 'local' }));
      api.put('/settings/app-runner', async (req) => {
        const { directAllowed } = parse(z.object({ directAllowed: z.boolean() }).strict(), req.body);
        await setDirectCode(app.db, me(req), directAllowed, app.config.mode);
        return { mode: await app.apps.modeFor(), directAllowed, localInstall: app.config.mode === 'local' };
      });

      // ---- Outside destinations app and fix steps may declare: the organization's list, and each team's narrower one.
      api.get('/settings/egress', async () => ({ destinations: await orgEgress(app.db) }));
      api.put('/settings/egress', async (req) => {
        const { destinations } = parse(z.object({ destinations: z.array(z.string().max(260)).max(100) }).strict(), req.body);
        return { destinations: await setOrgEgress(app.db, me(req), destinations) };
      });
      api.get<{ Params: { id: string } }>('/teams/:id/egress', async (req) => {
        const teamId = parse(uuid, req.params.id);
        await assertTeamMember(app.db, teamId, me(req));
        return { organization: await orgEgress(app.db), team: await teamEgress(app.db, teamId), effective: (await egressCeiling(app.db, teamId)).map((d) => d.text) };
      });
      api.put<{ Params: { id: string } }>('/teams/:id/egress', async (req) => {
        const { destinations } = parse(z.object({ destinations: z.array(z.string().max(260)).max(100).nullable() }).strict(), req.body);
        const teamId = parse(uuid, req.params.id);
        return { team: await setTeamEgress(app.db, me(req), teamId, destinations), effective: (await egressCeiling(app.db, teamId)).map((d) => d.text) };
      });

      // ---- Live browser: watch a browser step, take over when it asks, or open a page yourself
      api.get<{ Querystring: { run?: string } }>('/live', async (req) =>
        req.query.run ? app.live.forRun(parse(uuid, req.query.run), me(req)) : app.live.mine(me(req)),
      );
      api.get<{ Params: { id: string } }>('/live/:id/stream', async (req, reply) => {
        const id = parse(uuid, req.params.id);
        const member = me(req);
        // Server-Sent Events: frames (JPEG) and state changes, until the session ends or the viewer leaves.
        app.live.assertOwner(id, member);
        const raw = reply.raw;
        reply.hijack();
        raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        raw.flushHeaders();
        const unsubscribe = app.live.subscribe(id, member, (e) => {
          raw.write(`data: ${JSON.stringify(e)}\n\n`);
          if (e.type === 'state' && e.closed) raw.end();
        });
        const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
        req.raw.on('close', () => {
          clearInterval(ping);
          unsubscribe();
        });
      });
      api.post<{ Params: { id: string } }>('/live/:id/input', async (req) => ({ result: await app.live.input(parse(uuid, req.params.id), me(req), (req.body ?? {}) as Record<string, unknown>) }));
      api.post<{ Params: { id: string } }>('/live/:id/continue', async (req, reply) => {
        app.live.continue(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });
      // The sites the Dittoly Browser opens: those of approved browser modules, and the ones an admin added.
      const browserSites = async () => {
        const fromModules = (await embeddable(app.db, app.config.insecureHttpHosts)).pages.map((o) => o.slice(o.indexOf('://') + 3));
        return { fromModules, added: await getBrowserSites(app.db) };
      };
      api.get('/browser-sites', async () => browserSites());
      api.put('/browser-sites', async (req) => {
        const body = parse(z.object({ hosts: z.array(z.string().max(255)).max(100) }).strict(), req.body);
        return { added: await setBrowserSites(app.db, me(req), body.hosts) };
      });
      api.post('/live', async (req, reply) => {
        const { url } = parse(z.object({ url: z.string().url().max(2000) }).strict(), req.body);
        const sites = await browserSites();
        const hosts = [...new Set([...sites.fromModules, ...sites.added])];
        return reply.status(201).send(await app.live.open(me(req), url, app.browser, { hosts, plainHttp: app.config.insecureHttpHosts, allowPrivate: app.config.internalHosts }));
      });
      api.post<{ Params: { id: string } }>('/live/:id/screenshot', async (req) => ({ screenshot: await app.live.screenshot(parse(uuid, req.params.id), me(req)) }));
      api.delete<{ Params: { id: string } }>('/live/:id', async (req, reply) => {
        await app.live.close(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });

      // ---- Plans: upload a PDF; the AI asks what it needs, then drafts modules and Flows for review
      api.get('/plans', async (req) => app.plans.list(me(req)));
      // The live build panel: what the AI is drafting for this person now.
      // The Live panel: the member's plan items, then their other AI builds (src/core/builds.ts) in the same shape.
      api.get('/builds/live', async (req) => {
        const actor = me(req);
        const others = (await currentBuilds(app.db, app.cipher, actor.id, false)).map((b) => ({
          itemId: `build:${b.id}`,
          planId: null,
          planTitle: null,
          kind: b.kind,
          title: b.title,
          status: 'drafting',
          progress: b.progress ? { step: b.progress.step, percent: b.progress.percent, since: b.progress.since, detail: b.progress.detail, detailAt: b.progress.detailAt } : { step: 'starting', percent: 0, since: b.startedAt },
          moduleVersionId: null,
          flowVersionId: null,
          updatedAt: b.startedAt,
          link: b.link,
        }));
        return [...others, ...(await app.plans.live(actor))];
      });
      // The Builds page: every module, Flow and Super Flow the AI is building now; admins and approvers may see everyone's.
      api.get<{ Querystring: { scope?: string } }>('/builds', async (req) => {
        const actor = me(req);
        const all = req.query.scope === 'all';
        if (all && !canApprove(actor)) throw forbidden('approver_only');
        const plan = (await app.plans.live(actor, { all, activeOnly: true })).map((i) => ({
          id: `plan:${i.itemId}`,
          kind: i.kind,
          source: 'plan' as const,
          title: i.title,
          by: i.by,
          status: i.status,
          // Straight to this part of the plan: its progress, what it waits for, and why it stopped.
          link: `/plans/${i.planId}#item-${i.itemId}`,
          planTitle: i.planTitle,
          progress: i.progress,
        }));
        const others = (await currentBuilds(app.db, app.cipher, actor.id, all)).map((b) => ({ ...b, status: 'drafting', planTitle: null }));
        return { all, builds: [...others, ...plan] };
      });
      // A 10 MB PDF is about 13.4 MB as base64.
      api.post('/plans', { bodyLimit: 15_000_000 }, async (req, reply) => {
        const body = parse(
          z
            .object({
              fileName: z.string().min(1).max(255),
              pdfBase64: z.string().min(1).max(14_000_000),
              title: z.string().max(120).optional(),
              teamId: uuid.optional(),
            })
            .strict(),
          req.body,
        );
        const pdf = Buffer.from(body.pdfBase64, 'base64');
        return reply.status(201).send(await app.plans.upload(me(req), { fileName: body.fileName, pdf, title: body.title, teamId: body.teamId }));
      });
      // The home chat: one turn (kept with the chat for its owner and team), "Build it", and the chats kept.
      api.post('/chat/plan', async (req) => {
        const body = parse(z.object({ chatId: uuid.optional(), message: z.string().trim().min(1).max(4000), teamId: uuid.optional() }).strict(), req.body);
        return app.plans.chat(me(req), body);
      });
      api.post('/plans/from-chat', async (req, reply) => {
        const body = parse(z.object({ chatId: uuid }).strict(), req.body);
        return reply.status(201).send(await app.plans.fromChat(me(req), body));
      });
      api.get<{ Querystring: { teamId?: string } }>('/chats', async (req) => app.plans.chats.list(me(req), req.query.teamId ? parse(uuid, req.query.teamId) : undefined));
      api.get<{ Params: { id: string } }>('/chats/:id', async (req) => app.plans.chats.get(parse(uuid, req.params.id), me(req)));
      api.delete<{ Params: { id: string } }>('/chats/:id', async (req, reply) => {
        await app.plans.chats.remove(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });
      api.get('/settings/chat-retention', async () => chatRetentionDays(app.db));
      api.put('/settings/chat-retention', async (req) => {
        const body = parse(z.object({ days: z.number().int() }).strict(), req.body);
        return setChatRetentionDays(app.db, me(req), body.days);
      });
      api.get<{ Params: { id: string } }>('/plans/:id', async (req) => app.plans.get(parse(uuid, req.params.id), me(req)));
      api.get<{ Params: { id: string } }>('/plans/:id/pdf', async (req, reply) => {
        const { fileName, data } = await app.plans.pdf(parse(uuid, req.params.id), me(req));
        return reply
          .type('application/pdf')
          .header('content-disposition', `attachment; filename="${fileName.replace(/[^\x20-\x7e]|"/g, '_')}"`)
          .send(data);
      });
      api.post<{ Params: { id: string } }>('/plans/:id/answers', async (req) => {
        const { answers } = parse(z.object({ answers: answersSchema }).strict(), req.body);
        return app.plans.answer(parse(uuid, req.params.id), me(req), answers);
      });
      api.post<{ Params: { id: string } }>('/plans/:id/retry', async (req) => app.plans.retry(parse(uuid, req.params.id), me(req)));
      api.post<{ Params: { id: string } }>('/plans/:id/cancel', async (req) => app.plans.cancel(parse(uuid, req.params.id), me(req)));
      api.post<{ Params: { id: string; itemId: string } }>('/plans/:id/items/:itemId/cancel', async (req) =>
        app.plans.cancelItem(parse(uuid, req.params.id), parse(uuid, req.params.itemId), me(req)),
      );
      api.post<{ Params: { id: string; itemId: string } }>('/plans/:id/items/:itemId/retry', async (req) =>
        app.plans.retryItem(parse(uuid, req.params.id), parse(uuid, req.params.itemId), me(req), parse(itemHelpBody, req.body ?? {})),
      );
      api.delete<{ Params: { id: string; itemId: string } }>('/plans/:id/items/:itemId/notes', async (req) =>
        app.plans.clearNotes(parse(uuid, req.params.id), parse(uuid, req.params.itemId), me(req)),
      );
      api.delete<{ Params: { id: string } }>('/plans/:id', async (req, reply) => {
        await app.plans.remove(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });

      // ---- Phones and glasses: pairing (from the portal) and commands (from the paired phone)
      api.get('/devices', async (req) => app.devices.list(me(req)));
      api.post('/devices/pair', async (req, reply) => {
        if (req.deviceId) throw new AppError('device_not_allowed', 403);
        const { origin } = parse(z.object({ origin: z.string().max(300).optional() }).strict(), req.body ?? {});
        return reply.status(201).send(await app.devices.startPairing(me(req), origin));
      });
      api.delete<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
        await app.devices.revoke(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });
      const deviceOf = (req: FastifyRequest) => {
        if (!req.deviceId) throw new AppError('device_only', 403);
        return req.deviceId;
      };
      const history = z.array(z.object({ role: z.enum(['person', 'dittoly']), text: z.string().max(1000) }).strict()).max(10).default([]);
      api.post('/m/command', async (req) => {
        const body = parse(z.object({ text: z.string().min(1).max(2000), history }).strict(), req.body);
        return app.deviceCommands.command(me(req), deviceOf(req), body.text, body.history);
      });
      api.post('/m/confirm', async (req) => {
        const body = parse(z.object({ id: uuid, yes: z.boolean() }).strict(), req.body);
        return app.deviceCommands.confirm(me(req), deviceOf(req), body.id, body.yes);
      });
      api.get<{ Params: { id: string } }>('/m/runs/:id', async (req) => {
        deviceOf(req);
        const reply = await app.deviceCommands.status(me(req), parse(uuid, req.params.id));
        const run = await app.engine.runView(parse(uuid, req.params.id), me(req)).catch(() => null);
        return { ...reply, status: run?.status ?? null };
      });
      api.get('/m/inbox', async (req) => {
        deviceOf(req);
        return app.deviceCommands.inbox(me(req));
      });

      // ---- Flow URLs (management; the token is shown once on create and rotate)
      // ---- MCP: personal tokens for AI assistants, and which Flows they may run
      api.get('/me/mcp-tokens', async (req) => app.mcpServer.listTokens(me(req)));
      api.post('/me/mcp-tokens', async (req, reply) => {
        const body = parse(z.object({ name: z.string(), scopes: scopesBody.optional(), expiresInDays: z.number().int().optional() }).strict(), req.body);
        return reply.status(201).send(await app.mcpServer.createToken(me(req), body));
      });
      api.delete<{ Params: { id: string } }>('/me/mcp-tokens/:id', async (req, reply) => {
        await app.mcpServer.revokeToken(me(req), parse(uuid, req.params.id));
        return reply.status(204).send();
      });
      api.get('/me/mcp-tools', async (req) => [
        ...(await app.mcpServer.tools(me(req))).map(({ name, key, title, changesData }) => ({ name, key, title, changesData, kind: 'flow' })),
        ...((await app.mcpServer.gateway?.eligible(me(req))) ?? []).map(({ name, key, title, changesData }) => ({ name, key, title, changesData, kind: 'action' })),
      ]);
      // ---- MCP gateway: approved module actions admins offer to agents
      api.get('/gateway-tools', async (req) => app.mcpServer.gateway!.list(me(req)));
      api.post('/gateway-tools', async (req, reply) => reply.status(201).send(await app.mcpServer.gateway!.offer(me(req), parse(offerBody, req.body))));
      api.delete<{ Params: { id: string } }>('/gateway-tools/:id', async (req, reply) => {
        await app.mcpServer.gateway!.remove(me(req), parse(uuid, req.params.id));
        return reply.status(204).send();
      });
      // ---- Agents: what each MCP token may use, its calls, and calls waiting for its person
      api.get<{ Querystring: { all?: string } }>('/agents', async (req) => app.mcpServer.agents.list(me(req), req.query.all === '1'));
      api.post('/agents', async (req, reply) => reply.status(201).send(await app.mcpServer.createToken(me(req), parse(agentBody, req.body))));
      api.put<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
        await app.mcpServer.agents.update(me(req), parse(uuid, req.params.id), parse(agentUpdateBody, req.body));
        return reply.status(204).send();
      });
      api.delete<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
        await app.mcpServer.agents.revoke(me(req), parse(uuid, req.params.id));
        return reply.status(204).send();
      });
      api.get<{ Params: { id: string } }>('/agents/:id/calls', async (req) => app.mcpServer.agents.calls(me(req), { agentId: parse(uuid, req.params.id) }));
      api.get('/agent-calls', async (req) => app.mcpServer.agents.calls(me(req), {}));
      api.post<{ Params: { id: string } }>('/agent-calls/:id/decision', async (req) =>
        app.mcpServer.decideCall(me(req), parse(uuid, req.params.id), parse(z.object({ decision: z.enum(['confirmed', 'rejected']) }).strict(), req.body).decision),
      );
      api.get<{ Params: { id: string } }>('/flows/:id/mcp', async (req) => {
        const id = parse(uuid, req.params.id);
        await app.flows.assertCanSee(app.db, me(req), { flowId: id });
        const r = (await app.db.query<{ mcp_enabled: boolean; name: string }>(`SELECT mcp_enabled, name FROM flows WHERE id = $1`, [id])).rows[0];
        return { enabled: r?.mcp_enabled ?? false, tool: r ? toolName(r.name, id) : null };
      });
      api.put<{ Params: { id: string } }>('/flows/:id/mcp', async (req, reply) => {
        const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
        await setFlowMcp(app.db, me(req), parse(uuid, req.params.id), body.enabled);
        return reply.status(204).send();
      });
      api.get<{ Params: { id: string } }>('/flows/:id/endpoints', async (req) => app.endpoints.list(parse(uuid, req.params.id), me(req)));
      api.post<{ Params: { id: string } }>('/flows/:id/endpoints', async (req, reply) => reply.status(201).send(await app.endpoints.create(parse(uuid, req.params.id), req.body, me(req))));
      api.post<{ Params: { id: string } }>('/endpoints/:id/rotate', async (req) => {
        const { overlapSeconds } = parse(z.object({ overlapSeconds: z.number().int().default(0) }).strict(), req.body ?? {});
        return app.endpoints.rotate(parse(uuid, req.params.id), me(req), overlapSeconds);
      });
      api.patch<{ Params: { id: string } }>('/endpoints/:id', async (req) => {
        const body = parse(z.object({ enabled: z.boolean().optional(), expiresAt: z.string().datetime({ offset: true }).nullable().optional(), inputMap: inputMapSchema.nullable().optional() }).strict(), req.body);
        return app.endpoints.update(parse(uuid, req.params.id), me(req), body);
      });
      api.delete<{ Params: { id: string } }>('/endpoints/:id', async (req, reply) => {
        await app.endpoints.remove(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });

      // ---- Follow-ups: run a Flow after another one finishes
      api.get<{ Querystring: { flow?: string } }>('/followups', async (req) => app.followups.list(me(req), req.query.flow ? parse(uuid, req.query.flow) : undefined));
      api.post('/followups', async (req, reply) => reply.status(201).send(await app.followups.create(req.body, me(req))));
      api.patch<{ Params: { id: string } }>('/followups/:id', async (req, reply) => {
        const { enabled } = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
        await app.followups.setEnabled(parse(uuid, req.params.id), me(req), enabled);
        return reply.status(204).send();
      });
      api.delete<{ Params: { id: string } }>('/followups/:id', async (req, reply) => {
        await app.followups.remove(parse(uuid, req.params.id), me(req));
        return reply.status(204).send();
      });
      api.get('/schedules', async (req) => app.scheduler.list(me(req)));
      api.post('/schedules', async (req, reply) => reply.status(201).send(await app.scheduler.create(req.body, me(req))));
      api.patch<{ Params: { id: string } }>('/schedules/:id', async (req, reply) => {
        const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
        await app.scheduler.setEnabled(parse(uuid, req.params.id), me(req), body.enabled);
        return reply.status(204).send();
      });

      // ---- Triggers
      api.get('/triggers', async (req) => app.webhooks.list(me(req)));
      api.post('/triggers', async (req, reply) => reply.status(201).send(await app.webhooks.create(req.body, me(req))));
      api.post<{ Params: { id: string } }>('/triggers/:id/rotate-secret', async (req) => {
        const body = parse(z.object({ overlapSeconds: z.number().int().default(86_400) }).strict(), req.body ?? {});
        return app.webhooks.rotate(parse(uuid, req.params.id), me(req), body.overlapSeconds);
      });

      api.get('/notifications', async (req) => {
        const { rows } = await app.db.query(
          `SELECT n.id, n.kind, n.run_id, n.step_id, n.delegation_id, n.plan_id, n.flow_version_id, v.flow_id, n.created_at, n.read_at
           FROM notifications n LEFT JOIN flow_versions v ON v.id = n.flow_version_id
           WHERE n.member_id = $1 ORDER BY n.id DESC LIMIT 100`,
          [me(req).id],
        );
        // How each run ended or stands now, for the inbox (the run page has the full outcome).
        const outcomes = await outcomeSentences(app.db, [...new Set(rows.map((r) => r.run_id).filter((x): x is string => !!x))]);
        return rows.map((r) => ({ ...r, outcome: r.run_id ? (outcomes.get(r.run_id) ?? null) : null }));
      });
      registerGovernanceRoutes(api, app);
      registerModuleSafetyRoutes(api, app);
      registerChannelRoutes(api, app);
      registerInsightRoutes(api, app);
      registerAiModelRoutes(api, app);
      registerExportRoutes(api, app);
      registerWatchRoutes(api, app);
      registerTableRoutes(api, app);
      registerOnboardingRoutes(api, app);
      registerMcpConsentRoutes(api, app);
      registerScimAdminRoutes(api, app);
    },
    { prefix: '/api' },
  );

  return server;
}

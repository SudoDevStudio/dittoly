import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { teamSecret } from '../core/team-credentials.js';
import { assertTeamAdmin } from '../core/teams.js';
import { accessPreview } from '../governance/access.js';
import { cancelStandin, createStandin, listStandins } from '../governance/approvals.js';
import { verifyAudit } from '../governance/audit-chain.js';
import { createStream, deleteStream, listStreams, setStreamEnabled, streamBody, testStream } from '../governance/audit-stream.js';
import { breakglassBody, endGrant, listGrants, setBreakglass, startGrant } from '../governance/breakglass.js';
import { createPolicy, deletePolicy, describePolicy, listPolicies, POLICY_KINDS, setPolicyEnabled } from '../governance/policies.js';
import { auditReport, reportCsv } from '../governance/report.js';
import { aiInventory, classifyBody, classifyEntry, inventoryCsv, inventoryKey, type OrgAi } from '../governance/ai-inventory.js';
import { changesFor, getChange, listChanges } from '../governance/changes.js';
import { evidenceHtml, evidencePack } from '../governance/evidence-pack.js';
import { audit } from '../core/audit.js';
import { AUTO_STOP_DEFAULTS, autoStopSettingsSchema, getAutoStopSettings, listStops, resumeBody, resumeStop, setAutoStopSettings, stopFor } from '../governance/auto-stop.js';
import { anchorBody, createAnchor, deleteAnchor, listAnchors, sendAnchorNow } from '../governance/evidence.js';
import { review, reviewBody, reviewsFor } from '../governance/reviews.js';
import { me, parse, uuid } from './http.js';
import { canApprove } from '../core/members.js';
import { compareModels } from '../ai/compare-models.js';

/** The organization's AI, as the AI inventory names it. */
const orgAi = (app: App): OrgAi => ({ provider: app.ai?.id ?? null, model: app.orgAi ? app.orgAi.modelName : (app.config.aiModel ?? null) });

/** Governance: rules, access preview, token scopes, break-glass, access reviews, the audit report. */
export function registerGovernanceRoutes(api: FastifyInstance, app: App): void {
  // ---- Rules (admins set them; everyone can read what is in force)
  api.get('/policies', async () => ({ kinds: POLICY_KINDS, policies: (await listPolicies(app.db)).map((p) => ({ ...p, says: describePolicy(p) })) }));
  api.post('/policies', async (req, reply) => reply.status(201).send(await createPolicy(app.db, me(req), req.body)));
  api.put<{ Params: { id: string } }>('/policies/:id', async (req, reply) => {
    const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    await setPolicyEnabled(app.db, me(req), parse(uuid, req.params.id), body.enabled);
    return reply.status(204).send();
  });
  api.delete<{ Params: { id: string } }>('/policies/:id', async (req, reply) => {
    await deletePolicy(app.db, me(req), parse(uuid, req.params.id));
    return reply.status(204).send();
  });

  // ---- Stand-ins: "while I'm away, Sam approves for me"
  api.get('/standins', async (req) => listStandins(app.db, me(req)));
  // Who can stand in: admins and approvers, names only.
  api.get('/approvers', async () =>
    (await app.db.query(`SELECT id, handle, display_name AS "displayName", role FROM members WHERE role IN ('admin', 'approver') AND NOT disabled ORDER BY handle`)).rows,
  );
  api.post('/standins', async (req, reply) => reply.status(201).send(await createStandin(app.db, me(req), req.body)));
  api.delete<{ Params: { id: string } }>('/standins/:id', async (req, reply) => {
    await cancelStandin(app.db, me(req), parse(uuid, req.params.id));
    return reply.status(204).send();
  });

  // ---- Before running: every step and whose access it uses
  api.get<{ Params: { id: string } }>('/flow-versions/:id/access', async (req) => {
    const id = parse(uuid, req.params.id);
    await app.flows.assertCanSee(app.db, me(req), { versionId: id });
    return accessPreview(app, id, me(req));
  });

  // ---- Token scopes: check a stored token again
  api.post<{ Params: { service: string } }>('/me/credentials/:service/check', async (req) => {
    const member = me(req);
    const secret = await app.vault.reveal(member.id, req.params.service);
    if (secret === null) throw notFound('credential');
    return app.scopes.checkPersonal(member.id, req.params.service, secret);
  });
  api.post<{ Params: { id: string; service: string } }>('/teams/:id/credentials/:service/check', async (req) => {
    const teamId = parse(uuid, req.params.id);
    await assertTeamAdmin(app.db, teamId, me(req));
    const secret = await teamSecret(app.db, app.cipher, teamId, req.params.service);
    if (secret === null) throw notFound('credential');
    return app.scopes.checkTeam(teamId, req.params.service, secret);
  });

  // ---- Automatic stops: Flows and agents stopped because a control kept failing
  api.get('/auto-stops', async (req) => listStops(app.db, me(req)));
  api.get('/auto-stops/settings', async () => ({ settings: await getAutoStopSettings(app.db), defaults: AUTO_STOP_DEFAULTS }));
  api.put('/auto-stops/settings', async (req) => ({ settings: await setAutoStopSettings(app.db, me(req), parse(autoStopSettingsSchema, req.body)) }));
  api.post<{ Params: { id: string } }>('/auto-stops/:id/resume', async (req, reply) => {
    await resumeStop(app.db, (tx, runId, decision, actorId) => app.engine.settleAutoStopped(tx, runId, decision, actorId), me(req), parse(uuid, req.params.id), parse(resumeBody, req.body));
    return reply.status(204).send();
  });
  api.get<{ Params: { id: string } }>('/flows/:id/auto-stop', async (req) => {
    const id = parse(uuid, req.params.id);
    await app.flows.assertCanSee(app.db, me(req), { flowId: id });
    return { stop: await stopFor(app.db, me(req), { type: 'flow', id }) };
  });

  // ---- Break-glass
  api.get('/breakglass', async (req) => listGrants(app.db, me(req)));
  api.get('/me/breakglass', async (req) => ({
    allowed: (await app.db.query<{ breakglass: boolean }>(`SELECT breakglass FROM members WHERE id = $1`, [me(req).id])).rows[0]?.breakglass === true,
  }));
  api.post('/breakglass', async (req, reply) => reply.status(201).send(await startGrant(app.db, me(req), parse(breakglassBody, req.body))));
  api.post<{ Params: { id: string } }>('/breakglass/:id/end', async (req, reply) => {
    await endGrant(app.db, me(req), parse(uuid, req.params.id));
    return reply.status(204).send();
  });
  api.put<{ Params: { id: string } }>('/members/:id/breakglass', async (req, reply) => {
    const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    await setBreakglass(app.db, me(req), parse(uuid, req.params.id), body.enabled);
    return reply.status(204).send();
  });

  // ---- Access reviews
  api.get('/me/reviews', async (req) => reviewsFor(app.db, me(req)));
  api.post('/reviews', async (req, reply) => {
    await review(app.db, me(req), parse(reviewBody, req.body));
    return reply.status(204).send();
  });

  // ---- Audit report and chain (admins)
  api.get<{ Querystring: { from?: string; to?: string; format?: string } }>('/admin/audit-report', async (req, reply) => {
    if (me(req).role !== 'admin') throw forbidden('admin_only');
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw badRequest('invalid_range');
    const report = await auditReport(app.db, from, to, { flows: app.flows, org: orgAi(app) });
    if (req.query.format === 'csv') {
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="dittoly-audit-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv"`)
        .send(reportCsv(report));
    }
    return report;
  });
  // Places that get a copy of the audit chain's latest hash every day.
  api.get('/admin/audit-anchors', async (req) => listAnchors(app.db, me(req)));
  api.post('/admin/audit-anchors', async (req, reply) => reply.status(201).send(await createAnchor(app.evidence, me(req), parse(anchorBody, req.body))));
  api.delete<{ Params: { id: string } }>('/admin/audit-anchors/:id', async (req, reply) => {
    await deleteAnchor(app.db, me(req), parse(uuid, req.params.id));
    return reply.status(204).send();
  });
  api.post<{ Params: { id: string } }>('/admin/audit-anchors/:id/send', async (req) => sendAnchorNow(app.evidence, me(req), parse(uuid, req.params.id)));
  // SIEMs that get every audit event as it is sealed.
  api.get('/admin/audit-streams', async (req) => listStreams(app.db, me(req)));
  api.post('/admin/audit-streams', async (req, reply) => reply.status(201).send(await createStream(app.streams, me(req), parse(streamBody, req.body))));
  api.patch<{ Params: { id: string } }>('/admin/audit-streams/:id', async (req, reply) => {
    await setStreamEnabled(app.db, me(req), parse(uuid, req.params.id), parse(z.object({ enabled: z.boolean() }).strict(), req.body).enabled);
    return reply.status(204).send();
  });
  api.delete<{ Params: { id: string } }>('/admin/audit-streams/:id', async (req, reply) => {
    await deleteStream(app.db, me(req), parse(uuid, req.params.id));
    return reply.status(204).send();
  });
  api.post<{ Params: { id: string } }>('/admin/audit-streams/:id/test', async (req) => testStream(app.streams, me(req), parse(uuid, req.params.id)));
  // ---- Change records (self-fixes as governed changes): admins and approvers
  api.get('/changes', async (req) => listChanges(app.db, me(req)));
  api.get<{ Querystring: { moduleVersion?: string; flowVersion?: string } }>('/changes/for', async (req) =>
    changesFor(app.db, me(req), {
      moduleVersionId: req.query.moduleVersion ? parse(uuid, req.query.moduleVersion) : undefined,
      flowVersionId: req.query.flowVersion ? parse(uuid, req.query.flowVersion) : undefined,
    }),
  );
  api.get<{ Params: { id: string } }>('/changes/:id', async (req) => getChange(app.db, me(req), parse(uuid, req.params.id)));

  // ---- Evidence pack of one run: whoever may open the run page, as HTML or JSON
  api.get<{ Params: { id: string }; Querystring: { format?: string } }>('/runs/:id/evidence', async (req, reply) => {
    const id = parse(uuid, req.params.id);
    const actor = me(req);
    const pack = await evidencePack(app, id, actor);
    await audit(app.db, { actorId: actor.id, action: 'run.evidence_exported', subjectType: 'run', subjectId: id, outcome: 'ok' });
    const name = `dittoly-evidence-${id}`;
    if (req.query.format === 'html') {
      return reply.header('content-type', 'text/html; charset=utf-8').header('content-disposition', `attachment; filename="${name}.html"`).send(evidenceHtml(pack));
    }
    if (req.query.format === 'download') return reply.header('content-disposition', `attachment; filename="${name}.json"`).send(pack);
    return pack;
  });

  // ---- Which AI writes the better work here, from this organization's own drafts (approvers and admins)
  api.get('/admin/model-comparison', async (req) => {
    if (!canApprove(me(req))) throw forbidden('approver_only');
    return compareModels(app.db);
  });

  // ---- AI system inventory (admins)
  api.get<{ Querystring: { format?: string } }>('/admin/ai-inventory', async (req, reply) => {
    if (me(req).role !== 'admin') throw forbidden('admin_only');
    const entries = await aiInventory(app.db, app.flows, orgAi(app));
    if (req.query.format === 'csv') {
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="dittoly-ai-inventory.csv"').send(inventoryCsv(entries));
    }
    return { generatedAt: new Date(), entries };
  });
  api.put<{ Params: { key: string } }>('/admin/ai-inventory/:key', async (req) =>
    classifyEntry(app.db, app.flows, orgAi(app), me(req), parse(inventoryKey, req.params.key), parse(classifyBody, req.body)),
  );

  api.get('/admin/audit-chain', async (req) => {
    if (me(req).role !== 'admin') throw forbidden('admin_only');
    return verifyAudit(app.db);
  });
}

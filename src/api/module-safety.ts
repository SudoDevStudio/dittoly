import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { defaultTeamFor } from '../core/teams.js';
import { flowChanges, lineDiff, manifestChanges } from '../modules/diff.js';
import {
  assertRecordable,
  deleteRecording,
  listDrift,
  listRecordings,
  recordingBody,
  recordingFetch,
  resolveDrift,
  saveRecording,
} from '../modules/health.js';
import { fixDrift, getSelfFix, selfFixBody, setSelfFix } from '../modules/self-fix.js';
import { me, parse, uuid } from './http.js';
import { readablePair } from '../modules/source.js';

/** Module safety: recorded tests, drift warnings, and what changed between versions. */
export function registerModuleSafetyRoutes(api: FastifyInstance, app: App): void {
  const reviewer = (role: string) => role === 'admin' || role === 'approver';

  // ---- Record a test: run a read action once, as yourself, against the real app.
  api.post<{ Params: { id: string } }>('/modules/:id/record', async (req) => {
    const actor = me(req);
    if (!reviewer(actor.role)) throw forbidden('approver_only');
    const body = parse(z.object({ action: z.string().max(64), input: z.unknown(), name: z.string().min(1).max(70) }).strict(), req.body);
    const mv = await app.modules.get(app.db, parse(uuid, req.params.id));
    if (!mv) throw notFound('module');
    if (mv.status !== 'approved') throw conflict('module_not_approved');
    assertRecordable(mv, body.action);
    const used: string[] = [];
    const rec = { current: null as ReturnType<typeof recordingFetch> | null };
    const secretFor = async (service: string) => {
      const s = await app.vault.reveal(actor.id, service);
      if (s) used.push(s, ...s.split(':').filter((p) => p.length >= 8));
      return s;
    };
    const output = await app.engine.invokeOutsideRun(mv, body.action, body.input, await defaultTeamFor(app.db, actor.id), secretFor, {
      // A test run outside a Flow: the module's own declared defaults are used for its settings.
      settings: Object.fromEntries((mv.manifest.settings ?? []).flatMap((s) => ('default' in s && s.default ? [[s.id, s.default]] : []))),
      wrapFetch: (inner) => {
        rec.current = recordingFetch(inner, () => used);
        return rec.current.fetch;
      },
    });
    const problem = rec.current?.problem();
    if (problem) throw badRequest(problem);
    // Nothing is saved yet: the person reviews what was recorded (answers may hold real data) and then saves it.
    return { test: { name: body.name, action: body.action, input: body.input, http: rec.current?.http ?? [], calls: [], expectOk: true }, output };
  });
  api.post<{ Params: { id: string } }>('/modules/:id/recordings', async (req, reply) => {
    const actor = me(req);
    if (!reviewer(actor.role)) throw forbidden('approver_only');
    const mv = await app.modules.get(app.db, parse(uuid, req.params.id));
    if (!mv) throw notFound('module');
    const { test } = parse(recordingBody, req.body);
    assertRecordable(mv, test.action);
    return reply.status(201).send(await saveRecording(app.db, actor, mv, test));
  });
  api.get<{ Params: { id: string } }>('/modules/:id/recordings', async (req) => {
    const mv = await app.modules.get(app.db, parse(uuid, req.params.id));
    if (!mv) throw notFound('module');
    return listRecordings(app.db, mv.name);
  });
  api.delete<{ Params: { id: string } }>('/recordings/:id', async (req, reply) => {
    await deleteRecording(app.db, me(req), parse(uuid, req.params.id));
    return reply.status(204).send();
  });

  // ---- Drift: modules whose app seems to have changed
  api.get('/modules-drift', async () => listDrift(app.db));
  // Self-fixing: whether Dittoly drafts fixes by itself, and how many a day.
  api.get('/admin/self-fix', async (req) => {
    if (me(req).role !== 'admin') throw forbidden('admin_only');
    return { ...(await getSelfFix(app.db)), aiConfigured: app.ai !== null };
  });
  api.put('/admin/self-fix', async (req) => setSelfFix(app.db, me(req), parse(selfFixBody, req.body)));
  api.post<{ Params: { name: string } }>('/modules-drift/:name/dismiss', async (req, reply) => {
    await resolveDrift(app.db, req.params.name, me(req));
    return reply.status(204).send();
  });
  /**
   * Ask the organization's AI for a fixed version, by hand: the same as self-fixing does by itself
   * (validated, including recorded tests, sent for review, the Flows' new versions proposed), as a
   * change record that the admin who asked may not approve.
   */
  api.post<{ Params: { name: string } }>('/modules-drift/:name/fix', async (req, reply) => {
    const actor = me(req);
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const drift = (await listDrift(app.db)).find((d) => d.module === req.params.name);
    if (!drift) throw notFound('drift');
    await app.db.query(
      `UPDATE module_drift SET fix_attempted_at = now(), fix_error = NULL, fix_version_id = NULL, fix_flows = '[]' WHERE module_name = $1 AND resolved_at IS NULL`,
      [drift.module],
    );
    const deps = { db: app.db, modules: app.modules, moduleChat: app.moduleChat, flows: app.flows, flowTests: app.flowTests, aiConfigured: app.ai !== null, cipher: app.cipher };
    const out = await fixDrift(deps, { module_name: drift.module, version: drift.version, summary: drift.summary, detected_at: drift.detectedAt }, { id: actor.id, how: 'by_hand' });
    if (!out) throw notFound('module');
    return reply.status(201).send({ id: out.draft.id, version: out.draft.version, passed: out.draft.validationReport?.passed ?? false, changeId: out.changeId });
  });

  // ---- What changed between versions
  api.get<{ Params: { id: string }; Querystring: { against?: string } }>('/modules/:id/diff', async (req) => {
    const mv = await app.modules.get(app.db, parse(uuid, req.params.id));
    if (!mv) throw notFound('module');
    let base = req.query.against ? await app.modules.get(app.db, parse(uuid, req.query.against)) : null;
    if (!base) {
      // Default: the newest approved version of the same module, other than this one.
      const { rows } = await app.db.query<{ id: string }>(
        `SELECT id FROM module_versions WHERE name = $1 AND status = 'approved' AND id <> $2 ORDER BY created_at DESC LIMIT 1`,
        [mv.name, mv.id],
      );
      base = rows[0] ? await app.modules.get(app.db, rows[0].id) : null;
    }
    if (!base) return { against: null, changes: [], code: null };
    if (base.name !== mv.name) throw badRequest('different_modules');
    return { against: { id: base.id, version: base.version }, changes: manifestChanges(base.manifest, mv.manifest), code: lineDiff(...readablePair(base, mv)) };
  });
  api.get<{ Params: { id: string }; Querystring: { against?: string } }>('/flow-versions/:id/diff', async (req) => {
    const v = await app.flows.getVersion(app.db, parse(uuid, req.params.id));
    if (!v) throw notFound('flow_version');
    await app.flows.assertCanSee(app.db, me(req), { versionId: v.id });
    let base = req.query.against ? await app.flows.getVersion(app.db, parse(uuid, req.query.against)) : null;
    if (!base) {
      const { rows } = await app.db.query<{ id: string }>(
        `SELECT id FROM flow_versions WHERE flow_id = $1 AND version < $2 ORDER BY (status IN ('approved', 'superseded')) DESC, version DESC LIMIT 1`,
        [v.flowId, v.version],
      );
      base = rows[0] ? await app.flows.getVersion(app.db, rows[0].id) : null;
    }
    if (!base) return { against: null, changes: [] };
    if (base.flowId !== v.flowId) throw badRequest('different_flows');
    return { against: { id: base.id, version: base.version }, changes: flowChanges(base.definition, v.definition) };
  });
}

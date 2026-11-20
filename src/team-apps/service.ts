import { z } from 'zod';
import type { App } from '../app.js';
import { withAiContext } from '../ai/metering.js';
import type { AiImage } from '../ai/provider.js';
import { credentialNeeds } from '../api/runnable.js';
import { audit } from '../core/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { canApprove, type Member } from '../core/members.js';
import { teamStoredServices } from '../core/team-credentials.js';
import { assertTeamMember, canUseTeam, defaultTeamFor } from '../core/teams.js';
import { withTx, type Queryable } from '../db/db.js';
import { enqueue } from '../engine/jobs.js';
import { slugify } from '../export/bundle.js';
import { checkPlan, defaultPlan, draftPlan, planFlows, uiPlanSchema, type PlanFlow, type UiPlan } from '../export/frontend/plan.js';
import { brandInput, DEFAULT_BRAND, deriveTheme, type BrandInput } from '../export/theme.js';
import type { FlowDefinition } from '../flows/definition.js';

/**
 * Apps: pages (a page plan, the same one an export uses) over a team's approved Flows, opened inside Dittoly.
 * - Shared by the team: every member opens the same app and sees its runs. Its runs use the team's shared
 *   credentials, so it gives everyone the same results; a Flow that would use someone's own key cannot run in it.
 * - Versioned: each change is a new version that an approver signs off (not its author, on a shared server).
 *   The live version stays live until a newer one is approved. Its author and approvers can preview a pending one.
 * - The Flows are referenced by id and run at their current approved version, like an export; or, pinned
 *   (versionId), at that version. A pinned version a newer one replaced still runs from the App, reads only:
 *   its steps that change data fail with pinned_version_retired until the App's author moves the pin.
 */

export const appSpec = z
  .object({
    flows: z.array(z.object({ flowId: z.string().uuid(), versionId: z.string().uuid().optional() }).strict()).min(1).max(20),
    plan: z.unknown(),
    brand: brandInput.optional(),
  })
  .strict();
export type AppSpec = { flows: AppFlowRef[]; plan: UiPlan; brand?: BrandInput | undefined };
/** A Flow of an app: followed at its current approved version, or pinned to one (versionId). */
export type AppFlowRef = { flowId: string; versionId?: string | undefined };

export const createBody = z.object({ name: z.string().trim().min(1).max(60), teamId: z.string().uuid().optional(), spec: appSpec }).strict();
export const updateBody = z.object({ name: z.string().trim().min(1).max(60).optional(), spec: appSpec }).strict();
export const layoutBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    teamId: z.string().uuid().optional(),
    flows: appSpec.shape.flows,
    brief: z.string().trim().max(2000).optional(),
    /** A layout sketch or screenshot, as a data URL (PNG, JPEG, WebP or GIF, at most 4 MB). */
    image: z.string().max(5_600_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/).optional(),
    nav: z.enum(['sidebar-left', 'sidebar-right', 'top', 'none']).optional(),
  })
  .strict();

const issues = (e: z.ZodError) => e.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

/** One of the app's Flows: its key in the plan, and its current approved version. */
export interface AppFlow {
  key: string;
  flowId: string;
  name: string;
  description: string;
  versionId: string;
  definition: FlowDefinition;
  /** Pinned to this version (else the current approved one). */
  pinned: boolean;
  /** Pinned to a version a newer one replaced: runs read only. */
  retired: boolean;
  /** The Flow's current approved version number (null when none). */
  current: number | null;
  version: number;
}

/** The app's Flows, keyed like an export keys them (by name, in order). Only the team's approved Flows. */
export async function appFlows(
  app: App,
  teamId: string,
  flows: AppFlowRef[],
  /** A pending version of one Flow, as if approved (src/team-apps/service.ts appImpact). */
  candidate?: { flowId: string; definition: FlowDefinition },
): Promise<{ flows: AppFlow[]; problems: string[]; notes: string[] }> {
  const out: AppFlow[] = [];
  const problems: string[] = [];
  /** Not blocking: a pinned version a newer one replaced (the App runs it read only). */
  const notes: string[] = [];
  const keys = new Set<string>();
  for (const { flowId, versionId: pin } of flows) {
    const row = (
      await app.db.query<{ id: string; name: string; team_id: string; archived_at: Date | null }>(`SELECT id, name, team_id, archived_at FROM flows WHERE id = $1`, [flowId])
    ).rows[0];
    if (!row) throw notFound('flow');
    if (row.team_id !== teamId) {
      problems.push(`${row.name}: only the app's team's Flows can be used`);
      continue;
    }
    if (row.archived_at) {
      problems.push(`${row.name} was deleted`);
      continue;
    }
    const v = (await app.db.query<{ id: string; version: number }>(`SELECT id, version FROM flow_versions WHERE flow_id = $1 AND status = 'approved'`, [flowId])).rows[0];
    if (candidate?.flowId === flowId && !pin) {
      let key = slugify(row.name, 'flow');
      for (let i = 2; keys.has(key); i++) key = `${slugify(row.name, 'flow').slice(0, 36)}-${i}`;
      keys.add(key);
      const d = candidate.definition;
      out.push({ key, flowId, name: row.name, description: d.description ?? '', versionId: '', definition: d, pinned: false, retired: false, current: v?.version ?? null, version: 0 });
      continue;
    }
    const version = await app.flows.getVersion(app.db, pin ?? v?.id ?? '00000000-0000-0000-0000-000000000000').catch(() => null);
    if (pin && (!version || version.flowId !== flowId || (version.status !== 'approved' && version.status !== 'superseded'))) {
      problems.push(`${row.name}: the pinned version is not one that was approved`);
      continue;
    }
    if (!version) {
      problems.push(`${row.name} has no approved version`);
      continue;
    }
    const retired = version.status === 'superseded';
    if (retired) {
      notes.push(
        `${row.name} is pinned to v${version.version}, which ${v ? `v${v.version}` : 'a newer version'} replaced: it still reads, but its steps that change data no longer run. Move the pin.`,
      );
    }
    let key = slugify(row.name, 'flow');
    for (let i = 2; keys.has(key); i++) key = `${slugify(row.name, 'flow').slice(0, 36)}-${i}`;
    keys.add(key);
    out.push({ key, flowId, name: row.name, description: version.definition.description ?? '', versionId: version.id, definition: version.definition, pinned: !!pin, retired, current: v?.version ?? null, version: version.version });
  }
  return { flows: out, problems, notes };
}

/** The Flows as the page planner sees them, with each action's output shape from its module. */
async function plannerFlows(app: App, flows: AppFlow[]): Promise<PlanFlow[]> {
  const modules = new Map<string, { name: string; version: string; manifest: never }>();
  for (const f of flows) {
    for (const m of (await app.flows.pinnedModules(app.db, f.definition)).values()) modules.set(`${m.name}@${m.version}`, m as never);
  }
  return planFlows(
    flows.map((f) => ({ key: f.key, name: f.name, description: f.description, access: 'token' as const, exposed: true, definition: f.definition as unknown as Record<string, unknown> })),
    [...modules.values()],
  );
}

/** A spec checked against the team's Flows: every page's Flow, input and step must exist. */
async function checkSpec(app: App, teamId: string, raw: z.infer<typeof appSpec>): Promise<AppSpec> {
  const { flows, problems } = await appFlows(app, teamId, raw.flows);
  if (problems.length) throw badRequest('invalid_app', problems.join('; '));
  const plan = uiPlanSchema.safeParse(raw.plan);
  if (!plan.success) throw badRequest('invalid_plan', issues(plan.error));
  const planProblems = checkPlan(plan.data, await plannerFlows(app, flows));
  if (planProblems.length) throw badRequest('invalid_plan', planProblems.join('; '));
  return { flows: raw.flows.map((f) => (f.versionId ? { flowId: f.flowId, versionId: f.versionId } : { flowId: f.flowId })), plan: plan.data, ...(raw.brand ? { brand: raw.brand } : {}) };
}

/**
 * What stops the app's Flows from running for the team: a credential the team has not switched to team access,
 * or one it has not stored yet. Empty when the app is ready.
 */
type Gap = { flow: string; label: string; problem: 'personal' | 'not_stored' | 'delegated' };
export async function teamCredentialGaps(app: App, teamId: string, flows: { name: string; definition: FlowDefinition }[], depth = 0): Promise<Gap[]> {
  const gaps: Gap[] = [];
  const stored = await teamStoredServices(app.db, teamId);
  for (const f of flows) {
    const { personal, team } = await credentialNeeds(app, teamId, f.definition, await app.flows.pinnedModules(app.db, f.definition));
    for (const [, label] of personal) gaps.push({ flow: f.name, label, problem: 'personal' });
    for (const [service, label] of team) if (!stored.has(service)) gaps.push({ flow: f.name, label, problem: 'not_stored' });
    // A step handed to a teammate runs on their own access, not the team's.
    for (const s of f.definition.steps) if (s.type === 'action' && s.delegateTo) gaps.push({ flow: f.name, label: `step ${s.id}`, problem: 'delegated' });
    // A Super Flow's Flows run in its runs too, in their own teams.
    if (depth < 3) {
      for (const c of (await app.flows.pinnedFlows(app.db, f.definition)).values()) {
        const childTeam = await app.flows.teamOfVersion(app.db, c.version.id);
        gaps.push(...(await teamCredentialGaps(app, childTeam, [{ name: `${f.name} → ${c.name}`, definition: c.version.definition }], depth + 1)));
      }
    }
  }
  return gaps;
}

const gapText = (g: Gap) =>
  `${g.flow}: ${g.label} ${
    g.problem === 'personal' ? 'uses each person’s own key; a team admin must switch it to the team’s shared key'
    : g.problem === 'delegated' ? 'is handed to a teammate and runs on their own access, which a shared app cannot use'
    : 'needs the team’s shared key, which no team admin has stored yet'}`;

interface AppRow { id: string; team_id: string; name: string; created_by: string; created_at: Date; archived_at: Date | null }
interface VersionRow { id: string; app_id: string; version: number; status: string; spec: AppSpec; created_by: string; created_at: Date; decided_by: string | null; decided_at: Date | null }

async function appRow(db: Queryable, id: string): Promise<AppRow> {
  const row = (await db.query<AppRow>(`SELECT * FROM apps WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound('app');
  return row;
}

const versionView = (v: VersionRow) => ({ id: v.id, version: v.version, status: v.status, spec: v.spec, createdBy: v.created_by, createdAt: v.created_at, decidedBy: v.decided_by, decidedAt: v.decided_at });

// ---- authoring

export async function createApp(app: App, actor: Member, raw: unknown) {
  const body = createBody.safeParse(raw);
  if (!body.success) throw badRequest('invalid_app', issues(body.error));
  const teamId = body.data.teamId ?? (await defaultTeamFor(app.db, actor.id));
  await assertTeamMember(app.db, teamId, actor);
  const spec = await checkSpec(app, teamId, body.data.spec);
  return withTx(app.db, async (tx) => {
    const a = (await tx.query<{ id: string }>(`INSERT INTO apps (team_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [teamId, body.data.name, actor.id])).rows[0]!;
    const v = (
      await tx.query<{ id: string }>(`INSERT INTO app_versions (app_id, version, status, spec, created_by) VALUES ($1, 1, 'pending', $2, $3) RETURNING id`, [a.id, JSON.stringify(spec), actor.id])
    ).rows[0]!;
    await audit(tx, { actorId: actor.id, action: 'app.created', subjectType: 'app', subjectId: a.id, outcome: 'ok', relatedId: v.id });
    return { appId: a.id, versionId: v.id, version: 1 };
  });
}

/** A change is a new pending version; an earlier pending one is superseded, the live one stays live. */
export async function updateApp(app: App, actor: Member, appId: string, raw: unknown) {
  const body = updateBody.safeParse(raw);
  if (!body.success) throw badRequest('invalid_app', issues(body.error));
  const a = await appRow(app.db, appId);
  if (a.archived_at) throw conflict('app_archived');
  if (a.created_by !== actor.id && actor.role !== 'admin') throw forbidden('app_owner_or_admin');
  const spec = await checkSpec(app, a.team_id, body.data.spec);
  return withTx(app.db, async (tx) => {
    await tx.query(`SELECT id FROM apps WHERE id = $1 FOR UPDATE`, [appId]);
    const next = (await tx.query<{ n: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS n FROM app_versions WHERE app_id = $1`, [appId])).rows[0]!.n;
    await tx.query(`UPDATE app_versions SET status = 'superseded' WHERE app_id = $1 AND status = 'pending'`, [appId]);
    const v = (
      await tx.query<{ id: string }>(`INSERT INTO app_versions (app_id, version, status, spec, created_by) VALUES ($1, $2, 'pending', $3, $4) RETURNING id`, [appId, next, JSON.stringify(spec), actor.id])
    ).rows[0]!;
    if (body.data.name && body.data.name !== a.name) await tx.query(`UPDATE apps SET name = $2 WHERE id = $1`, [appId, body.data.name]);
    await audit(tx, { actorId: actor.id, action: 'app.version_created', subjectType: 'app', subjectId: appId, outcome: 'ok', relatedId: v.id });
    return { appId, versionId: v.id, version: next };
  });
}

/** Approvers sign off a pending version (on a shared server, not their own); approving makes it the live one. */
export async function decideApp(app: App, actor: Member, versionId: string, decision: 'approved' | 'rejected') {
  if (!canApprove(actor)) throw forbidden('approver_only');
  await withTx(app.db, async (tx) => {
    const v = (await tx.query<VersionRow>(`SELECT * FROM app_versions WHERE id = $1 FOR UPDATE`, [versionId])).rows[0];
    if (!v) throw notFound('app_version');
    if (v.status !== 'pending') throw conflict('app_version_not_pending');
    if (app.config.mode === 'shared' && v.created_by === actor.id) throw forbidden('cannot_approve_own_app');
    const a = await appRow(tx, v.app_id);
    if (a.archived_at) throw conflict('app_archived');
    if (decision === 'approved') await tx.query(`UPDATE app_versions SET status = 'superseded' WHERE app_id = $1 AND status = 'approved'`, [v.app_id]);
    await tx.query(`UPDATE app_versions SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [versionId, decision, actor.id]);
    // Written to the team's (else the organization's) git repository, when one is connected (src/git-sync/service.ts).
    if (decision === 'approved') await enqueue(tx, 'git_export', { kind: 'app', versionId });
    await audit(tx, { actorId: actor.id, action: `app.${decision}`, subjectType: 'app', subjectId: v.app_id, outcome: 'ok', relatedId: versionId });
  });
}

/** Deleting an app archives it: it stops opening, its versions and runs stay. Its author or an admin. */
export async function archiveApp(app: App, actor: Member, appId: string) {
  const a = await appRow(app.db, appId);
  if (a.created_by !== actor.id && actor.role !== 'admin') throw forbidden('app_owner_or_admin');
  await app.db.query(`UPDATE apps SET archived_at = now(), archived_by = $2 WHERE id = $1 AND archived_at IS NULL`, [appId, actor.id]);
  await audit(app.db, { actorId: actor.id, action: 'app.archived', subjectType: 'app', subjectId: appId, outcome: 'ok' });
}

/** Apps of the member's teams (approvers and admins: every team's), with their live and latest versions. */
export async function listApps(app: App, actor: Member, teamId?: string) {
  const { rows } = await app.db.query<{ id: string; name: string; team_id: string; team_name: string; created_by: string; live: number | null; latest: number; latest_status: string; latest_id: string }>(
    `SELECT a.id, a.name, a.team_id, t.name AS team_name, a.created_by,
            (SELECT version FROM app_versions WHERE app_id = a.id AND status = 'approved') AS live,
            l.version AS latest, l.status AS latest_status, l.id AS latest_id
     FROM apps a JOIN teams t ON t.id = a.team_id
     JOIN LATERAL (SELECT id, version, status FROM app_versions WHERE app_id = a.id ORDER BY version DESC LIMIT 1) l ON true
     WHERE a.archived_at IS NULL AND ($2::uuid IS NULL OR a.team_id = $2)
       AND ($3 OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = a.team_id AND tm.member_id = $1))
     ORDER BY a.name LIMIT 200`,
    [actor.id, teamId ?? null, canApprove(actor)],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, team: { id: r.team_id, name: r.team_name }, createdBy: r.created_by, liveVersion: r.live, latest: { id: r.latest_id, version: r.latest, status: r.latest_status } }));
}

/** One app: its versions (newest first) and what stops its live (or latest) version from running for the team. */
export async function getApp(app: App, actor: Member, appId: string) {
  const a = await appRow(app.db, appId);
  if (!canApprove(actor)) await assertTeamMember(app.db, a.team_id, actor);
  const versions = (await app.db.query<VersionRow>(`SELECT * FROM app_versions WHERE app_id = $1 ORDER BY version DESC`, [appId])).rows;
  const current = versions.find((v) => v.status === 'approved') ?? versions[0]!;
  const { flows, problems, notes } = await appFlows(app, a.team_id, current.spec.flows);
  const planProblems = checkPlan(current.spec.plan, await plannerFlows(app, flows));
  return {
    id: a.id,
    name: a.name,
    teamId: a.team_id,
    createdBy: a.created_by,
    archived: !!a.archived_at,
    versions: versions.map(versionView),
    flows: flows.map((f) => ({ key: f.key, flowId: f.flowId, name: f.name, version: f.version, pinned: f.pinned, retired: f.retired, current: f.current })),
    /** Why the app (as it stands) cannot be used: Flows that changed or lost their approval, and missing team keys. */
    problems: [...problems, ...notes, ...planProblems, ...(await teamCredentialGaps(app, a.team_id, flows)).map(gapText)],
  };
}

/**
 * A layout for the chosen Flows: drafted by the organization's AI from a brief and/or layout image, or the plain
 * default one (no AI, nothing sent anywhere).
 */
export async function draftLayout(app: App, actor: Member, raw: unknown): Promise<{ plan: UiPlan; explanation: string; ai: boolean; flows: { key: string; name: string }[] }> {
  const body = layoutBody.safeParse(raw);
  if (!body.success) throw badRequest('invalid_app', issues(body.error));
  const teamId = body.data.teamId ?? (await defaultTeamFor(app.db, actor.id));
  await assertTeamMember(app.db, teamId, actor);
  const { flows, problems } = await appFlows(app, teamId, body.data.flows);
  if (problems.length) throw badRequest('invalid_app', problems.join('; '));
  const planner = await plannerFlows(app, flows);
  const keys = flows.map((f) => ({ key: f.key, name: f.name }));
  if (!body.data.brief && !body.data.image) {
    return { plan: defaultPlan(planner, body.data.nav ? { nav: body.data.nav } : {}), explanation: 'The default layout: a page for each Flow.', ai: false, flows: keys };
  }
  if (!app.ai) throw badRequest('ai_not_configured', 'a brief or layout image needs the organization AI; leave both out for the default layout');
  let image: AiImage | undefined;
  if (body.data.image) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(body.data.image)!;
    if (Buffer.byteLength(m[2]!, 'base64') > 4_000_000) throw badRequest('image_too_large');
    image = { mediaType: m[1] as AiImage['mediaType'], data: m[2]! };
  }
  const brief = [body.data.brief, body.data.nav ? `Navigation: ${body.data.nav}.` : ''].filter(Boolean).join(' ');
  const out = await withAiContext({ memberId: actor.id, teamId, purpose: 'other' }, () => draftPlan(app.ai!, planner, { appName: body.data.name, brief, image }));
  return { ...out, ai: true, flows: keys };
}

// ---- opening and using an app (the API its pages call, the same one an exported app serves)

/** An app as one member opens it: the live version, or (for its author and approvers) a given version to preview. */
export interface OpenedApp {
  app: AppRow;
  version: VersionRow;
  preview: boolean;
  flows: AppFlow[];
}

export async function openApp(app: App, actor: Member, appId: string, ref: string): Promise<OpenedApp> {
  const a = await appRow(app.db, appId);
  if (a.archived_at) throw notFound('app');
  // The team opens it; approvers may also preview a version to decide on it (running it still needs the team).
  if (!(await canUseTeam(app.db, a.team_id, actor)) && !(ref !== 'live' && canApprove(actor))) throw forbidden('not_in_team');
  let version: VersionRow | undefined;
  if (ref === 'live') {
    version = (await app.db.query<VersionRow>(`SELECT * FROM app_versions WHERE app_id = $1 AND status = 'approved'`, [appId])).rows[0];
    if (!version) throw conflict('app_not_approved');
  } else {
    if (!z.string().uuid().safeParse(ref).success) throw notFound('app_version');
    version = (await app.db.query<VersionRow>(`SELECT * FROM app_versions WHERE id = $1 AND app_id = $2`, [ref, appId])).rows[0];
    if (!version) throw notFound('app_version');
    // Anyone in the team opens the live version this way too; another version is a preview for its author and approvers.
    if (version.status !== 'approved' && version.created_by !== actor.id && !canApprove(actor)) throw forbidden('preview_author_or_approver');
  }
  const { flows } = await appFlows(app, a.team_id, version.spec.flows);
  return { app: a, version, preview: version.status !== 'approved', flows };
}

/** GET .../api/app: what the renderer needs. */
export async function appInfo(app: App, o: OpenedApp) {
  const brand = { ...(o.version.spec.brand ?? DEFAULT_BRAND), name: o.app.name };
  return {
    name: o.app.name,
    kind: 'ui',
    preview: o.preview,
    version: o.version.version,
    theme: deriveTheme(brand),
    plan: o.version.spec.plan,
    humanSteps: o.flows.some((f) => f.definition.steps.some((s) => s.type === 'approval' || s.type === 'input')),
    flows: o.flows.map((f) => ({ key: f.key, name: f.name, description: f.description, access: 'token', inputs: f.definition.inputs, form: f.definition.form ?? null })),
    problems: (await teamCredentialGaps(app, o.app.team_id, o.flows)).map(gapText),
  };
}

const keyOf = (o: OpenedApp, flowVersionId: string) => o.flows.find((f) => f.versionId === flowVersionId)?.key ?? null;

/** Wait (at most `seconds`) until a run stops working, so a page can show its result at once. */
async function settle(app: App, runId: string, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const r = (await app.db.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId])).rows[0];
    if (!r || r.status !== 'running') return;
    await new Promise((res) => setTimeout(res, 250));
  }
}

/** POST .../api/flows/:key/runs: a real run of the Flow's approved version, as the member, on the team's keys. */
export async function startAppRun(app: App, actor: Member, o: OpenedApp, key: string, inputs: unknown, wait: number) {
  const f = o.flows.find((x) => x.key === key);
  if (!f) throw notFound('flow');
  const gaps = await teamCredentialGaps(app, o.app.team_id, [f]);
  if (gaps.length) throw new AppError('app_needs_team_credentials', 409, gaps.map(gapText).join('; '));
  const runId = await app.engine.startRun(f.versionId, actor.id, inputs ?? {}, { actorId: actor.id, appId: o.app.id, ...(f.retired ? { readsOnly: true } : {}) });
  await settle(app, runId, Math.min(20, Math.max(0, wait)));
  const run = await app.engine.appRunView(runId, o.app.id, actor);
  return { runId, status: run.status, runToken: '', run: { ...run, flow: keyOf(o, run.flowVersionId) } };
}

export async function appRun(app: App, actor: Member, o: OpenedApp, runId: string) {
  const run = await app.engine.appRunView(runId, o.app.id, actor);
  return { ...run, flow: keyOf(o, run.flowVersionId) };
}

/** GET .../api/runs: the app's recent runs, everyone's (the app is the team's). */
export async function appRuns(app: App, o: OpenedApp, flowKey: string | undefined, limit: number) {
  const f = flowKey ? o.flows.find((x) => x.key === flowKey) : undefined;
  if (flowKey && !f) return { runs: [] };
  const { rows } = await app.db.query<{ id: string; flow_id: string; status: string; wait_reason: string | null; created_at: Date; finished_at: Date | null; handle: string }>(
    `SELECT r.id, v.flow_id, r.status, r.wait_reason, r.created_at, r.finished_at, m.handle
     FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN members m ON m.id = r.run_as
     WHERE r.app_id = $1 AND ($2::uuid IS NULL OR v.flow_id = $2) ORDER BY r.created_at DESC LIMIT $3`,
    [o.app.id, f?.flowId ?? null, Math.min(100, Math.max(1, limit))],
  );
  const byFlow = new Map(o.flows.map((x) => [x.flowId, x.key]));
  return { runs: rows.map((r) => ({ id: r.id, flow: byFlow.get(r.flow_id) ?? null, status: r.status, waitReason: r.wait_reason, createdAt: r.created_at, finishedAt: r.finished_at, startedBy: r.handle })) };
}

/** GET .../api/inbox: the app's steps this member can act on: sign-offs (approvers) and their own runs' forms. */
export async function appInbox(app: App, actor: Member, o: OpenedApp) {
  const { rows } = await app.db.query<{ id: string; run_as: string }>(
    `SELECT id, run_as FROM runs WHERE app_id = $1 AND status = 'waiting' ORDER BY created_at LIMIT 100`,
    [o.app.id],
  );
  const items = [];
  for (const r of rows) {
    const mine = r.run_as === actor.id;
    const decides = canApprove(actor) && (app.config.mode === 'local' || !mine);
    if (!mine && !decides) continue;
    const run = await app.engine.appRunView(r.id, o.app.id, actor);
    for (const w of run.waiting) {
      if ((w.kind === 'approval' && decides) || (w.kind === 'input' && mine)) items.push({ runId: run.id, flow: keyOf(o, run.flowVersionId), createdAt: run.createdAt, ...w });
    }
  }
  return { items };
}

/** A run of this app (so the app's pages cannot reach other runs). */
async function assertAppRun(app: App, o: OpenedApp, runId: string) {
  const r = (await app.db.query<{ app_id: string | null }>(`SELECT app_id FROM runs WHERE id = $1`, [runId])).rows[0];
  if (!r || r.app_id !== o.app.id) throw notFound('run');
}

export async function decideAppStep(app: App, actor: Member, o: OpenedApp, runId: string, stepId: string, decision: 'approved' | 'rejected', valuesSha256?: string) {
  await assertAppRun(app, o, runId);
  await app.engine.decideGate(runId, stepId, actor, decision, valuesSha256);
}

export async function answerAppStep(app: App, actor: Member, o: OpenedApp, runId: string, stepId: string, values: Record<string, unknown>) {
  await assertAppRun(app, o, runId);
  await app.engine.submitInput(runId, stepId, actor, values);
}

// ---- a new Flow version and the apps that use it

export interface AppImpact {
  appId: string;
  name: string;
  /** Pages, fields and steps of the app's live version the new Flow version breaks; empty when it still fits. */
  problems: string[];
  /** The app pins another version of this Flow: the new one does not reach it. */
  pinned: boolean;
}

/**
 * What approving a new version of a Flow does to the apps of its team: an app following the Flow (no pin)
 * switches to it, so its live pages are checked against it; an app pinning another version is listed, unaffected.
 */
export async function appImpact(app: App, flowId: string, definition: FlowDefinition): Promise<AppImpact[]> {
  const { rows } = await app.db.query<{ app_id: string; name: string; team_id: string; spec: AppSpec }>(
    `SELECT a.id AS app_id, a.name, a.team_id, v.spec FROM apps a JOIN app_versions v ON v.app_id = a.id AND v.status = 'approved'
     WHERE a.archived_at IS NULL AND v.spec->'flows' @> $1::jsonb ORDER BY a.name`,
    [JSON.stringify([{ flowId }])],
  );
  const out: AppImpact[] = [];
  for (const r of rows) {
    const ref = r.spec.flows.find((f) => f.flowId === flowId)!;
    if (ref.versionId) {
      out.push({ appId: r.app_id, name: r.name, problems: [], pinned: true });
      continue;
    }
    // The app's live pages against the new version (the Flow may have no approved version while it waits).
    const { flows } = await appFlows(app, r.team_id, r.spec.flows, { flowId, definition });
    const key = flows.find((f) => f.flowId === flowId)?.key;
    const problems = checkPlan(r.spec.plan, await plannerFlows(app, flows)).filter((p) => !key || p.includes(key) || pagesOf(r.spec.plan, key).some((id) => p.startsWith(`page ${id} `)));
    out.push({ appId: r.app_id, name: r.name, problems, pinned: false });
  }
  return out;
}

/** Ids of the pages of a plan that run a Flow (by its key in the app). */
function pagesOf(plan: UiPlan, key: string): string[] {
  return plan.pages.filter((p) => 'flow' in p && p.flow === key).map((p) => p.id);
}

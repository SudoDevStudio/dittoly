import { z } from 'zod';
import type { App } from '../app.js';
import { withAiContext } from '../ai/metering.js';
import type { AiImage } from '../ai/provider.js';
import { audit } from '../core/audit.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { collectBundle, exportBody, type AppBundle, type ExportBody } from './bundle.js';
import { bundleFiles } from './files.js';
import { exportChanges, outdated, snapshotOf, type ExportChanges, type ExportSnapshot } from './updates.js';
import { checkPlan, defaultPlan, draftPlan, planFlows, uiPlanSchema, type UiPlan } from './frontend/plan.js';
import { tarGz, type TarFile } from './tar.js';
import { brandInput, contrast, DEFAULT_BRAND, deriveTheme, type BrandInput, type Theme } from './theme.js';

/**
 * Exporting apps from the portal: brand themes kept for reuse, a preview of what an export
 * needs, the AI's page plan, and the download. Admins and approvers.
 */

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest('invalid_export', r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  return r.data;
}

const canExport = (m: Member) => m.role === 'admin' || m.role === 'approver';
const requireExporter = (m: Member) => {
  if (!canExport(m)) throw forbidden('export_admin_or_approver');
};

// ---- brand themes

export const themeBody = z.object({ name: z.string().trim().min(1).max(60), brand: brandInput }).strict();

export async function listThemes(db: App['db'], actor: Member) {
  requireExporter(actor);
  const rows = (await db.query<{ id: string; name: string; brand: BrandInput; updated_at: Date }>(`SELECT id, name, brand, updated_at FROM brand_themes ORDER BY name`)).rows;
  return rows.map((r) => ({ id: r.id, name: r.name, brand: r.brand, theme: deriveTheme(r.brand), updatedAt: r.updated_at }));
}

export async function saveTheme(db: App['db'], actor: Member, body: z.infer<typeof themeBody>, id?: string) {
  requireExporter(actor);
  const row = id
    ? (await db.query<{ id: string }>(`UPDATE brand_themes SET name = $2, brand = $3, updated_at = now() WHERE id = $1 RETURNING id`, [id, body.name, JSON.stringify(body.brand)])).rows[0]
    : (await db.query<{ id: string }>(`INSERT INTO brand_themes (name, brand, created_by) VALUES ($1, $2, $3) RETURNING id`, [body.name, JSON.stringify(body.brand), actor.id])).rows[0];
  if (!row) throw notFound('brand_theme');
  await audit(db, { actorId: actor.id, action: id ? 'brand_theme.updated' : 'brand_theme.created', subjectType: 'org', subjectId: row.id, outcome: 'ok' });
  return { id: row.id, theme: deriveTheme(body.brand) };
}

export async function deleteTheme(db: App['db'], actor: Member, id: string) {
  requireExporter(actor);
  if (!(await db.query(`DELETE FROM brand_themes WHERE id = $1`, [id])).rowCount) throw notFound('brand_theme');
  await audit(db, { actorId: actor.id, action: 'brand_theme.deleted', subjectType: 'org', subjectId: id, outcome: 'ok' });
}

export const paletteBody = z.object({ name: z.string().trim().min(1).max(60), primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), description: z.string().trim().max(400).default('') }).strict();

/** The organization's AI proposes brand colours; the theme still enforces contrast, whatever it proposes. */
export async function suggestPalette(app: App, actor: Member, body: z.infer<typeof paletteBody>): Promise<{ brand: BrandInput; theme: Theme; explanation: string }> {
  requireExporter(actor);
  if (!app.ai) throw badRequest('ai_not_configured');
  const out = await withAiContext({ memberId: actor.id, purpose: 'other' }, () =>
    app.ai!.generateJson({
      system: 'You propose brand colours for a small web app. Return a primary and an accent colour as #rrggbb, a font style (one of system, humanist, geometric, serif, rounded, mono), a corner style (none, small, medium, large), and one sentence on why. Prefer colours that read well on white and on near-black.',
      prompt: `App: ${body.name}\n${body.primary ? `Their main colour: ${body.primary}\n` : ''}What it is about: ${body.description || '(not given)'}`,
      schema: { type: 'object', properties: { primary: { type: 'string' }, accent: { type: 'string' }, font: { type: 'string' }, radius: { type: 'string' }, explanation: { type: 'string' } }, required: ['primary', 'accent', 'font', 'radius', 'explanation'], additionalProperties: false },
    }),
  );
  const hex = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback);
  const parsed = brandInput.safeParse({
    name: body.name,
    primary: body.primary ?? hex(out.primary, DEFAULT_BRAND.primary),
    accent: hex(out.accent, '#c2410c'),
    font: out.font,
    radius: out.radius,
  });
  const brand = parsed.success ? parsed.data : { ...DEFAULT_BRAND, name: body.name, primary: body.primary ?? hex(out.primary, DEFAULT_BRAND.primary) };
  return { brand, theme: deriveTheme(brand), explanation: String(out.explanation ?? '').slice(0, 300) };
}

// ---- exports

async function themeFor(app: App, body: ExportBody): Promise<Theme | null> {
  if (body.kind !== 'ui' && body.kind !== 'custom') return null;
  if (!body.themeId) return deriveTheme({ ...(body.brand ?? DEFAULT_BRAND), name: body.name });
  const row = (await app.db.query<{ brand: BrandInput }>(`SELECT brand FROM brand_themes WHERE id = $1`, [body.themeId])).rows[0];
  if (!row) throw notFound('brand_theme');
  return deriveTheme({ ...row.brand, name: body.name });
}

/** The plan the export will use: the one given (checked), or the default one. */
function planFor(bundle: AppBundle, given: unknown): UiPlan {
  const flows = planFlows(bundle.flows, bundle.modules);
  if (given === undefined || given === null) return defaultPlan(flows);
  const parsed = uiPlanSchema.safeParse(given);
  if (!parsed.success) throw badRequest('invalid_plan', parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const problems = checkPlan(parsed.data, flows);
  if (problems.length) throw badRequest('invalid_plan', problems.join('; '));
  return parsed.data;
}

/** What an export would contain and need, without making it. */
export async function previewExport(app: App, actor: Member, raw: unknown) {
  const body = parseBody(exportBody, raw);
  const bundle = await collectBundle(app, actor, body, { theme: await themeFor(app, body), plan: null, preview: true });
  const flows = planFlows(bundle.flows, bundle.modules);
  return {
    name: bundle.name,
    kind: bundle.kind,
    flows: bundle.flows.map((f) => ({ key: f.key, name: f.name, access: f.access, exposed: f.exposed, version: f.version })),
    modules: bundle.modules.map((m) => `${m.name}@${m.version}`),
    schedules: bundle.schedules.map((s) => ({ flow: s.flow, cron: s.cron, timezone: s.timezone })),
    hooks: bundle.hooks.map((h) => ({ flow: h.flow, provider: h.provider, env: h.env })),
    tables: bundle.tables.map((t) => t.name),
    env: bundle.env,
    needs: bundle.needs,
    theme: bundle.theme,
    defaultPlan: defaultPlan(flows),
  };
}

export const planBody = z
  .object({
    export: z.unknown(),
    brief: z.string().trim().max(2000).optional(),
    /** A layout sketch or screenshot, as a data URL (PNG, JPEG, WebP or GIF, at most 4 MB). */
    image: z.string().max(5_600_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/).optional(),
    nav: z.enum(['sidebar-left', 'sidebar-right', 'top', 'none']).optional(),
  })
  .strict();

/**
 * The page plan from the app's Flows: drafted by the organization's AI from the brief and
 * layout image when there is one, otherwise the default plan (no AI, nothing sent anywhere).
 */
export async function planExport(app: App, actor: Member, raw: unknown): Promise<{ plan: UiPlan; explanation: string; ai: boolean }> {
  const req = parseBody(planBody, raw);
  const body = parseBody(exportBody, req.export);
  const bundle = await collectBundle(app, actor, body, { theme: null, plan: null, preview: true });
  const flows = planFlows(bundle.flows, bundle.modules);
  if (!req.brief && !req.image) {
    return { plan: defaultPlan(flows, req.nav ? { nav: req.nav } : {}), explanation: 'The default layout: a page for each Flow.', ai: false };
  }
  if (!app.ai) throw badRequest('ai_not_configured', 'a brief or layout image needs the organization AI; leave both out for the default layout');
  let image: AiImage | undefined;
  if (req.image) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(req.image)!;
    if (Buffer.byteLength(m[2]!, 'base64') > 4_000_000) throw badRequest('image_too_large');
    image = { mediaType: m[1] as AiImage['mediaType'], data: m[2]! };
  }
  const brief = [req.brief, req.nav ? `Navigation: ${req.nav}.` : ''].filter(Boolean).join(' ');
  const out = await withAiContext({ memberId: actor.id, purpose: 'other' }, () => draftPlan(app.ai!, flows, { appName: body.name, brief, image }));
  return { ...out, ai: true };
}

/** Build the bundle and its archive; recorded and audited. */
export async function createExport(app: App, actor: Member, raw: unknown): Promise<{ bundle: AppBundle; archive: Buffer; filename: string }> {
  const body = parseBody(exportBody, raw);
  requireExporter(actor);
  const theme = await themeFor(app, body);
  const draft = await collectBundle(app, actor, body, { theme, plan: null, preview: true });
  // The built-in UI uses a given layout too (an app made in Dittoly); without one, a page per Flow.
  const plan = body.kind === 'custom' || (body.kind === 'ui' && body.plan != null) ? planFor(draft, body.plan) : null;
  const bundle = await collectBundle(app, actor, body, { theme, plan });
  const archive = tarGz(bundleFiles(bundle));
  await app.db.query(
    `INSERT INTO app_exports (name, kind, framework, flow_versions, sha256, created_by, request, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      bundle.name,
      bundle.kind,
      bundle.frontend?.framework ?? null,
      bundle.flows.map((f) => f.sourceVersionId),
      bundle.sha256,
      actor.id,
      // The request as made (with the layout it used), so the same app can be exported again later.
      JSON.stringify({ ...body, plan: plan ?? undefined }),
      JSON.stringify(snapshotOf(bundle)),
    ],
  );
  return { bundle, archive, filename: `${bundle.slug}.tar.gz` };
}

type ExportRecord = { id: string; name: string; request: ExportBody | null; snapshot: ExportSnapshot | null };

export async function listExports(db: App['db'], actor: Member) {
  requireExporter(actor);
  const rows = (
    await db.query<{ id: string; name: string; kind: string; framework: string | null; sha256: string; createdAt: Date; createdBy: string | null; flows: number; request: ExportBody | null; snapshot: ExportSnapshot | null }>(
      `SELECT e.id, e.name, e.kind, e.framework, e.sha256, e.created_at AS "createdAt", m.handle AS "createdBy", cardinality(e.flow_versions) AS flows, e.request, e.snapshot
       FROM app_exports e LEFT JOIN members m ON m.id = e.created_by ORDER BY e.created_at DESC LIMIT 50`,
    )
  ).rows;
  const stale = await outdated(db, rows);
  return rows.map(({ request, snapshot, ...r }) => ({ ...r, reexportable: !!(request && snapshot), updates: stale.get(r.id) ?? null }));
}

async function exportRecord(db: App['db'], id: string): Promise<ExportRecord> {
  const row = (await db.query<ExportRecord>(`SELECT id, name, request, snapshot FROM app_exports WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound('app_export');
  return row;
}

/** What exporting this app again would change: newer Flow versions, their steps, modules, settings. */
export async function reviewExport(app: App, actor: Member, id: string): Promise<ExportChanges> {
  requireExporter(actor);
  return exportChanges(app, actor, await exportRecord(app.db, id));
}

/** Export the same app again, from the Flows' current approved versions. */
export async function reexport(app: App, actor: Member, id: string) {
  requireExporter(actor);
  const row = await exportRecord(app.db, id);
  if (!row.request) throw badRequest('export_not_reexportable', 'this export was made before re-exporting existed; make a new export');
  return createExport(app, actor, row.request);
}

/** For tests and the portal: a theme's text contrast, worst case. */
export const worstContrast = (t: Theme) => Math.min(contrast(t.light.text, t.light.bg), contrast(t.light.onPrimary, t.light.primary), contrast(t.dark.text, t.dark.bg), contrast(t.dark.onPrimary, t.dark.primary), contrast(t.light.link, t.light.surface), contrast(t.dark.link, t.dark.surface));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { App } from '../app.js';
import { audit } from '../core/audit.js';
import { canonicalJson, sha256Hex } from '../core/crypto.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Manifest } from '../modules/manifest.js';
import { appEnv, credentialEnv, hookEnv, settingEnv, type EnvVar } from './env.js';
import { brandInput, type Theme } from './theme.js';
import type { UiPlan } from './frontend/plan.js';
import { ROOT } from '../paths.js';

/** This Dittoly's version, written into bundles. */
export const DITTOLY_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * What an exported app is made from: approved Flows with the exact approved module code they pin.
 * The export writes it out as a TypeScript project (codegen/), the Flows as code. Nothing secret
 * is in it: settings, credentials, the AI key and webhook secrets become environment variables,
 * listed in `env`.
 */

export const BUNDLE_FORMAT = 'dittoly.app/2';
export const APP_KINDS = ['runner', 'api', 'ui', 'custom'] as const;
export type AppKind = (typeof APP_KINDS)[number];
export const FRAMEWORKS = ['react', 'next', 'angular', 'astro', 'vue'] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export interface BundleFlow {
  /** URL-safe name: /api/flows/<key>/runs. */
  key: string;
  name: string;
  description: string;
  sourceFlowId: string;
  sourceVersionId: string;
  version: number;
  definition: Record<string, unknown>;
  /** public: anyone may start it (rate limited); token: needs APP_API_TOKEN. */
  access: 'public' | 'token';
  /** False for Flows only included because another Flow runs them. */
  exposed: boolean;
  /** Steps that wait for a sign-off because text an AI wrote could steer them (src/flows/injection.ts). */
  guarded: string[];
}
export interface BundleModule { name: string; version: string; manifest: Manifest; code: string; codeSha256: string; tests: unknown[] }
export interface BundleSchedule { flow: string; cron: string; timezone: string; inputs: unknown }
export interface BundleHook { flow: string; provider: string; payloadSchema: unknown; inputMap: Record<string, string>; rateLimitPerMinute: number; env: string }
export interface BundleTable { name: string; description: string | null; keyColumn: string; columns: unknown[] }

export interface AppBundle {
  format: typeof BUNDLE_FORMAT;
  name: string;
  slug: string;
  kind: AppKind;
  exportedAt: string;
  dittolyVersion: string;
  flows: BundleFlow[];
  modules: BundleModule[];
  schedules: BundleSchedule[];
  hooks: BundleHook[];
  tables: BundleTable[];
  env: EnvVar[];
  /** state: a Flow waits for a person, waits a while or uses a table, so runs must outlive a restart (STATE_URL). */
  needs: { ai: boolean; humanSteps: boolean; state: boolean };
  theme: Theme | null;
  frontend: { framework: Framework; plan: UiPlan } | null;
  /** The built-in UI's page plan when one was given (an app made in Dittoly); otherwise a page per Flow. */
  uiPlan: UiPlan | null;
  /** sha256 of everything above, canonical JSON. */
  sha256: string;
}

export const exportBody = z
  .object({
    name: z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f\u007f\u2028\u2029]*$/, 'one line of text'),
    kind: z.enum(APP_KINDS),
    flows: z.array(z.object({ flowId: z.string().uuid(), access: z.enum(['public', 'token']).default('token') }).strict()).min(1).max(20),
    framework: z.enum(FRAMEWORKS).optional(),
    /** A brand theme saved earlier, or none (the default theme). */
    themeId: z.string().uuid().optional(),
    /** A brand given directly (an app made in Dittoly carries its own), used when no saved theme is named. */
    brand: brandInput.optional(),
    /** The frontend layout (from /api/app-exports/plan); a default one is made when it is left out. */
    plan: z.unknown().optional(),
    includeSchedules: z.boolean().default(true),
    includeWebhooks: z.boolean().default(true),
  })
  .strict();
export type ExportBody = z.infer<typeof exportBody>;

export const slugify = (s: string, fallback = 'app') =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;

/** Every `"module": "name@x.y.z"` a definition refers to (action steps, live form options). */
function moduleRefs(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => moduleRefs(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'module' && typeof x === 'string' && /^[a-z][a-z0-9-]{1,39}@\d+\.\d+\.\d+$/.test(x)) out.add(x);
      else moduleRefs(x, out);
    }
  }
  return out;
}

type Step = { id: string; type: string; delegateTo?: string; ai?: string; provider?: string; table?: string; runs?: { flow: string; version: number }[] };
const stepsOf = (d: Record<string, unknown>) => (d.steps as Step[] | undefined) ?? [];

/** What can't run outside Dittoly: one line per reason, naming the steps it applies to. */
function unsupported(flowName: string, d: Record<string, unknown>): string[] {
  const why = new Map<string, string[]>();
  const add = (reason: string, id: string) => why.set(reason, [...(why.get(reason) ?? []), id]);
  for (const s of stepsOf(d)) {
    if (s.type === 'app') add("building and running an app from git needs Dittoly's build sandbox", s.id);
    if (s.type === 'fix') add("fixing and verifying code needs Dittoly's build sandbox, which exported apps do not include", s.id);
    if (s.delegateTo) add('handing a step to a teammate needs people, and an exported app has one identity', s.id);
    if (s.type === 'browse') add('the AI-guided browser is not included in exported apps', s.id);
    if (s.type === 'table' && (s as { op?: string }).op === 'claim') add('claiming a table key needs Dittoly\'s database', s.id);
  }
  return [...why].map(([reason, ids]) => `${flowName}: ${reason} (${ids.length === 1 ? 'step' : 'steps'} ${ids.join(', ')})`);
}

/** Gather an export: only approved versions and approved modules. Admins and approvers. */
export async function collectBundle(app: App, actor: Member, body: ExportBody, opts: { theme: Theme | null; plan: UiPlan | null; preview?: boolean }): Promise<AppBundle> {
  if (actor.role !== 'admin' && actor.role !== 'approver') throw forbidden('export_admin_or_approver');
  if (body.kind === 'custom' && !body.framework) throw badRequest('framework_required');
  const db = app.db;
  const flows: BundleFlow[] = [];
  const problems: string[] = [];
  const keys = new Set<string>();
  const byVersion = new Map<string, BundleFlow>();
  let teamId: string | null = null;

  const add = async (row: { flow_id: string; id: string; version: number; definition: Record<string, unknown>; name: string; team_id: string }, access: 'public' | 'token', exposed: boolean) => {
    const existing = byVersion.get(row.id);
    if (existing) {
      if (exposed) Object.assign(existing, { exposed: true, access });
      return;
    }
    teamId ??= row.team_id;
    if (row.team_id !== teamId) problems.push(`${row.name}: every Flow of an app must belong to the same team`);
    let key = slugify(row.name, 'flow');
    for (let i = 2; keys.has(key); i++) key = `${slugify(row.name, 'flow').slice(0, 36)}-${i}`;
    keys.add(key);
    const f: BundleFlow = {
      key,
      name: row.name,
      description: typeof row.definition.description === 'string' ? row.definition.description : '',
      sourceFlowId: row.flow_id,
      sourceVersionId: row.id,
      version: row.version,
      definition: row.definition,
      access,
      exposed,
      guarded: await app.flows.guardedSteps(app.db, (await app.flows.getVersion(app.db, row.id))!),
    };
    byVersion.set(row.id, f);
    flows.push(f);
    problems.push(...unsupported(row.name, row.definition));
    // Flows this one runs come along, at the exact versions it pins.
    for (const s of stepsOf(row.definition)) {
      for (const r of s.type === 'flow' ? (s.runs ?? []) : []) {
        const child = (
          await db.query(
            `SELECT v.flow_id, v.id, v.version, v.definition, f.name, f.team_id FROM flow_versions v JOIN flows f ON f.id = v.flow_id
             WHERE v.flow_id = $1 AND v.version = $2 AND v.status IN ('approved', 'superseded')`,
            [r.flow, r.version],
          )
        ).rows[0];
        if (!child) problems.push(`${row.name}: step ${s.id} runs a Flow version that is not approved`);
        else await add(child, 'token', false);
      }
    }
  };

  for (const req of body.flows) {
    const row = (
      await db.query(
        `SELECT v.flow_id, v.id, v.version, v.definition, f.name, f.team_id FROM flow_versions v JOIN flows f ON f.id = v.flow_id
         WHERE v.flow_id = $1 AND v.status = 'approved'`,
        [req.flowId],
      )
    ).rows[0];
    if (!row) {
      const exists = (await db.query(`SELECT 1 FROM flows WHERE id = $1`, [req.flowId])).rowCount;
      if (!exists) throw notFound('flow');
      problems.push(`flow ${req.flowId} has no approved version`);
      continue;
    }
    await add(row, req.access, true);
  }

  // Modules, exactly as approved.
  const modules: BundleModule[] = [];
  for (const ref of [...new Set(flows.flatMap((f) => [...moduleRefs(f.definition)]))].sort()) {
    const [name, version] = ref.split('@') as [string, string];
    const m = (
      await db.query<{ manifest: Manifest; code: string; code_sha256: string; tests: unknown[]; status: string; origin: string }>(
        `SELECT manifest, code, code_sha256, tests, status, origin FROM module_versions WHERE name = $1 AND version = $2`,
        [name, version],
      )
    ).rows[0];
    if (!m || m.status !== 'approved') problems.push(`module ${ref} is not approved`);
    else if (m.origin === 'mcp') problems.push(`module ${ref} comes from an MCP server, which exported apps cannot connect to yet`);
    else if (m.manifest.browser) problems.push(`module ${ref} drives a browser, which exported apps do not include`);
    else modules.push({ name, version, manifest: m.manifest, code: m.code, codeSha256: m.code_sha256, tests: m.tests });
  }
  if (problems.length) throw badRequest('export_not_possible', [...new Set(problems)].join('\n'));

  // Data tables the Flows use: their columns, not their rows.
  const tables: BundleTable[] = [];
  for (const name of [...new Set(flows.flatMap((f) => stepsOf(f.definition).filter((s) => s.type === 'table').map((s) => s.table!)))]) {
    const t = (await db.query(`SELECT name, description, key_column, columns FROM data_tables WHERE team_id = $1 AND name = $2`, [teamId, name])).rows[0];
    if (!t) throw badRequest('export_not_possible', `table ${name} does not exist in the Flows' team`);
    tables.push({ name: t.name, description: t.description, keyColumn: t.key_column, columns: t.columns });
  }

  const versionIds = flows.map((f) => f.sourceVersionId);
  const keyOf = (versionId: string) => byVersion.get(versionId)!.key;
  const schedules: BundleSchedule[] = [];
  if (body.includeSchedules) {
    for (const s of (await db.query(`SELECT id, flow_version_id, cron, timezone, inputs_enc FROM schedules WHERE flow_version_id = ANY($1) AND enabled`, [versionIds])).rows) {
      schedules.push({ flow: keyOf(s.flow_version_id), cron: s.cron, timezone: s.timezone, inputs: app.cipher.decryptJson(s.inputs_enc, `schedule:${s.id}:inputs`) });
    }
  }
  const hooks: BundleHook[] = [];
  if (body.includeWebhooks) {
    for (const t of (await db.query(`SELECT flow_version_id, provider, payload_schema, input_map, rate_limit_per_minute FROM triggers WHERE flow_version_id = ANY($1)`, [versionIds])).rows) {
      const flow = keyOf(t.flow_version_id);
      if (hooks.some((h) => h.flow === flow)) continue;
      hooks.push({ flow, provider: t.provider, payloadSchema: t.payload_schema, inputMap: t.input_map, rateLimitPerMinute: t.rate_limit_per_minute, env: hookEnv(flow) });
    }
  }

  // What the app needs from its environment.
  const allSteps = flows.flatMap((f) => stepsOf(f.definition));
  // A sign-off before a step that text an AI wrote could steer is a step that waits for a person too.
  const humanSteps = allSteps.some((s) => s.type === 'approval' || s.type === 'input') || flows.some((f) => f.guarded.length > 0);
  const state = humanSteps || allSteps.some((s) => s.type === 'delay' || s.type === 'table');
  const orgAi = allSteps.some((s) => (s.type === 'ai' || s.type === 'browse') && s.ai === 'organization');
  const env: EnvVar[] = appEnv({ tokenFlows: flows.some((f) => f.exposed && f.access === 'token'), humanSteps, hasApi: body.kind !== 'runner', state });
  for (const m of modules) {
    // Each Flow gives the module its values; an exported app asks for them as environment variables.
    const values: Record<string, string> = {};
    for (const f of flows) {
      for (const step of stepsOf(f.definition)) {
        const action = step as Step & { module?: string; settings?: Record<string, string> };
        if (action.type !== 'action' || !action.module?.startsWith(`${m.name}@`)) continue;
        Object.assign(values, (f.definition as { moduleSettings?: Record<string, Record<string, string>> }).moduleSettings?.[m.name] ?? {}, action.settings ?? {});
      }
    }
    for (const st of m.manifest.settings ?? []) {
      const name = settingEnv(m.name, st.id);
      if (env.some((v) => v.name === name)) continue;
      env.push({
        name,
        kind: 'setting',
        required: st.type === 'host',
        secret: false,
        description: `${m.manifest.title}: ${st.label}${st.type === 'host' ? ` (a host matching ${st.pattern})` : st.type === 'certificate' ? ' (PEM CA certificate; easiest as _FILE)' : ''}`,
        example: st.type === 'certificate' ? undefined : (values[st.id] ?? ('default' in st ? st.default : undefined)),
        module: m.name,
        setting: st.id,
      });
    }
  }
  const services = new Map<string, { label: string; placement: string; optional: boolean; modules: string[] }>();
  for (const m of modules) {
    for (const c of m.manifest.credentials) {
      const used = m.manifest.actions.some((a) => a.credentials.includes(c.id));
      if (!used) continue;
      const cur = services.get(c.service);
      services.set(c.service, { label: cur?.label ?? c.label, placement: c.placement.type, optional: (cur?.optional ?? true) && c.optional === true, modules: [...(cur?.modules ?? []), m.manifest.title] });
    }
  }
  for (const s of allSteps.filter((x) => (x.type === 'ai' || x.type === 'browse') && x.ai === 'runner')) {
    const service = s.provider ?? 'openai';
    if (!services.has(service)) services.set(service, { label: `${service === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key for AI steps`, placement: 'bearer', optional: false, modules: ['AI steps'] });
  }
  for (const [service, s] of services) {
    const how = s.placement === 'basic' ? ' as username:password' : s.placement === 'google_service_account' ? ': the service account JSON key (easiest as _FILE)' : '';
    env.push({ name: credentialEnv(service), kind: 'credential', required: !s.optional, secret: true, description: `${s.label} (${s.modules.join(', ')})${how}`, service });
  }
  if (orgAi) {
    env.push(
      { name: 'AI_PROVIDER', kind: 'ai', required: true, secret: false, description: 'anthropic, openai or ollama: the AI that AI and browse steps use.', example: app.config.aiProvider === 'openai' || app.config.aiProvider === 'ollama' ? app.config.aiProvider : 'anthropic' },
      { name: 'AI_API_KEY', kind: 'ai', required: false, secret: true, description: 'The API key for AI_PROVIDER (not needed for ollama).' },
      { name: 'AI_MODEL', kind: 'ai', required: false, secret: false, description: 'Model name; the provider default when empty (required for ollama).', example: app.config.aiModel ?? undefined },
      { name: 'OLLAMA_URL', kind: 'ai', required: false, secret: false, description: 'Ollama server address, for AI_PROVIDER=ollama.' },
    );
  }
  for (const h of hooks) env.push({ name: h.env, kind: 'hook', required: true, secret: true, description: `Signing secret for the ${h.flow} webhook (${h.provider}); senders sign with it.`, flow: h.flow });

  const content = {
    format: BUNDLE_FORMAT,
    name: body.name,
    slug: slugify(body.name),
    kind: body.kind,
    exportedAt: new Date().toISOString(),
    dittolyVersion: DITTOLY_VERSION,
    flows,
    modules,
    schedules,
    hooks,
    tables,
    env,
    needs: { ai: orgAi, humanSteps, state },
    theme: body.kind === 'ui' || body.kind === 'custom' ? opts.theme : null,
    frontend: body.kind === 'custom' && body.framework && opts.plan ? { framework: body.framework, plan: opts.plan } : null,
    uiPlan: body.kind === 'ui' ? opts.plan : null,
  } as const;
  const bundle: AppBundle = { ...content, sha256: sha256Hex(canonicalJson(content)) };
  if (!opts.preview) await audit(db, { actorId: actor.id, action: 'app.exported', subjectType: 'org', subjectId: bundle.sha256.slice(0, 32), outcome: 'ok' });
  return bundle;
}

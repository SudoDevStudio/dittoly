import { z } from 'zod';
import { withAiContext, type AiTally } from '../ai/metering.js';
import { audit } from '../core/audit.js';
import { tracked } from '../core/builds.js';
import type { Cipher } from '../core/crypto.js';
import { AppError, forbidden } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { notifyRole } from '../core/notify.js';
import type { Db, Queryable } from '../db/db.js';
import { recordSelfFix, selfFixEnabledBy, type ChangeFlow } from '../governance/changes.js';
import { parseFlowDefinition, type FlowDefinition } from '../flows/definition.js';
import type { FlowService } from '../flows/service.js';
import { playTest, type FlowTests } from '../flows/tests.js';
import type { ModuleChat } from './chat.js';
import { driftFeedback, type DriftSummary } from './health.js';
import type { ModuleRegistry } from './registry.js';

/**
 * Self-fixing Flows. When a module drifts (its app seems to have changed), Dittoly asks the
 * organization's AI for a fixed module version by itself, at most a few times a day, then:
 * - the fix runs the module's sandbox tests and the tests recorded against the real app;
 * - each approved Flow that uses the drifting version gets a proposed new version pinned to
 *   the fix, if the Flow's own tests pass against it; the approved version keeps running;
 * - everything goes for approval as usual. Nothing changes until people approve it;
 * - the whole of it is one change record (src/governance/changes.ts), which nobody who asked
 *   for it (by hand, or by turning self-fixing on) may approve.
 * AI is used only when something broke, which is the point: repeats cost nothing.
 */

const KEY = 'self_fix';
export const selfFixBody = z.object({ enabled: z.boolean(), perDay: z.number().int().min(1).max(50) }).strict();
export type SelfFixSettings = z.infer<typeof selfFixBody>;
const DEFAULTS: SelfFixSettings = { enabled: true, perDay: 3 };

export async function getSelfFix(db: Queryable): Promise<SelfFixSettings> {
  const row = (await db.query<{ value: Partial<SelfFixSettings> }>(`SELECT value FROM org_settings WHERE key = $1`, [KEY])).rows[0];
  return { ...DEFAULTS, ...(row?.value ?? {}) };
}

export async function setSelfFix(db: Queryable, actor: Member, next: SelfFixSettings): Promise<SelfFixSettings> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(next), actor.id],
  );
  await audit(db, { actorId: actor.id, action: next.enabled ? 'module.self_fix_on' : 'module.self_fix_off', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
  return next;
}

export interface SelfFixDeps {
  db: Db;
  modules: ModuleRegistry;
  moduleChat: ModuleChat;
  flows: FlowService;
  flowTests: FlowTests;
  /** Whether an organization AI is set up; without one nothing is attempted. */
  aiConfigured: boolean;
  /** With it, the fix shows as a build on the Builds page while the AI drafts it. */
  cipher?: Cipher;
}

export type FixedFlow = ChangeFlow;

/** Replace a pinned module ref everywhere in a definition. */
export function repin(def: FlowDefinition, from: string, to: string): unknown {
  const walk = (v: unknown): unknown =>
    v === from ? to : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(def);
}

const reasonOf = (err: unknown) => (err instanceof AppError ? (err.message !== err.code ? `${err.code}: ${err.message}` : err.code) : 'unexpected error').slice(0, 300);

/** New Flow versions pinned to the fix, for every approved Flow that uses the drifting version. */
async function proposeFlows(d: SelfFixDeps, module: string, fromVersion: string, toVersion: string): Promise<FixedFlow[]> {
  const from = `${module}@${fromVersion}`;
  const to = `${module}@${toVersion}`;
  const { rows } = await d.db.query<{ flow_id: string; name: string; definition: FlowDefinition }>(
    `SELECT v.flow_id, f.name, v.definition FROM flow_versions v JOIN flows f ON f.id = v.flow_id
     WHERE v.status = 'approved' AND strpos(v.definition::text, $1) > 0 ORDER BY f.name`,
    [JSON.stringify(from)],
  );
  const out: FixedFlow[] = [];
  for (const r of rows) {
    const next = repin(r.definition, from, to);
    const parsed = parseFlowDefinition(next);
    if (!parsed.ok) {
      out.push({ flowId: r.flow_id, name: r.name, status: 'needs_person', reason: parsed.issues.join('; ').slice(0, 300) });
      continue;
    }
    // The Flow's tests, played against the fixed module, must pass before anyone is asked.
    let passed = 0;
    const cases = await d.flowTests.casesFor(r.flow_id);
    try {
      const modules = await d.flows.pinnedModules(d.db, parsed.definition);
      const failing = cases.map((c) => ({ name: c.name, problems: playTest(parsed.definition, modules, c.case).problems })).filter((c) => c.problems.length);
      passed = cases.length - failing.length;
      if (failing.length) {
        out.push({ flowId: r.flow_id, name: r.name, status: 'needs_person', reason: `tests fail with the fix: ${failing.map((f) => `"${f.name}": ${f.problems[0]}`).join('; ')}`.slice(0, 300), tests: { total: cases.length, passed } });
        continue;
      }
      const v = await d.flows.proposeFix(r.flow_id, next, { module, fromVersion, toVersion, tests: { total: cases.length, passed } });
      out.push({ flowId: r.flow_id, name: r.name, versionId: v.id, status: 'proposed', tests: { total: cases.length, passed } });
    } catch (err) {
      out.push({ flowId: r.flow_id, name: r.name, status: 'needs_person', reason: reasonOf(err) });
    }
  }
  return out;
}

interface DriftRow {
  module_name: string;
  version: string;
  summary: DriftSummary;
  detected_at: Date;
}

/**
 * Ask the AI for a fixed version of a drifting module and, when it passes its tests, send it for
 * review and propose the affected Flows' new versions. Either way the result is a change record
 * (src/governance/changes.ts). The draft is authored by Dittoly itself; `requester` is the admin
 * who asked for it by hand, or who turned self-fixing on, and may not approve any part of it.
 * AI errors are thrown.
 */
export async function fixDrift(d: SelfFixDeps, drift: DriftRow, requester: { id: string | null; how: 'automatic' | 'by_hand' }) {
  const current = await d.modules.findByRef(d.db, drift.module_name, drift.version);
  if (!current) return null;
  const reason = driftFeedback(drift.summary);
  const tally: AiTally = { input: 0, output: 0 };
  const revise = () => d.moduleChat.revise(current.id, reason, null, { reason, fromVersion: drift.version });
  const draft = await withAiContext({ purpose: 'fix', memberId: requester.how === 'by_hand' ? (requester.id ?? undefined) : undefined, tally }, () =>
    d.cipher
      ? tracked({ db: d.db, cipher: d.cipher }, { memberId: requester.how === 'by_hand' ? requester.id : null, kind: 'module', source: 'self_fix', title: `Fix ${drift.module_name}: its app changed`, link: `/modules/${current.id}` }, revise)
      : revise(),
  );
  await audit(d.db, { actorId: requester.how === 'by_hand' ? requester.id : null, action: 'module.fix_drafted', subjectType: 'module', subjectId: draft.id, outcome: draft.validationReport?.passed ? 'ok' : 'failed', relatedId: current.id });
  await d.db.query(`UPDATE module_drift SET fix_version_id = $2 WHERE module_name = $1`, [drift.module_name, draft.id]);
  const sent = draft.validationReport?.passed === true;
  let flows: FixedFlow[] = [];
  if (!sent) {
    // Kept as a draft for an admin to look at or revise; not sent for review.
    await d.db.query(`UPDATE module_drift SET fix_error = 'the drafted fix does not pass its tests' WHERE module_name = $1`, [drift.module_name]);
    await notifyRole(d.db, ['admin'], 'module_fix_failed');
  } else {
    await d.modules.submit(draft.id, null);
    flows = await proposeFlows(d, drift.module_name, drift.version, draft.version);
    await d.db.query(`UPDATE module_drift SET fix_flows = $2 WHERE module_name = $1`, [drift.module_name, JSON.stringify(flows)]);
  }
  const changeId = await recordSelfFix(d.db, { from: current, fix: draft, drift: { detectedAt: drift.detected_at, summary: drift.summary }, tally, requester, flows, sent });
  return { draft, flows, changeId };
}

/**
 * Maintenance: for each new drift warning, draft a fix (within today's allowance), send it for
 * review, and propose the affected Flows' new versions. Each warning is tried once; an admin can
 * still ask for another fix by hand. Returns the modules a fix was drafted for.
 */
export async function runSelfFix(d: SelfFixDeps, now = new Date()): Promise<string[]> {
  if (!d.aiConfigured) return [];
  const settings = await getSelfFix(d.db);
  if (!settings.enabled) return [];
  const used = (await d.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'module.fix_drafted' AND actor_id IS NULL AND at > $1::timestamptz - interval '1 day'`, [now])).rows[0]!.n;
  let left = settings.perDay - used;
  const drifts = (
    await d.db.query<DriftRow>(
      `SELECT module_name, version, summary, detected_at FROM module_drift WHERE resolved_at IS NULL AND (fix_attempted_at IS NULL OR fix_attempted_at < detected_at) ORDER BY detected_at`,
    )
  ).rows;
  // Whoever turned self-fixing on asked for these fixes.
  const requester = { id: await selfFixEnabledBy(d.db), how: 'automatic' as const };
  const fixed: string[] = [];
  for (const drift of drifts) {
    if (left <= 0) break;
    const claimed = await d.db.query(
      `UPDATE module_drift SET fix_attempted_at = $2, fix_error = NULL, fix_version_id = NULL, fix_flows = '[]'
       WHERE module_name = $1 AND resolved_at IS NULL AND (fix_attempted_at IS NULL OR fix_attempted_at < detected_at)`,
      [drift.module_name, now],
    );
    if (!claimed.rowCount) continue;
    left--;
    let result;
    try {
      result = await fixDrift(d, drift, requester);
    } catch (err) {
      const error = reasonOf(err);
      await d.db.query(`UPDATE module_drift SET fix_error = $2 WHERE module_name = $1`, [drift.module_name, error]);
      await audit(d.db, { actorId: null, action: 'module.fix_drafted', subjectType: 'module', subjectId: drift.module_name, outcome: 'failed', errorType: err instanceof AppError ? err.code : 'unexpected' });
      await notifyRole(d.db, ['admin'], 'module_fix_failed');
      log.warn('self_fix_failed', { errorType: err instanceof AppError ? err.code : 'unexpected' });
      continue;
    }
    if (result?.draft.validationReport?.passed) fixed.push(drift.module_name);
  }
  return fixed;
}

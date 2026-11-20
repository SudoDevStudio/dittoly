import { audit } from '../core/audit.js';
import { AppError, badRequest } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Queryable } from '../db/db.js';
import { parseFlowDefinition, type FlowDefinition } from '../flows/definition.js';
import type { FlowService } from '../flows/service.js';
import { playTest, type FlowTests } from '../flows/tests.js';
import { repin } from './self-fix.js';
import { stepDetailAad } from '../engine/engine.js';

/**
 * "Have the AI fix <module>" on a stopped run: the fixed module version remembers the run and the version it replaces.
 * Once an admin approves it, the run's Flow gets a new version that uses it (when the Flow's tests pass with it), for
 * an approver to approve; the stopped run can then continue on that version. Other Flows keep their pinned version.
 */

export interface RunFixDeps {
  db: Queryable;
  flows: FlowService;
  flowTests: FlowTests;
  /** Drafts the Flow again when pinning the fixed module is not enough (no AI set up: the pin alone is tried). */
  flowChat?: { redraft(flowId: string, feedback: string): Promise<{ definition: unknown; explanation: string }> } | undefined;
  /** Reads what the failed step was refused for (run_steps.detail_enc), to tell the AI what to fix. */
  cipher?: { decrypt(value: string, aad: string): string } | undefined;
}

/** Records that `moduleVersionId` was drafted to fix `runId`'s use of `fromRef` ("name@version"), which the run's Flow pins. */
export async function markRunFix(db: Queryable, moduleVersionId: string, runId: string, fromRef: string): Promise<void> {
  const used = (await db.query<{ definition: FlowDefinition }>(`SELECT v.definition FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE r.id = $1`, [runId])).rows[0];
  if (!used || !JSON.stringify(used.definition).includes(JSON.stringify(fromRef))) throw badRequest('module_not_in_run', 'the run does not use this module version');
  await db.query(`UPDATE module_versions SET fix_for_run = $2, fix_from = $3 WHERE id = $1`, [moduleVersionId, runId, fromRef]);
}

export type RunFixOutcome =
  | { status: 'proposed'; flowVersionId: string; version: number; runId: string; redrafted: boolean }
  | { status: 'not_proposed'; reason: string; runId: string }
  | null;

/** After a module version is decided: when it is an approved run fix, propose the run's Flow on it. */
export async function proposeRunFix(d: RunFixDeps, moduleVersionId: string): Promise<RunFixOutcome> {
  const mv = (await d.db.query<{ name: string; version: string; status: string; fix_for_run: string | null; fix_from: string | null }>(
    `SELECT name, version, status, fix_for_run, fix_from FROM module_versions WHERE id = $1`,
    [moduleVersionId],
  )).rows[0];
  if (!mv || mv.status !== 'approved' || !mv.fix_for_run || !mv.fix_from) return null;
  const to = `${mv.name}@${mv.version}`;
  const flow = (await d.db.query<{ flow_id: string; owner: string }>(
    `SELECT v.flow_id, f.created_by AS owner FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id WHERE r.id = $1`,
    [mv.fix_for_run],
  )).rows[0];
  if (!flow) return null;
  const runId = mv.fix_for_run;
  const notProposed = async (reason: string): Promise<RunFixOutcome> => {
    await audit(d.db, { actorId: null, action: 'flow.run_fix_not_proposed', subjectType: 'module', subjectId: moduleVersionId, outcome: 'failed', relatedId: flow.flow_id, errorType: reason.slice(0, 60) });
    log.info('run_fix_not_proposed', { errorType: reason.slice(0, 60) });
    return { status: 'not_proposed', reason, runId };
  };
  // The Flow's newest approved version, so a change approved since the run is kept.
  const latest = (await d.db.query<{ definition: FlowDefinition }>(
    `SELECT definition FROM flow_versions WHERE flow_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1`,
    [flow.flow_id],
  )).rows[0];
  if (!latest) return notProposed('no_approved_version');
  const text = JSON.stringify(latest.definition);
  if (text.includes(JSON.stringify(to))) return notProposed('already_uses_it');
  if (!text.includes(JSON.stringify(mv.fix_from))) return notProposed('module_no_longer_used');
  const next = repin(latest.definition, mv.fix_from, to);
  const parsed = parseFlowDefinition(next);
  if (!parsed.ok) return notProposed('invalid_definition');
  const cases = await d.flowTests.casesFor(flow.flow_id);
  const plays = async (def: FlowDefinition) => {
    const modules = await d.flows.pinnedModules(d.db, def);
    return cases.filter((c) => playTest(def, modules, c.case).problems.length).length === 0;
  };
  const at = mv.fix_from.lastIndexOf('@');
  const fix = { module: mv.name, fromVersion: mv.fix_from.slice(at + 1), toVersion: mv.version, tests: { total: cases.length, passed: cases.length } };
  const propose = async (definition: unknown, redrafted: boolean): Promise<RunFixOutcome> => {
    try {
      const v = await d.flows.proposeFix(flow.flow_id, definition, { ...fix, ...(redrafted ? { redrafted: true } : {}) });
      return { status: 'proposed', flowVersionId: v.id, version: v.version, runId, redrafted };
    } catch (err) {
      return notProposed(err instanceof AppError ? err.code : 'unexpected');
    }
  };
  // The cheap way first: the same Flow on the new version. When its own examples still pass, nothing else is needed.
  if (await plays(parsed.definition)) return propose(next, false);
  // They do not: the fixed module asks for something else than the Flow sends it (that is often why the run failed
  // in the first place). Pinning it alone would fail the same way, so the AI adapts the Flow to the new version.
  if (!d.flowChat) return notProposed('flow_tests_fail');
  const redrafted = await redraft(d, flow.flow_id, mv, to, plays);
  if ('reason' in redrafted) return notProposed(redrafted.reason);
  return propose(redrafted.definition, true);
}

/**
 * Ask the AI for a version of the Flow that fits the fixed module: what it pins now, what the run was refused for
 * (the step's own words, where they were kept), and that everything else stays. A draft that does not parse, does
 * not use the new version, or still fails the Flow's own examples is thrown away — a fix nobody checked is worse
 * than none.
 */
async function redraft(
  d: RunFixDeps,
  flowId: string,
  mv: { name: string; fix_for_run: string | null; fix_from: string | null },
  to: string,
  plays: (def: FlowDefinition) => Promise<boolean>,
): Promise<{ definition: unknown } | { reason: string }> {
  const refused = mv.fix_for_run ? await refusalOf(d, mv.fix_for_run) : null;
  const feedback =
    `Dittoly fixed the module "${mv.name}": this Flow uses ${mv.fix_from} and must now use ${to}, whose actions may take different inputs.` +
    (refused ? ` In the run this fix came from, the step "${refused.stepId}" was refused: ${refused.why}` : '') +
    ` Change the steps that use this module so they fit ${to} (its actions, their inputs and outputs) and keep everything else exactly as it is: the other steps, the inputs, the form, the tables and the sign-offs.`;
  let out;
  try {
    out = await d.flowChat!.redraft(flowId, feedback);
  } catch (err) {
    log.info('run_fix_redraft_failed', { errorType: err instanceof AppError ? err.code : 'unexpected' });
    return { reason: 'redraft_failed' };
  }
  const parsed = parseFlowDefinition(out.definition);
  if (!parsed.ok) return { reason: 'redraft_invalid' };
  if (!JSON.stringify(parsed.definition).includes(JSON.stringify(to))) return { reason: 'redraft_does_not_use_it' };
  if (!(await plays(parsed.definition))) return { reason: 'redraft_tests_fail' };
  return { definition: out.definition };
}

/** What the run's failed step was refused for, in its own words, when they were kept. */
async function refusalOf(d: RunFixDeps, runId: string): Promise<{ stepId: string; why: string } | null> {
  const row = (await d.db.query<{ step_id: string; error_type: string | null; detail_enc: string | null }>(
    `SELECT step_id, error_type, detail_enc FROM run_steps WHERE run_id = $1 AND status = 'failed' ORDER BY idx LIMIT 1`,
    [runId],
  )).rows[0];
  if (!row?.error_type) return null;
  let detail: string | null = null;
  try {
    detail = row.detail_enc && d.cipher ? d.cipher.decrypt(row.detail_enc, stepDetailAad(runId, row.step_id)) : null;
  } catch {
    detail = null;
  }
  return { stepId: row.step_id, why: `${row.error_type.replace(/_/g, ' ')}${detail ? ` (${detail})` : ''}.` };
}

import { AppError, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';
import { repin } from '../modules/self-fix.js';
import { parseFlowDefinition, type FlowDefinition } from './definition.js';
import { playTest, type FlowTests } from './tests.js';
import type { FlowService, FlowVersion } from './service.js';

/**
 * A module a Flow pins has a newer approved version: the Flow goes on using the one it was approved with, by
 * design, and nothing tells its owner there is a newer one. These two say so, and move it in one press — the
 * same thing Dittoly does by itself when a module is fixed (src/modules/run-fix.ts), asked for by a person.
 */
export interface ModuleUpdate {
  module: string;
  /** The version this Flow pins, and the newest approved one. */
  pinned: string;
  latest: string;
}

/** "1.2.10" after "1.2.9": compared number by number, never as text. */
export function semverCmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Every module of `def` whose newest approved version is newer than the pinned one. */
export async function moduleUpdates(db: Queryable, def: FlowDefinition): Promise<ModuleUpdate[]> {
  const pinned = new Map<string, string>();
  for (const s of def.steps) {
    if (s.type !== 'action') continue;
    const at = s.module.lastIndexOf('@');
    pinned.set(s.module.slice(0, at), s.module.slice(at + 1));
  }
  if (!pinned.size) return [];
  const { rows } = await db.query<{ name: string; version: string }>(
    `SELECT name, version FROM module_versions WHERE name = ANY($1) AND status = 'approved'
       AND name NOT IN (SELECT name FROM module_archive)`,
    [[...pinned.keys()]],
  );
  const newest = new Map<string, string>();
  for (const r of rows) if (!newest.has(r.name) || semverCmp(r.version, newest.get(r.name)!) > 0) newest.set(r.name, r.version);
  return [...pinned]
    .filter(([name, version]) => newest.has(name) && semverCmp(newest.get(name)!, version) > 0)
    .map(([module, version]) => ({ module, pinned: version, latest: newest.get(module)! }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

export interface UpdateDeps {
  db: Queryable;
  flows: FlowService;
  flowTests: FlowTests;
  /** Drafts the Flow again when pinning the newer module is not enough (no AI set up: the caller is told why). */
  flowChat?: { redraft(flowId: string, feedback: string): Promise<{ definition: unknown; explanation: string }> } | undefined;
}

/**
 * Move a Flow to the newest approved version of the modules named (all of them when none are), as a new version
 * its approvers decide on, like any change.
 *
 * Changing the pin is only half of it: a newer module may take something else than the Flow sends it, and then a
 * re-pinned Flow is a Flow that fails. So the re-pin is tried first, with the Flow's own examples played against
 * it; when those do not hold, the AI drafts the steps that use those modules again and that version is proposed
 * instead — but only if it parses, really uses the new versions, and makes the examples pass. Nothing is proposed
 * on a guess.
 */
export async function updateModules(
  d: UpdateDeps,
  flowId: string,
  actor: Member,
  modules?: string[],
): Promise<{ version: FlowVersion; updated: ModuleUpdate[]; tests: { total: number; passed: number }; redrafted: boolean }> {
  const versions = await d.flows.versions(flowId);
  const base = [...versions].reverse().find((v) => v.status === 'approved') ?? versions.at(-1);
  if (!base) throw notFound('flow');
  const all = await moduleUpdates(d.db, base.definition);
  const wanted = modules?.length ? all.filter((u) => modules.includes(u.module)) : all;
  if (!wanted.length) throw new AppError('no_module_updates', 409, 'Every module this Flow uses is already at its newest approved version.');
  let next: unknown = base.definition;
  for (const u of wanted) next = repin(next as FlowDefinition, `${u.module}@${u.pinned}`, `${u.module}@${u.latest}`);

  const cases = await d.flowTests.casesFor(flowId);
  const played = async (def: FlowDefinition) => {
    const pinned = await d.flows.pinnedModules(d.db, def);
    return cases.filter((c) => playTest(def, pinned, c.case).problems.length === 0).length;
  };
  const parsed = parseFlowDefinition(next);
  // The re-pin holds when it parses and every example still passes (none to play: the pin is all there is to check).
  const passed = parsed.ok ? await played(parsed.definition) : 0;
  if (parsed.ok && passed === cases.length) {
    const version = await d.flows.update(flowId, next, actor);
    return { version, updated: wanted, tests: { total: cases.length, passed }, redrafted: false };
  }

  const drafted = await redraftFor(d, flowId, wanted, parsed.ok ? null : parsed.issues);
  if ('reason' in drafted) throw new AppError('flow_needs_changes', 409, drafted.reason);
  const after = await played(drafted.definition);
  if (after < cases.length) {
    throw new AppError(
      'flow_needs_changes',
      409,
      `The AI drafted this Flow for ${wanted.map((u) => `${u.module} ${u.latest}`).join(', ')}, but ${cases.length - after} of its ${cases.length} examples still fail. Change the Flow yourself, or fix the examples first.`,
    );
  }
  const version = await d.flows.update(flowId, drafted.raw, actor);
  return { version, updated: wanted, tests: { total: cases.length, passed: after }, redrafted: true };
}

/** The AI's version of this Flow for the newer modules, checked before anybody is offered it. */
async function redraftFor(
  d: UpdateDeps,
  flowId: string,
  wanted: ModuleUpdate[],
  issues: string[] | null,
): Promise<{ definition: FlowDefinition; raw: unknown } | { reason: string }> {
  const moves = wanted.map((u) => `${u.module} ${u.pinned} → ${u.latest}`).join(', ');
  if (!d.flowChat) {
    return {
      reason: `Pinning the newer module is not enough (${moves}): ${issues ? issues.slice(0, 2).join('; ') : "the Flow's own examples no longer pass"}. With no organization AI set up, change the Flow yourself.`,
    };
  }
  const feedback =
    `This Flow must now use the newer approved versions of its modules: ${moves}. Their actions may take different inputs or return something else.` +
    (issues?.length ? ` Pinning them alone left the Flow invalid: ${issues.slice(0, 3).join('; ')}.` : " Pinning them alone left the Flow's own examples failing.") +
    ' Change the steps that use those modules so they fit the new versions, and keep everything else exactly as it is: the other steps, the inputs, the form, the tables and the sign-offs.';
  let out;
  try {
    out = await d.flowChat.redraft(flowId, feedback);
  } catch (err) {
    log.info('module_update_redraft_failed', { errorType: err instanceof AppError ? err.code : 'unexpected' });
    return { reason: `Pinning the newer module is not enough (${moves}), and the AI could not draft the Flow for it. Change the Flow yourself.` };
  }
  const parsed = parseFlowDefinition(out.definition);
  if (!parsed.ok) return { reason: `The AI's version of this Flow for ${moves} is not valid: ${parsed.issues.slice(0, 2).join('; ')}.` };
  const text = JSON.stringify(parsed.definition);
  const missing = wanted.filter((u) => !text.includes(JSON.stringify(`${u.module}@${u.latest}`)));
  if (missing.length) return { reason: `The AI's version of this Flow does not use ${missing.map((u) => `${u.module}@${u.latest}`).join(', ')}.` };
  return { definition: parsed.definition, raw: out.definition };
}

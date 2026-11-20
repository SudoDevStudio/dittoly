import type { App } from '../app.js';
import { AppError } from '../core/errors.js';
import { canonicalJson, sha256Hex } from '../core/crypto.js';
import type { Member } from '../core/members.js';
import { collectBundle, type AppBundle, type ExportBody } from './bundle.js';

/**
 * Exports that a newer approved Flow version would change. Each export keeps what it was asked
 * for and a snapshot of what it held; the review compares that with what an export made now
 * would hold, in the terms a deployer acts on: Flow versions and steps, modules, settings, state.
 */

export interface ExportSnapshot {
  flows: { flowId: string; key: string; name: string; version: number; versionId: string; requested: boolean; steps: { id: string; type: string; title: string | null; hash: string }[] }[];
  modules: string[];
  env: { name: string; required: boolean }[];
  needs: AppBundle['needs'];
}

export function snapshotOf(b: AppBundle): ExportSnapshot {
  return {
    flows: b.flows.map((f) => ({
      flowId: f.sourceFlowId,
      key: f.key,
      name: f.name,
      version: f.version,
      versionId: f.sourceVersionId,
      requested: f.exposed,
      steps: ((f.definition.steps ?? []) as { id: string; type: string; title?: string }[]).map((s) => ({ id: s.id, type: s.type, title: s.title ?? null, hash: sha256Hex(canonicalJson(s)).slice(0, 16) })),
    })),
    modules: b.modules.map((m) => `${m.name}@${m.version}`),
    env: b.env.map((v) => ({ name: v.name, required: v.required })),
    needs: b.needs,
  };
}

/**
 * Exports naming a Flow whose approved version is no longer the one they hold: "new" when every
 * Flow has an approved version (it can be exported again now), "pending" when a change to one
 * still waits for approval (a proposed change supersedes the approved version at once).
 */
export async function outdated(db: App['db'], rows: { id: string; request: ExportBody | null; snapshot: ExportSnapshot | null }[]): Promise<Map<string, 'new' | 'pending'>> {
  const ids = [...new Set(rows.flatMap((r) => (r.request && r.snapshot ? r.request.flows.map((f) => f.flowId) : [])))];
  if (!ids.length) return new Map();
  const approved = new Map(
    (await db.query<{ flow_id: string; id: string }>(`SELECT flow_id, id FROM flow_versions WHERE status = 'approved' AND flow_id = ANY($1)`, [ids])).rows.map((r) => [r.flow_id, r.id]),
  );
  const out = new Map<string, 'new' | 'pending'>();
  for (const r of rows) {
    if (!r.request || !r.snapshot) continue;
    const held = new Map(r.snapshot.flows.filter((f) => f.requested).map((f) => [f.flowId, f.versionId]));
    if (r.request.flows.some((f) => !approved.has(f.flowId))) out.set(r.id, 'pending');
    else if (r.request.flows.some((f) => approved.get(f.flowId) !== held.get(f.flowId))) out.set(r.id, 'new');
  }
  return out;
}

export interface StepChange { id: string; type: string; title: string | null }
export interface ExportChanges {
  id: string;
  name: string;
  /** False for exports made before re-export existed. */
  reexportable: boolean;
  /** Something changed since the export was made. */
  changed: boolean;
  /** Why an export cannot be made now (e.g. a Flow has no approved version any more). */
  problem: string | null;
  flows: { key: string; name: string; from: number | null; to: number | null; added: StepChange[]; removed: StepChange[]; changed: StepChange[] }[];
  modules: { added: string[]; removed: string[] };
  env: { added: { name: string; required: boolean }[]; removed: string[]; nowRequired: string[] };
  /** Runs must now (true) or no longer (false) outlive a restart: STATE_URL. Null when unchanged. */
  state: boolean | null;
}

const step = (s: ExportSnapshot['flows'][number]['steps'][number]): StepChange => ({ id: s.id, type: s.type, title: s.title });

export function compare(before: ExportSnapshot, now: ExportSnapshot): Omit<ExportChanges, 'id' | 'name' | 'reexportable' | 'problem' | 'changed'> {
  const flows: ExportChanges['flows'] = [];
  const old = new Map(before.flows.map((f) => [f.flowId, f]));
  const cur = new Map(now.flows.map((f) => [f.flowId, f]));
  for (const f of now.flows) {
    const o = old.get(f.flowId);
    if (o && o.versionId === f.versionId) continue;
    const was = new Map((o?.steps ?? []).map((s) => [s.id, s]));
    const is = new Map(f.steps.map((s) => [s.id, s]));
    flows.push({
      key: f.key,
      name: f.name,
      from: o?.version ?? null,
      to: f.version,
      added: f.steps.filter((s) => !was.has(s.id)).map(step),
      removed: (o?.steps ?? []).filter((s) => !is.has(s.id)).map(step),
      changed: f.steps.filter((s) => was.has(s.id) && was.get(s.id)!.hash !== s.hash).map(step),
    });
  }
  for (const o of before.flows) if (!cur.has(o.flowId)) flows.push({ key: o.key, name: o.name, from: o.version, to: null, added: [], removed: o.steps.map(step), changed: [] });
  const oldEnv = new Map(before.env.map((v) => [v.name, v]));
  const newEnv = new Map(now.env.map((v) => [v.name, v]));
  return {
    flows,
    modules: { added: now.modules.filter((m) => !before.modules.includes(m)), removed: before.modules.filter((m) => !now.modules.includes(m)) },
    env: {
      added: now.env.filter((v) => !oldEnv.has(v.name)),
      removed: before.env.filter((v) => !newEnv.has(v.name)).map((v) => v.name),
      nowRequired: now.env.filter((v) => v.required && oldEnv.has(v.name) && !oldEnv.get(v.name)!.required).map((v) => v.name),
    },
    state: before.needs.state === now.needs.state ? null : now.needs.state,
  };
}

/** What an export made now, from the same request, would change. */
export async function exportChanges(app: App, actor: Member, row: { id: string; name: string; request: ExportBody | null; snapshot: ExportSnapshot | null }): Promise<ExportChanges> {
  const empty = { flows: [], modules: { added: [], removed: [] }, env: { added: [], removed: [], nowRequired: [] }, state: null };
  if (!row.request || !row.snapshot) return { id: row.id, name: row.name, reexportable: false, changed: false, problem: null, ...empty };
  let now: AppBundle;
  try {
    now = await collectBundle(app, actor, row.request, { theme: null, plan: null, preview: true });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return { id: row.id, name: row.name, reexportable: true, changed: true, problem: err.message, ...empty };
  }
  const diff = compare(row.snapshot, snapshotOf(now));
  const changed = diff.flows.length > 0 || diff.modules.added.length + diff.modules.removed.length > 0 || diff.env.added.length + diff.env.removed.length + diff.env.nowRequired.length > 0 || diff.state !== null;
  return { id: row.id, name: row.name, reexportable: true, changed, problem: null, ...diff };
}

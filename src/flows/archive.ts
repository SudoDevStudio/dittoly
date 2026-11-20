import { audit } from '../core/audit.js';
import { AppError, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';

/**
 * Deleting a Flow (a Super Flow too) or a module archives it: it leaves the lists and catalogs and can
 * never run again, while its versions, runs, approvals and audit events stay. Nothing is archived while
 * something still uses it: the refusal lists what does. An admin can restore it.
 */

/** What still uses a Flow or a module: Flows (with an approved or pending version) and active runs. */
export interface InUse {
  flows: { id: string; name: string }[];
  activeRuns: number;
}

const ACTIVE = `('running', 'waiting', 'paused')`;

function refuse(code: string, what: string, use: InUse): AppError {
  const parts = [
    use.flows.length ? `used by ${use.flows.map((f) => `"${f.name}"`).join(', ')}` : '',
    use.activeRuns ? `${use.activeRuns} run${use.activeRuns === 1 ? '' : 's'} still active (cancel or let them finish)` : '',
  ].filter(Boolean);
  return new AppError(code, 409, `${what} is ${parts.join('; ')}`);
}

/** Flows (not archived) whose approved or pending version runs this Flow in a flow step, and its active runs. */
export async function flowInUse(db: Queryable, flowId: string): Promise<InUse> {
  const flows = await db.query<{ id: string; name: string }>(
    `SELECT DISTINCT f.id, f.name FROM flows f JOIN flow_versions v ON v.flow_id = f.id
     WHERE f.id <> $1 AND f.archived_at IS NULL AND v.status IN ('approved', 'pending')
       AND jsonb_path_exists(v.definition, '$.steps[*] ? (@.type == "flow").runs[*] ? (@.flow == $id)', jsonb_build_object('id', $1::text))
     ORDER BY f.name`,
    [flowId],
  );
  const runs = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE v.flow_id = $1 AND r.status IN ${ACTIVE}`,
    [flowId],
  );
  return { flows: flows.rows, activeRuns: runs.rows[0]!.n };
}

/** Flows (not archived) whose approved or pending version calls an action of this module. */
export async function moduleInUse(db: Queryable, name: string): Promise<InUse> {
  const flows = await db.query<{ id: string; name: string }>(
    `SELECT DISTINCT f.id, f.name FROM flows f JOIN flow_versions v ON v.flow_id = f.id
     WHERE f.archived_at IS NULL AND v.status IN ('approved', 'pending')
       AND jsonb_path_exists(v.definition, '$.** ? (@.module starts with $ref)', jsonb_build_object('ref', $1::text || '@'))
     ORDER BY f.name`,
    [name],
  );
  return { flows: flows.rows, activeRuns: 0 };
}

async function flowRow(db: Queryable, flowId: string) {
  const r = await db.query<{ name: string; created_by: string; archived_at: Date | null }>(
    `SELECT name, created_by, archived_at FROM flows WHERE id = $1`,
    [flowId],
  );
  if (!r.rows[0]) throw notFound('flow');
  return r.rows[0];
}

/** Its owner (who made it, as for a change) or an admin. */
export async function archiveFlow(db: Queryable, flowId: string, actor: Member): Promise<void> {
  const f = await flowRow(db, flowId);
  if (actor.role !== 'admin' && actor.id !== f.created_by) throw forbidden('not_flow_owner');
  if (f.archived_at) return;
  const use = await flowInUse(db, flowId);
  if (use.flows.length || use.activeRuns) throw refuse('flow_in_use', `"${f.name}"`, use);
  await db.query(`UPDATE flows SET archived_at = now(), archived_by = $2 WHERE id = $1`, [flowId, actor.id]);
  await audit(db, { actorId: actor.id, action: 'flow.archived', subjectType: 'flow', subjectId: flowId, outcome: 'ok' });
}

export async function restoreFlow(db: Queryable, flowId: string, actor: Member): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  await flowRow(db, flowId);
  await db.query(`UPDATE flows SET archived_at = NULL, archived_by = NULL WHERE id = $1`, [flowId]);
  await audit(db, { actorId: actor.id, action: 'flow.restored', subjectType: 'flow', subjectId: flowId, outcome: 'ok' });
}

const MODULE_NAME = /^[a-z][a-z0-9-]{1,39}$/;

/** Every version of a module, by name. Admins only. */
export async function archiveModule(db: Queryable, name: string, actor: Member): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (!MODULE_NAME.test(name) || !(await db.query(`SELECT 1 FROM module_versions WHERE name = $1 LIMIT 1`, [name])).rowCount) throw notFound('module');
  const use = await moduleInUse(db, name);
  if (use.flows.length) throw refuse('module_in_use', `Module "${name}"`, use);
  await db.query(`INSERT INTO module_archive (name, archived_by) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, actor.id]);
  await audit(db, { actorId: actor.id, action: 'module.archived', subjectType: 'module', subjectId: name, outcome: 'ok' });
}

export async function restoreModule(db: Queryable, name: string, actor: Member): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (!MODULE_NAME.test(name)) throw notFound('module');
  await db.query(`DELETE FROM module_archive WHERE name = $1`, [name]);
  await audit(db, { actorId: actor.id, action: 'module.restored', subjectType: 'module', subjectId: name, outcome: 'ok' });
}

export async function archivedModules(db: Queryable): Promise<Set<string>> {
  return new Set((await db.query<{ name: string }>(`SELECT name FROM module_archive`)).rows.map((r) => r.name));
}

export async function isFlowArchived(db: Queryable, flowId: string): Promise<boolean> {
  return Boolean((await db.query(`SELECT 1 FROM flows WHERE id = $1 AND archived_at IS NOT NULL`, [flowId])).rowCount);
}

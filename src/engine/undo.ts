import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { canApprove, type Member } from '../core/members.js';
import { notify, notifyRole } from '../core/notify.js';
import { approvalAuthority } from '../governance/approvals.js';
import { canUseTeam } from '../core/teams.js';
import type { Db, Queryable } from '../db/db.js';
import { resolve } from '../flows/template.js';
import type { ModuleRegistry, ModuleVersion } from '../modules/registry.js';
import type { ManifestAction } from '../runtime/types.js';
import type { TemplateScope } from '../runtime/template.js';
import { enqueue } from './jobs.js';
import type { Engine } from './engine.js';

/**
 * Undo. A module's write action may declare the action that reverses it (create_issue →
 * delete_issue {key: output.key}); the admin reviews that with the module. When such a write
 * succeeds, in a Flow run or an agent's gateway call, Dittoly builds the reversing input at once
 * and keeps only that, encrypted, for the organization's undo window. The person it ran as asks
 * to reverse a run (all of it, or some writes) or a call, with a reason; an approver signs off;
 * then the reversals run newest first, as that same person with their own access, through the
 * broker like any step. Writes with no declared undo are shown as not reversible.
 */

const KEY = 'undo_window';
export const DEFAULT_UNDO_DAYS = 7;
export const MAX_UNDO_DAYS = 90;
const aad = (id: string) => `undo:${id}:input`;

export async function getUndoWindow(db: Queryable): Promise<number> {
  const days = (await db.query<{ value: { days?: number } }>(`SELECT value FROM org_settings WHERE key = $1`, [KEY])).rows[0]?.value.days;
  return typeof days === 'number' ? days : DEFAULT_UNDO_DAYS;
}

export async function setUndoWindow(db: Queryable, actor: Member, days: number): Promise<number> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (!Number.isInteger(days) || days < 1 || days > MAX_UNDO_DAYS) throw badRequest('invalid_undo_window', `days must be 1 to ${MAX_UNDO_DAYS}`);
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify({ days }), actor.id],
  );
  await audit(db, { actorId: actor.id, action: 'org.undo_window_updated', subjectType: 'member', subjectId: actor.id, outcome: 'ok' });
  return days;
}

/**
 * After a write succeeded: keep what reverses it, if its module declares that. Returns the record
 * id, or null when the action has no undo or its input could not be built from what came back.
 */
export async function recordUndo(
  db: Queryable,
  cipher: Cipher,
  w: { module: ModuleVersion; action: ManifestAction; input: unknown; output: unknown; memberId: string; teamId: string; runId?: string; stepId?: string; item?: number },
): Promise<string | null> {
  if (w.action.effect !== 'write' || !w.action.undo) return null;
  let input: unknown;
  try {
    input = resolve(w.action.undo.input, { input: w.input, output: w.output } as unknown as TemplateScope);
  } catch {
    return null;
  }
  const days = await getUndoWindow(db);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO undo_records (run_id, step_id, item, member_id, team_id, module_version_id, action, undo_action, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' days')::interval) RETURNING id`,
    [w.runId ?? null, w.stepId ?? null, w.item ?? 0, w.memberId, w.teamId, w.module.id, w.action.name, w.action.undo.action, String(days)],
  );
  const id = rows[0]!.id;
  await db.query(`UPDATE undo_records SET input_enc = $2 WHERE id = $1`, [id, cipher.encryptJson(input, aad(id))]);
  return id;
}

export const reversalBody = z
  .object({
    runId: z.string().uuid().optional(),
    agentCallId: z.string().uuid().optional(),
    reason: z.string().trim().min(10).max(500),
    /** Only these writes; default: every write that can still be reversed. */
    undoIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  })
  .strict()
  .refine((b) => !!b.runId !== !!b.agentCallId, 'runId or agentCallId');

export interface UndoRecord {
  id: string;
  runId: string | null;
  stepId: string | null;
  item: number;
  agentCallId: string | null;
  action: string;
  undoAction: string;
  status: 'ready' | 'reversing' | 'reversed' | 'failed' | 'expired';
  error: string | null;
  createdAt: Date;
  expiresAt: Date;
  reversedAt: Date | null;
}

export interface Reversal {
  id: string;
  runId: string | null;
  agentCallId: string | null;
  requestedBy: string | null;
  requester: string | null;
  decider: string | null;
  reason: string;
  status: 'pending' | 'rejected' | 'running' | 'done' | 'partly_failed';
  decidedBy: string | null;
  decidedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  writes: UndoRecord[];
}

interface RecordRow {
  id: string; run_id: string | null; step_id: string | null; item: number; agent_call_id: string | null; member_id: string; team_id: string; module_version_id: string;
  action: string; undo_action: string; input_enc: string | null; status: UndoRecord['status']; error: string | null; created_at: Date; expires_at: Date; reversed_at: Date | null;
}

const toRecord = (r: RecordRow): UndoRecord => ({
  id: r.id, runId: r.run_id, stepId: r.step_id, item: r.item, agentCallId: r.agent_call_id, action: r.action, undoAction: r.undo_action,
  status: r.status, error: r.error, createdAt: r.created_at, expiresAt: r.expires_at, reversedAt: r.reversed_at,
});

export class Undo {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly modules: ModuleRegistry,
    private readonly engine: Engine,
    private readonly mode: 'local' | 'shared',
  ) {}

  /** The writes of a run and the Flows it ran, newest first, and its reversals. Callers check the actor may see the run. */
  async forRun(runId: string): Promise<{ writes: UndoRecord[]; reversals: Reversal[]; windowDays: number }> {
    await this.expire();
    const { rows } = await this.db.query<RecordRow>(
      `WITH RECURSIVE tree(id) AS (SELECT $1::uuid UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
       SELECT u.* FROM undo_records u WHERE u.run_id IN (SELECT id FROM tree) ORDER BY u.seq DESC, u.item DESC`,
      [runId],
    );
    const reversals = (await this.db.query<{ id: string }>(`SELECT id FROM reversals WHERE run_id = $1 ORDER BY created_at DESC`, [runId])).rows;
    return { writes: rows.map(toRecord), reversals: await Promise.all(reversals.map((r) => this.load(r.id))), windowDays: await getUndoWindow(this.db) };
  }

  /** Point a gateway call's undo record at the agent call it belongs to. */
  async linkCall(undoId: string, agentCallId: string): Promise<void> {
    await this.db.query(`UPDATE undo_records SET agent_call_id = $2 WHERE id = $1`, [undoId, agentCallId]);
  }

  /** The person it ran as (or an admin) asks to reverse; approvers are asked to sign off. */
  async request(actor: Member, body: z.infer<typeof reversalBody>): Promise<Reversal> {
    await this.expire();
    let owner: string;
    let rows: RecordRow[];
    if (body.runId) {
      const run = (await this.db.query<{ run_as: string }>(`SELECT run_as FROM runs WHERE id = $1`, [body.runId])).rows[0];
      if (!run) throw notFound('run');
      owner = run.run_as;
      rows = (
        await this.db.query<RecordRow>(
          `WITH RECURSIVE tree(id) AS (SELECT $1::uuid UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
           SELECT * FROM undo_records WHERE run_id IN (SELECT id FROM tree)`,
          [body.runId],
        )
      ).rows;
    } else {
      const call = (await this.db.query<{ member_id: string }>(`SELECT member_id FROM agent_calls WHERE id = $1`, [body.agentCallId])).rows[0];
      if (!call) throw notFound('agent_call');
      owner = call.member_id;
      rows = (await this.db.query<RecordRow>(`SELECT * FROM undo_records WHERE agent_call_id = $1`, [body.agentCallId])).rows;
    }
    if (owner !== actor.id && actor.role !== 'admin') throw forbidden('only_its_person_reverses');
    const ready = rows.filter((r) => r.status === 'ready');
    const chosen = body.undoIds ? ready.filter((r) => body.undoIds!.includes(r.id)) : ready;
    if (body.undoIds && chosen.length !== body.undoIds.length) throw conflict('not_reversible');
    if (!chosen.length) throw conflict('nothing_to_reverse');
    const busy = await this.db.query(`SELECT 1 FROM reversals WHERE status IN ('pending', 'running') AND undo_ids && $1::uuid[]`, [chosen.map((r) => r.id)]);
    if (busy.rowCount) throw conflict('reversal_already_requested');
    const { rows: made } = await this.db.query<{ id: string }>(
      `INSERT INTO reversals (run_id, agent_call_id, requested_by, reason, undo_ids) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [body.runId ?? null, body.agentCallId ?? null, actor.id, body.reason, chosen.map((r) => r.id)],
    );
    const id = made[0]!.id;
    await audit(this.db, { actorId: actor.id, action: 'reversal.requested', subjectType: body.runId ? 'run' : 'member', subjectId: body.runId ?? owner, outcome: 'ok', relatedId: id });
    await notifyRole(this.db, ['approver', 'admin'], 'reversal_needs_approval', body.runId ? { runId: body.runId } : {}, this.mode === 'shared' ? actor.id : undefined);
    return this.load(id);
  }

  async get(actor: Member, id: string): Promise<Reversal> {
    const r = await this.load(id);
    if (!canApprove(actor) && r.requestedBy !== actor.id && !(await this.ownsSubject(actor, r))) throw notFound('reversal');
    return r;
  }

  /** Reversals waiting for this approver. On a shared server nobody signs off their own request. */
  async pending(actor: Member): Promise<Reversal[]> {
    if (!canApprove(actor)) return [];
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM reversals WHERE status = 'pending' AND ($2 = false OR requested_by IS DISTINCT FROM $1) ORDER BY created_at`,
      [actor.id, this.mode === 'shared'],
    );
    return Promise.all(rows.map((r) => this.load(r.id)));
  }

  async decide(actor: Member, id: string, decision: 'approved' | 'rejected'): Promise<Reversal> {
    if (!canApprove(actor)) throw forbidden('approver_only');
    const r = await this.load(id);
    if (this.mode === 'shared' && r.requestedBy === actor.id) throw forbidden('cannot_approve_own_reversal');
    const status = decision === 'approved' ? 'running' : 'rejected';
    // With the team rule, the team whose changes these are (or a stand-in for its approvers) signs off.
    const team = (await this.db.query<{ team_id: string }>(`SELECT team_id FROM undo_records WHERE id = $1`, [r.writes[0]?.id])).rows[0]?.team_id;
    if (team) await approvalAuthority(this.db, actor, team, this.mode === 'shared' ? (r.requestedBy ?? '') : '');
    const claimed = await this.db.query(`UPDATE reversals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending'`, [id, status, actor.id]);
    if (!claimed.rowCount) throw conflict('reversal_not_pending');
    await audit(this.db, { actorId: actor.id, action: `reversal.${decision}`, subjectType: r.runId ? 'run' : 'member', subjectId: r.runId ?? actor.id, outcome: 'ok', relatedId: id });
    if (decision === 'approved') await enqueue(this.db, 'reverse', { reversalId: id });
    else if (r.requestedBy) await notify(this.db, r.requestedBy, 'reversal_finished', r.runId ? { runId: r.runId } : {});
    return this.load(id);
  }

  /** The job: reverse each chosen write, newest first, as the person who made it. One failure does not stop the rest. */
  async execute(id: string): Promise<void> {
    const r = await this.load(id);
    if (r.status !== 'running') return;
    let failed = 0;
    for (const w of [...r.writes].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.item - a.item)) {
      const row = (await this.db.query<RecordRow>(`UPDATE undo_records SET status = 'reversing' WHERE id = $1 AND status = 'ready' AND expires_at > now() RETURNING *`, [w.id])).rows[0];
      if (!row) {
        if (w.status !== 'reversed') failed++;
        continue;
      }
      const error = await this.reverseOne(row);
      if (error) failed++;
      await this.db.query(
        `UPDATE undo_records SET status = $2, error = $3, input_enc = CASE WHEN $2 = 'reversed' THEN NULL ELSE input_enc END, reversed_at = CASE WHEN $2 = 'reversed' THEN now() END WHERE id = $1`,
        [row.id, error ? 'failed' : 'reversed', error],
      );
      await audit(this.db, { actorId: row.member_id, action: 'undo.reversed', subjectType: 'module', subjectId: row.module_version_id, outcome: error ? 'failed' : 'ok', errorType: error ?? undefined, relatedId: row.id });
    }
    await this.db.query(`UPDATE reversals SET status = $2, finished_at = now() WHERE id = $1`, [id, failed ? 'partly_failed' : 'done']);
    if (r.requestedBy) await notify(this.db, r.requestedBy, 'reversal_finished', r.runId ? { runId: r.runId } : {});
  }

  /** Writes kept past the window can no longer be reversed: their input is dropped. */
  async expire(): Promise<void> {
    await this.db.query(`UPDATE undo_records SET status = 'expired', input_enc = NULL WHERE status = 'ready' AND expires_at <= now()`);
  }

  private async reverseOne(row: RecordRow): Promise<string | null> {
    const m = await this.modules.get(this.db, row.module_version_id);
    if (!m || m.status !== 'approved') return 'module_not_approved';
    // It acts with that person's access: only while they are still a member who may act for the team.
    const member = (await this.db.query<Member & { disabled: boolean }>(`SELECT id, handle, role, disabled FROM members WHERE id = $1`, [row.member_id])).rows[0];
    if (!member || member.disabled || !(await canUseTeam(this.db, row.team_id, member))) return 'member_cannot_act';
    try {
      const input = this.cipher.decryptJson(row.input_enc!, aad(row.id));
      // The module is configured as the step that made the change was (the Flow's values).
      const settings = await this.engine.stepSettings(row.run_id, row.step_id);
      await this.engine.invokeOutsideRun(m, row.undo_action, input, row.team_id, await this.engine.secretResolver(row.team_id, m.name, row.member_id), { settings });
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? 'internal';
    }
  }

  private async ownsSubject(actor: Member, r: Reversal): Promise<boolean> {
    const q = r.runId ? `SELECT 1 FROM runs WHERE id = $1 AND run_as = $2` : `SELECT 1 FROM agent_calls WHERE id = $1 AND member_id = $2`;
    return !!(await this.db.query(q, [r.runId ?? r.agentCallId, actor.id])).rowCount;
  }

  private async load(id: string): Promise<Reversal> {
    const r = (
      await this.db.query<{
        id: string; run_id: string | null; agent_call_id: string | null; requested_by: string | null; reason: string; undo_ids: string[]; status: Reversal['status'];
        decided_by: string | null; decided_at: Date | null; finished_at: Date | null; created_at: Date; requester: string | null; decider: string | null;
      }>(
        `SELECT r.*, a.handle AS requester, d.handle AS decider FROM reversals r
         LEFT JOIN members a ON a.id = r.requested_by LEFT JOIN members d ON d.id = r.decided_by WHERE r.id = $1`,
        [id],
      )
    ).rows[0];
    if (!r) throw notFound('reversal');
    const writes = (await this.db.query<RecordRow>(`SELECT * FROM undo_records WHERE id = ANY($1) ORDER BY seq DESC, item DESC`, [r.undo_ids])).rows.map(toRecord);
    return {
      id: r.id, runId: r.run_id, agentCallId: r.agent_call_id, requestedBy: r.requested_by, requester: r.requester, decider: r.decider, reason: r.reason, status: r.status,
      decidedBy: r.decided_by, decidedAt: r.decided_at, finishedAt: r.finished_at, createdAt: r.created_at, writes,
    };
  }
}

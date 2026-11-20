import type { Queryable } from '../db/db.js';
import { log } from './log.js';
import { enqueue } from '../engine/jobs.js';

export type NotificationKind =
  | 'run_paused'
  | 'run_failed'
  | 'run_succeeded'
  | 'approval_needed'
  | 'input_needed'
  | 'delegation_requested'
  | 'delegation_decided'
  | 'delegation_reminder'
  | 'delegation_cancelled'
  | 'delegation_delegate_offboarded'
  | 'delegation_expired'
  | 'delegation_escalated'
  | 'schedule_failed'
  | 'followup_failed'
  | 'module_review_needed'
  | 'plan_needs_answers'
  | 'plan_needs_attention'
  | 'plan_ready'
  | 'plan_failed'
  | 'breakglass_used'
  | 'access_review_due'
  | 'access_removed'
  | 'module_drift'
  | 'ai_budget_warning'
  | 'watch_failed'
  | 'audit_anchor_failed'
  | 'audit_stream_failed'
  | 'flow_fix_proposed'
  | 'module_fix_failed'
  | 'flow_approval_needed'
  | 'approval_reminder'
  | 'approval_escalated'
  | 'standin_assigned'
  | 'agent_confirmation_needed'
  | 'gateway_tool_blocked'
  | 'reversal_needs_approval'
  | 'reversal_finished'
  | 'member_offboarded'
  | 'cost_cap_reached'
  | 'pinned_model_unavailable'
  | 'model_change_checked'
  | 'autostop_tripped'
  | 'autostop_resumed';

/**
 * Notifications are stored as IDs only; the portal resolves them for display.
 * Email delivery is a separate job (see delivery.ts).
 */
export async function notify(
  db: Queryable,
  memberId: string,
  kind: NotificationKind,
  refs: NotificationRefs = {},
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notifications (member_id, kind, run_id, step_id, delegation_id, plan_id, flow_version_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [memberId, kind, refs.runId ?? null, refs.stepId ?? null, refs.delegationId ?? null, refs.planId ?? null, refs.flowVersionId ?? null],
  );
  // Email (if configured) goes out as a durable job in the same transaction.
  await enqueue(db, 'deliver_notification', { notificationId: String(rows[0]!.id) });
  log.info('notification', { memberId, action: kind, runId: refs.runId, stepId: refs.stepId });
}

export interface NotificationRefs {
  runId?: string;
  stepId?: string;
  delegationId?: string;
  planId?: string;
  flowVersionId?: string;
}

export async function notifyRole(
  db: Queryable,
  roles: string[],
  kind: NotificationKind,
  refs: { runId?: string; stepId?: string } = {},
  exceptMemberId?: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM members WHERE role = ANY($1)`, [roles]);
  for (const r of rows) if (r.id !== exceptMemberId) await notify(db, r.id, kind, refs);
}

import type { Queryable } from '../db/db.js';
import { log } from './log.js';

/**
 * Audit records hold IDs, times, statuses and error types, never payloads.
 * The shape of AuditEvent makes it impossible to pass anything else.
 */
export interface AuditEvent {
  actorId: string | null;
  action: string;
  subjectType: 'member' | 'credential' | 'chat' | 'module' | 'flow' | 'flow_version' | 'run' | 'step' | 'delegation' | 'trigger'
    | 'plan'
    | 'app'
    | 'endpoint'
    | 'device'
    | 'policy'
    | 'breakglass'
    | 'change'
    | 'team' | 'org'
    | 'job';
  subjectId: string;
  outcome: 'ok' | 'denied' | 'failed';
  errorType?: string | undefined;
  /** A second ID, e.g. the requester of a delegation or the member a step ran as. */
  relatedId?: string | undefined;
}

const SAFE = /^[A-Za-z0-9_.:-]{1,80}$/;

export async function audit(db: Queryable, e: AuditEvent): Promise<void> {
  const errorType = e.errorType && SAFE.test(e.errorType) ? e.errorType : e.errorType ? 'unknown_error' : null;
  const relatedId = e.relatedId && SAFE.test(e.relatedId) ? e.relatedId : null;
  if (!SAFE.test(e.action) || !SAFE.test(e.subjectId)) throw new Error('audit fields must be identifiers');
  await db.query(
    `INSERT INTO audit_events (actor_id, action, subject_type, subject_id, outcome, error_type, related_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actorId, e.action, e.subjectType, e.subjectId, e.outcome, errorType, relatedId],
  );
  if (e.outcome !== 'ok') {
    log.warn('audit', { action: e.action, status: e.outcome, errorType: errorType ?? undefined, memberId: e.actorId });
  }
}

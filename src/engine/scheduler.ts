import { assertTeamMember } from '../core/teams.js';
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { notify } from '../core/notify.js';
import type { Db } from '../db/db.js';
import type { FlowService } from '../flows/service.js';
import { ajv } from '../modules/manifest.js';
import type { Engine } from './engine.js';

export const createScheduleSchema = z
  .object({
    flowVersionId: z.string().uuid(),
    /** Standard 5-field cron expression. */
    cron: z.string().min(9).max(120),
    /** IANA time zone, e.g. Europe/Berlin. */
    timezone: z.string().min(1).max(64).default('UTC'),
    inputs: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

interface ScheduleRow {
  id: string;
  flow_version_id: string;
  run_as: string;
  cron: string;
  timezone: string;
  inputs_enc: string;
  enabled: boolean;
  disabled_reason: string | null;
  next_run_at: Date;
  last_run_at: Date | null;
  last_run_id: string | null;
}

const MIN_INTERVAL_MS = 60_000;

/** Next fire time after `from`. Throws on an invalid expression or one that fires more than once a minute. */
export function nextFireTime(cron: string, timezone: string, from: Date): Date {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw badRequest('invalid_cron', 'use a 5-field cron expression');
  let expr;
  try {
    expr = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone, strict: false });
  } catch {
    throw badRequest('invalid_cron');
  }
  const first = expr.next().toDate();
  const second = expr.next().toDate();
  if (second.getTime() - first.getTime() < MIN_INTERVAL_MS) throw badRequest('cron_too_frequent');
  return first;
}

const aad = (id: string) => `schedule:${id}:inputs`;

/**
 * Scheduled triggers. Like webhooks, a schedule fixes the Flow version and the
 * member it runs as when it is created. A schedule whose Flow version loses its
 * approval is disabled and its owner told; it never silently follows a new version.
 */
export class Scheduler {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly flows: FlowService,
    private readonly engine: Engine,
  ) {}

  async create(body: unknown, actor: Member) {
    const parsed = createScheduleSchema.safeParse(body);
    if (!parsed.success) throw badRequest('invalid_schedule');
    const s = parsed.data;
    // It runs as its creator, who must be in the Flow's team.
    await assertTeamMember(this.db, await this.flows.teamOfVersion(this.db, s.flowVersionId), actor);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s.timezone });
    } catch {
      throw badRequest('invalid_timezone');
    }
    const next = nextFireTime(s.cron, s.timezone, new Date());
    const { version } = await this.flows.assertRunnable(this.db, s.flowVersionId);
    const problems = ajv.explain(version.definition.inputs, s.inputs);
    if (problems.length) throw badRequest('invalid_inputs', problems.join('; '));
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO schedules (id, flow_version_id, run_as, cron, timezone, inputs_enc, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, s.flowVersionId, actor.id, s.cron.trim(), s.timezone, this.cipher.encryptJson(s.inputs, aad(id)), next],
    );
    await audit(this.db, { actorId: actor.id, action: 'schedule.created', subjectType: 'trigger', subjectId: id, outcome: 'ok' });
    return { id, nextRunAt: next };
  }

  async list(actor: Member) {
    const { rows } = await this.db.query<ScheduleRow>(
      `SELECT * FROM schedules WHERE run_as = $1 OR $2 ORDER BY created_at`,
      [actor.id, actor.role === 'admin'],
    );
    return rows.map((r) => ({
      id: r.id,
      flowVersionId: r.flow_version_id,
      runAs: r.run_as,
      cron: r.cron,
      timezone: r.timezone,
      enabled: r.enabled,
      disabledReason: r.disabled_reason,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastRunId: r.last_run_id,
    }));
  }

  async setEnabled(id: string, actor: Member, enabled: boolean): Promise<void> {
    const row = (await this.db.query<ScheduleRow>(`SELECT * FROM schedules WHERE id = $1`, [id])).rows[0];
    if (!row) throw notFound('schedule');
    if (row.run_as !== actor.id && actor.role !== 'admin') throw forbidden();
    if (enabled) await this.flows.assertRunnable(this.db, row.flow_version_id);
    const next = enabled ? nextFireTime(row.cron, row.timezone, new Date()) : row.next_run_at;
    await this.db.query(`UPDATE schedules SET enabled = $2, disabled_reason = NULL, next_run_at = $3 WHERE id = $1`, [id, enabled, next]);
    await audit(this.db, {
      actorId: actor.id,
      action: enabled ? 'schedule.enabled' : 'schedule.disabled',
      subjectType: 'trigger',
      subjectId: id,
      outcome: 'ok',
    });
  }

  /**
   * Fire every due schedule once. A server that was down fires a missed
   * schedule once on return, not once per missed slot.
   */
  async tick(now = new Date()): Promise<number> {
    let fired = 0;
    for (let i = 0; i < 100; i++) {
      const row = (
        await this.db.query<ScheduleRow>(`SELECT * FROM schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at LIMIT 1`, [now])
      ).rows[0];
      if (!row) break;
      const next = nextFireTime(row.cron, row.timezone, now);
      // Claim this slot: only one worker moves next_run_at forward, so the slot fires once.
      // No transaction stays open while the run starts (the embedded database has one backend).
      const claimed = await this.db.query(
        `UPDATE schedules SET next_run_at = $2, last_run_at = $3 WHERE id = $1 AND enabled AND next_run_at <= $3`,
        [row.id, next, now],
      );
      if (!claimed.rowCount) continue;
      try {
        const inputs = this.cipher.decryptJson(row.inputs_enc, aad(row.id));
        const runId = await this.engine.startRun(row.flow_version_id, row.run_as, inputs, { actorId: row.run_as, scheduleId: row.id });
        await this.db.query(`UPDATE schedules SET last_run_id = $2 WHERE id = $1`, [row.id, runId]);
        fired++;
      } catch (err) {
        const code = err instanceof AppError ? err.code : errorType(err);
        // A Flow version that is no longer approved will never become runnable again.
        const permanent = code === 'flow_version_not_approved' || code === 'approval_hash_mismatch' || code === 'invalid_inputs';
        if (permanent) await this.db.query(`UPDATE schedules SET enabled = false, disabled_reason = $2 WHERE id = $1`, [row.id, code]);
        await audit(this.db, { actorId: null, action: 'schedule.fire_failed', subjectType: 'trigger', subjectId: row.id, outcome: 'failed', errorType: code });
        await notify(this.db, row.run_as, 'schedule_failed', {});
        log.warn('schedule_failed', { triggerId: row.id, errorType: code });
      }
    }
    return fired;
  }
}

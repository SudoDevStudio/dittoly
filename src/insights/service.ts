import { audit } from '../core/audit.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';

/**
 * Run insights: which Flows fail and where, how long runs take, how long they wait on
 * people (sign-offs, forms, teammates), and the time they save (the owner says how long
 * one run would take by hand). Counts and times only; no run data.
 */

export interface FlowInsight {
  flowId: string;
  name: string;
  team: string | null;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  dry: number;
  /** Share of finished real runs that succeeded (0–1), null without finished runs. */
  successRate: number | null;
  medianSeconds: number | null;
  p90Seconds: number | null;
  /** Time runs spent waiting on people, in seconds (sum). */
  waitingSeconds: number;
  manualMinutes: number | null;
  /** manualMinutes × successful real runs. */
  savedMinutes: number | null;
  topFailures: { step: string; errorType: string; count: number }[];
}

export interface WaitInsight {
  kind: 'sign-off' | 'form' | 'teammate';
  count: number;
  medianSeconds: number | null;
  longestSeconds: number | null;
}

const canSeeAll = (m: Member) => m.role === 'admin' || m.role === 'approver';

/** Flows this member's insights cover: their teams' (admins and approvers: every team's). */
const VISIBLE = `($2 OR f.team_id IN (SELECT team_id FROM team_members WHERE member_id = $1))`;

export async function insights(db: Queryable, member: Member, days: number, teamId?: string) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest('invalid_days');
  const args = [member.id, canSeeAll(member), days, teamId ?? null];
  const teamFilter = `AND ($4::uuid IS NULL OR f.team_id = $4)`;
  const since = `now() - make_interval(days => $3)`;

  const flows = await db.query<{
    flow_id: string;
    name: string;
    team: string | null;
    manual_minutes: number | null;
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    dry: number;
    median: number | null;
    p90: number | null;
  }>(
    `SELECT f.id AS flow_id, f.name, t.name AS team, f.manual_minutes,
            count(r.id)::int AS runs,
            count(r.id) FILTER (WHERE r.status = 'succeeded' AND NOT r.dry)::int AS succeeded,
            count(r.id) FILTER (WHERE r.status IN ('failed', 'paused') AND NOT r.dry)::int AS failed,
            count(r.id) FILTER (WHERE r.status = 'cancelled' AND NOT r.dry)::int AS cancelled,
            count(r.id) FILTER (WHERE r.dry)::int AS dry,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.finished_at - r.created_at)) FILTER (WHERE r.status = 'succeeded' AND NOT r.dry) AS median,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM r.finished_at - r.created_at)) FILTER (WHERE r.status = 'succeeded' AND NOT r.dry) AS p90
     FROM flows f
     LEFT JOIN teams t ON t.id = f.team_id
     LEFT JOIN flow_versions v ON v.flow_id = f.id
     LEFT JOIN runs r ON r.flow_version_id = v.id AND r.created_at > ${since}
     WHERE ${VISIBLE} ${teamFilter}
     GROUP BY f.id, f.name, t.name, f.manual_minutes
     ORDER BY count(r.id) DESC, f.name`,
    args,
  );

  const failures = await db.query<{ flow_id: string; step: string; error_type: string; n: number }>(
    `SELECT f.id AS flow_id, coalesce(v.definition->'steps'->rs.idx->>'title', rs.step_id) AS step, rs.error_type, count(*)::int AS n
     FROM run_steps rs JOIN runs r ON r.id = rs.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
     WHERE rs.status = 'failed' AND rs.error_type IS NOT NULL AND NOT r.dry AND r.created_at > ${since} AND ${VISIBLE} ${teamFilter}
     GROUP BY f.id, 2, rs.error_type ORDER BY n DESC`,
    args,
  );

  // Waiting on people: sign-off and form steps (from when they started waiting to when they were answered), and teammates.
  const stepWaits = await db.query<{ flow_id: string; kind: 'approval' | 'input'; seconds: number }>(
    `SELECT f.id AS flow_id, v.definition->'steps'->rs.idx->>'type' AS kind, extract(epoch FROM rs.finished_at - rs.started_at)::float8 AS seconds
     FROM run_steps rs JOIN runs r ON r.id = rs.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
     WHERE v.definition->'steps'->rs.idx->>'type' IN ('approval', 'input') AND rs.started_at IS NOT NULL AND rs.finished_at IS NOT NULL
       AND NOT r.dry AND r.created_at > ${since} AND ${VISIBLE} ${teamFilter}`,
    args,
  );
  const teammateWaits = await db.query<{ flow_id: string; seconds: number }>(
    `SELECT f.id AS flow_id, extract(epoch FROM d.decided_at - d.created_at)::float8 AS seconds
     FROM delegations d JOIN runs r ON r.id = d.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
     WHERE d.decided_at IS NOT NULL AND r.created_at > ${since} AND ${VISIBLE} ${teamFilter}`,
    args,
  );

  const waitsByFlow = new Map<string, number>();
  for (const w of [...stepWaits.rows, ...teammateWaits.rows]) waitsByFlow.set(w.flow_id, (waitsByFlow.get(w.flow_id) ?? 0) + Math.max(0, w.seconds));

  const flowsOut: FlowInsight[] = flows.rows.map((r) => {
    const finished = r.succeeded + r.failed;
    return {
      flowId: r.flow_id,
      name: r.name,
      team: r.team,
      runs: r.runs,
      succeeded: r.succeeded,
      failed: r.failed,
      cancelled: r.cancelled,
      dry: r.dry,
      successRate: finished ? r.succeeded / finished : null,
      medianSeconds: r.median === null ? null : Math.round(r.median),
      p90Seconds: r.p90 === null ? null : Math.round(r.p90),
      waitingSeconds: Math.round(waitsByFlow.get(r.flow_id) ?? 0),
      manualMinutes: r.manual_minutes,
      savedMinutes: r.manual_minutes === null ? null : r.manual_minutes * r.succeeded,
      topFailures: failures.rows
        .filter((f) => f.flow_id === r.flow_id)
        .slice(0, 3)
        .map((f) => ({ step: f.step, errorType: f.error_type, count: f.n })),
    };
  });

  const summarize = (kind: WaitInsight['kind'], secs: number[]): WaitInsight => {
    const s = secs.map((x) => Math.max(0, x)).sort((a, b) => a - b);
    return { kind, count: s.length, medianSeconds: s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]!) : null, longestSeconds: s.length ? Math.round(s.at(-1)!) : null };
  };
  const waits: WaitInsight[] = [
    summarize('sign-off', stepWaits.rows.filter((w) => w.kind === 'approval').map((w) => w.seconds)),
    summarize('form', stepWaits.rows.filter((w) => w.kind === 'input').map((w) => w.seconds)),
    summarize('teammate', teammateWaits.rows.map((w) => w.seconds)),
  ];

  const succeeded = flowsOut.reduce((n, f) => n + f.succeeded, 0);
  const failed = flowsOut.reduce((n, f) => n + f.failed, 0);
  return {
    days,
    totals: {
      runs: flowsOut.reduce((n, f) => n + f.runs, 0),
      succeeded,
      failed,
      successRate: succeeded + failed ? succeeded / (succeeded + failed) : null,
      savedMinutes: flowsOut.reduce((n, f) => n + (f.savedMinutes ?? 0), 0),
      /** Flows with runs but no manual time set: their savings are not counted. */
      flowsWithoutManualTime: flowsOut.filter((f) => f.runs > 0 && f.manualMinutes === null).length,
    },
    flows: flowsOut,
    waits,
  };
}

/** The Flow's owner (or an admin) says how long one run would take by hand. */
export async function setManualMinutes(db: Queryable, actor: Member, flowId: string, minutes: number | null): Promise<void> {
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_000)) throw badRequest('invalid_minutes');
  const owner = (await db.query<{ created_by: string }>(`SELECT created_by FROM flows WHERE id = $1`, [flowId])).rows[0];
  if (!owner) throw notFound('flow');
  if (owner.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
  await db.query(`UPDATE flows SET manual_minutes = $2 WHERE id = $1`, [flowId, minutes]);
  await audit(db, { actorId: actor.id, action: 'flow.manual_time_set', subjectType: 'flow', subjectId: flowId, outcome: 'ok' });
}

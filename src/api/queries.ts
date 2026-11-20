import type { DeploymentMode } from '../config.js';
import { canApprove, type Member } from '../core/members.js';
import { queueScope } from '../governance/approvals.js';
import { TRIGGER_NAMES, type Trigger } from '../governance/auto-stop.js';
import type { Db } from '../db/db.js';

/** Read-only lists for the portal. IDs, names and statuses only; no run payloads. */

/** Flows the member can see: their teams' (approvers and admins see every team's), optionally one team only. */
/** Deleted (archived) Flows only with `archived` (admins, to restore them). `kind` keeps only Super Flows or only plain Flows (by the latest version). */
export async function listFlows(db: Db, member: Member, teamId?: string, archived = false, kind?: 'super' | 'flow') {
  const { rows } = await db.query<{
    id: string;
    name: string;
    team_id: string;
    team_name: string;
    created_by: string;
    created_at: Date;
    latest_id: string;
    latest_version: number;
    latest_status: string;
    approved_id: string | null;
    is_super: boolean;
    mcp_enabled: boolean;
  }>(
    `SELECT f.id, f.name, f.team_id, t.name AS team_name, f.created_by, f.created_at, f.mcp_enabled,
            v.id AS latest_id, v.version AS latest_version, v.status AS latest_status,
            (SELECT a.id FROM flow_versions a WHERE a.flow_id = f.id AND a.status = 'approved' LIMIT 1) AS approved_id,
            COALESCE(v.definition->'steps' @> '[{"type":"flow"}]'::jsonb, false) AS is_super
     FROM flows f
     JOIN teams t ON t.id = f.team_id
     JOIN LATERAL (SELECT * FROM flow_versions WHERE flow_id = f.id ORDER BY version DESC LIMIT 1) v ON true
     WHERE ($2::uuid IS NULL OR f.team_id = $2) AND (f.archived_at IS NOT NULL) = $4
       AND ($5::text IS NULL OR COALESCE(v.definition->'steps' @> '[{"type":"flow"}]'::jsonb, false) = ($5 = 'super'))
       AND ($3 OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = f.team_id AND tm.member_id = $1))
     ORDER BY f.created_at DESC LIMIT 200`,
    [member.id, teamId ?? null, canApprove(member), archived && member.role === 'admin', kind ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    team: { id: r.team_id, name: r.team_name },
    createdBy: r.created_by,
    createdAt: r.created_at,
    latest: { id: r.latest_id, version: r.latest_version, status: r.latest_status },
    approvedVersionId: r.approved_id,
    /** Runs other Flows (has flow steps). */
    isSuper: r.is_super,
    /** Offered to AI assistants through Dittoly's MCP server. */
    mcpEnabled: r.mcp_enabled,
  }));
}

export async function listRuns(db: Db, member: Member, limit = 50) {
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.wait_reason, r.created_at, r.finished_at, r.flow_version_id, f.name AS flow_name, v.version
     FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
     WHERE r.run_as = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [member.id, Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50],
  );
  return rows.map((r) => ({
    id: r.id,
    flowName: r.flow_name,
    version: r.version,
    flowVersionId: r.flow_version_id,
    status: r.status,
    waitReason: r.wait_reason,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }));
}

/** Everything waiting on this member's decision. On a shared server nobody decides on their own work. */
export async function approvalQueue(db: Db, member: Member, mode: DeploymentMode) {
  const excludeOwn = mode === 'shared';
  const out: {
    kind: string; id: string; title: string; flowId?: string; appId?: string; runId?: string; stepId?: string; createdAt: Date;
    /** The automatic stop that paused the run (kind auto_stop). */
    stopId?: string;
    /** Approving as this person's stand-in. */
    forMember?: string;
    /** An org admin approving outside the Flow's team (team approvals rule). */
    outsideTeam?: boolean;
  }[] = [];
  if (canApprove(member)) {
    // With the team approvals rule: only the member's teams, the teams of whoever they stand in for, and (for admins) the rest, marked.
    const scope = await queueScope(db, member);
    const place = (teamId: string): { show: boolean; forMember?: string; outsideTeam?: boolean } => {
      if (!scope.rule || scope.mine.has(teamId)) return { show: true };
      const forMember = scope.standingIn.get(teamId);
      if (forMember) return { show: true, forMember };
      return member.role === 'admin' ? { show: true, outsideTeam: true } : { show: false };
    };
    const flows = await db.query(
      `SELECT v.id, v.flow_id, f.name, f.team_id, v.version, v.created_at FROM flow_versions v JOIN flows f ON f.id = v.flow_id
       WHERE v.status = 'pending' AND f.archived_at IS NULL AND ($2 = false OR v.created_by <> $1) ORDER BY v.created_at`,
      [member.id, excludeOwn],
    );
    for (const r of flows.rows) {
      const { show, ...how } = place(r.team_id);
      if (show) out.push({ kind: 'flow_version', id: r.id, flowId: r.flow_id, title: `${r.name} v${r.version}`, createdAt: r.created_at, ...how });
    }
    // App versions waiting for sign-off (src/team-apps/service.ts).
    const apps = await db.query(
      `SELECT v.id, v.app_id, a.name, a.team_id, v.version, v.created_at FROM app_versions v JOIN apps a ON a.id = v.app_id
       WHERE v.status = 'pending' AND a.archived_at IS NULL AND ($2 = false OR v.created_by <> $1) ORDER BY v.created_at`,
      [member.id, excludeOwn],
    );
    for (const r of apps.rows) {
      const { show, ...how } = place(r.team_id);
      if (show) out.push({ kind: 'app_version', id: r.id, appId: r.app_id, title: `App ${r.name} v${r.version}`, createdAt: r.created_at, ...how });
    }
    const gates = await db.query(
      `SELECT s.run_id, s.step_id, f.name, f.team_id, s.started_at, s.error_type = 'awaiting_sign_off' AS guard,
              (SELECT st->>'title' FROM jsonb_array_elements(v.definition->'steps') st WHERE st->>'id' = s.step_id) AS step_title
       FROM run_steps s
       JOIN runs r ON r.id = s.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
       WHERE s.status = 'waiting' AND r.wait_reason = 'approval' AND ($2 = false OR r.run_as <> $1)
       ORDER BY s.started_at`,
      [member.id, excludeOwn],
    );
    for (const r of gates.rows) {
      const { show, ...how } = place(r.team_id);
      if (show) out.push({ kind: 'gate', id: `${r.run_id}:${r.step_id}`, title: `${r.name}: ${r.guard ? 'check what the AI wrote before ' : ''}${r.step_title ?? r.step_id}`, runId: r.run_id, stepId: r.step_id, createdAt: r.started_at, ...how });
    }
    // Runs paused by their Flow's automatic stop: whoever may resume the Flow decides whether each goes on (Automatic stops page).
    const stopped = await db.query(
      `SELECT r.id AS run_id, f.id AS flow_id, f.name, f.team_id, a.id AS stop_id, a.trigger, a.tripped_at
       FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
       JOIN autostops a ON a.subject_type = 'flow' AND a.subject_id = f.id AND a.resumed_at IS NULL
       WHERE r.status = 'waiting' AND r.wait_reason = 'auto_stop' ORDER BY a.tripped_at, r.created_at`,
    );
    for (const r of stopped.rows) {
      const { show, ...how } = place(r.team_id);
      if (show) out.push({ kind: 'auto_stop', id: r.run_id, title: `${r.name}: paused by an automatic stop (${TRIGGER_NAMES[r.trigger as Trigger] ?? r.trigger})`, flowId: r.flow_id, runId: r.run_id, stopId: r.stop_id, createdAt: r.tripped_at, ...how });
    }
  }
  // Runs waiting at their AI cost cap: for their owner, and for the team's approvers.
  const capped = await db.query(
    `SELECT s.run_id, s.step_id, f.id AS flow_id, f.name, f.team_id, r.run_as, s.started_at FROM run_steps s
     JOIN runs r ON r.id = s.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
     WHERE s.status = 'waiting' AND s.error_type = 'cost_cap_reached' AND r.wait_reason = 'cost_cap' ORDER BY s.started_at`,
  );
  const capScope = canApprove(member) ? await queueScope(db, member) : null;
  for (const r of capped.rows) {
    const mine = r.run_as === member.id;
    const approver = capScope && (!capScope.rule || capScope.mine.has(r.team_id) || capScope.standingIn.has(r.team_id) || member.role === 'admin');
    if (mine || approver) out.push({ kind: 'cost_cap', id: `${r.run_id}:${r.step_id}`, title: `${r.name}: reached its AI cost cap`, flowId: r.flow_id, runId: r.run_id, stepId: r.step_id, createdAt: r.started_at });
  }
  // The member's own runs waiting for them to fill in a form.
  const inputs = await db.query(
    `SELECT s.run_id, s.step_id, f.name, s.started_at,
            (SELECT st->>'title' FROM jsonb_array_elements(v.definition->'steps') st WHERE st->>'id' = s.step_id) AS step_title
     FROM run_steps s
     JOIN runs r ON r.id = s.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
     WHERE s.status = 'waiting' AND r.wait_reason = 'input_needed' AND r.run_as = $1
     ORDER BY s.started_at`,
    [member.id],
  );
  for (const r of inputs.rows) {
    out.push({ kind: 'input', id: `${r.run_id}:${r.step_id}`, title: `${r.name}: ${r.step_title ?? r.step_id}`, runId: r.run_id, stepId: r.step_id, createdAt: r.started_at });
  }
  if (canApprove(member)) {
    const rev = await db.query<{ id: string; run_id: string | null; agent_call_id: string | null; n: number; name: string | null; created_at: Date }>(
      `SELECT r.id, r.run_id, r.agent_call_id, cardinality(r.undo_ids) AS n, f.name, r.created_at
       FROM reversals r LEFT JOIN runs ru ON ru.id = r.run_id LEFT JOIN flow_versions v ON v.id = ru.flow_version_id LEFT JOIN flows f ON f.id = v.flow_id
       WHERE r.status = 'pending' AND ($2 = false OR r.requested_by IS DISTINCT FROM $1) ORDER BY r.created_at`,
      [member.id, excludeOwn],
    );
    for (const r of rev.rows) {
      const what = r.run_id ? `${r.name ?? 'a run'}` : "an AI agent's call";
      out.push({ kind: 'reversal', id: r.id, title: `Reverse ${r.n} change${r.n === 1 ? '' : 's'} of ${what}`, ...(r.run_id ? { runId: r.run_id } : {}), createdAt: r.created_at });
    }
  }
  if (member.role === 'admin') {
    const mods = await db.query(
      `SELECT id, name, version, created_at FROM module_versions WHERE status = 'pending_review' AND name NOT IN (SELECT name FROM module_archive) AND ($2 = false OR created_by IS DISTINCT FROM $1) ORDER BY created_at`,
      [member.id, excludeOwn],
    );
    for (const r of mods.rows) out.push({ kind: 'module', id: r.id, title: `${r.name}@${r.version}`, createdAt: r.created_at });
  }
  return out;
}

/**
 * The credentials approved modules ask for, and whether this member has stored
 * each one. Lets members fill their vault without knowing service names.
 */
export async function neededCredentials(db: Db, member: Member) {
  const { rows } = await db.query<{ service: string; label: string; placement: string; module: string; optional: boolean; stored: boolean }>(
    `SELECT DISTINCT ON (c->>'service', mv.name)
            c->>'service' AS service, c->>'label' AS label, c->'placement'->>'type' AS placement, mv.manifest->>'title' AS module,
            COALESCE((c->>'optional')::boolean, false) AS optional,
            EXISTS (SELECT 1 FROM credentials k WHERE k.member_id = $1 AND k.service = c->>'service') AS stored
     FROM module_versions mv, jsonb_array_elements(mv.manifest->'credentials') c
     WHERE mv.status = 'approved'
     ORDER BY c->>'service', mv.name, mv.created_at DESC`,
    [member.id],
  );
  // A service is optional only when every module that uses it can work without it.
  const byService = new Map<string, { service: string; label: string; placement: string; modules: string[]; optional: boolean; stored: boolean }>();
  for (const r of rows) {
    const entry = byService.get(r.service) ?? { service: r.service, label: r.label, placement: r.placement, modules: [], optional: true, stored: r.stored };
    entry.optional &&= r.optional;
    if (!entry.modules.includes(r.module)) entry.modules.push(r.module);
    byService.set(r.service, entry);
  }
  const rank = (n: { stored: boolean; optional: boolean }) => (n.stored ? 2 : n.optional ? 1 : 0);
  return [...byService.values()].sort((a, b) => rank(a) - rank(b) || a.service.localeCompare(b.service));
}

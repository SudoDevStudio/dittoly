import type { Queryable } from '../db/db.js';
import type { FlowService } from '../flows/service.js';
import { aiInventory, inventorySummary, type OrgAi } from './ai-inventory.js';
import { changeReportRows } from './changes.js';
import { describePolicy, listPolicies } from './policies.js';
import { verifyAudit, type ChainReport } from './audit-chain.js';
import { CHAIN_CONTROLS, controlsFor, controlSummary } from './evidence.js';

/**
 * The audit report an admin hands to a reviewer: who changed what, who approved it
 * (flagging anyone who approved their own work), who ran what as whom, break-glass
 * use, rule changes, access reviews, self-fix change records and their decisions, the AI system
 * inventory, automatic stops and who resumed them, and whether the audit chain is intact.
 */

export interface ReportRow {
  section: 'approval' | 'run' | 'delegation' | 'breakglass' | 'policy' | 'access' | 'change' | 'ai' | 'autostop';
  at: Date;
  who: string | null;
  what: string;
  subject: string;
  detail: string;
  /** Separation-of-duties or other flag a reviewer should look at. */
  flag: string | null;
  /** Controls this line is evidence for, e.g. "SOC 2 CC8.1", "ISO/IEC 27001:2022 A.8.32". */
  controls?: string[];
}

export interface AuditReport {
  from: Date;
  to: Date;
  generatedAt: Date;
  chain: ChainReport;
  rulesInForce: string[];
  rows: ReportRow[];
  counts: Record<ReportRow['section'] | 'flagged', number>;
  /** Per control: how many lines are evidence for it (a starting point for an auditor, not a claim of compliance). */
  controls: ReturnType<typeof controlSummary>;
  chainControls: string[];
  /** Every place AI is used now, per risk class (src/governance/ai-inventory.ts); absent without the Flow service. */
  aiInventory?: ReturnType<typeof inventorySummary>;
}

export async function auditReport(db: Queryable, from: Date, to: Date, ai?: { flows: FlowService; org: OrgAi }): Promise<AuditReport> {
  const rows: ReportRow[] = [];
  const range = [from, to];

  // Module approvals: approving a module you drafted is a flag.
  // A self-fix is drafted by Dittoly; one that widens access lists each of its several approvers.
  for (const r of (await db.query<{ at: Date; reviewer: string | null; author: string | null; fix: boolean; approvers: string[] | null; name: string; version: string; status: string; same: boolean }>(
    `SELECT mv.reviewed_at AS at, rv.handle AS reviewer, au.handle AS author, coalesce(mv.generation ? 'fix', false) AS fix, mv.name, mv.version, mv.status, mv.reviewed_by = mv.created_by AS same,
            (SELECT array_agg(m.handle ORDER BY a.approved_at) FROM module_version_approvals a JOIN members m ON m.id = a.approver_id WHERE a.version_id = mv.id) AS approvers
     FROM module_versions mv LEFT JOIN members rv ON rv.id = mv.reviewed_by LEFT JOIN members au ON au.id = mv.created_by
     WHERE mv.reviewed_at BETWEEN $1 AND $2 ORDER BY mv.reviewed_at`, range)).rows) {
    const author = r.author ?? (r.fix ? 'Dittoly (self-fix)' : 'seed');
    rows.push({ section: 'approval', at: r.at, who: r.reviewer, what: `module ${r.status}`, subject: `${r.name}@${r.version}`, detail: `drafted by ${author}${r.approvers?.length ? `; approved by ${r.approvers.join(', ')}` : ''}`, flag: r.same ? 'approved own module' : null });
  }
  // Flow versions: every approver (several when a rule asks), and the author.
  // "sam for maya" when a stand-in approved; "(org admin outside the team)" under the team approvals rule.
  for (const r of (await db.query<{ at: Date; decider: string | null; author: string; flow: string; version: number; status: string; approvers: string[] | null; self: boolean }>(
    `SELECT fv.decided_at AS at,
            d.handle || COALESCE(' for ' || df.handle, '') || CASE WHEN fv.decided_outside_team THEN ' (org admin outside the team)' ELSE '' END AS decider,
            au.handle AS author, f.name AS flow, fv.version, fv.status,
            (SELECT array_agg(m.handle || COALESCE(' for ' || o.handle, '') || CASE WHEN a.outside_team THEN ' (org admin outside the team)' ELSE '' END ORDER BY a.approved_at)
               FROM flow_version_approvals a JOIN members m ON m.id = a.approver_id LEFT JOIN members o ON o.id = a.on_behalf_of WHERE a.version_id = fv.id) AS approvers,
            (fv.decided_by = fv.created_by OR EXISTS (SELECT 1 FROM flow_version_approvals a WHERE a.version_id = fv.id AND a.approver_id = fv.created_by)) AS self
     FROM flow_versions fv JOIN flows f ON f.id = fv.flow_id JOIN members au ON au.id = fv.created_by LEFT JOIN members d ON d.id = fv.decided_by
     LEFT JOIN members df ON df.id = fv.decided_for
     WHERE fv.decided_at BETWEEN $1 AND $2 AND fv.status IN ('approved', 'rejected', 'superseded') ORDER BY fv.decided_at`, range)).rows) {
    const by = r.approvers?.length ? r.approvers.join(', ') : r.decider ?? 'unknown';
    rows.push({ section: 'approval', at: r.at, who: r.decider, what: `flow version ${r.status === 'superseded' ? 'approved' : r.status}`, subject: `${r.flow} v${r.version}`, detail: `drafted by ${r.author}; decided by ${by}`, flag: r.self ? 'approved own Flow' : null });
  }
  // Runs: who started it, who it ran as, and how.
  for (const r of (await db.query<{ at: Date; id: string; flow: string; version: number; run_as: string; actor: string | null; dry: boolean; breakglass_id: string | null; status: string; via: string }>(
    `SELECT r.created_at AS at, r.id, f.name AS flow, fv.version, ra.handle AS run_as, ac.handle AS actor, r.dry, r.breakglass_id, r.status,
            CASE WHEN r.trigger_id IS NOT NULL THEN 'webhook' WHEN r.schedule_id IS NOT NULL THEN 'schedule' WHEN r.watch_id IS NOT NULL THEN 'watch' WHEN r.endpoint_id IS NOT NULL THEN 'Flow URL' WHEN r.mcp_token_id IS NOT NULL THEN 'AI assistant (MCP)'
                 WHEN r.parent_run_id IS NOT NULL THEN 'Super Flow' WHEN r.followup_of IS NOT NULL THEN 'follow-up' ELSE 'manual' END AS via
     FROM runs r JOIN flow_versions fv ON fv.id = r.flow_version_id JOIN flows f ON f.id = fv.flow_id JOIN members ra ON ra.id = r.run_as
     LEFT JOIN LATERAL (SELECT e.actor_id FROM audit_events e WHERE e.subject_type = 'run' AND e.subject_id = r.id::text AND e.action LIKE 'run.%started' ORDER BY e.id LIMIT 1) st ON true
     LEFT JOIN members ac ON ac.id = st.actor_id
     WHERE r.created_at BETWEEN $1 AND $2 ORDER BY r.created_at`, range)).rows) {
    const asOther = r.actor && r.actor !== r.run_as;
    rows.push({
      section: 'run',
      at: r.at,
      who: r.actor ?? r.run_as,
      what: r.dry ? 'dry run' : 'run',
      subject: `${r.flow} v${r.version}`,
      detail: `run ${r.id} as ${r.run_as} via ${r.via}; ${r.status}`,
      flag: r.breakglass_id ? 'break-glass' : asOther && r.via === 'manual' ? 'ran as someone else' : null,
    });
  }
  for (const r of (await db.query<{ at: Date; requester: string; delegate: string; action: string; status: string; module: string }>(
    `SELECT d.created_at AS at, rq.handle AS requester, dl.handle AS delegate, d.action, d.status, mv.name AS module
     FROM delegations d JOIN members rq ON rq.id = d.requester_id JOIN members dl ON dl.id = d.delegate_id JOIN module_versions mv ON mv.id = d.module_version_id
     WHERE d.created_at BETWEEN $1 AND $2 ORDER BY d.created_at`, range)).rows) {
    rows.push({ section: 'delegation', at: r.at, who: r.requester, what: 'asked a teammate to run an action', subject: `${r.module}.${r.action}`, detail: `with ${r.delegate}'s access; ${r.status}`, flag: null });
  }
  for (const r of (await db.query<{ at: Date; member: string; act_as: string; reason: string; expires_at: Date; ended_at: Date | null; runs: number }>(
    `SELECT g.started_at AS at, m.handle AS member, a.handle AS act_as, g.reason, g.expires_at, g.ended_at, (SELECT count(*)::int FROM runs r WHERE r.breakglass_id = g.id) AS runs
     FROM breakglass_grants g JOIN members m ON m.id = g.member_id JOIN members a ON a.id = g.act_as
     WHERE g.started_at BETWEEN $1 AND $2 ORDER BY g.started_at`, range)).rows) {
    rows.push({ section: 'breakglass', at: r.at, who: r.member, what: 'break-glass access', subject: `as ${r.act_as}`, detail: `reason: ${r.reason}; ${r.runs} run(s); ${r.ended_at ? 'ended' : 'until'} ${(r.ended_at ?? r.expires_at).toISOString()}`, flag: 'break-glass' });
  }
  // Rule changes, access reviews and provisioning by the identity provider (SCIM) come from the audit log itself.
  for (const r of (await db.query<{ at: Date; who: string | null; action: string; subject_type: string; subject_id: string; related_id: string | null }>(
    `SELECT e.at, m.handle AS who, e.action, e.subject_type, e.subject_id, e.related_id FROM audit_events e LEFT JOIN members m ON m.id = e.actor_id
     WHERE e.at BETWEEN $1 AND $2 AND (e.subject_type = 'policy' OR e.action LIKE 'access.%' OR e.action LIKE 'scim.%' OR e.action LIKE 'breakglass.%allowed') ORDER BY e.id`, range)).rows) {
    const policy = r.subject_type === 'policy';
    rows.push({
      section: policy ? 'policy' : 'access',
      at: r.at,
      who: r.who ?? (r.action.startsWith('scim.') ? 'identity provider (SCIM)' : 'Dittoly'),
      what: r.action.replace(/^[a-z]+\./, '').replace(/_/g, ' '),
      subject: policy ? `rule ${r.subject_id}` : r.subject_id,
      detail: r.related_id ? `related ${r.related_id}` : '',
      flag: r.action === 'access.expired_unreviewed' ? 'removed unreviewed' : null,
    });
  }
  // Self-fixes as governed changes: each change record, and each decision on its parts.
  for (const r of await changeReportRows(db, from, to)) rows.push({ section: 'change', ...r });
  // AI system inventory: classifications (each one is a review).
  for (const r of (await db.query<{ at: Date; who: string | null; action: string; subject_id: string }>(
    `SELECT e.at, m.handle AS who, e.action, e.subject_id FROM audit_events e LEFT JOIN members m ON m.id = e.actor_id
     WHERE e.at BETWEEN $1 AND $2 AND e.action LIKE 'ai_inventory.%' ORDER BY e.id`, range)).rows) {
    const riskClass = r.action.replace('ai_inventory.classified_', '');
    rows.push({ section: 'ai', at: r.at, who: r.who, what: 'AI use classified', subject: r.subject_id, detail: `risk class: ${riskClass.replace('_', ' ')}`, flag: riskClass === 'high' || riskClass === 'prohibited_check' ? `risk class ${riskClass.replace('_', ' ')}` : null });
  }
  // Automatic stops (src/governance/auto-stop.ts): each trip with what crossed its threshold, and each resume with its reason.
  for (const r of (await db.query<{ tripped_at: Date; resumed_at: Date | null; trigger: string; summary: string; subject_type: string; name: string | null; resumed_by: string | null; reason: string | null; decisions: Record<string, string> | null }>(
    `SELECT a.tripped_at, a.resumed_at, a.trigger, a.evidence->>'summary' AS summary, a.subject_type, coalesce(f.name, t.name) AS name, m.handle AS resumed_by, a.resume_reason AS reason, a.run_decisions AS decisions
     FROM autostops a LEFT JOIN flows f ON a.subject_type = 'flow' AND f.id = a.subject_id LEFT JOIN mcp_tokens t ON a.subject_type = 'agent' AND t.id = a.subject_id
     LEFT JOIN members m ON m.id = a.resumed_by
     WHERE a.tripped_at BETWEEN $1 AND $2 OR a.resumed_at BETWEEN $1 AND $2 ORDER BY a.tripped_at`, range)).rows) {
    const subject = `${r.subject_type === 'flow' ? 'Flow' : 'agent'} ${r.name ?? '(removed)'}`;
    if (r.tripped_at >= from && r.tripped_at <= to) {
      rows.push({ section: 'autostop', at: r.tripped_at, who: 'Dittoly', what: `automatic stop: ${r.trigger.replace(/_/g, ' ')}`, subject, detail: r.summary, flag: 'automatic stop' });
    }
    if (r.resumed_at && r.resumed_at >= from && r.resumed_at <= to) {
      const runs = Object.values(r.decisions ?? {});
      const counts = runs.length ? `; runs: ${runs.filter((d) => d === 'continued').length} continued, ${runs.filter((d) => d === 'cancelled').length} cancelled` : '';
      rows.push({ section: 'autostop', at: r.resumed_at, who: r.resumed_by, what: 'automatic stop resumed', subject, detail: `reason: ${r.reason ?? ''}${counts}`, flag: null });
    }
  }
  rows.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const r of rows) r.controls = controlsFor(r).map((c) => `${c.framework} ${c.id}`);
  const counts = { approval: 0, run: 0, delegation: 0, breakglass: 0, policy: 0, access: 0, change: 0, ai: 0, autostop: 0, flagged: 0 };
  for (const r of rows) {
    counts[r.section] += 1;
    if (r.flag) counts.flagged += 1;
  }
  return {
    from,
    to,
    generatedAt: new Date(),
    chain: await verifyAudit(db),
    rulesInForce: (await listPolicies(db, true)).map(describePolicy),
    rows,
    counts,
    controls: controlSummary(rows),
    chainControls: CHAIN_CONTROLS.map((c) => `${c.framework} ${c.id}`),
    ...(ai ? { aiInventory: inventorySummary(await aiInventory(db, ai.flows, ai.org)) } : {}),
  };
}

export const csvCell = (v: string) => {
  // Neutralize spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function reportCsv(r: AuditReport): string {
  const head = [
    `# Dittoly audit report ${r.from.toISOString()} to ${r.to.toISOString()}, generated ${r.generatedAt.toISOString()}`,
    `# Audit chain: ${r.chain.ok ? 'intact' : 'BROKEN'}; ${r.chain.sealed} sealed events; head ${r.chain.head ? `${r.chain.head.eventId}:${r.chain.head.hash}` : 'none'}`,
    ...r.chain.problems.map((p) => `# ${p}`),
    `# The audit log and its chain are evidence for: ${r.chainControls.join('; ')}`,
    ...(r.aiInventory
      ? [`# AI system inventory: ${r.aiInventory.entries} entries (${Object.entries(r.aiInventory.byClass).map(([k, n]) => `${k.replace('_', ' ')} ${n}`).join(', ')}); ${r.aiInventory.flowsWithUnguardedReach} Flow(s) where AI output reaches a change without a person checking`]
      : []),
    `# Control mapping is a starting point for an auditor, not a claim of compliance.`,
    'section,at,who,what,subject,detail,flag,controls',
  ];
  return [...head, ...r.rows.map((x) => [x.section, x.at.toISOString(), x.who ?? '', x.what, x.subject, x.detail, x.flag ?? '', (x.controls ?? []).join('; ')].map(csvCell).join(','))].join('\n') + '\n';
}

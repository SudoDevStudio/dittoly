import { audit } from '../core/audit.js';
import { conflict, forbidden, notFound } from '../core/errors.js';
import { canApprove, type Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';
import type { AiTally } from '../ai/metering.js';
import type { DriftSummary } from '../modules/health.js';
import { accessWidening, lineDiff, manifestChanges } from '../modules/diff.js';
import type { ModuleVersion } from '../modules/registry.js';
import { listPolicies } from './policies.js';
import { readablePair } from '../modules/source.js';

/**
 * Change records. Every self-fix is one governed change: the drift that started it, the AI request
 * and what it produced, how the manifest and code changed, the tests, the Flow versions proposed,
 * and each decision people made. Nothing is applied by itself: the module and every Flow version
 * still need their usual approvals, and nobody who asked for the change may approve any part of it.
 *
 * A fix that widens access (a new host, a new credential, a new action that changes data, or an
 * action that went from reading to changing data) is flagged and needs several different admins,
 * like a new module under the organization's several-approvers rule (at least two).
 */

export type ChangeStatus = 'proposed' | 'partly_approved' | 'approved' | 'rejected' | 'superseded' | 'failed';

/** What a person sees for each affected Flow (as self-fixing reports it). */
export interface ChangeFlow {
  flowId: string;
  name: string;
  versionId?: string;
  status: 'proposed' | 'needs_person';
  reason?: string;
  tests?: { total: number; passed: number };
}

interface Row {
  id: string;
  module_name: string;
  from_version_id: string | null;
  from_version: string;
  module_version_id: string | null;
  flow_version_ids: string[];
  status: ChangeStatus;
  requested_by: string | null;
  requested_how: 'automatic' | 'by_hand';
  drift: { detectedAt: string; summary: DriftSummary };
  ai: { provider: string | null; model: string | null; inputTokens: number; outputTokens: number; cost: { amount: number; currency: string } | null };
  diff: { changes: string[]; code: { added: number; removed: number }; widening: string[] };
  widens_access: boolean;
  approvals_needed: number;
  tests: { module: TestCount; recorded: TestCount; flows: { flowId: string; name: string; total: number; passed: number }[] };
  flows: ChangeFlow[];
  created_at: Date;
  updated_at: Date;
}

interface TestCount {
  total: number;
  passed: number;
  failing: string[];
}

/** Who turned self-fixing on: the requester of the fixes it drafts by itself (null: on by default). */
export async function selfFixEnabledBy(db: Queryable): Promise<string | null> {
  return (await db.query<{ updated_by: string | null }>(`SELECT updated_by FROM org_settings WHERE key = 'self_fix'`)).rows[0]?.updated_by ?? null;
}

async function estimatedCost(db: Queryable, provider: string | undefined, model: string | undefined, input: number, output: number) {
  if (!provider || !model) return null;
  const p = (await db.query<{ input_per_million: string; output_per_million: string; currency: string }>(`SELECT * FROM ai_prices WHERE provider = $1 AND model = $2`, [provider, model])).rows[0];
  return p ? { amount: (input * Number(p.input_per_million) + output * Number(p.output_per_million)) / 1_000_000, currency: p.currency } : null;
}

/** How many different admins a widening change's module needs: the several-approvers rule, at least two. */
async function wideningApprovals(db: Queryable): Promise<number> {
  const counts = (await listPolicies(db, true)).filter((p) => p.kind === 'approvals_for_writes').map((p) => (p.config as { count: number }).count);
  return Math.max(2, ...counts);
}

const testCount = (tests: { name: string; passed: boolean }[]): TestCount => ({
  total: tests.length,
  passed: tests.filter((t) => t.passed).length,
  failing: tests.filter((t) => !t.passed).map((t) => t.name).slice(0, 20),
});

/**
 * Record a self-fix as a change. `fix` is the drafted module version; `sent` whether it passed its
 * tests and went for review (otherwise the change is "failed": nothing was asked of anyone).
 */
export async function recordSelfFix(
  db: Queryable,
  input: {
    from: ModuleVersion;
    fix: ModuleVersion;
    drift: { detectedAt: Date; summary: DriftSummary };
    tally: AiTally;
    requester: { id: string | null; how: 'automatic' | 'by_hand' };
    flows: ChangeFlow[];
    sent: boolean;
  },
): Promise<string> {
  const { from, fix } = input;
  const widening = accessWidening(from.manifest, fix.manifest);
  const code = lineDiff(...readablePair(from, fix), 0);
  const tests = fix.validationReport?.tests ?? [];
  const recorded = tests.filter((t) => t.name.startsWith('recorded: '));
  const record = {
    module: testCount(tests.filter((t) => !t.name.startsWith('recorded: '))),
    recorded: testCount(recorded),
    flows: input.flows.filter((f) => f.tests).map((f) => ({ flowId: f.flowId, name: f.name, total: f.tests!.total, passed: f.tests!.passed })),
  };
  const status: ChangeStatus = input.sent ? 'proposed' : 'failed';
  // A newer change for the same module replaces any that still wait.
  const older = await db.query<{ id: string }>(
    `UPDATE change_records SET status = 'superseded', updated_at = now() WHERE module_name = $1 AND status IN ('proposed', 'partly_approved') RETURNING id`,
    [from.name],
  );
  for (const o of older.rows) await audit(db, { actorId: null, action: 'change.superseded', subjectType: 'change', subjectId: o.id, outcome: 'ok' });
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO change_records (module_name, from_version_id, from_version, module_version_id, flow_version_ids, status, requested_by, requested_how,
                                 drift, ai, diff, widens_access, approvals_needed, tests, flows)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      from.name,
      from.id,
      from.version,
      fix.id,
      input.flows.flatMap((f) => (f.versionId ? [f.versionId] : [])),
      status,
      input.requester.id,
      input.requester.how,
      JSON.stringify({ detectedAt: input.drift.detectedAt, summary: input.drift.summary }),
      JSON.stringify({
        provider: input.tally.provider ?? null,
        model: input.tally.model ?? null,
        inputTokens: input.tally.input,
        outputTokens: input.tally.output,
        cost: await estimatedCost(db, input.tally.provider, input.tally.model, input.tally.input, input.tally.output),
      }),
      JSON.stringify({ changes: manifestChanges(from.manifest, fix.manifest), code: { added: code.added, removed: code.removed }, widening }),
      widening.length > 0,
      widening.length ? await wideningApprovals(db) : 1,
      JSON.stringify(record),
      JSON.stringify(input.flows),
    ],
  );
  const id = rows[0]!.id;
  await audit(db, {
    actorId: null,
    action: input.sent ? (widening.length ? 'change.proposed_widening_access' : 'change.proposed') : 'change.failed',
    subjectType: 'change',
    subjectId: id,
    outcome: input.sent ? 'ok' : 'failed',
    relatedId: fix.id,
  });
  return id;
}

/** Refuses an approval by the person who asked for the change (any part of it). Shared mode only. */
export async function assertNotRequester(db: Queryable, part: 'module' | 'flow', subjectId: string, actor: Member): Promise<void> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM change_records WHERE requested_by = $1 AND ${part === 'module' ? 'module_version_id = $2' : '$2 = ANY(flow_version_ids)'}`,
    [actor.id, subjectId],
  );
  if (rowCount) throw forbidden('cannot_approve_change_you_requested');
}

/** Different admins a module version needs: more than one when a change it is part of widens access. */
export async function moduleApprovalsNeeded(db: Queryable, moduleVersionId: string): Promise<number> {
  const { rows } = await db.query<{ n: number | null }>(
    `SELECT max(approvals_needed)::int AS n FROM change_records WHERE module_version_id = $1`,
    [moduleVersionId],
  );
  return rows[0]?.n ?? 1;
}

/**
 * A module approval that needs several admins: records this one and says whether there are enough.
 * Each admin approves once; the version must still wait for review.
 */
export async function recordModuleApproval(db: Queryable, moduleVersionId: string, actor: Member, need: number): Promise<{ given: number; done: boolean }> {
  const pending = await db.query(`SELECT 1 FROM module_versions WHERE id = $1 AND status = 'pending_review'`, [moduleVersionId]);
  if (!pending.rowCount) throw conflict('module_not_pending_review');
  const added = await db.query(`INSERT INTO module_version_approvals (version_id, approver_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [moduleVersionId, actor.id]);
  if (!added.rowCount) throw conflict('already_approved_by_you');
  const given = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM module_version_approvals WHERE version_id = $1`, [moduleVersionId])).rows[0]!.n;
  return { given, done: given >= need };
}

/** The status a change has from its parts' statuses. */
async function computeStatus(db: Queryable, r: Pick<Row, 'id' | 'status' | 'module_version_id' | 'flow_version_ids'>): Promise<ChangeStatus> {
  if (r.status === 'superseded' || r.status === 'failed') return r.status;
  const module = (await db.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [r.module_version_id])).rows[0]?.status;
  const flows = (await db.query<{ status: string }>(`SELECT status FROM flow_versions WHERE id = ANY($1::uuid[])`, [r.flow_version_ids])).rows.map((x) => x.status);
  if (module === 'rejected') return 'rejected';
  if (module === 'approved' && !flows.includes('pending')) return 'approved';
  const any = await db.query(`SELECT 1 FROM change_decisions WHERE change_id = $1 AND decision = 'approved'`, [r.id]);
  return module === 'approved' || any.rowCount ? 'partly_approved' : 'proposed';
}

/** After a module or Flow version is decided: the decision goes on each change it is part of. */
export async function noteChangeDecision(db: Queryable, part: 'module' | 'flow', subjectId: string, actor: Member, decision: 'approved' | 'rejected'): Promise<void> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM change_records WHERE status IN ('proposed', 'partly_approved') AND ${part === 'module' ? 'module_version_id = $1' : '$1 = ANY(flow_version_ids)'}`,
    [subjectId],
  );
  for (const r of rows) {
    const status = (
      await db.query<{ status: string }>(part === 'module' ? `SELECT status FROM module_versions WHERE id = $1` : `SELECT status FROM flow_versions WHERE id = $1`, [subjectId])
    ).rows[0]?.status;
    const final = part === 'module' ? status !== 'pending_review' : status !== 'pending';
    await db.query(`INSERT INTO change_decisions (change_id, part, subject_id, decision, final, decided_by) VALUES ($1, $2, $3, $4, $5, $6)`, [
      r.id,
      part,
      subjectId,
      decision,
      final,
      actor.id,
    ]);
    await audit(db, { actorId: actor.id, action: `change.${part}_${decision}${final ? '' : '_once'}`, subjectType: 'change', subjectId: r.id, outcome: 'ok', relatedId: subjectId });
    const next = await computeStatus(db, r);
    if (next !== r.status) {
      await db.query(`UPDATE change_records SET status = $2, updated_at = now() WHERE id = $1`, [r.id, next]);
      await audit(db, { actorId: actor.id, action: `change.${next}`, subjectType: 'change', subjectId: r.id, outcome: 'ok' });
    }
  }
}

// ---------------------------------------------------------------- reading

const assertReviewer = (actor: Member) => {
  if (!canApprove(actor)) throw forbidden('approver_only');
};

async function handles(db: Queryable, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  return new Map((await db.query<{ id: string; handle: string }>(`SELECT id, handle FROM members WHERE id = ANY($1::uuid[])`, [list])).rows.map((r) => [r.id, r.handle]));
}

const SELF_FIX_AUTHOR = 'Dittoly (self-fix)';

function summary(r: Row, who: Map<string, string>) {
  return {
    id: r.id,
    kind: 'self_fix' as const,
    module: r.module_name,
    fromVersion: r.from_version,
    toVersion: null as string | null,
    status: r.status,
    widensAccess: r.widens_access,
    widening: r.diff.widening,
    approvalsNeeded: r.approvals_needed,
    author: SELF_FIX_AUTHOR,
    requestedBy: r.requested_by ? (who.get(r.requested_by) ?? null) : null,
    requestedHow: r.requested_how,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function versionOf(db: Queryable, id: string | null) {
  return id ? ((await db.query<{ version: string; status: string }>(`SELECT version, status FROM module_versions WHERE id = $1`, [id])).rows[0] ?? null) : null;
}

/** The Changes list: admins and approvers. */
export async function listChanges(db: Queryable, actor: Member) {
  assertReviewer(actor);
  const { rows } = await db.query<Row & { to_version: string | null }>(
    `SELECT c.*, mv.version AS to_version FROM change_records c LEFT JOIN module_versions mv ON mv.id = c.module_version_id ORDER BY c.created_at DESC LIMIT 500`,
  );
  const who = await handles(db, rows.map((r) => r.requested_by));
  return rows.map((r) => ({ ...summary(r, who), toVersion: r.to_version }));
}

/** Changes a module version or Flow version is part of (for links from its review page). */
export async function changesFor(db: Queryable, actor: Member, ref: { moduleVersionId?: string; flowVersionId?: string }) {
  assertReviewer(actor);
  const { rows } = await db.query<Row & { to_version: string | null }>(
    `SELECT c.*, mv.version AS to_version FROM change_records c LEFT JOIN module_versions mv ON mv.id = c.module_version_id
     WHERE c.module_version_id = $1 OR $2 = ANY(c.flow_version_ids) ORDER BY c.created_at DESC`,
    [ref.moduleVersionId ?? null, ref.flowVersionId ?? null],
  );
  const who = await handles(db, rows.map((r) => r.requested_by));
  const given = async (r: Row) =>
    r.module_version_id ? (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM module_version_approvals WHERE version_id = $1`, [r.module_version_id])).rows[0]!.n : 0;
  return Promise.all(rows.map(async (r) => ({ ...summary(r, who), toVersion: r.to_version, moduleApprovalsGiven: await given(r) })));
}

/** One change with all its evidence, diffs, tests and decisions. */
export async function getChange(db: Queryable, actor: Member, id: string) {
  assertReviewer(actor);
  const r = (await db.query<Row>(`SELECT * FROM change_records WHERE id = $1`, [id])).rows[0];
  if (!r) throw notFound('change');
  const decisions = (
    await db.query<{ part: string; subject_id: string; decision: string; final: boolean; decided_by: string; decided_at: Date }>(
      `SELECT part, subject_id, decision, final, decided_by, decided_at FROM change_decisions WHERE change_id = $1 ORDER BY id`,
      [id],
    )
  ).rows;
  const who = await handles(db, [r.requested_by, ...decisions.map((d) => d.decided_by)]);
  const fix = await versionOf(db, r.module_version_id);
  const flowStatus = new Map(
    (await db.query<{ id: string; status: string; version: number }>(`SELECT id, status, version FROM flow_versions WHERE id = ANY($1::uuid[])`, [r.flow_version_ids])).rows.map((v) => [v.id, v]),
  );
  // The code diff, from the stored versions (both are immutable).
  const codes = (await db.query<{ id: string; code: string; source: string | null }>(`SELECT id, code, source FROM module_versions WHERE id = ANY($1::uuid[])`, [[r.from_version_id, r.module_version_id].filter(Boolean)])).rows;
  const fromRow = codes.find((c) => c.id === r.from_version_id);
  const toRow = codes.find((c) => c.id === r.module_version_id);
  const [before, after] = fromRow && toRow ? readablePair(fromRow, toRow) : [undefined, undefined];
  const given = r.module_version_id
    ? (await db.query<{ handle: string; approved_at: Date }>(
        `SELECT m.handle, a.approved_at FROM module_version_approvals a JOIN members m ON m.id = a.approver_id WHERE a.version_id = $1 ORDER BY a.approved_at`,
        [r.module_version_id],
      )).rows.map((x) => ({ handle: x.handle, at: x.approved_at }))
    : [];
  return {
    ...summary(r, who),
    toVersion: fix?.version ?? null,
    drift: r.drift,
    ai: r.ai,
    moduleVersion: {
      fromVersionId: r.from_version_id,
      versionId: r.module_version_id,
      status: fix?.status ?? null,
      approvals: { required: r.approvals_needed, given },
    },
    diff: { ...r.diff, codeLines: before !== undefined && after !== undefined ? lineDiff(before, after).lines : [] },
    tests: r.tests,
    flows: r.flows.map((f) => ({ ...f, versionStatus: f.versionId ? (flowStatus.get(f.versionId)?.status ?? null) : null, version: f.versionId ? (flowStatus.get(f.versionId)?.version ?? null) : null })),
    decisions: decisions.map((d) => ({ part: d.part, subjectId: d.subject_id, decision: d.decision, final: d.final, by: who.get(d.decided_by) ?? null, at: d.decided_at })),
  };
}

/** Lines for the audit report: each change, and each decision on it. */
export async function changeReportRows(db: Queryable, from: Date, to: Date) {
  const out: { at: Date; who: string | null; what: string; subject: string; detail: string; flag: string | null }[] = [];
  for (const r of (await db.query<Row & { requester: string | null; to_version: string | null }>(
    `SELECT c.*, m.handle AS requester, mv.version AS to_version FROM change_records c LEFT JOIN members m ON m.id = c.requested_by
     LEFT JOIN module_versions mv ON mv.id = c.module_version_id WHERE c.created_at BETWEEN $1 AND $2 ORDER BY c.created_at`,
    [from, to],
  )).rows) {
    const flows = r.flows.filter((f) => f.status === 'proposed').length;
    out.push({
      at: r.created_at,
      who: SELF_FIX_AUTHOR,
      what: `self-fix ${r.status.replace('_', ' ')}`,
      subject: `${r.module_name}@${r.from_version} -> ${r.to_version ?? '?'}`,
      detail: `change ${r.id}; ${r.requested_how === 'by_hand' ? 'asked for' : 'self-fixing turned on'} by ${r.requester ?? 'nobody (on by default)'}; ${flows} Flow version(s) proposed; AI ${r.ai.provider ?? 'unknown'}/${r.ai.model ?? 'unknown'}, ${r.ai.inputTokens + r.ai.outputTokens} tokens`,
      flag: r.widens_access ? `widens access: ${r.diff.widening.join('; ')}` : null,
    });
  }
  for (const d of (await db.query<{ at: Date; who: string; part: string; decision: string; final: boolean; change_id: string; module_name: string; self: boolean }>(
    `SELECT d.decided_at AS at, m.handle AS who, d.part, d.decision, d.final, d.change_id, c.module_name, d.decided_by = c.requested_by AS self
     FROM change_decisions d JOIN change_records c ON c.id = d.change_id JOIN members m ON m.id = d.decided_by
     WHERE d.decided_at BETWEEN $1 AND $2 ORDER BY d.decided_at`,
    [from, to],
  )).rows) {
    out.push({
      at: d.at,
      who: d.who,
      what: `self-fix ${d.part} ${d.decision}${d.final ? '' : ' (one of several approvals)'}`,
      subject: d.module_name,
      detail: `change ${d.change_id}`,
      flag: d.self && d.decision === 'approved' ? 'approved own change request' : null,
    });
  }
  return out;
}

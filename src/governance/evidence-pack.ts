import { secretService } from '../flows/definition.js';
import type { App } from '../app.js';
import { notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { runDataAad, runDataHash } from '../core/retention.js';
import { teamSecret } from '../core/team-credentials.js';
import { moduleRef } from '../modules/registry.js';
import { GENESIS } from './audit-chain.js';
import { describePolicy, listPolicies, requiredApprovals } from './policies.js';

/**
 * Evidence packs: everything Dittoly knows about one run, for someone who has to show later what
 * happened and who decided what (a deployer's records under the EU AI Act, an auditor's sample):
 * - the approved Flow version, who approved it and when, and the rules in force;
 * - the pinned module versions with their code and manifest hashes;
 * - which AI was used and how many tokens;
 * - every step in order with its sign-offs (and sign-offs an evidence gate released, with the
 *   verified facts it released them on), inputs, hand-offs and undo records;
 * - automatic stops of its Flow that paused it: what tripped them, who resumed and why;
 * - inputs and outputs while retention still keeps them (shown only to whom the run page shows
 *   them), their hashes otherwise;
 * - the run's audit events with their hash-chain links and the nearest daily anchor, so the
 *   chain can be checked without trusting this file.
 * One JSON document; the HTML page is the same data, readable and printable, with no external
 * assets and everything escaped. No secrets: the run's credentials are removed from outputs, and
 * fields named like secrets are blanked.
 */

export const PACK_FORMAT = 'dittoly-evidence-pack/1';
const REMOVED = 'removed after the retention period';
const NOT_SHOWN = 'kept, but shown only to the person who ran the run (or the step)';
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;
const MAX_VALUE = 20_000;

export interface DataItem {
  /** shown: the value is below; kept: kept but not shown to you; removed: retention deleted it; none: nothing was kept. */
  state: 'shown' | 'kept' | 'removed' | 'none';
  note: string | null;
  sha256: string | null;
  value?: unknown;
}

/** Remove the run's own credentials wherever they appear, and blank fields named like secrets. */
export function scrubber(secrets: string[]) {
  const parts = [...new Set(secrets.flatMap((s) => [s, ...s.split(':').filter((p) => p.length >= 8)]).filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return parts.reduce((t, s) => t.split(s).join('[credential removed]'), v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && typeof x === 'string' ? '[removed]' : scrub(x)]));
    return v;
  };
  return (v: unknown) => {
    const out = scrub(v);
    const text = JSON.stringify(out) ?? 'null';
    return text.length > MAX_VALUE ? { truncated: true, start: text.slice(0, MAX_VALUE) } : out;
  };
}

export async function evidencePack(app: App, runId: string, actor: Member) {
  // The same people who may open the run page, seeing the same data (src/engine/engine.ts runView).
  const view = await app.engine.runView(runId, actor);
  const db = app.db;
  const run = (
    await db.query<{
      id: string; run_as: string; run_as_handle: string; created_at: Date; finished_at: Date | null; status: string; dry: boolean; breakglass_id: string | null;
      data_expires_at: Date | null; inputs_enc: string | null; inputs_from_model: boolean; via: string; team: string;
    }>(
      `SELECT r.id, r.run_as, m.handle AS run_as_handle, r.created_at, r.finished_at, r.status, r.dry, r.breakglass_id, r.data_expires_at, r.inputs_enc, r.inputs_from_model,
              CASE WHEN r.trigger_id IS NOT NULL THEN 'webhook' WHEN r.schedule_id IS NOT NULL THEN 'schedule' WHEN r.watch_id IS NOT NULL THEN 'watch' WHEN r.endpoint_id IS NOT NULL THEN 'Flow URL'
                   WHEN r.mcp_token_id IS NOT NULL THEN 'AI assistant (MCP)' WHEN r.parent_run_id IS NOT NULL THEN 'Super Flow' WHEN r.followup_of IS NOT NULL THEN 'follow-up' ELSE 'manual' END AS via,
              t.name AS team
       FROM runs r JOIN members m ON m.id = r.run_as JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id JOIN teams t ON t.id = f.team_id
       WHERE r.id = $1`,
      [runId],
    )
  ).rows[0];
  if (!run) throw notFound('run');
  const version = (await app.flows.getVersion(db, view.flowVersionId))!;
  const fv = (
    await db.query<{ author: string; created_at: Date; decided_by: string | null; decided_for: string | null; decided_at: Date | null; outside: boolean | null }>(
      `SELECT au.handle AS author, v.created_at, d.handle AS decided_by, df.handle AS decided_for, v.decided_at, v.decided_outside_team AS outside
       FROM flow_versions v JOIN members au ON au.id = v.created_by LEFT JOIN members d ON d.id = v.decided_by LEFT JOIN members df ON df.id = v.decided_for WHERE v.id = $1`,
      [version.id],
    )
  ).rows[0]!;
  const approvals = (
    await db.query<{ handle: string; for_handle: string | null; approved_at: Date }>(
      `SELECT m.handle, o.handle AS for_handle, a.approved_at FROM flow_version_approvals a JOIN members m ON m.id = a.approver_id LEFT JOIN members o ON o.id = a.on_behalf_of
       WHERE a.version_id = $1 ORDER BY a.approved_at`,
      [version.id],
    )
  ).rows;
  const modules = await app.flows.pinnedModules(db, version.definition);
  const need = await requiredApprovals(db, version.definition, modules);
  const reviews = new Map(
    (await db.query<{ id: string; reviewer: string | null; reviewed_at: Date | null }>(
      `SELECT mv.id, m.handle AS reviewer, mv.reviewed_at FROM module_versions mv LEFT JOIN members m ON m.id = mv.reviewed_by WHERE mv.id = ANY($1::uuid[])`,
      [[...modules.values()].map((m) => m.id)],
    )).rows.map((r) => [r.id, r]),
  );
  const handleOf = new Map((await db.query<{ id: string; handle: string }>(`SELECT id, handle FROM members`)).rows.map((r) => [r.id, r.handle]));

  // Credentials the run used (its person's, a teammate's for a step they ran, or the team's), to remove from outputs.
  const teamId = await app.engine.teamOfRun(runId);
  const steps = (
    await db.query<{ step_id: string; idx: number; status: string; attempts: number; error_type: string | null; executed_by: string | null; output_enc: string | null; started_at: Date | null; finished_at: Date | null }>(
      `SELECT step_id, idx, status, attempts, error_type, executed_by, output_enc, started_at, finished_at FROM run_steps WHERE run_id = $1 ORDER BY idx`,
      [runId],
    )
  ).rows;
  const secrets: string[] = [];
  const people = [...new Set([run.run_as, ...steps.flatMap((s) => (s.executed_by ? [s.executed_by] : []))])];
  for (const m of modules.values()) {
    for (const person of people) {
      const resolve = await app.engine.secretResolver(teamId, m.name, person);
      for (const c of m.manifest.credentials) {
        const s = await resolve(c.service).catch(() => null);
        if (s) secrets.push(s);
      }
    }
  }
  // Secret env vars of app and fix steps (the team's credential for the service, else the person's own).
  for (const s of version.definition.steps) {
    if (s.type !== 'app' && s.type !== 'fix') continue;
    for (const service of Object.values(s.secretEnv).map(secretService)) {
      const team = await teamSecret(db, app.cipher, teamId, service).catch(() => null);
      if (team) secrets.push(team);
      else
        for (const person of people) {
          const own = await (await app.engine.secretResolver(teamId, '', person))(service).catch(() => null);
          if (own) secrets.push(own);
        }
    }
  }
  const clean = scrubber(secrets);

  // Inputs and outputs: shown as on the run page while kept; their hashes either way.
  const kept = new Map((await db.query<{ step_id: string; sha256: string }>(`SELECT step_id, sha256 FROM run_data_hashes WHERE run_id = $1`, [runId])).rows.map((r) => [r.step_id, r.sha256]));
  const finished = run.finished_at !== null;
  const item = (enc: string | null, aad: string, key: string, shown: unknown, mayShow: boolean): DataItem => {
    if (enc) {
      let hash: string | null = null;
      try {
        hash = runDataHash(app.cipher.decryptJson(enc, aad));
      } catch {
        hash = null;
      }
      return mayShow && shown !== undefined
        ? { state: 'shown', note: run.data_expires_at ? `kept until ${run.data_expires_at.toISOString()}` : null, sha256: hash, value: clean(shown) }
        : { state: 'kept', note: NOT_SHOWN, sha256: hash };
    }
    if (kept.has(key)) return { state: 'removed', note: REMOVED, sha256: kept.get(key)! };
    return finished ? { state: 'removed', note: REMOVED, sha256: null } : { state: 'none', note: null, sha256: null };
  };
  const isOwner = run.run_as === actor.id;

  const gates = new Map(
    (await db.query<{ step_id: string; decision: string; decided_at: Date; by: string | null; for_handle: string | null; outside_team: boolean; auto_evidence: Record<string, unknown> | null }>(
      `SELECT g.step_id, g.decision, g.decided_at, m.handle AS by, o.handle AS for_handle, g.outside_team, g.auto_evidence
       FROM gate_decisions g LEFT JOIN members m ON m.id = g.decided_by LEFT JOIN members o ON o.id = g.on_behalf_of WHERE g.run_id = $1`,
      [runId],
    )).rows.map((g) => [g.step_id, g]),
  );
  const delegations = (
    await db.query<{ id: string; step_id: string; requester: string; delegate: string; status: string; created_at: Date; decided_at: Date | null }>(
      `SELECT d.id, d.step_id, rq.handle AS requester, dl.handle AS delegate, d.status, d.created_at, d.decided_at
       FROM delegations d JOIN members rq ON rq.id = d.requester_id JOIN members dl ON dl.id = d.delegate_id WHERE d.run_id = $1 ORDER BY d.created_at`,
      [runId],
    )
  ).rows;

  // The run's audit events: its own, its steps', its hand-offs', and those naming it.
  const events = (
    await db.query<{
      id: string; at: Date; at_us: string; actor_id: string | null; action: string; subject_type: string; subject_id: string; outcome: string;
      error_type: string | null; related_id: string | null; hash: string | null; prev_hash: string | null;
    }>(
      `SELECT e.id::text AS id, e.at, (extract(epoch FROM e.at) * 1000000)::bigint::text AS at_us, e.actor_id, e.action, e.subject_type, e.subject_id, e.outcome, e.error_type, e.related_id,
              s.hash, (SELECT p.hash FROM audit_seals p WHERE p.event_id < e.id ORDER BY p.event_id DESC LIMIT 1) AS prev_hash
       FROM audit_events e LEFT JOIN audit_seals s ON s.event_id = e.id
       WHERE e.subject_id = $1 OR e.subject_id LIKE $1 || ':%' OR e.related_id = $1 OR (e.subject_type = 'delegation' AND e.subject_id = ANY($2::text[]))
       ORDER BY e.id`,
      [runId, delegations.map((d) => d.id)],
    )
  ).rows;
  const submissions = new Map(events.filter((e) => e.action === 'input.submitted').map((e) => [e.subject_id.slice(runId.length + 1), e]));
  const chain = events.map((e) => ({
    eventId: e.id,
    atMicros: e.at_us,
    actorId: e.actor_id,
    action: e.action,
    subjectType: e.subject_type,
    subjectId: e.subject_id,
    outcome: e.outcome,
    errorType: e.error_type,
    relatedId: e.related_id,
    // The hash of the sealed event just before this one in the whole chain (the first event links to the start value).
    previousHash: e.hash ? (e.prev_hash ?? GENESIS) : null,
    hash: e.hash,
  }));
  const lastSealed = [...events].reverse().find((e) => e.hash)?.id ?? null;
  const anchor = lastSealed
    ? (
        await db.query<{ day: string; event_id: string; hash: string; sent_at: Date; kind: string }>(
          `SELECT s.day::text AS day, s.event_id::text AS event_id, s.hash, s.sent_at, a.kind FROM audit_anchor_sends s JOIN audit_anchors a ON a.id = s.anchor_id
           WHERE s.ok AND s.event_id >= $1 ORDER BY s.event_id, s.day LIMIT 1`,
          [lastSealed],
        )
      ).rows[0] ?? null
    : null;
  const head = (await db.query<{ event_id: string; hash: string }>(`SELECT s.event_id::text AS event_id, s.hash FROM audit_seals s ORDER BY s.event_id DESC LIMIT 1`)).rows[0] ?? null;

  const usage = (
    await db.query<{ step_id: string | null; provider: string; model: string; key_owner: string; purpose: string; calls: number; input: number; output: number }>(
      `SELECT step_id, provider, model, key_owner, purpose, count(*)::int AS calls, sum(input_tokens)::int AS input, sum(output_tokens)::int AS output
       FROM ai_usage WHERE run_id = $1 GROUP BY step_id, provider, model, key_owner, purpose ORDER BY step_id NULLS LAST, provider, model`,
      [runId],
    )
  ).rows;
  // The model the run asked for (its own, or its version's lock; null: the organization's), and extra spend people
  // allowed past the run's cost cap.
  const asked = (await db.query<{ run_model: string | null; ai_model: string | null; model_locked: boolean }>(
    `SELECT r.ai_model AS run_model, v.ai_model, v.model_locked FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE r.id = $1`,
    [runId],
  )).rows[0];
  const pinnedModel = asked?.run_model ?? (asked?.model_locked ? asked.ai_model : null);
  const allowances = (
    await db.query<{ tokens: string; amount: string; handle: string | null; allowed_at: Date }>(
      `SELECT a.tokens::text, a.amount::text, m.handle, a.allowed_at FROM run_cost_allowances a LEFT JOIN members m ON m.id = a.allowed_by WHERE a.run_id = $1 ORDER BY a.allowed_at`,
      [runId],
    )
  ).rows;
  const undo = (
    await db.query<{ step_id: string | null; item: number; action: string; undo_action: string; status: string; created_at: Date; expires_at: Date; reversed_at: Date | null; module: string }>(
      `SELECT u.step_id, u.item, u.action, u.undo_action, u.status, u.created_at, u.expires_at, u.reversed_at, mv.name || '@' || mv.version AS module
       FROM undo_records u JOIN module_versions mv ON mv.id = u.module_version_id WHERE u.run_id = $1 ORDER BY u.seq, u.item`,
      [runId],
    )
  ).rows;
  const reversals = (
    await db.query<{ id: string; requested_by: string | null; status: string; decided_by: string | null; decided_at: Date | null; finished_at: Date | null; created_at: Date }>(
      `SELECT r.id, rq.handle AS requested_by, r.status, d.handle AS decided_by, r.decided_at, r.finished_at, r.created_at
       FROM reversals r LEFT JOIN members rq ON rq.id = r.requested_by LEFT JOIN members d ON d.id = r.decided_by WHERE r.run_id = $1 ORDER BY r.created_at`,
      [runId],
    )
  ).rows;

  const defs = version.definition.steps;
  return {
    format: PACK_FORMAT,
    generatedAt: new Date().toISOString(),
    generatedBy: actor.handle,
    run: {
      id: run.id,
      flowName: view.flowName ?? null,
      flowId: version.flowId,
      team: run.team,
      runAs: run.run_as_handle,
      via: run.via,
      status: run.status,
      dry: run.dry,
      breakglass: run.breakglass_id !== null,
      inputsWrittenByModel: run.inputs_from_model,
      startedAt: run.created_at,
      finishedAt: run.finished_at,
    },
    flowVersion: {
      id: version.id,
      version: version.version,
      approvalHash: version.approvalHash,
      status: version.status,
      draftedBy: fv.author,
      draftedAt: fv.created_at,
      decidedBy: fv.decided_by ? `${fv.decided_by}${fv.decided_for ? ` for ${fv.decided_for}` : ''}${fv.outside ? ' (org admin outside the team)' : ''}` : null,
      decidedAt: fv.decided_at,
      approvals: { required: need.count, because: need.because, given: approvals.map((a) => ({ by: a.for_handle ? `${a.handle} for ${a.for_handle}` : a.handle, at: a.approved_at })) },
      /** Steps that wait for a sign-off because model-written text could steer them, and paths the approver accepted. */
      guardedSteps: version.guardedSteps ?? [],
      acceptedPaths: version.injectionAccepted.map((a) => ({ step: a.sink, reason: a.reason, by: handleOf.get(a.by) ?? null, at: a.at })),
    },
    /** Rules in force when this pack was made (rule changes are in the audit report). */
    policies: (await listPolicies(db, true)).map(describePolicy),
    modules: [...modules.values()].map((m) => ({
      ref: moduleRef(m),
      codeSha256: m.codeSha256,
      manifestSha256: m.manifestSha256,
      status: m.status,
      origin: m.origin,
      draftedByAi: m.origin === 'chat' || m.origin === 'assistant',
      reviewedBy: reviews.get(m.id)?.reviewer ?? null,
      reviewedAt: reviews.get(m.id)?.reviewed_at ?? null,
    })),
    ai: {
      steps: defs.flatMap((s): { step: string; type: string; whose: string; provider: string | null }[] =>
        s.type === 'ai' || s.type === 'browse'
          ? [{ step: s.id, type: s.type, whose: s.ai, provider: s.provider ?? (s.ai === 'organization' ? (app.ai?.id ?? null) : 'openai') }]
          : s.type === 'fix'
            ? [{ step: s.id, type: s.type, whose: s.ai, provider: app.ai?.id ?? null }]
            : [],
      ),
      pinnedModel,
      usage: usage.map((u) => ({ step: u.step_id, provider: u.provider, model: u.model, key: u.key_owner, purpose: u.purpose, calls: u.calls, inputTokens: u.input, outputTokens: u.output })),
      allowances: allowances.map((a) => ({ tokens: Number(a.tokens), amount: Number(a.amount), by: a.handle, at: a.allowed_at })),
    },
    inputs: item(run.inputs_enc, runDataAad(runId), '', view.inputs, isOwner),
    steps: steps.map((s) => {
      const def = defs[s.idx];
      const v = view.steps.find((x) => x.id === s.step_id);
      const gate = gates.get(s.step_id);
      const sub = submissions.get(s.step_id);
      return {
        id: s.step_id,
        type: def?.type ?? null,
        title: def?.title ?? null,
        module: def?.type === 'action' ? def.module : null,
        action: def?.type === 'action' ? def.action : null,
        status: s.status,
        attempts: s.attempts,
        errorType: s.error_type,
        startedAt: s.started_at,
        finishedAt: s.finished_at,
        executedBy: s.executed_by ? (handleOf.get(s.executed_by) ?? null) : null,
        signOff: gate
          ? {
              kind: def?.type === 'approval' ? 'sign-off step' : gate.auto_evidence ? 'guard released by its evidence gate (a verified fix)' : 'guard: check what the AI wrote before this step',
              decision: gate.decision,
              by: gate.auto_evidence ? 'Dittoly (evidence gate, no person)' : gate.for_handle ? `${gate.by} for ${gate.for_handle}` : (gate.by ?? '—'),
              outsideTeam: gate.outside_team,
              at: gate.decided_at,
              /** For an automatic release: the fix step's verified facts it was released on. */
              evidence: gate.auto_evidence ?? null,
            }
          : null,
        inputGiven: sub ? { by: sub.actor_id ? (handleOf.get(sub.actor_id) ?? null) : null, at: sub.at } : null,
        delegations: delegations.filter((d) => d.step_id === s.step_id).map((d) => ({ requester: d.requester, delegate: d.delegate, status: d.status, at: d.created_at, decidedAt: d.decided_at })),
        output: item(s.output_enc, runDataAad(runId, s.step_id), s.step_id, v?.output, isOwner || s.executed_by === actor.id),
      };
    }),
    /** Automatic stops of the Flow that paused this run (src/governance/auto-stop.ts), with what happened to the run. */
    autoStops: view.autoStops.map((a) => ({
      trigger: a.triggerName,
      summary: a.summary,
      trippedAt: a.trippedAt,
      events: a.evidence.events,
      resumedAt: a.resumedAt,
      resumedBy: a.resumedBy,
      reason: a.reason,
      thisRun: a.thisRun,
    })),
    undo: {
      records: undo.map((u) => ({ step: u.step_id, item: u.item, module: u.module, action: u.action, undoAction: u.undo_action, status: u.status, createdAt: u.created_at, expiresAt: u.expires_at, reversedAt: u.reversed_at })),
      reversals: reversals.map((r) => ({ id: r.id, requestedBy: r.requested_by, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, finishedAt: r.finished_at, at: r.created_at })),
    },
    audit: {
      events: events.map((e) => ({ id: e.id, at: e.at, actor: e.actor_id ? (handleOf.get(e.actor_id) ?? null) : null, action: e.action, subject: `${e.subject_type} ${e.subject_id}`, outcome: e.outcome, errorType: e.error_type, sealed: e.hash !== null })),
      /** The run's segment of the audit chain: enough to recompute each event's hash. */
      chain,
      /** The first daily copy of the chain hash sent outside Dittoly at or after this run's last sealed event. */
      anchor: anchor ? { day: anchor.day, eventId: anchor.event_id, hash: anchor.hash, sentAt: anchor.sent_at, sentBy: anchor.kind } : null,
      head: head ? { eventId: head.event_id, hash: head.hash } : null,
    },
    verification: [
      `Each event's hash is SHA-256 (hex) of: the previous hash, a newline, and the JSON array [eventId, atMicros, actorId, action, subjectType, subjectId, outcome, errorType, relatedId] (strings and nulls exactly as in audit.chain, no spaces).`,
      `previousHash is the hash of the sealed event just before it in the organization's whole audit chain (other people's events sit in between), or "${GENESIS}" for the very first event.`,
      `Recompute each hash from its fields and previousHash: a match shows the event is the one that was sealed. Events marked unsealed are sealed about 30 seconds after they are written; download the pack again to include them.`,
      `To tie the events to a hash kept outside Dittoly, compare the anchor (the daily copy sent by email or webhook) with the copy you received, and ask an admin for the audit report: its chain check covers every event from the start to the head shown here.`,
      `Inputs and outputs carry the SHA-256 of their canonical JSON (keys sorted, no spaces) where it is known; after the retention period only the hash remains.`,
    ],
  };
}

export type EvidencePack = Awaited<ReturnType<typeof evidencePack>>;

// ---------------------------------------------------------------- HTML

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const when = (v: unknown) => (v ? esc(new Date(v as string).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')) : '—');
const table = (head: string[], rows: unknown[][]) =>
  rows.length
    ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<p class="muted">None.</p>';
const data = (d: DataItem) =>
  `<p class="muted">${esc(d.state === 'shown' ? 'Shown below' : d.state === 'none' ? 'Nothing kept' : d.note)}${d.sha256 ? ` · SHA-256 <code>${esc(d.sha256)}</code>` : ''}</p>` +
  (d.state === 'shown' ? `<pre>${esc(JSON.stringify(d.value, null, 2))}</pre>` : '');

/** The pack as one self-contained HTML page: inline styles only, every value escaped. */
export function evidenceHtml(p: EvidencePack): string {
  const r = p.run;
  const f = p.flowVersion;
  const css = `body{font:14px/1.5 system-ui,sans-serif;color:#111;margin:24px auto;max-width:960px;padding:0 16px}h1{font-size:22px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #ccc}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top;font-size:12px}th{background:#f3f3f3}
code,pre{font:11px/1.4 ui-monospace,monospace;word-break:break-all}pre{background:#f7f7f7;padding:8px;white-space:pre-wrap}.muted{color:#555}
@media print{body{margin:0}h2{break-after:avoid}table,pre{break-inside:avoid}}`;
  const body = [
    `<h1>Evidence pack: ${esc(r.flowName)} v${esc(f.version)}, run ${esc(r.id)}</h1>`,
    `<p class="muted">Made ${when(p.generatedAt)} by ${esc(p.generatedBy)} (${esc(p.format)}). The same data is available as JSON.</p>`,
    `<h2>Run</h2>`,
    table(['Run as', 'Team', 'Started via', 'Status', 'Started', 'Finished', 'Notes'], [[esc(r.runAs), esc(r.team), esc(r.via), esc(r.status), when(r.startedAt), when(r.finishedAt), esc([r.dry ? 'dry run' : '', r.breakglass ? 'break-glass' : '', r.inputsWrittenByModel ? 'inputs written by an AI model' : ''].filter(Boolean).join(', '))]]),
    `<h2>Flow version and approval</h2>`,
    table(['Version id', 'Approval hash', 'Drafted by', 'Decided by', 'Decided', 'Status'], [[`<code>${esc(f.id)}</code>`, `<code>${esc(f.approvalHash)}</code>`, `${esc(f.draftedBy)} (${when(f.draftedAt)})`, esc(f.decidedBy ?? '—'), when(f.decidedAt), esc(f.status)]]),
    `<p>Approvals required: ${esc(f.approvals.required)}${f.approvals.because ? ` (${esc(f.approvals.because)})` : ''}.</p>`,
    f.approvals.given.length ? table(['Approved by', 'At'], f.approvals.given.map((a) => [esc(a.by), when(a.at)])) : '',
    `<p>Steps that wait for a sign-off because AI-written text could steer them: ${esc(f.guardedSteps.join(', ') || 'none')}.</p>`,
    f.acceptedPaths.length ? table(['Accepted path to step', 'Reason', 'By', 'At'], f.acceptedPaths.map((a) => [esc(a.step), esc(a.reason), esc(a.by ?? '—'), when(a.at)])) : '',
    `<h2>Rules in force</h2>`,
    p.policies.length ? `<ul>${p.policies.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>',
    `<h2>Module versions</h2>`,
    table(['Module', 'Code SHA-256', 'Manifest SHA-256', 'Drafted by AI', 'Reviewed by', 'Reviewed'], p.modules.map((m) => [esc(m.ref), `<code>${esc(m.codeSha256)}</code>`, `<code>${esc(m.manifestSha256)}</code>`, m.draftedByAi ? 'yes' : 'no', esc(m.reviewedBy ?? '—'), when(m.reviewedAt)])),
    `<h2>AI used</h2>`,
    table(['Step', 'Type', 'Whose AI', 'Provider'], p.ai.steps.map((s) => [esc(s.step), esc(s.type), esc(s.whose), esc(s.provider ?? '—')])),
    `<p>Model the run asked for: ${esc(p.ai.pinnedModel ?? "the organization's model at the time")}</p>`,
    table(['Step', 'Provider', 'Model', 'Key', 'Purpose', 'Calls', 'Input tokens', 'Output tokens'], p.ai.usage.map((u) => [esc(u.step ?? '—'), esc(u.provider), esc(u.model), esc(u.key), esc(u.purpose), esc(u.calls), esc(u.inputTokens), esc(u.outputTokens)])),
    ...(p.ai.allowances.length
      ? [`<p>Spend allowed past the run's cost cap:</p>`, table(['Tokens', 'Amount', 'Allowed by', 'When'], p.ai.allowances.map((a) => [esc(a.tokens), esc(a.amount), esc(a.by ?? '—'), when(a.at)]))]
      : []),
    `<h2>Run inputs</h2>`,
    data(p.inputs),
    `<h2>Steps</h2>`,
    ...p.steps.map(
      (s, i) =>
        `<h3>${i + 1}. ${esc(s.title ?? s.id)} <span class="muted">(${esc(s.type)}${s.module ? `: ${esc(s.module)} ${esc(s.action)}` : ''})</span></h3>` +
        table(['Status', 'Attempts', 'Started', 'Finished', 'Ran as', 'Error'], [[esc(s.status), esc(s.attempts), when(s.startedAt), when(s.finishedAt), esc(s.executedBy ?? '—'), esc(s.errorType ?? '')]]) +
        (s.signOff ? `<p>${esc(s.signOff.kind)}: <strong>${esc(s.signOff.decision)}</strong> by ${esc(s.signOff.by)}${s.signOff.outsideTeam ? ' (org admin outside the team)' : ''} at ${when(s.signOff.at)}.</p>` : '') +
        (s.signOff?.evidence ? `<pre>${esc(JSON.stringify(s.signOff.evidence, null, 2))}</pre>` : '') +
        (s.inputGiven ? `<p>Input given by ${esc(s.inputGiven.by ?? '—')} at ${when(s.inputGiven.at)}.</p>` : '') +
        (s.delegations.length ? table(['Asked by', 'Teammate', 'Status', 'Asked', 'Decided'], s.delegations.map((d) => [esc(d.requester), esc(d.delegate), esc(d.status), when(d.at), when(d.decidedAt)])) : '') +
        data(s.output),
    ),
    ...(p.autoStops.length
      ? [
          `<h2>Automatic stops</h2>`,
          `<p class="muted">Its Flow was stopped automatically because a control kept failing; the run waited before its next step.</p>`,
          table(['Trigger', 'What crossed the threshold', 'Stopped', 'Resumed by', 'Resumed', 'Reason', 'This run'], p.autoStops.map((a) => [esc(a.trigger), esc(a.summary), when(a.trippedAt), esc(a.resumedBy ?? '—'), when(a.resumedAt), esc(a.reason ?? ''), esc(a.thisRun ?? '—')])),
        ]
      : []),
    `<h2>Undo records</h2>`,
    table(['Step', 'Module', 'Action', 'Reversed by', 'Status', 'Recorded', 'Reversed'], p.undo.records.map((u) => [esc(u.step ?? '—'), esc(u.module), esc(u.action), esc(u.undoAction), esc(u.status), when(u.createdAt), when(u.reversedAt)])),
    p.undo.reversals.length ? table(['Reversal', 'Asked by', 'Status', 'Decided by', 'Decided'], p.undo.reversals.map((x) => [`<code>${esc(x.id)}</code>`, esc(x.requestedBy ?? '—'), esc(x.status), esc(x.decidedBy ?? '—'), when(x.decidedAt)])) : '',
    `<h2>Audit events and hash chain</h2>`,
    table(
      ['Event', 'At', 'Who', 'Action', 'Subject', 'Outcome', 'Previous hash', 'Hash'],
      p.audit.chain.map((c, i) => [esc(c.eventId), when(p.audit.events[i]!.at), esc(p.audit.events[i]!.actor ?? 'Dittoly'), esc(c.action), esc(`${c.subjectType} ${c.subjectId}`), esc(c.outcome + (c.errorType ? ` (${c.errorType})` : '')), `<code>${esc(c.previousHash ?? 'not sealed yet')}</code>`, `<code>${esc(c.hash ?? 'not sealed yet')}</code>`]),
    ),
    `<p>Nearest daily anchor: ${p.audit.anchor ? `${esc(p.audit.anchor.day)}, sent by ${esc(p.audit.anchor.sentBy)}: event ${esc(p.audit.anchor.eventId)}, hash <code>${esc(p.audit.anchor.hash)}</code>` : 'none sent yet after this run (set one up under Members &amp; Access → Daily copy of the audit hash)'}.</p>`,
    `<p>Chain head when this pack was made: ${p.audit.head ? `event ${esc(p.audit.head.eventId)}, hash <code>${esc(p.audit.head.hash)}</code>` : 'none'}.</p>`,
    `<h2>How to verify</h2>`,
    `<ol>${p.verification.map((v) => `<li>${esc(v)}</li>`).join('')}</ol>`,
    `<p class="muted">This pack is evidence of what Dittoly recorded. It is not by itself proof of compliance with any law or standard.</p>`,
  ].join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(`Evidence pack ${r.flowName ?? ''} run ${r.id}`)}</title><style>${css}</style></head><body>\n${body}\n</body></html>\n`;
}

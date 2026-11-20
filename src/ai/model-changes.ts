import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import { canApprove, type Member } from '../core/members.js';
import type { DeploymentMode } from '../config.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { enqueue, type Job } from '../engine/jobs.js';
import type { AiStep, FlowDefinition } from '../flows/definition.js';
import type { FlowService } from '../flows/service.js';
import { playTest, type FlowTests } from '../flows/tests.js';
import { resolve, type TemplateScope } from '../flows/template.js';
import { approvalAuthority, notifyApprovers } from '../governance/approvals.js';
import { runAiStep, StepError, withFlowInstructions } from '../runtime/ai-step.js';
import { loadPrices, priceOf } from './costs.js';
import { withAiContext, type AiTally } from './metering.js';
import { MODEL_ID, orgAiSteps, pinTo, splitModel } from './models.js';
import type { AiProvider } from './provider.js';

/**
 * The model-change check. When the organization moves to another AI model, approved Flows follow it at once (unless an
 * approver locked one to a model), and Dittoly checks each Flow with AI steps against the new model in the background:
 * each AI step is asked again (a few times) with the inputs of the Flow's tests and, while retention still holds them,
 * of its recent successful runs, and the answers are compared with the recorded ones. Nothing waits on the check. An
 * approver then accepts the new model for the Flow (moving a locked Flow's lock to it; with a reason when the check
 * found differences), or keeps the old one, which locks the Flow to it. Neither creates a new version (the definition
 * did not change); a switch is recorded with the version.
 */

const KEY = 'ai_model';
/** How many times each input is asked, for a consistency score. */
export const REPEATS = 3;
/** Inputs per step: the tests first, then recent runs. */
const MAX_SAMPLES = 5;
/** At or above this, a text answer counts as the same, and a step as agreeing. */
export const SAME = 0.8;

export type CheckStatus = 'queued' | 'running' | 'passed' | 'differs' | 'failed' | 'skipped_budget' | 'no_inputs';

// ---------------------------------------------------------------- comparing answers

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Normalized text similarity: overlap of the words (Dice coefficient), 1 for the same words in any case and punctuation. */
export function textSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length && !y.length) return 1;
  const counts = new Map<string, number>();
  for (const w of x) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of y) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

const kind = (v: unknown) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** How alike two answers are, 0 to 1: exact for numbers, booleans and enums, text similarity for strings, field by field. */
export function similarity(a: unknown, b: unknown): number {
  if (kind(a) !== kind(b)) return 0;
  if (typeof a === 'string') return textSimilarity(a, b as string);
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    const n = Math.max(a.length, bb.length);
    if (!n) return 1;
    let sum = 0;
    for (let i = 0; i < Math.min(a.length, bb.length); i++) sum += similarity(a[i], bb[i]);
    return sum / n;
  }
  if (a && typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])];
    if (!keys.length) return 1;
    return keys.reduce((n, k) => n + similarity(ao[k], bo[k]), 0) / keys.length;
  }
  return a === b ? 1 : 0;
}

export interface FieldDiff { path: string; similarity: number; expected?: unknown; got?: unknown }

const clip = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : v === undefined ? null : JSON.stringify(v).slice(0, 200));

/** The fields where two answers differ (text below SAME, anything else not equal). */
export function fieldDiffs(expected: unknown, got: unknown, path = 'output', out: FieldDiff[] = []): FieldDiff[] {
  if (out.length >= 20) return out;
  if (kind(expected) === 'array' && kind(got) === 'array') {
    const e = expected as unknown[];
    const g = got as unknown[];
    if (e.length !== g.length) out.push({ path: `${path}.length`, similarity: 0, expected: e.length, got: g.length });
    for (let i = 0; i < Math.min(e.length, g.length); i++) fieldDiffs(e[i], g[i], `${path}.${i}`, out);
    return out;
  }
  if (kind(expected) === 'object' && kind(got) === 'object') {
    const e = expected as Record<string, unknown>;
    const g = got as Record<string, unknown>;
    for (const k of new Set([...Object.keys(e), ...Object.keys(g)])) fieldDiffs(e[k], g[k], `${path}.${k}`, out);
    return out;
  }
  const s = similarity(expected, got);
  if (typeof expected === 'string' && typeof got === 'string' ? s < SAME : s < 1) out.push({ path, similarity: Math.round(s * 100) / 100, expected: clip(expected), got: clip(got) });
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

/** Agreement with the recorded answer and consistency across repeats, for one input. */
export function compareSample(expected: unknown, answers: unknown[]) {
  const agreement = expected === undefined ? null : mean(answers.map((a) => similarity(expected, a)));
  const pairs: number[] = [];
  for (let i = 0; i < answers.length; i++) for (let j = i + 1; j < answers.length; j++) pairs.push(similarity(answers[i], answers[j]));
  return { agreement: r2(agreement), consistency: r2(mean(pairs)) };
}

// ---------------------------------------------------------------- the service

interface CheckRow {
  id: string;
  flow_version_id: string;
  from_model: string;
  to_model: string;
  status: CheckStatus;
  summary: CheckSummary | null;
  details_enc: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: Date;
  finished_at: Date | null;
  decision: 'accepted' | 'kept' | null;
}

export interface StepSummary {
  stepId: string;
  type: 'ai' | 'browse' | 'fix';
  status: 'passed' | 'differs' | 'failed' | 'not_checked' | 'no_inputs';
  samples: number;
  calls: number;
  /** Answers that did not parse or did not match the step's output. */
  failedCalls: number;
  errors: Record<string, number>;
  agreement: number | null;
  consistency: number | null;
}
export interface CheckSummary { steps: StepSummary[]; note?: string }

interface SampleDetail { source: 'test' | 'run'; name: string; agreement: number | null; consistency: number | null; errors: string[]; diffs: FieldDiff[] }

export const decisionBody = z.object({ decision: z.enum(['accept', 'keep']), reason: z.string().trim().max(1000).optional() }).strict();

const aadInputs = (runId: string) => `run:${runId}:inputs`;
const aadOutput = (runId: string, stepId: string) => `run:${runId}:step:${stepId}:output`;

export interface ModelChangeDeps {
  db: Db;
  cipher: Cipher;
  flows: FlowService;
  tests: FlowTests;
  /** The organization's AI (metered), and its model now (an admin may change it). */
  ai: AiProvider | null;
  aiModel: () => string | null;
  mode: DeploymentMode;
}

export class ModelChanges {
  constructor(private readonly d: ModelChangeDeps) {}

  private aad(id: string) {
    return `model-check:${id}:details`;
  }

  /**
   * Compare the organization's model with the last one seen (at startup and on each maintenance
   * pass). On a change, every approved Flow with organization AI steps gets a check. Returns how many.
   */
  async detect(): Promise<number> {
    const current = this.d.aiModel();
    if (!this.d.ai || !current) return 0;
    return withTx(this.d.db, async (tx) => {
      const last = (await tx.query<{ value: { model?: string } }>(`SELECT value FROM org_settings WHERE key = $1 FOR UPDATE`, [KEY])).rows[0]?.value.model;
      if (last === current) return 0;
      await tx.query(
        `INSERT INTO org_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [KEY, JSON.stringify({ model: current, previous: last ?? null })],
      );
      if (!last) return 0; // the first model seen: nothing to compare with
      await audit(tx, { actorId: null, action: 'ai.model_changed', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
      log.info('ai_model_changed', {});
      const { rows } = await tx.query<{ id: string; definition: FlowDefinition; ai_model: string | null }>(
        `SELECT id, definition, ai_model FROM flow_versions WHERE status = 'approved' AND (ai_model IS NULL OR ai_model <> $1)`,
        [current],
      );
      let queued = 0;
      for (const v of rows) {
        if (!orgAiSteps(v.definition).length) continue;
        // Versions approved before models were pinned ran with the model used until now.
        const from = v.ai_model ?? last;
        if (!v.ai_model) await tx.query(`UPDATE flow_versions SET ai_model = $2 WHERE id = $1`, [v.id, from]);
        await this.queue(tx, v.id, from, current);
        queued++;
      }
      return queued;
    });
  }

  private async queue(db: Queryable, versionId: string, from: string, to: string): Promise<string> {
    // An earlier check that nobody decided is replaced by this one.
    await db.query(`DELETE FROM model_change_checks WHERE flow_version_id = $1 AND decision IS NULL`, [versionId]);
    const { rows } = await db.query<{ id: string }>(`INSERT INTO model_change_checks (flow_version_id, from_model, to_model) VALUES ($1, $2, $3) RETURNING id`, [versionId, from, to]);
    await enqueue(db, 'model_change_check', { checkId: rows[0]!.id });
    return rows[0]!.id;
  }

  async handleJob(job: Job): Promise<void> {
    if (job.payload.checkId) await this.run(job.payload.checkId);
  }

  /** The inputs to ask with: the Flow's tests, then its recent successful runs while retention still holds their data. */
  private async samples(flowId: string, versionId: string, def: FlowDefinition, step: AiStep) {
    const out: { source: 'test' | 'run'; name: string; input: unknown; expected: unknown }[] = [];
    let modules = new Map();
    try {
      modules = await this.d.flows.pinnedModules(this.d.db, def);
    } catch {
      // As in the tests view: the AI steps' inputs may still be reached.
    }
    for (const t of await this.d.tests.casesFor(flowId)) {
      if (out.length >= MAX_SAMPLES) break;
      const played = playTest(def, modules, t.case);
      if (played.steps.find((s) => s.id === step.id)?.status !== 'succeeded') continue;
      const scope: TemplateScope = { inputs: t.case.inputs, steps: {} };
      for (const s of played.steps) if (s.status === 'succeeded' && s.output !== undefined) scope.steps[s.id] = { output: s.output };
      try {
        out.push({ source: 'test', name: t.name, input: resolve(step.input, scope), expected: t.case.answers[step.id]?.output });
      } catch {
        // The test does not reach this step's data.
      }
    }
    const runs = (await this.d.db.query<{ id: string; inputs_enc: string; finished_at: Date }>(
      `SELECT id, inputs_enc, finished_at FROM runs
       WHERE flow_version_id = $1 AND status = 'succeeded' AND NOT dry AND inputs_enc IS NOT NULL AND (data_expires_at IS NULL OR data_expires_at > now())
       ORDER BY finished_at DESC LIMIT $2`,
      [versionId, MAX_SAMPLES],
    )).rows;
    for (const r of runs) {
      if (out.length >= MAX_SAMPLES) break;
      const steps = (await this.d.db.query<{ step_id: string; output_enc: string }>(`SELECT step_id, output_enc FROM run_steps WHERE run_id = $1 AND status = 'succeeded' AND output_enc IS NOT NULL`, [r.id])).rows;
      const scope: TemplateScope = { inputs: this.d.cipher.decryptJson(r.inputs_enc, aadInputs(r.id)), steps: {} };
      for (const s of steps) scope.steps[s.step_id] = { output: this.d.cipher.decryptJson(s.output_enc, aadOutput(r.id, s.step_id)) };
      if (!scope.steps[step.id]) continue;
      try {
        out.push({ source: 'run', name: `run of ${r.finished_at.toISOString().slice(0, 16).replace('T', ' ')}`, input: resolve(step.input, scope), expected: scope.steps[step.id]!.output });
      } catch {
        // Its data is gone.
      }
    }
    return out;
  }

  /** Run one check (a background job). */
  async run(checkId: string): Promise<void> {
    const claimed = (await this.d.db.query<CheckRow>(`UPDATE model_change_checks SET status = 'running' WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`, [checkId])).rows[0];
    if (!claimed) return;
    const v = await this.d.flows.getVersion(this.d.db, claimed.flow_version_id);
    if (!v || v.status !== 'approved' || !this.d.ai) {
      await this.d.db.query(`DELETE FROM model_change_checks WHERE id = $1`, [checkId]);
      return;
    }
    const teamId = await this.d.flows.teamOfVersion(this.d.db, v.id);
    const provider = pinTo(this.d.ai, claimed.to_model);
    const tally: AiTally = { input: 0, output: 0 };
    const steps: StepSummary[] = [];
    const details: { stepId: string; samples: SampleDetail[] }[] = [];
    let budget = false;
    // The check's tokens count against the Flow's team, like its runs (and stop at its budget).
    await withAiContext({ teamId, purpose: 'check', tally }, async () => {
      for (const step of orgAiSteps(v.definition)) {
        if (step.type !== 'ai') {
          // A browse step needs a browser and live pages, a fix step a repository: they are not asked again.
          steps.push({ stepId: step.id, type: step.type === 'fix' ? 'fix' : 'browse', status: 'not_checked', samples: 0, calls: 0, failedCalls: 0, errors: {}, agreement: null, consistency: null });
          continue;
        }
        const samples = budget ? [] : await this.samples(v.flowId, v.id, v.definition, step);
        const sum: StepSummary = { stepId: step.id, type: 'ai', status: 'no_inputs', samples: samples.length, calls: 0, failedCalls: 0, errors: {}, agreement: null, consistency: null };
        const kept: SampleDetail[] = [];
        for (const s of samples) {
          if (budget) break;
          const answers: unknown[] = [];
          const errors: string[] = [];
          for (let i = 0; i < REPEATS; i++) {
            sum.calls++;
            try {
              answers.push(await runAiStep(withFlowInstructions(step, v.definition.instructions), s.input, provider, { retry: false }));
            } catch (err) {
              const code = err instanceof StepError ? err.code : 'ai_call_failed';
              if (code === 'ai_budget_exhausted') {
                budget = true;
                break;
              }
              sum.failedCalls++;
              errors.push(code);
              sum.errors[code] = (sum.errors[code] ?? 0) + 1;
            }
          }
          const scores = compareSample(s.expected, answers);
          // Values are shown for tests only: what runs held stays under the retention rules.
          const diffs = s.expected === undefined || !answers.length ? [] : fieldDiffs(s.expected, answers[0]).map((d) => (s.source === 'test' ? d : { path: d.path, similarity: d.similarity }));
          kept.push({ source: s.source, name: s.name, ...scores, errors, diffs });
        }
        const agreements = kept.map((k) => k.agreement).filter((x): x is number => x !== null);
        const consistencies = kept.map((k) => k.consistency).filter((x): x is number => x !== null);
        sum.agreement = r2(mean(agreements));
        sum.consistency = r2(mean(consistencies));
        sum.status = !kept.length ? 'no_inputs' : sum.failedCalls ? 'failed' : (sum.agreement ?? 1) < SAME || (sum.consistency ?? 1) < SAME ? 'differs' : 'passed';
        steps.push(sum);
        details.push({ stepId: step.id, samples: kept });
      }
    });
    const checked = steps.filter((s) => s.type === 'ai' && s.status !== 'no_inputs');
    const status: CheckStatus = budget
      ? 'skipped_budget'
      : !checked.length
        ? 'no_inputs'
        : checked.some((s) => s.status === 'failed')
          ? 'failed'
          : checked.some((s) => s.status === 'differs') || steps.some((s) => s.type === 'ai' && s.status === 'no_inputs')
            ? 'differs'
            : 'passed';
    const summary: CheckSummary = {
      steps,
      ...(budget ? { note: "The team's monthly AI budget is used up; run the check again once it is raised." } : {}),
    };
    await withTx(this.d.db, async (tx) => {
      await tx.query(
        `UPDATE model_change_checks SET status = $2, summary = $3, details_enc = $4, input_tokens = $5, output_tokens = $6, finished_at = now() WHERE id = $1`,
        [checkId, status, JSON.stringify(summary), this.d.cipher.encryptJson(details, this.aad(checkId)), tally.input, tally.output],
      );
      await audit(tx, { actorId: null, action: 'flow.model_check_finished', subjectType: 'flow_version', subjectId: v.id, outcome: status === 'passed' ? 'ok' : 'failed', errorType: status === 'passed' ? undefined : status, relatedId: checkId });
      await notifyApprovers(tx, teamId, '', 'model_change_checked', { flowVersionId: v.id });
    });
  }

  private async price(input: number, output: number, model: string) {
    const p = await priceOf(this.d.db, await loadPrices(this.d.db), model);
    return p ? { amount: Math.round(((input * p.input + output * p.output) / 1e6) * 10_000) / 10_000, currency: p.currency } : null;
  }

  /** For approvers: Flows waiting to switch to the organization's model, with their checks, and Flows whose pinned model is gone. */
  async list(actor: Member) {
    if (!canApprove(actor)) throw forbidden('approver_only');
    const current = this.d.aiModel();
    const { rows } = await this.d.db.query<CheckRow & { flow_id: string; flow_name: string; version: number; team: string | null }>(
      `SELECT DISTINCT ON (c.flow_version_id) c.*, v.flow_id, f.name AS flow_name, v.version, t.name AS team
       FROM model_change_checks c JOIN flow_versions v ON v.id = c.flow_version_id JOIN flows f ON f.id = v.flow_id LEFT JOIN teams t ON t.id = f.team_id
       WHERE c.decision IS NULL AND v.status = 'approved' AND c.to_model = $1
       ORDER BY c.flow_version_id, c.created_at DESC`,
      [current],
    );
    const waiting = await Promise.all(
      rows.sort((a, b) => a.flow_name.localeCompare(b.flow_name)).map(async (c) => ({
        checkId: c.id,
        flowId: c.flow_id,
        flowName: c.flow_name,
        versionId: c.flow_version_id,
        version: c.version,
        team: c.team,
        fromModel: c.from_model,
        toModel: c.to_model,
        status: c.status,
        summary: c.summary,
        details: c.details_enc ? this.d.cipher.decryptJson<{ stepId: string; samples: SampleDetail[] }[]>(c.details_enc, this.aad(c.id)) : [],
        tokens: { input: c.input_tokens, output: c.output_tokens },
        cost: await this.price(c.input_tokens, c.output_tokens, c.to_model),
        createdAt: c.created_at,
        finishedAt: c.finished_at,
      })),
    );
    const unavailable = (await this.d.db.query<{ flow_id: string; flow_name: string; version_id: string; version: number; ai_model: string | null; at: Date }>(
      `SELECT DISTINCT ON (v.id) v.flow_id, f.name AS flow_name, v.id AS version_id, v.version, v.ai_model, s.finished_at AS at
       FROM run_steps s JOIN runs r ON r.id = s.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
       WHERE s.error_type = 'pinned_model_unavailable' AND v.status = 'approved' AND s.finished_at > now() - interval '30 days'
         AND v.ai_model IS DISTINCT FROM $1
       ORDER BY v.id, s.finished_at DESC`,
      [current],
    )).rows.map((r) => ({ flowId: r.flow_id, flowName: r.flow_name, versionId: r.version_id, version: r.version, model: r.ai_model, lastFailedAt: r.at, checking: waiting.some((w) => w.versionId === r.version_id) }));
    return { currentModel: current, waiting, unavailable };
  }

  /** Switch a version to the checked model (one click when it passed; with a reason otherwise), or keep its model. */
  async decide(actor: Member, checkId: string, body: z.infer<typeof decisionBody>): Promise<void> {
    if (!canApprove(actor)) throw forbidden('approver_only');
    await withTx(this.d.db, async (tx) => {
      const c = (await tx.query<CheckRow>(`SELECT * FROM model_change_checks WHERE id = $1 FOR UPDATE`, [checkId])).rows[0];
      if (!c) throw notFound('model_change_check');
      if (c.decision) throw conflict('already_decided');
      if (c.status === 'queued' || c.status === 'running') throw conflict('check_not_finished');
      const v = await this.d.flows.getVersion(tx, c.flow_version_id);
      if (!v || v.status !== 'approved') throw conflict('flow_version_not_approved');
      if (this.d.mode === 'shared' && v.createdBy === actor.id) throw forbidden('cannot_approve_own_flow');
      // With the team rule, only the Flow's team (or a stand-in for one of its approvers) decides; an org admin may step in.
      const by = await approvalAuthority(tx, actor, await this.d.flows.teamOfVersion(tx, v.id), this.d.mode === 'shared' ? v.createdBy : '');
      const suffix = by.onBehalfOf ? '_as_standin' : by.outsideTeam ? '_outside_team' : '';
      const reason = body.reason?.trim() || null;
      if (body.decision === 'keep') {
        // Keeping the old model locks the Flow to it, so it no longer follows the organization's.
        await tx.query(`UPDATE flow_versions SET ai_model = $2, model_locked = true WHERE id = $1`, [v.id, c.from_model]);
        await tx.query(`UPDATE model_change_checks SET decision = 'kept', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1`, [checkId, actor.id, reason]);
        await audit(tx, { actorId: actor.id, action: `flow.model_kept${suffix}`, subjectType: 'flow_version', subjectId: v.id, outcome: 'ok', relatedId: checkId });
        return;
      }
      if (c.to_model !== this.d.aiModel()) throw conflict('model_changed_again');
      if (c.status !== 'passed' && (!reason || reason.length < 10)) throw badRequest('reason_required', 'the check did not pass: say why the switch is accepted anyway (10 characters or more)');
      const from = v.aiModel ?? c.from_model;
      await tx.query(`UPDATE flow_versions SET ai_model = $2 WHERE id = $1`, [v.id, c.to_model]);
      await tx.query(
        `INSERT INTO flow_model_pins (flow_version_id, from_model, to_model, check_id, check_summary, reason, decided_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [v.id, from, c.to_model, checkId, JSON.stringify({ status: c.status, steps: c.summary?.steps ?? [], tokens: c.input_tokens + c.output_tokens }), c.status === 'passed' ? null : reason, actor.id],
      );
      await tx.query(`UPDATE model_change_checks SET decision = 'accepted', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1`, [checkId, actor.id, reason]);
      await audit(tx, {
        actorId: actor.id,
        action: `${c.status === 'passed' ? 'flow.model_switched' : 'flow.model_switched_despite_differences'}${suffix}`,
        subjectType: 'flow_version',
        subjectId: v.id,
        outcome: 'ok',
        relatedId: by.onBehalfOf ?? checkId,
      });
    });
  }

  /** Check a version against the organization's model again (after a budget stop, new tests, or a model that went away). */
  async recheck(actor: Member, versionId: string): Promise<{ checkId: string }> {
    if (!canApprove(actor)) throw forbidden('approver_only');
    const current = this.d.aiModel();
    if (!this.d.ai || !current) throw conflict('organization_ai_not_configured');
    return withTx(this.d.db, async (tx) => {
      const v = await this.d.flows.getVersion(tx, versionId);
      if (!v) throw notFound('flow_version');
      if (v.status !== 'approved') throw conflict('flow_version_not_approved');
      if (!orgAiSteps(v.definition).length) throw badRequest('no_ai_steps');
      if ((v.aiModel ?? current) === current) throw conflict('already_on_current_model');
      const checkId = await this.queue(tx, v.id, v.aiModel!, current);
      await audit(tx, { actorId: actor.id, action: 'flow.model_check_requested', subjectType: 'flow_version', subjectId: v.id, outcome: 'ok', relatedId: checkId });
      return { checkId };
    });
  }

  /**
   * An approver locks an approved version to one model ("provider:model", a provider the server has), or unlocks it
   * (null) so it follows the organization's model again. Audited and kept in its model history.
   */
  async lock(actor: Member, versionId: string, model: string | null): Promise<void> {
    if (!canApprove(actor)) throw forbidden('approver_only');
    if (!this.d.ai) throw conflict('organization_ai_not_configured');
    if (model !== null) {
      if (!MODEL_ID.test(model)) throw badRequest('invalid_model', 'a model as provider:model, e.g. anthropic:claude-opus-5-5');
      const routed = this.d.ai as AiProvider & { forProvider?: (id: string) => AiProvider | null };
      const provider = splitModel(model).provider;
      if (routed.forProvider ? !routed.forProvider(provider) : provider !== this.d.ai.id) throw badRequest('ai_provider_not_configured');
    }
    await withTx(this.d.db, async (tx) => {
      const v = await this.d.flows.getVersion(tx, versionId);
      if (!v) throw notFound('flow_version');
      if (v.status !== 'approved') throw conflict('flow_version_not_approved');
      if (!orgAiSteps(v.definition).length) throw badRequest('no_ai_steps');
      const by = await approvalAuthority(tx, actor, await this.d.flows.teamOfVersion(tx, v.id), '');
      const from = v.modelLocked && v.aiModel ? v.aiModel : (this.d.aiModel() ?? 'organization');
      if (model === null) await tx.query(`UPDATE flow_versions SET model_locked = false WHERE id = $1`, [v.id]);
      else await tx.query(`UPDATE flow_versions SET ai_model = $2, model_locked = true WHERE id = $1`, [v.id, model]);
      await tx.query(`INSERT INTO flow_model_pins (flow_version_id, from_model, to_model, reason, decided_by) VALUES ($1, $2, $3, $4, $5)`, [
        v.id,
        from,
        model ?? 'organization',
        model === null ? "unlocked: follows the organization's model" : 'locked by an approver',
        actor.id,
      ]);
      await audit(tx, {
        actorId: actor.id,
        action: model === null ? 'flow.model_unlocked' : 'flow.model_locked',
        subjectType: 'flow_version',
        subjectId: v.id,
        outcome: 'ok',
        relatedId: by.onBehalfOf ?? undefined,
      });
    });
  }

  /** For the review page: the version's model, the organization's, and every switch so far. */
  async pinView(versionId: string) {
    const history = (await this.d.db.query<{ from_model: string; to_model: string; reason: string | null; handle: string; decided_at: Date; check_summary: { status?: string } | null }>(
      `SELECT p.from_model, p.to_model, p.reason, m.handle, p.decided_at, p.check_summary FROM flow_model_pins p JOIN members m ON m.id = p.decided_by
       WHERE p.flow_version_id = $1 ORDER BY p.decided_at`,
      [versionId],
    )).rows.map((p) => ({ from: p.from_model, to: p.to_model, reason: p.reason, by: p.handle, at: p.decided_at, check: p.check_summary?.status ?? null }));
    const open = (await this.d.db.query<{ status: CheckStatus; to_model: string }>(
      `SELECT status, to_model FROM model_change_checks WHERE flow_version_id = $1 AND decision IS NULL ORDER BY created_at DESC LIMIT 1`,
      [versionId],
    )).rows[0];
    return { organizationModel: this.d.aiModel(), history, check: open ? { status: open.status, toModel: open.to_model } : null };
  }
}

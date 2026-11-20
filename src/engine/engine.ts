import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { BrowserLauncher } from '../sandbox/browser.js';
import type { LiveHub } from '../sandbox/live.js';
import { getRetention } from '../core/retention.js';
import { audit } from '../core/audit.js';
import { canonicalJson, sha256Hex, type Cipher } from '../core/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import { nextSteps, type BlockerContext, type NextSteps } from './next-steps.js';
import { recordCall } from '../modules/health.js';
import { MeteredProvider, withAiContext as aiContext } from '../ai/metering.js';
import { guardedFetch } from '../runtime/egress.js';
import { canApprove, type Member } from '../core/members.js';
import { readsFrom, needsSignOff } from '../flows/injection.js';
import { canUseTeam } from '../core/teams.js';
import { credentialModes, teamSecret, teamStoredServices } from '../core/team-credentials.js';
import { notify, notifyRole } from '../core/notify.js';
import { approvalAuthority, notifyApprovers } from '../governance/approvals.js';
import type { Vault } from '../core/vault.js';
import { withTx, type Db, type Queryable, type Tx } from '../db/db.js';
import { AUTO_APPROVE, secretPhases, secretService, settingsOf, type ActionStep, type AiStep, type AppStep, type BrowseStep, type FixStep, type FlowDefinition, type FlowStep, type FormField, type InputStep, type OptionsSource, type Step, type TableStep } from '../flows/definition.js';
import type { Tables } from '../tables/service.js';
import { checkAnswers, toChoices, type Choice } from '../runtime/form.js';
import type { FlowService, FlowVersion } from '../flows/service.js';
import { evaluate, lookup, resolve, TemplateError, type TemplateScope } from '../flows/template.js';
import { signOffValues } from '../flows/sign-off.js';
import { ajv, hostMatches, resolveManifest, servicesFor, type Manifest, type ManifestAction } from '../modules/manifest.js';
import type { ModuleVersion } from '../modules/registry.js';
import { Broker, type FetchLike } from '../sandbox/broker.js';
import { fieldsHint, sampleOf } from './sample.js';
import type { SandboxRunner } from '../sandbox/runner.js';
import type { McpService } from '../mcp/mcp.js';
import { enqueue, LeaseLost, type Job } from './jobs.js';
import { followupAad } from './followups.js';
import { recordUndo } from './undo.js';
import { checkAllowedHost, checkDelegation, checkRunStart } from '../governance/policies.js';
import { formatReport, providerFor, runAiStep, runBrowseStep, StepError, toChecks, type Check } from './builtin.js';
import { withFlowInstructions } from '../runtime/ai-step.js';
import { AiError, type AiProvider } from '../ai/provider.js';
import { ViolationError } from '../runtime/errors.js';
import { MODEL_ID, pinTo, runModel, splitModel, withFallback } from '../ai/models.js';
import { capReached, runSpend, type CapReached } from '../ai/costs.js';
import type { CodeRunner, StepNetwork } from './apps.js';
import { runOutcome } from './outcome.js';
import { egressCeiling, judgeEgress } from '../core/egress-policy.js';
import { parseDestinations } from '../runtime/destinations.js';
import { runFixStep, type FixOutput } from './fix.js';
import { commentaryOf, narrator, sayNow } from './commentary.js';
import { progress, withProgress } from '../core/progress.js';
import { normalizeOnlyFiles } from './fix-limits.js';
import { acquireSlot, releaseSlot, renewSlot, SLOT_RETRY_MS } from './sandbox-housekeeping.js';
import { flowStopped, isStopped, noteBlockedCall, noteCostCap, noteRejectedSignOff, noteRunFailure, stopsOfRun } from '../governance/auto-stop.js';

type RunStatus = 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'skipped' | 'failed' | 'not_run';

interface RunRow {
  id: string;
  inputs_from_model: boolean;
  /** Started by an App on its pinned, superseded version: steps that change data do not run. */
  reads_only: boolean;
  /** The model the run was started with; null: its Flow's. */
  ai_model?: string | null;
  flow_version_id: string;
  run_as: string;
  status: RunStatus;
  wait_reason: string | null;
  inputs_enc: string | null;
  manual_retries_used: number;
  followup_of: string | null;
  parent_run_id: string | null;
  /** A dry run: reads run for real, anything that would change something is skipped. */
  dry: boolean;
  breakglass_id: string | null;
  /** The agent (MCP token) that started it, if one did. */
  mcp_token_id: string | null;
  /** Started from outside: a webhook endpoint, a schedule or trigger, or a watch. Its inputs come with it. */
  endpoint_id?: string | null;
  trigger_id?: string | null;
  watch_id?: string | null;
}

/** Follow-ups may start follow-ups, but only this deep: a chain never loops forever. */
const MAX_FOLLOWUP_DEPTH = 3;
/** Super Flows may run Super Flows, but only this deep. */
const MAX_FLOW_NESTING = 5;
const childAad = (childRunId: string) => `run-child:${childRunId}:result`;
/** A step waiting for a sign-off because model-written text could steer it (run_steps.error_type while it waits). */
const GUARD = 'awaiting_sign_off';
/** A step waiting because the run reached its AI cost cap (run_steps.error_type while it waits; runs.wait_reason 'cost_cap'). */
const COST_CAP = 'cost_cap_reached';
/** Every code sandbox is in use: the app or fix step waits its turn (run wait reason too). */
const SANDBOX_BUSY = 'sandbox_busy';
/** Associated data of a step's "why it was refused" (run_steps.detail_enc); read elsewhere by src/modules/run-fix.ts. */
export const stepDetailAad = (runId: string, stepId: string) => `run:${runId}:step:${stepId}:detail`;
/** How much of what a failed step printed is kept with it, and how many of its last lines the run says out loud. */
const LOG_KEPT = 4000;
const LOG_LINES_SAID = 12;
/** A step waiting because its Flow was stopped automatically (run_steps.error_type while it waits; runs.wait_reason 'auto_stop'). */
const AUTO_STOP = 'auto_stopped';

interface StepRow {
  run_id: string;
  step_id: string;
  idx: number;
  status: StepStatus;
  attempts: number;
  lease_until: Date | null;
  resume_at: Date | null;
  error_type: string | null;
  executed_by: string | null;
  output_enc: string | null;
  progress_enc: string | null;
  sign_off_enc?: string | null;
  sign_off_sha256?: string | null;
  proposed_enc?: string | null;
  calls_enc?: string | null;
  log_enc?: string | null;
  detail_enc?: string | null;
}

interface DelegationRow {
  id: string;
  run_id: string;
  step_id: string;
  requester_id: string;
  delegate_id: string;
  module_version_id: string;
  action: string;
  inputs_enc: string | null;
  request_hash: string;
  status: string;
  expires_at: Date;
}

/** Inputs for one action step: one entry per invocation (several with forEach). */
interface ResolvedInputs {
  forEach: boolean;
  items: unknown[];
}

interface ExecutePlan {
  runId: string;
  step: ActionStep;
  module: ModuleVersion;
  action: ManifestAction;
  executorId: string;
  inputs: ResolvedInputs;
  delegationId: string | null;
  /** Outputs of forEach items that already succeeded in an earlier attempt. */
  done: Record<string, unknown>;
  /** The module's settings, from the Flow (its "moduleSettings" and the step's own), templates resolved. */
  settings: Record<string, string>;
}

/** Ends a builtin step's work early with its output set. */
class Done extends Error {}

/** A step Dittoly runs itself (ask an AI, AI-guided browser), outside the planning transaction. */
interface BuiltinPlan {
  builtin: true;
  runId: string;
  step: AiStep | BrowseStep | AppStep | FixStep;
  executorId: string;
  /** Resolved templates: the AI step's input, or the browse step's url and checks. */
  input: unknown;
  versionId: string;
  definition: FlowDefinition;
  /** Dry runs have no cost caps. */
  dry: boolean;
}

/** A step as the commentary names it. */
const stepName = (step: Step) => (step.title ?? step.id).slice(0, 80);
const BUILTIN_DOING: Record<BuiltinPlan['step']['type'], string> = {
  ai: 'the AI is working on it',
  fix: 'preparing a code sandbox for the AI to fix the code',
  browse: 'the AI is opening the page',
  app: 'starting the app in a code sandbox',
};

const TERMINAL_RUN: RunStatus[] = ['succeeded', 'failed', 'cancelled'];
/** A failed step a person chose to skip (src/engine/engine.ts resolveStep): later steps read its output as null. */
const SKIPPED_BY_PERSON = 'skipped_by_person';
/** The wait of a run whose member asked to get past a step that changes data: an approver decides. */
const RESOLUTION_WAIT = 'step_resolution';
const MAX_GIVEN_RESULT = 64 * 1024;

/** The run ended (cancelled, or failed elsewhere) while one of its steps was working: stop and free the slot. */
class RunEnded extends Error {}
const UNCERTAIN_ERRORS = new Set(['network_error', 'upstream_timeout', 'action_timeout', 'sandbox_exited']);

export interface EngineDeps {
  db: Db;
  cipher: Cipher;
  vault: Vault;
  flows: FlowService;
  runner: SandboxRunner;
  /** Headless browser for browser scripts. */
  browser?: BrowserLauncher;
  /** Live views of browser steps, for the run's member. */
  live?: LiveHub;
  /** Builds and runs apps from git branches for app steps. */
  apps?: CodeRunner;
  /** The organization's AI provider, for AI and browse steps that use it. */
  ai?: AiProvider | null;
  /** The organization's model now ("provider:model"; an admin may change it); versions run with the one they are pinned to. */
  aiModel?: () => string | null;
  /** Test hook: the provider built from the runner's own key. */
  runnerAi?: (provider: 'openai' | 'anthropic', apiKey: string) => AiProvider;
  mcp: McpService;
  /** Resolves a member's credential for the broker (plain secret, or a refreshed OAuth access token). */
  secrets: (memberId: string, service: string) => Promise<string | null>;
  config: Pick<Config, 'mode' | 'retry' | 'insecureHttpHosts' | 'internalHosts' | 'delegationTtlHours' | 'maxWaitingRuns' | 'codeSandboxes'>;
  /** Test hook: replace real outbound HTTP. */
  fetchImpl?: FetchLike;
  actionTimeoutMs?: number;
  /** The teams' data tables, for table steps. */
  tables?: Tables;
}

export class Engine {
  constructor(private readonly d: EngineDeps) {}

  private get db() {
    return this.d.db;
  }

  // ---- encryption helpers: in-progress data is encrypted and bound to its row ----
  private aadInputs = (runId: string) => `run:${runId}:inputs`;
  private aadOutput = (runId: string, stepId: string) => `run:${runId}:step:${stepId}:output`;
  private aadProgress = (runId: string, stepId: string) => `run:${runId}:step:${stepId}:progress`;
  private aadSignOff = (runId: string, stepId: string) => `run:${runId}:step:${stepId}:sign_off`;
  private aadProposed = (runId: string, stepId: string) => `run:${runId}:step:${stepId}:proposed`;
  private aadCalls = (runId: string, stepId: string) => `run:${runId}:step:${stepId}:calls`;
  /** What a failed step printed (a fix or app step's install, build and test output). */
  private aadLog = (runId: string, stepId: string) => `run:${runId}:step:${stepId}:log`;
  /** Why a step was refused, as the check that refused it put it. */
  private aadDetail = stepDetailAad;

  /** A guarded step's exact values, encrypted, and their hash: what its sign-off covers (src/flows/sign-off.ts). */
  private signOffFields(runId: string, step: Step, scope: TemplateScope): { sign_off_enc: string; sign_off_sha256: string } {
    const values = signOffValues(step, scope);
    return { sign_off_enc: this.d.cipher.encryptJson(values, this.aadSignOff(runId, step.id)), sign_off_sha256: sha256Hex(canonicalJson(values)) };
  }
  private aadDelegation = (id: string) => `delegation:${id}:inputs`;

  // ---------------------------------------------------------------- start

  async startRun(
    flowVersionId: string,
    runAs: string,
    inputs: unknown,
    opts: {
      actorId: string;
      triggerId?: string;
      scheduleId?: string;
      deliveryId?: string;
      endpointId?: string;
      dry?: boolean;
      breakglassId?: string;
      watchId?: string;
      mcpTokenId?: string;
      appId?: string;
      /** An App's pinned version that a newer one superseded: it may still start, but only its reads run. */
      readsOnly?: boolean;
      /** The model ("provider:model") this run's organization AI steps ask for; refused when the version is locked to one. */
      aiModel?: string;
    } = { actorId: runAs },
  ): Promise<string> {
    // Overload: a new run is refused while too many already wait for a slot. Runs already going (their child
    // runs, follow-ups and retries) never come through here, so they are never refused.
    const limit = this.d.config.maxWaitingRuns;
    if (limit) {
      const waiting = (await this.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs WHERE kind = 'advance' AND failed_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())`,
      )).rows[0]!.n;
      if (waiting >= limit) throw new AppError('server_busy', 503, 'Too many runs are waiting to start. Nothing was started; try again in a minute.');
    }
    const runId = randomUUID();
    await withTx(this.db, (tx) => this.startRunIn(tx, runId, flowVersionId, runAs, inputs, opts));
    log.info('run_started', { runId, flowVersionId, memberId: runAs });
    return runId;
  }

  /** Every check happens before the first write, so a refused start leaves the transaction usable. */
  private async startRunIn(
    tx: Tx,
    runId: string,
    flowVersionId: string,
    runAs: string,
    inputs: unknown,
    opts: { actorId: string; triggerId?: string; scheduleId?: string; deliveryId?: string; followupOf?: string; inputsFromModel?: boolean; endpointId?: string; parentRunId?: string; dry?: boolean; breakglassId?: string; watchId?: string; mcpTokenId?: string; appId?: string; readsOnly?: boolean; aiModel?: string },
  ): Promise<void> {
    {
      if (opts.triggerId && opts.deliveryId) {
        // Claimed in the same transaction as the run, so a redelivered webhook never starts a second run.
        const claimed = await tx.query(
          `UPDATE webhook_deliveries SET run_id = $3 WHERE trigger_id = $1 AND delivery_id = $2 AND run_id IS NULL`,
          [opts.triggerId, opts.deliveryId, runId],
        );
        if (!claimed.rowCount) throw conflict('webhook_already_processed');
      }
      const { version, modules } = await this.d.flows.assertRunnable(tx, flowVersionId, { allowSuperseded: opts.readsOnly === true });
      // A Flow stopped automatically starts nothing, however the run is started (break-glass too).
      if (await isStopped(tx, 'flow', version.flowId)) throw flowStopped();
      // Organization rules (working hours, daily limits); dry runs change nothing, so only limits by hours apply to real runs.
      if (!opts.dry) await checkRunStart(tx, runAs, version.definition, modules);
      // A Flow runs only as a member of its team (org admins may run any).
      const runner = await tx.query<Member>(`SELECT id, handle, role FROM members WHERE id = $1 AND NOT disabled`, [runAs]);
      if (!runner.rows[0] || !(await canUseTeam(tx, await this.d.flows.teamOfVersion(tx, flowVersionId), runner.rows[0]))) throw forbidden('not_in_team');
      const problems = ajv.explain(version.definition.inputs, inputs);
      if (problems.length) throw badRequest('invalid_inputs', problems.join('; '));
      if (opts.aiModel) this.checkRunModel(version, opts.aiModel);
      await tx.query(
        `INSERT INTO runs (id, flow_version_id, run_as, trigger_id, schedule_id, status, inputs_enc, followup_of, endpoint_id, parent_run_id, dry, breakglass_id, watch_id, mcp_token_id, inputs_from_model, app_id, reads_only, ai_model)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [runId, flowVersionId, runAs, opts.triggerId ?? null, opts.scheduleId ?? null, this.d.cipher.encryptJson(inputs ?? {}, this.aadInputs(runId)), opts.followupOf ?? null, opts.endpointId ?? null, opts.parentRunId ?? null, opts.dry === true, opts.breakglassId ?? null, opts.watchId ?? null, opts.mcpTokenId ?? null, opts.inputsFromModel === true, opts.appId ?? null, opts.readsOnly === true, opts.aiModel ?? null],
      );
      for (const [idx, step] of version.definition.steps.entries()) {
        await tx.query(`INSERT INTO run_steps (run_id, step_id, idx, status) VALUES ($1, $2, $3, 'pending')`, [runId, step.id, idx]);
      }
      await audit(tx, {
        actorId: opts.actorId,
        action: opts.dry ? 'run.dry_started' : opts.breakglassId ? 'run.breakglass_started' : 'run.started',
        subjectType: 'run',
        subjectId: runId,
        outcome: 'ok',
        relatedId: opts.breakglassId ?? opts.triggerId ?? opts.scheduleId ?? opts.endpointId ?? opts.mcpTokenId ?? opts.appId ?? opts.parentRunId ?? flowVersionId,
      });
      await enqueue(tx, 'advance', { runId });
    }
  }

  /** A model a run is started with: "provider:model" of a provider the organization's AI has, on a version not locked to one. */
  private checkRunModel(version: FlowVersion, model: string): void {
    if (!MODEL_ID.test(model)) throw badRequest('invalid_model', 'a model as provider:model, e.g. anthropic:claude-opus-5-5');
    if (version.modelLocked) throw conflict('flow_model_locked');
    const ai = this.d.ai as (AiProvider & { forProvider?: (id: string) => AiProvider | null }) | null | undefined;
    const provider = splitModel(model).provider;
    if (!ai || (ai.forProvider ? !ai.forProvider(provider) : provider !== ai.id)) throw badRequest('ai_provider_not_configured');
  }

  async handleJob(job: Job, heartbeat: () => Promise<void>): Promise<void> {
    if (job.kind === 'advance' && job.payload.runId) await this.advance(job.payload.runId, heartbeat);
  }

  // ---------------------------------------------------------------- advance

  /** Move a run forward until it waits, pauses or ends. Safe to call any number of times. */
  async advance(runId: string, heartbeat: () => Promise<void> = async () => undefined): Promise<void> {
    // A step's checkpoints (each item, each keep-alive) also check that its run still goes on.
    const checkpoint = async () => {
      await heartbeat();
      const r = await this.db.query<{ status: RunStatus }>(`SELECT status FROM runs WHERE id = $1`, [runId]);
      if (!r.rows[0] || TERMINAL_RUN.includes(r.rows[0].status)) throw new RunEnded();
    };
    try {
      for (let guard = 0; guard < 200; guard++) {
        const plan = await withTx(this.db, (tx) => this.plan(tx, runId));
        if (!plan) return;
        if ('builtin' in plan) await this.executeBuiltin(plan, checkpoint);
        else await this.execute(plan, checkpoint);
      }
    } catch (err) {
      // Ended meanwhile: whoever ended it already marked its steps; nothing more to record.
      if (err instanceof RunEnded) return log.info('run_step_stopped', { runId });
      throw err;
    }
  }

  private async loadRun(tx: Tx, runId: string) {
    const r = await tx.query<RunRow>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [runId]);
    const run = r.rows[0];
    if (!run) return null;
    const steps = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx FOR UPDATE`, [runId])).rows;
    const version = await this.d.flows.getVersion(tx, run.flow_version_id);
    // Inputs a model wrote, or that came from outside (a webhook, an endpoint, a trigger): see guardedSteps.
    const outside = { inputsFromModel: run.inputs_from_model === true, inputsExternal: Boolean(run.endpoint_id || run.trigger_id || run.watch_id) };
    return {
      run,
      steps,
      definition: version!.definition,
      flowId: version!.flowId,
      guarded: outside.inputsFromModel || outside.inputsExternal ? new Set(await this.d.flows.guardedSteps(tx, version!, outside)) : await this.guarded(tx, version!),
    };
  }

  /** The version is approved, or was replaced by a newer approved version of the same Flow. */
  private async stillApproved(tx: Tx, versionId: string): Promise<boolean> {
    const { rows } = await tx.query<{ ok: boolean }>(
      `SELECT v.status = 'approved' OR EXISTS (SELECT 1 FROM flow_versions n WHERE n.flow_id = v.flow_id AND n.version > v.version AND n.status = 'approved') AS ok
       FROM flow_versions v WHERE v.id = $1`,
      [versionId],
    );
    return rows[0]?.ok === true;
  }

  /** Whether a step can change anything: a write action, a delegated one, a table write, an app build or fix, or a Flow step. */
  private async mayChange(tx: Tx, definition: FlowDefinition, step: Step): Promise<boolean> {
    if (step.type === 'app' || step.type === 'fix' || step.type === 'flow') return true;
    if (step.type === 'table') return step.op !== 'get' && step.op !== 'list';
    if (step.type !== 'action') return false;
    if (step.delegateTo) return true;
    const mv = (await this.d.flows.pinnedModules(tx, definition)).get(step.module);
    return mv?.manifest.actions.find((a) => a.name === step.action)?.effect !== 'read';
  }

  /** Steps of a version that wait for a sign-off before they run (prompt-injection containment). Versions never change. */
  private readonly guards = new Map<string, Set<string>>();
  private async guarded(tx: Tx, version: FlowVersion): Promise<Set<string>> {
    let g = this.guards.get(version.id);
    if (!g) {
      g = new Set(await this.d.flows.guardedSteps(tx, version));
      if (version.guardedSteps) this.guards.set(version.id, g);
    }
    return g;
  }

  private scope(run: RunRow, steps: StepRow[]): TemplateScope {
    const inputs = run.inputs_enc ? this.d.cipher.decryptJson(run.inputs_enc, this.aadInputs(run.id)) : {};
    const out: TemplateScope['steps'] = {};
    for (const s of steps) {
      if (s.status === 'succeeded' && s.output_enc) {
        out[s.step_id] = { output: this.d.cipher.decryptJson(s.output_enc, this.aadOutput(run.id, s.step_id)) };
      } else if (s.status === 'skipped' && (!s.error_type || s.error_type === SKIPPED_BY_PERSON)) {
        // Skipped by its condition: its output is null, so a later step can take whichever path ran.
        // Paths below it (steps.x.output.y) stay unresolved; dry-run skips leave it out as before.
        out[s.step_id] = { output: null };
      }
    }
    return { inputs, steps: out };
  }

  /**
   * Decide the next thing to do, inside one transaction holding the run lock.
   * Returns an action to execute (outside the transaction), or null to stop.
   */
  private async plan(tx: Tx, runId: string): Promise<ExecutePlan | BuiltinPlan | null> {
    const loaded = await this.loadRun(tx, runId);
    if (!loaded) return null;
    const { run, steps, definition, flowId, guarded } = loaded;
    if (run.status !== 'running' && run.status !== 'waiting') return null;

    for (const row of steps) {
      if (row.status === 'succeeded' || row.status === 'skipped') continue;
      const step = definition.steps[row.idx]!;

      if (row.status === 'running') {
        if (row.lease_until && row.lease_until > new Date()) return null; // another worker is executing it
        if (step.type === 'ai' || step.type === 'browse' || step.type === 'app' || step.type === 'fix') {
          // Asking an AI, checking pages or building in a sandbox again is safe; give up after the usual number of attempts.
          if (row.attempts >= 1 + this.d.config.retry.autoRetries) {
            await this.failStep(tx, run, step.id, 'worker_crashed');
            return null;
          }
          return this.planBuiltin(tx, run, row, step, this.scope(run, steps));
        }
        return this.recoverCrashedStep(tx, run, row, step as ActionStep);
      }

      if (row.status === 'waiting' && row.error_type === GUARD) {
        // Waiting for a sign-off before a step that model-written text could steer.
        const decision = await this.gateDecision(tx, run.id, step.id);
        if (!decision) return null;
        if (decision === 'rejected') {
          await this.setStep(tx, run.id, step.id, { status: 'failed', error_type: 'sign_off_rejected', finished_at: new Date() });
          await this.finishRun(tx, run, 'failed');
          return null;
        }
        // The sign-off covers the values the approver saw. Should the step's values differ now, it asks again.
        if (row.sign_off_sha256) {
          let now: ReturnType<Engine['signOffFields']>;
          try {
            now = this.signOffFields(run.id, step, this.scope(run, steps));
          } catch {
            await this.failStep(tx, run, step.id, 'template_unresolved');
            return null;
          }
          const signed = (await tx.query<{ values_sha256: string | null }>(`SELECT values_sha256 FROM gate_decisions WHERE run_id = $1 AND step_id = $2`, [run.id, step.id])).rows[0]?.values_sha256;
          if (signed !== now.sign_off_sha256) {
            await tx.query(`DELETE FROM gate_decisions WHERE run_id = $1 AND step_id = $2`, [run.id, step.id]);
            await this.setStep(tx, run.id, step.id, now);
            await this.setRun(tx, run.id, 'waiting', 'approval');
            await audit(tx, { actorId: null, action: 'gate.values_changed', subjectType: 'step', subjectId: `${run.id}:${step.id}`, outcome: 'denied', errorType: 'sign_off_values_changed' });
            const owner = this.d.config.mode === 'shared' ? run.run_as : '';
            await notifyApprovers(tx, await this.teamOfRun(run.id, tx), owner, 'approval_needed', { runId: run.id, stepId: step.id });
            return null;
          }
        }
        await this.setStep(tx, run.id, step.id, { status: 'pending', error_type: null });
        row.status = 'pending';
      } else if (row.status === 'waiting' && row.error_type === AUTO_STOP) {
        // Its Flow was stopped automatically: it waits until someone resumes the Flow (and lets this run go on).
        if (await isStopped(tx, 'flow', flowId)) return null;
        await this.setStep(tx, run.id, step.id, { status: 'pending', error_type: null });
        row.status = 'pending';
      } else if (row.status === 'waiting' && row.error_type === COST_CAP) {
        // Waiting at the run's cost cap: it goes on once someone allowed more.
        if (await capReached(tx, run.id, definition, step)) return null;
        await this.setStep(tx, run.id, step.id, { status: 'pending', error_type: null });
        row.status = 'pending';
      } else if (row.status === 'waiting') {
        const next = await this.checkWaiting(tx, run, row, step);
        if (next === 'continue') continue;
        return next;
      }

      if (row.status === 'pending') {
        if (row.resume_at && row.resume_at > new Date()) return null; // retry backoff
        // Its Flow was stopped automatically meanwhile: the run waits before this step, never in the middle of one.
        if (await isStopped(tx, 'flow', flowId)) {
          await this.setStep(tx, run.id, step.id, { status: 'waiting', error_type: AUTO_STOP, started_at: new Date() });
          await this.setRun(tx, run.id, 'waiting', 'auto_stop');
          await audit(tx, { actorId: null, action: 'run.auto_stopped', subjectType: 'run', subjectId: run.id, outcome: 'denied', errorType: 'flow_stopped', relatedId: flowId });
          log.info('run_auto_stopped', { runId: run.id, stepId: step.id });
          return null;
        }
        const scope = this.scope(run, steps);
        if (step.when && !evaluate(step.when, scope)) {
          await this.setStep(tx, run.id, step.id, { status: 'skipped', finished_at: new Date() });
          row.status = 'skipped';
          continue;
        }
        // A dry run waits for nobody and builds nothing: sign-offs, delays, app builds and fixes are skipped.
        if (run.dry && (step.type === 'approval' || step.type === 'delay' || step.type === 'app' || step.type === 'fix')) {
          await this.skipDry(tx, run.id, step.id, 'dry_run');
          row.status = 'skipped';
          continue;
        }
        // A step that changes something runs only while what was approved still stands: a change to
        // the Flow (or its rejection) cancels the approval, also for runs already under way.
        if (!run.dry && !(await this.stillApproved(tx, run.flow_version_id)) && (await this.mayChange(tx, definition, step))) {
          await this.failStep(tx, run, step.id, 'flow_version_not_approved');
          return null;
        }
        // An App's pinned version that a newer one replaced: it still reads, it changes nothing.
        if (run.reads_only && !run.dry && (await this.mayChange(tx, definition, step))) {
          await this.failStep(tx, run, step.id, 'pinned_version_retired');
          return null;
        }
        // Model-written text could steer this step (src/flows/injection.ts): a person signs off first,
        // unless its evidence gate holds (a fix step's change, verified by Dittoly: autoApproveWhen).
        if (guarded.has(step.id) && !run.dry && !(await this.gateDecision(tx, run.id, step.id)) && !(await this.releaseByEvidence(tx, run, step, scope))) {
          // The approver sees, and signs off, exactly what the step will do.
          let signOff: ReturnType<Engine['signOffFields']>;
          try {
            signOff = this.signOffFields(run.id, step, scope);
          } catch {
            await this.failStep(tx, run, step.id, 'template_unresolved');
            return null;
          }
          await this.setStep(tx, run.id, step.id, { status: 'waiting', started_at: new Date(), error_type: GUARD, ...signOff });
          await this.setRun(tx, run.id, 'waiting', 'approval');
          const owner = this.d.config.mode === 'shared' ? run.run_as : '';
          await notifyApprovers(tx, await this.teamOfRun(run.id, tx), owner, 'approval_needed', { runId: run.id, stepId: step.id });
          return null;
        }
        if (step.type === 'approval') {
          await this.setStep(tx, run.id, step.id, { status: 'waiting', started_at: new Date() });
          await this.setRun(tx, run.id, 'waiting', 'approval');
          // The team's approvers (or everyone's, without the team rule), or their stand-ins while away.
          const owner = this.d.config.mode === 'shared' ? run.run_as : '';
          await notifyApprovers(tx, await this.teamOfRun(run.id, tx), owner, 'approval_needed', { runId: run.id, stepId: step.id });
          return null;
        }
        if (step.type === 'input') {
          // Only the member the run belongs to can answer; the run waits for them.
          await this.setStep(tx, run.id, step.id, { status: 'waiting', started_at: new Date() });
          await this.setRun(tx, run.id, 'waiting', 'input_needed');
          await notify(tx, run.run_as, 'input_needed', { runId: run.id, stepId: step.id });
          return null;
        }
        if (step.type === 'delay') {
          const resumeAt = new Date(Date.now() + step.seconds * 1000);
          await this.setStep(tx, run.id, step.id, { status: 'waiting', started_at: new Date(), resume_at: resumeAt });
          await this.setRun(tx, run.id, 'waiting', 'delay');
          await enqueue(tx, 'advance', { runId: run.id }, resumeAt);
          return null;
        }
        if (step.type === 'report') {
          // Formatting only: done here, in the same transaction.
          try {
            const output = formatReport(step, resolve(step.items, scope), step.link ? String(resolve(step.link, scope)) : undefined);
            const outputEnc = this.d.cipher.encryptJson(output, this.aadOutput(run.id, step.id));
            await this.setStep(tx, run.id, step.id, { status: 'succeeded', output_enc: outputEnc, started_at: new Date(), finished_at: new Date() });
            // Later steps in this same pass read it from the rows already loaded.
            row.status = 'succeeded';
            row.output_enc = outputEnc;
          } catch (err) {
            await this.failStep(tx, run, step.id, err instanceof TemplateError ? 'template_unresolved' : 'report_failed');
            return null;
          }
          continue;
        }
        if (step.type === 'table') {
          // Small and local: done here, in the same transaction. A dry run reads but changes nothing.
          if (run.dry && step.op !== 'get' && step.op !== 'list') {
            await this.skipDry(tx, run.id, step.id, 'dry_run');
            row.status = 'skipped';
            continue;
          }
          try {
            const output = await this.tableStep(tx, run, step, scope);
            const outputEnc = this.d.cipher.encryptJson(output, this.aadOutput(run.id, step.id));
            await this.setStep(tx, run.id, step.id, { status: 'succeeded', output_enc: outputEnc, started_at: new Date(), finished_at: new Date(), executed_by: run.run_as });
            row.status = 'succeeded';
            row.output_enc = outputEnc;
          } catch (err) {
            const code = err instanceof TemplateError ? 'template_unresolved' : err instanceof AppError ? err.code : 'table_failed';
            await this.failStep(tx, run, step.id, code);
            return null;
          }
          continue;
        }
        if ((step.type === 'ai' || step.type === 'browse' || step.type === 'fix') && !run.dry) {
          const cap = await capReached(tx, run.id, definition, step);
          if (cap) {
            await this.pauseForCost(tx, run, cap);
            return null;
          }
        }
        if (step.type === 'ai' || step.type === 'browse' || step.type === 'app' || step.type === 'fix') return this.planBuiltin(tx, run, row, step, scope);
        if (step.type === 'flow') {
          if (!(await this.startChildren(tx, run, step, scope))) return null;
          // (Children of a dry run are dry runs too.)
          await this.setStep(tx, run.id, step.id, { status: 'waiting', started_at: new Date() });
          await this.setRun(tx, run.id, 'waiting', 'child_flows');
          return null;
        }
        // An automatic retry of a delegated action stays with the same approved request and delegate.
        const approved = await this.openDelegationFor(tx, run.id, step.id, ['approved']);
        if (approved) return this.planDelegated(tx, run, row, step, approved);
        return this.planAction(tx, run, row, step, scope);
      }

      return null; // failed or not_run: the run is paused or finished
    }

    await this.finishRun(tx, run, 'succeeded');
    return null;
  }

  private async tableStep(tx: Tx, run: RunRow, step: TableStep, scope: TemplateScope): Promise<unknown> {
    if (!this.d.tables) throw new AppError('tables_unavailable', 500);
    const t = await this.d.tables.byName(tx, await this.teamOfRun(run.id, tx), step.table);
    if (!t) throw new AppError('table_not_found', 404);
    const key = step.key === undefined ? undefined : resolve(step.key, scope);
    const who = { runId: run.id };
    switch (step.op) {
      case 'get': {
        const row = await this.d.tables.getRow(tx, t, key);
        return { found: row !== null, row };
      }
      case 'put': {
        // "Only if nothing changed since I read it": the revision the get step returned, resolved like any value.
        const expected = step.ifRevision === undefined ? undefined : Number(resolve(step.ifRevision, scope));
        if (expected !== undefined && !Number.isInteger(expected)) throw new AppError('invalid_if_revision', 400, 'ifRevision must resolve to a whole number');
        return this.d.tables.putRow(tx, t, key, resolve(step.values ?? {}, scope) as Record<string, unknown>, who, expected);
      }
      case 'delete':
        return { deleted: await this.d.tables.deleteRow(tx, t, key) };
      case 'increment':
        return this.d.tables.increment(tx, t, key, step.column!, step.by === undefined ? 1 : resolve(step.by, scope), who);
      case 'claim':
        return this.d.tables.claim(tx, t, key, step.hours ?? 6, run.id);
      case 'list': {
        const rows = await this.d.tables.rows(tx, t, {
          ...(step.where ? { where: { column: step.where.column, equals: resolve(step.where.equals, scope) } } : {}),
          ...(step.limit ? { limit: step.limit } : {}),
        });
        return { rows, count: rows.length };
      }
    }
  }

  private async planBuiltin(tx: Tx, run: RunRow, row: StepRow, step: AiStep | BrowseStep | AppStep | FixStep, scope: TemplateScope): Promise<BuiltinPlan | null> {
    let input: unknown;
    try {
      if (step.type === 'ai') input = resolve(step.input, scope);
      else if (step.type === 'app') input = { repo: String(resolve(step.repo, scope)), ref: String(resolve(step.ref, scope)) };
      else if (step.type === 'fix') {
        input = {
          repo: String(resolve(step.repo, scope)),
          ref: String(resolve(step.ref, scope)),
          instruction: String(resolve(step.instruction, scope)).slice(0, 60_000),
          context: resolve(step.context, scope),
          onlyFilesIn: step.limits?.onlyFilesIn === undefined ? null : normalizeOnlyFiles(resolve(step.limits.onlyFilesIn, scope)),
        };
      }
      else {
        // The app an earlier step started: its address is only known now.
        const appHost = step.app ? (scope.steps[step.app]?.output as { hostKey?: unknown } | undefined)?.hostKey : undefined;
        if (step.app && typeof appHost !== 'string') throw new TemplateError();
        input = { url: String(resolve(step.url, scope)), checks: toChecks(resolve(step.checks, scope)), appHost: appHost ?? null };
      }
    } catch (err) {
      await this.failStep(tx, run, step.id, err instanceof TemplateError ? 'template_unresolved' : 'input_resolution_failed');
      return null;
    }
    await this.setStep(tx, run.id, step.id, {
      status: 'running',
      attempts: row.attempts + 1,
      lease_until: this.leaseUntil(),
      started_at: new Date(),
      executed_by: run.run_as,
      error_type: null,
      resume_at: null,
    });
    await this.setRun(tx, run.id, 'running', null);
    const version = await this.d.flows.getVersion(tx, run.flow_version_id);
    return { builtin: true, runId: run.id, step, executorId: run.run_as, input, versionId: run.flow_version_id, definition: version!.definition, dry: run.dry };
  }

  /** Ask an AI, or check pages with an AI-guided browser, then record the result like any step. */
  private async executeBuiltin(plan: BuiltinPlan, heartbeat: () => Promise<void>): Promise<void> {
    const { runId, step, executorId } = plan;
    let output: unknown = null;
    let failure: { errorType: string; retryable: boolean } | null = null;
    /** What an AI answered when the step failed because its answer could not be read. */
    let aiAnswer: string | null = null;
    /** What a failed fix or app step printed (install, build, tests), so "installing the project failed" can be read. */
    let logTail: string | null = null;
    const say = narrator(this.db, this.d.cipher, runId, step.id);
    say.say(`Now on step "${stepName(step)}": ${BUILTIN_DOING[step.type]}`);
    // An app or fix step's code sandbox slot (sandbox-housekeeping.ts), held while it builds and tests.
    let slot: number | null = null;
    const keepAlive = async () => {
      await heartbeat();
      await this.db.query(`UPDATE run_steps SET lease_until = $3 WHERE run_id = $1 AND step_id = $2 AND status = 'running'`, [runId, step.id, this.leaseUntil(30 * 60_000)]);
      if (slot !== null) await renewSlot(this.db, slot, runId, step.id);
    };
    try {
      await keepAlive();
      // App and fix steps: the runner's token clones the repository; secretEnv is read now.
      let token: string | null = null;
      let secrets: Record<string, string> = {};
      let network: StepNetwork | undefined;
      if (step.type === 'app' || step.type === 'fix') {
        if (!this.d.apps) throw new StepError('app_unavailable');
        // All code sandboxes busy: the run waits its turn (below) instead of holding a run slot.
        slot = await acquireSlot(this.db, this.d.config.codeSandboxes ?? 1, runId, step.id);
        if (slot === null) throw new StepError(SANDBOX_BUSY);
        // Its destinations, checked again against the team's ceiling as it is now (it may have narrowed since approval).
        network = await this.stepNetwork(runId, step);
        token = step.credential ? await this.d.secrets(executorId, step.credential) : null;
        if (step.credential && !token) throw new StepError('missing_credential');
        secrets = await this.secretEnv(runId, executorId, step);
        if (step.type === 'app') {
          const { repo, ref } = plan.input as { repo: string; ref: string };
          output = await this.d.apps.start({ runId, step, repo, ref, token, keepAlive, secrets, network });
          throw new Done();
        }
      }
      const chosen = await providerFor(step, {
        organization: this.d.ai ?? null,
        // The runner's own key, never a team's: the AI acts for the person running the Flow.
        secret: (service) => this.d.secrets(executorId, service),
        runnerProvider: this.d.runnerAi,
      });
      // A runner step without the runner's key falls back to the organization's AI.
      const orgAi = chosen === this.d.ai;
      // The runner's own key is counted too (never limited); the organization's is already metered.
      let provider: AiProvider = orgAi ? chosen : new MeteredProvider(this.db, chosen, 'runner');
      // The organization's AI answers with the run's model (its own, its version's lock, else the organization's now);
      // a model that is gone falls back to the organization's, and approvers are told.
      const orgModel = this.d.aiModel?.() ?? null;
      if (orgAi && orgModel) {
        const wanted = await runModel(this.db, runId, orgModel);
        if (wanted !== orgModel) {
          provider = withFallback(pinTo(provider, wanted), provider, () => {
            say.say(`The model ${wanted} is not available: using the organization's model ${orgModel} instead`);
            void this.teamOfRun(runId).then((team) => notifyApprovers(this.db, team, '', 'pinned_model_unavailable', { runId, stepId: step.id, flowVersionId: plan.versionId })).catch(() => undefined);
          });
        }
      }
      // Each call first checks the run's cost cap, so a browse step stops as soon as it is reached.
      if (!plan.dry) provider = this.capped(provider, runId, plan.definition, step);
      const aiCtx = { memberId: executorId, teamId: await this.teamOfRun(runId), runId, stepId: step.id, purpose: 'step' as const };
      // What the AI does as it works (a search, a file it reads, a command it runs) goes to the commentary.
      const aiWork = <T>(ctx: typeof aiCtx, fn: () => Promise<T>) =>
        withProgress(
          (p) => void (p.detail && say.say(`AI: ${p.detail}`)),
          () => {
            progress(step.type, 0);
            return aiContext(ctx, fn);
          },
        );
      if (step.type === 'ai') output = await aiWork(aiCtx, () => runAiStep(withFlowInstructions(step, plan.definition.instructions), plan.input, provider));
      else if (step.type === 'fix') {
        output = await aiWork(aiCtx, () => runFixStep(step, plan.input as Parameters<typeof runFixStep>[1], { apps: this.d.apps!, provider, runId, token, secrets, network, keepAlive }));
      } else {
        const { url, checks, appHost } = plan.input as { url: string; checks: Check[]; appHost: string | null };
        if (appHost && !this.d.apps?.isRunning(runId, appHost)) throw new StepError('app_not_running');
        // The app's address is reached over plain http, on a private address, by this run's browser only.
        const extra = appHost ? [appHost] : [];
        output = await aiWork(aiCtx, () => runBrowseStep(appHost ? { ...step, hosts: [...step.hosts, appHost] } : step, url, checks, provider, {
          browser: this.d.browser,
          plainHttp: [...this.d.config.insecureHttpHosts, ...extra],
          allowPrivate: [...this.d.config.internalHosts, ...extra],
          keepAlive,
          live: this.d.live
            ? { hub: this.d.live, owner: executorId, runId, stepId: step.id, askMember: () => notify(this.db, executorId, 'input_needed', { runId, stepId: step.id }) }
            : undefined,
        }));
      }
    } catch (err) {
      // Another worker took this job after our lease ran out (it owns the step now), or the run ended: record nothing.
      if (err instanceof LeaseLost || err instanceof RunEnded) throw err;
      if (!(err instanceof Done)) {
        failure = err instanceof StepError ? { errorType: err.code, retryable: err.retryable } : { errorType: errorType(err), retryable: false };
        if (err instanceof StepError && err.raw) aiAnswer = err.raw.slice(0, 1500);
        const tail = (err as { logTail?: unknown }).logTail;
        if (typeof tail === 'string' && tail.trim()) logTail = tail.slice(-LOG_KEPT);
      }
    } finally {
      // An app keeps running for the run's browse steps; only its install and build count against the slots.
      if (slot !== null) await releaseSlot(this.db, slot, runId, step.id).catch(() => undefined);
    }
    // An answer that could not be read is said as it came: the error code alone never shows what the model wrote.
    if (aiAnswer) say.say(`What the AI answered: ${aiAnswer}`);
    // The last lines of what it printed, so the Live panel shows why it failed instead of only that it did.
    if (logTail) for (const line of logTail.trimEnd().split('\n').slice(-LOG_LINES_SAID)) say.say(line.slice(0, 500));
    say.say(failure ? (failure.errorType === SANDBOX_BUSY ? 'Waiting for a free code sandbox' : `Step "${stepName(step)}" failed: ${failure.errorType.replace(/_/g, ' ')}`) : `Step "${stepName(step)}" done`);
    await say.flush();
    await withTx(this.db, async (tx) => {
      const run = (await tx.query<RunRow>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0]!;
      const row = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 AND step_id = $2 FOR UPDATE`, [runId, step.id])).rows[0]!;
      if (row.status !== 'running') return; // cancelled meanwhile
      await tx.query(`UPDATE run_steps SET log_enc = $3 WHERE run_id = $1 AND step_id = $2`, [
        runId,
        step.id,
        logTail ? this.d.cipher.encrypt(logTail, this.aadLog(runId, step.id)) : null,
      ]);
      if (!failure) {
        await this.setStep(tx, runId, step.id, {
          status: 'succeeded',
          output_enc: this.d.cipher.encryptJson(output, this.aadOutput(runId, step.id)),
          lease_until: null,
          finished_at: new Date(),
        });
        await audit(tx, { actorId: executorId, action: 'step.succeeded', subjectType: 'step', subjectId: `${runId}:${step.id}`, outcome: 'ok' });
        if (run.status === 'running') await enqueue(tx, 'advance', { runId });
        return;
      }
      if (failure.errorType === SANDBOX_BUSY) {
        // Not an attempt: the step starts again once a slot is free.
        await this.setStep(tx, runId, step.id, { status: 'pending', error_type: null, lease_until: null, attempts: Math.max(0, row.attempts - 1), resume_at: new Date(Date.now() + SLOT_RETRY_MS) });
        await this.setRun(tx, runId, 'waiting', SANDBOX_BUSY);
        await enqueue(tx, 'advance', { runId }, new Date(Date.now() + SLOT_RETRY_MS));
        return;
      }
      if (failure.errorType === COST_CAP) {
        const cap = await capReached(tx, runId, plan.definition, step);
        if (cap) {
          await this.pauseForCost(tx, run, cap);
          return;
        }
        // Someone allowed more meanwhile: ask again.
        await this.setStep(tx, runId, step.id, { status: 'pending', error_type: null, lease_until: null });
        await enqueue(tx, 'advance', { runId });
        return;
      }
      if (failure.errorType === 'pinned_model_unavailable') {
        // The model this version was approved with is gone: its approvers see it under Model changes.
        await notifyApprovers(tx, await this.teamOfRun(runId, tx), '', 'pinned_model_unavailable', { runId, stepId: step.id, flowVersionId: plan.versionId });
      }
      if (failure.retryable && row.attempts < 1 + this.d.config.retry.autoRetries) {
        const resumeAt = new Date(Date.now() + this.d.config.retry.backoffMs * 2 ** (row.attempts - 1));
        await this.setStep(tx, runId, step.id, { status: 'pending', error_type: failure.errorType, lease_until: null, resume_at: resumeAt });
        await this.setRun(tx, runId, 'waiting', 'retry');
        await enqueue(tx, 'advance', { runId }, resumeAt);
        return;
      }
      await this.failStep(tx, run, step.id, failure.errorType);
    });
  }

  /**
   * An app or fix step's destinations per phase, each inside the team's ceiling now (else
   * egress_not_allowed: an admin narrowed the list since the Flow was approved), and the phases each
   * secret env var reaches.
   */
  private async stepNetwork(runId: string, step: AppStep | FixStep): Promise<StepNetwork> {
    const ceiling = await egressCeiling(this.db, await this.teamOfRun(runId));
    if (judgeEgress(step, ceiling).some((d) => !d.allowed)) throw new StepError('egress_not_allowed');
    const egress = Object.fromEntries(Object.entries(step.egress ?? {}).map(([phase, list]) => [phase, parseDestinations((list as string[] | undefined) ?? []).destinations]));
    const secretPhasesOf = Object.fromEntries(Object.entries(step.secretEnv ?? {}).map(([name, v]) => [name, secretPhases(step.type, v)]));
    return { egress, secretPhases: secretPhasesOf };
  }

  /**
   * An app or fix step's secret env vars (secretEnv: name -> credential service): the team's stored
   * credential for the service when it has one, else the runner's own from their vault. Missing ->
   * missing_credential, as for an action. Each use is audited with the variable's name, never its value.
   */
  private async secretEnv(runId: string, executorId: string, step: AppStep | FixStep): Promise<Record<string, string>> {
    const entries = Object.entries(step.secretEnv ?? {}).map(([name, v]) => [name, secretService(v)] as const);
    if (!entries.length) return {};
    const teamId = await this.teamOfRun(runId);
    const out: Record<string, string> = {};
    for (const [name, service] of entries) {
      const value = (await teamSecret(this.db, this.d.cipher, teamId, service)) ?? (await this.d.secrets(executorId, service));
      if (!value) throw new StepError('missing_credential');
      out[name] = value;
    }
    for (const name of Object.keys(out)) {
      await audit(this.db, { actorId: executorId, action: 'app.secret_env_used', subjectType: 'step', subjectId: `${runId}:${step.id}`, outcome: 'ok', relatedId: name });
    }
    return out;
  }

  /**
   * The evidence gate (autoApproveWhen): a step that waits for a sign-off only because a fix step's
   * change reaches it goes on without a person when Dittoly's own verdict on that change,
   * steps.<fix>.output.autoPushAllowed, is true. Text from any other model-written source reaching
   * the step still needs a person, unless that source was skipped by its condition in this run (it wrote nothing). The release is recorded like a sign-off (by nobody, with the
   * evidence), audited and shown on the run page and in evidence packs.
   */
  private async releaseByEvidence(tx: Tx, run: RunRow, step: Step, scope: TemplateScope): Promise<boolean> {
    if (step.type !== 'action' || !step.autoApproveWhen) return false;
    const fixId = AUTO_APPROVE.exec(step.autoApproveWhen)?.[1];
    const version = await this.d.flows.getVersion(tx, run.flow_version_id);
    if (!fixId || version!.definition.steps.find((s) => s.id === fixId)?.type !== 'fix') return false;
    const { paths } = await this.d.flows.injection(tx, version!.definition, 0, { inputsFromModel: run.inputs_from_model, inputsExternal: Boolean(run.endpoint_id || run.trigger_id || run.watch_id) });
    const skipped = new Set((await tx.query<{ step_id: string }>(`SELECT step_id FROM run_steps WHERE run_id = $1 AND status = 'skipped' AND error_type IS NULL`, [run.id])).rows.map((r) => r.step_id));
    if (paths.some((p) => p.sink === step.id && p.source !== fixId && !skipped.has(p.source) && needsSignOff(p.sourceKind, p.influence))) return false;
    const fix = scope.steps[fixId]?.output as FixOutput | undefined;
    if (lookup(scope, step.autoApproveWhen) !== true || !fix) return false;
    const evidence = {
      fixStep: fixId,
      rule: step.autoApproveWhen,
      confidence: fix.confidence?.score ?? null,
      level: fix.confidence?.level ?? null,
      verified: fix.verified ?? null,
      limitsOk: fix.limits?.ok ?? null,
      filesChanged: fix.change?.filesChanged ?? null,
    };
    await tx.query(`INSERT INTO gate_decisions (run_id, step_id, decided_by, decision, auto_evidence) VALUES ($1, $2, NULL, 'approved', $3)`, [run.id, step.id, JSON.stringify(evidence)]);
    await audit(tx, {
      actorId: null,
      action: 'guard.auto_released',
      subjectType: 'step',
      subjectId: `${run.id}:${step.id}`,
      outcome: 'ok',
      errorType: `evidence_confidence_${evidence.confidence ?? 'unknown'}`,
      relatedId: `${run.id}:${fixId}`,
    });
    log.info('guard_auto_released', { runId: run.id, stepId: step.id });
    return true;
  }

  /** A provider that refuses a call once the run reached its cost cap (the step then waits for more to be allowed). */
  private capped(provider: AiProvider, runId: string, definition: FlowDefinition, step: Step): AiProvider {
    return {
      id: provider.id,
      generateJson: async (req) => {
        if (await capReached(this.db, runId, definition, step)) throw new AiError(COST_CAP);
        return provider.generateJson(req);
      },
    };
  }

  /** The run reached its cost cap: the step waits, like for a sign-off, and its owner and the team's approvers hear of it. */
  private async pauseForCost(tx: Tx, run: RunRow, cap: CapReached): Promise<void> {
    await this.setStep(tx, run.id, cap.stepId, { status: 'waiting', error_type: COST_CAP, lease_until: null, started_at: new Date() });
    await this.setRun(tx, run.id, 'waiting', 'cost_cap');
    await audit(tx, { actorId: null, action: 'run.cost_cap_reached', subjectType: 'step', subjectId: `${run.id}:${cap.stepId}`, outcome: 'ok', errorType: `${cap.scope}_cost_cap` });
    await notify(tx, run.run_as, 'cost_cap_reached', { runId: run.id, stepId: cap.stepId });
    await notifyApprovers(tx, await this.teamOfRun(run.id, tx), run.run_as, 'cost_cap_reached', { runId: run.id, stepId: cap.stepId });
    log.info('run_cost_cap_reached', { runId: run.id, stepId: cap.stepId });
    // Runs of one Flow reaching their cap again and again is a spend spike (src/governance/auto-stop.ts).
    const flowId = (await this.d.flows.getVersion(tx, run.flow_version_id))!.flowId;
    await noteCostCap(tx, { flowId, runId: run.id });
  }

  /** Who may let a run spend more, or end it at its cost cap: its owner, or an approver of its team. */
  private async assertCostDecider(tx: Tx, run: RunRow, actor: Member): Promise<void> {
    if (run.run_as === actor.id) return;
    if (!canApprove(actor)) throw forbidden('owner_or_approver_only');
    await approvalAuthority(tx, actor, await this.teamOfRun(run.id, tx), '');
  }

  /** Allow a run waiting at its cost cap to spend more (tokens and/or money); it goes on at once. */
  async allowMoreSpend(runId: string, actor: Member, more: { tokens?: number | undefined; amount?: number | undefined }): Promise<void> {
    if (!more.tokens && !more.amount) throw badRequest('nothing_allowed');
    await withTx(this.db, async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (run.status !== 'waiting' || run.wait_reason !== 'cost_cap') throw conflict('not_waiting_for_cost_cap');
      await this.assertCostDecider(tx, run, actor);
      await tx.query(`INSERT INTO run_cost_allowances (run_id, tokens, amount, allowed_by) VALUES ($1, $2, $3, $4)`, [runId, more.tokens ?? 0, more.amount ?? 0, actor.id]);
      await this.setRun(tx, runId, 'running', null);
      await audit(tx, { actorId: actor.id, action: 'run.cost_allowance_added', subjectType: 'run', subjectId: runId, outcome: 'ok' });
      await enqueue(tx, 'advance', { runId });
    });
  }

  private async planAction(tx: Tx, run: RunRow, row: StepRow, step: ActionStep, scope: TemplateScope): Promise<ExecutePlan | null> {
    const module = await this.moduleFor(tx, step);
    const action = module.manifest.actions.find((a) => a.name === step.action)!;
    // A dry run never changes anything and never asks a teammate.
    if (run.dry && (action.effect === 'write' || step.delegateTo)) {
      await this.skipDry(tx, run.id, step.id, 'dry_run');
      await enqueue(tx, 'advance', { runId: run.id });
      return null;
    }
    let inputs: ResolvedInputs;
    try {
      inputs = this.resolveInputs(step, scope);
    } catch (err) {
      // In a dry run, a value that would have come from a skipped step is simply not there.
      if (run.dry && err instanceof TemplateError) {
        await this.skipDry(tx, run.id, step.id, 'dry_run_input_missing');
        await enqueue(tx, 'advance', { runId: run.id });
        return null;
      }
      await this.failStep(tx, run, step.id, err instanceof TemplateError ? 'template_unresolved' : 'input_resolution_failed');
      return null;
    }
    // What the action's own schema refused, field by field ("files.0.path: must match pattern ..."): "input
    // invalid" on its own leaves a person reading JSON next to a schema to guess which field it meant. The lines
    // name the field and the rule, never the value (src/runtime/manifest.ts).
    const problems = inputs.items.flatMap((i) => ajv.explain(action.input, i, `the action ${step.action}`));
    if (problems.length) {
      await this.failStep(tx, run, step.id, 'input_invalid', [...new Set(problems)].slice(0, 10).join('; '));
      return null;
    }

    if (step.delegateTo) {
      await this.openDelegation(tx, run, step, module, inputs, run.run_as, step.delegateTo);
      return null;
    }

    // Credentials the team shares must be stored; the rest come from the member's own vault.
    const teamId = await this.teamOfRun(run.id, tx);
    const { personal, team } = await this.splitServices(tx, teamId, module.name, servicesFor(module.manifest, action.name));
    if (team.length) {
      const stored = await teamStoredServices(tx, teamId);
      if (team.some((s) => !stored.has(s))) {
        await this.failStep(tx, run, step.id, 'team_credential_missing');
        return null;
      }
    }
    const missing = await this.d.vault.has(run.run_as, personal, tx);
    if (missing.length > 0) {
      // The member lacks access. They can ask a teammate to run this one action (delegation).
      await this.failStep(tx, run, step.id, 'missing_credential');
      return null;
    }
    if (team.length) {
      // Both are recorded: the member the step runs as, and that it used the team's shared access.
      await audit(tx, { actorId: run.run_as, action: 'credential.team_used', subjectType: 'step', subjectId: `${run.id}:${step.id}`, outcome: 'ok', relatedId: teamId });
    }
    return this.markRunning(tx, run, row, step, module, action, run.run_as, inputs, null);
  }

  private async markRunning(
    tx: Tx,
    run: RunRow,
    row: StepRow,
    step: ActionStep,
    module: ModuleVersion,
    action: ManifestAction,
    executorId: string,
    inputs: ResolvedInputs,
    delegationId: string | null,
  ): Promise<ExecutePlan> {
    const done = row.progress_enc
      ? this.d.cipher.decryptJson<Record<string, unknown>>(row.progress_enc, this.aadProgress(run.id, row.step_id))
      : {};
    await this.setStep(tx, run.id, step.id, {
      status: 'running',
      attempts: row.attempts + 1,
      lease_until: this.leaseUntil(),
      started_at: new Date(),
      executed_by: executorId,
      error_type: null,
      resume_at: null,
    });
    await this.setRun(tx, run.id, 'running', null);
    return { runId: run.id, step, module, action, executorId, inputs, delegationId, done, settings: await this.settingsFor(tx, run, step) };
  }

  /**
   * What the module is told to work with (the Jira site, say): the Flow's "moduleSettings" with the step's own on
   * top, templates resolved against this run. Modules keep no configuration; the Flow gives it. A value that cannot
   * be resolved is left out, so the step stops with module_settings_missing instead of calling the wrong place.
   */
  private async settingsFor(tx: Tx, run: RunRow, step: ActionStep): Promise<Record<string, string>> {
    const version = await this.d.flows.getVersion(tx, run.flow_version_id);
    const raw = version ? settingsOf(version.definition, step) : {};
    if (!Object.keys(raw).length) return {};
    const steps = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [run.id])).rows;
    const scope = this.scope(run, steps);
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(raw)) {
      try {
        const v = resolve(value, scope);
        if (v !== null && v !== undefined && String(v) !== '') out[id] = String(v);
      } catch {
        // Unresolved: treated as not given.
      }
    }
    return out;
  }

  private leaseUntil(ms = (this.d.actionTimeoutMs ?? 60_000) + 30_000): Date {
    return new Date(Date.now() + ms);
  }

  private resolveInputs(step: ActionStep, scope: TemplateScope): ResolvedInputs {
    if (!step.forEach) return { forEach: false, items: [resolve(step.input, scope)] };
    const list = resolve(step.forEach, scope);
    if (!Array.isArray(list)) throw new TemplateError();
    if (list.length > 100) throw new TemplateError();
    return { forEach: true, items: list.map((item) => resolve(step.input, { ...scope, item })) };
  }

  private async moduleFor(tx: Tx, step: ActionStep): Promise<ModuleVersion> {
    const mods = await this.d.flows.pinnedModules(tx, { steps: [step] } as FlowDefinition);
    return mods.get(step.module)!;
  }

  /** A step was left 'running' by a worker that died. */
  private async recoverCrashedStep(tx: Tx, run: RunRow, row: StepRow, step: ActionStep): Promise<ExecutePlan | null> {
    const module = await this.moduleFor(tx, step);
    const action = module.manifest.actions.find((a) => a.name === step.action)!;
    log.warn('step_recovered_after_crash', { runId: run.id, stepId: step.id, attempt: row.attempts });
    if (action.effect === 'write' && !action.idempotent) {
      // We cannot know whether the change reached the app. Never repeat it blindly (an idempotent action finds its own earlier change).
      await this.failStep(tx, run, step.id, 'uncertain_outcome');
      return null;
    }
    if (row.attempts >= 1 + this.d.config.retry.autoRetries) {
      await this.failStep(tx, run, step.id, 'worker_crashed');
      return null;
    }
    await this.setStep(tx, run.id, step.id, { status: 'pending', lease_until: null });
    const fresh = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 AND step_id = $2`, [run.id, step.id])).rows[0]!;
    const steps = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [run.id])).rows;
    const scope = this.scope(run, steps);
    const open = await this.openDelegationFor(tx, run.id, step.id, ['approved']);
    if (open) return this.planDelegated(tx, run, fresh, step, open);
    return this.planAction(tx, run, fresh, step, scope);
  }

  private async checkWaiting(
    tx: Tx,
    run: RunRow,
    row: StepRow,
    step: Step,
  ): Promise<ExecutePlan | null | 'continue'> {
    if (step.type === 'approval') {
      const d = await tx.query<{ decision: string }>(`SELECT decision FROM gate_decisions WHERE run_id = $1 AND step_id = $2`, [
        run.id,
        step.id,
      ]);
      const decision = d.rows[0]?.decision;
      if (!decision) return null;
      if (decision === 'approved') {
        await this.setStep(tx, run.id, step.id, { status: 'succeeded', finished_at: new Date() });
        return 'continue';
      }
      await this.setStep(tx, run.id, step.id, { status: 'failed', error_type: 'approval_rejected', finished_at: new Date() });
      await this.finishRun(tx, run, 'failed');
      return null;
    }
    if (step.type === 'input') return null; // answered through submitInput, which completes the step
    if (step.type === 'flow') {
      const kids = (await tx.query<{ key: string; status: string; result_enc: string | null; child_run_id: string }>(
        `SELECT key, status, result_enc, child_run_id FROM run_children WHERE parent_run_id = $1 AND step_id = $2`,
        [run.id, step.id],
      )).rows;
      if (kids.some((k) => !['succeeded', 'failed', 'cancelled'].includes(k.status))) return null;
      if (kids.length === step.runs.length && kids.every((k) => k.status === 'succeeded')) {
        const output = Object.fromEntries(kids.map((k) => [k.key, k.result_enc ? this.d.cipher.decryptJson(k.result_enc, childAad(k.child_run_id)) : null]));
        const outputEnc = this.d.cipher.encryptJson(output, this.aadOutput(run.id, step.id));
        await this.setStep(tx, run.id, step.id, { status: 'succeeded', output_enc: outputEnc, finished_at: new Date() });
        await this.setRun(tx, run.id, 'running', null);
        // Later steps in this same pass read it from the rows already loaded.
        row.status = 'succeeded';
        row.output_enc = outputEnc;
        return 'continue';
      }
      await this.failStep(tx, run, step.id, 'child_flow_failed');
      return null;
    }
    if (step.type === 'delay') {
      if (row.resume_at && row.resume_at <= new Date()) {
        await this.setStep(tx, run.id, step.id, { status: 'succeeded', finished_at: new Date() });
        return 'continue';
      }
      return null;
    }
    // Action step waiting on a teammate.
    const pending = await this.openDelegationFor(tx, run.id, step.id, ['pending']);
    if (pending) {
      if (pending.expires_at <= new Date()) {
        await tx.query(`UPDATE delegations SET status = 'expired', inputs_enc = NULL WHERE id = $1`, [pending.id]);
        await audit(tx, {
          actorId: null,
          action: 'delegation.expired',
          subjectType: 'delegation',
          subjectId: pending.id,
          outcome: 'failed',
          errorType: 'delegation_expired',
        });
        await this.failStep(tx, run, step.id, 'delegation_expired');
      }
      return null;
    }
    const approved = await this.openDelegationFor(tx, run.id, step.id, ['approved']);
    if (approved) return this.planDelegated(tx, run, row, step as ActionStep, approved);
    return null;
  }

  private async planDelegated(tx: Tx, run: RunRow, row: StepRow, step: ActionStep, del: DelegationRow): Promise<ExecutePlan | null> {
    const module = await this.d.flows.pinnedModules(tx, { steps: [step] } as FlowDefinition).then((m) => m.get(step.module)!);
    const action = module.manifest.actions.find((a) => a.name === step.action)!;
    if (!del.inputs_enc) {
      await this.failStep(tx, run, step.id, 'delegation_inputs_missing');
      return null;
    }
    const inputs = this.d.cipher.decryptJson<ResolvedInputs>(del.inputs_enc, this.aadDelegation(del.id));
    // The approved request cannot change: re-check it against the hash recorded at request time.
    if (this.delegationHash(del.run_id, del.step_id, del.module_version_id, del.action, inputs) !== del.request_hash) {
      await this.failStep(tx, run, step.id, 'delegation_tampered');
      return null;
    }
    return this.markRunning(tx, run, row, step, module, action, del.delegate_id, inputs, del.id);
  }

  // ---------------------------------------------------------------- execute

  private async execute(plan: ExecutePlan, heartbeat: () => Promise<void>): Promise<void> {
    const { runId, step, module, action, executorId } = plan;
    const outputs: Record<string, unknown> = { ...plan.done };
    let failure: { errorType: string; retryable: boolean; violation: boolean } | null = null;

    // What the module works with comes from the Flow (plan.settings): a module keeps no configuration of its own.
    const teamId = await this.teamOfRun(runId);
    const resolved = resolveManifest(module.manifest, plan.settings);
    const secretFor = await this.secretResolver(teamId, module.name, executorId);
    // A host the Flow asked the person for when starting the run is checked here: against the module's reviewed
    // pattern, and against the organization's allowed hosts. Either way nothing is sent.
    for (const st of module.manifest.settings ?? []) {
      const value = plan.settings[st.id];
      if (st.type !== 'host' || !value) continue;
      try {
        if (!hostMatches(st.pattern, value)) throw new Error('pattern');
        await checkAllowedHost(this.db, value);
      } catch {
        failure = { errorType: 'host_not_allowed', retryable: false, violation: true };
      }
    }
    if (!failure && resolved.missing.length > 0) failure = { errorType: 'module_settings_missing', retryable: false, violation: false };

    // What the step called and how each call answered (the broker tells: method, host and path, status, and for a
    // refused call the app's reason and the query and body sent; never a header), kept when it fails so the person sees why.
    const calls: string[] = [];
    const say = narrator(this.db, this.d.cipher, runId, step.id);
    say.say(`Now on step "${stepName(step)}": ${module.name} ${action.name}${plan.inputs.forEach ? ` for ${plan.inputs.items.length} item(s)` : ''}`);
    for (const [i, input] of plan.inputs.items.entries()) {
      if (failure) break;
      if (Object.hasOwn(outputs, String(i))) continue; // already done in an earlier attempt
      const broker = new Broker({
        manifest: resolved.manifest,
        action: action.name,
        resolveSecret: secretFor,
        insecureHttpHosts: this.d.config.insecureHttpHosts,
        internalHosts: this.d.config.internalHosts,
        fetchImpl: this.d.fetchImpl,
        onCall: (line) => {
          if (calls.length < 50) calls.push(line);
          say.say(`Calling ${line}`);
        },
        browser: this.d.browser,
        ...(this.d.live
          ? {
              live: {
                hub: this.d.live,
                owner: executorId,
                runId,
                stepId: step.id,
                keepAlive: async () => {
                  await heartbeat();
                  await this.db.query(`UPDATE run_steps SET lease_until = $3 WHERE run_id = $1 AND step_id = $2 AND status = 'running'`, [runId, step.id, this.leaseUntil()]);
                },
                askMember: () => notify(this.db, executorId, 'input_needed', { runId, stepId: step.id }),
              },
            }
          : {}),
      });
      // MCP modules call their remote server through the same broker; code modules run in the sandbox.
      const r =
        module.origin === 'mcp'
          ? await this.d.mcp.invoke({
              module,
              action: action.name,
              input,
              broker,
              timeoutMs: this.d.actionTimeoutMs,
              hosts: resolved.manifest.hosts,
              resolveSecret: secretFor,
            })
          : await this.d.runner.invoke({ code: module.code, action: action.name, input, broker, timeoutMs: this.d.actionTimeoutMs, settings: resolved.settings }).finally(() => broker.close());
      if (broker.violations.length > 0) {
        failure = { errorType: broker.violations[0]!, retryable: false, violation: true };
        break;
      }
      if (!r.ok) {
        // A lost answer to a write: stop, unless the module says a repeat finds what the first call made.
        const uncertain = action.effect === 'write' && !action.idempotent && broker.writeSent && UNCERTAIN_ERRORS.has(r.errorType);
        failure = uncertain
          ? { errorType: 'uncertain_outcome', retryable: false, violation: false }
          : { errorType: r.errorType, retryable: r.retryable, violation: false };
        break;
      }
      if (!ajv.validate(action.output, r.output)) {
        failure = { errorType: 'output_schema_mismatch', retryable: false, violation: false };
        break;
      }
      outputs[String(i)] = r.output;
      // What reverses this write, if its module declares that (kept for the undo window).
      await recordUndo(this.db, this.d.cipher, { module, action, input, output: r.output, memberId: executorId, teamId, runId, stepId: step.id, item: i }).catch((err) =>
        log.error('undo_record_failed', { runId, stepId: step.id, errorType: err instanceof AppError ? err.code : 'internal' }),
      );
      if (plan.inputs.forEach) {
        // Record each finished item so a retry never repeats it.
        await this.db.query(`UPDATE run_steps SET progress_enc = $3, lease_until = $4 WHERE run_id = $1 AND step_id = $2`, [
          runId,
          step.id,
          this.d.cipher.encryptJson(outputs, this.aadProgress(runId, step.id)),
          this.leaseUntil(),
        ]);
        await heartbeat();
      }
    }

    say.say(failure ? `Step "${stepName(step)}" failed: ${failure.errorType.replace(/_/g, ' ')}` : `Step "${stepName(step)}" done`);
    await say.flush();

    // Outcome only (no data), for drift detection.
    await recordCall(this.db, { module: module.name, version: module.version, action: action.name, ok: !failure, errorType: failure?.errorType ?? null }).catch(() => undefined);

    await withTx(this.db, async (tx) => {
      const run = (await tx.query<RunRow>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0]!;
      const row = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 AND step_id = $2 FOR UPDATE`, [runId, step.id]))
        .rows[0]!;
      if (row.status !== 'running') return; // cancelled meanwhile
      await tx.query(`UPDATE run_steps SET calls_enc = $3 WHERE run_id = $1 AND step_id = $2`, [runId, step.id, failure && calls.length ? this.d.cipher.encryptJson(calls.slice(-12), this.aadCalls(runId, step.id)) : null]);

      if (!failure) {
        const output = plan.inputs.forEach ? plan.inputs.items.map((_, i) => outputs[String(i)]) : outputs['0'];
        await this.setStep(tx, runId, step.id, {
          status: 'succeeded',
          output_enc: this.d.cipher.encryptJson(output ?? null, this.aadOutput(runId, step.id)),
          progress_enc: null,
          lease_until: null,
          finished_at: new Date(),
        });
        if (plan.delegationId) await this.closeDelegation(tx, plan.delegationId, 'completed', executorId);
        await audit(tx, {
          actorId: executorId,
          action: plan.delegationId ? 'step.succeeded_delegated' : 'step.succeeded',
          subjectType: 'step',
          subjectId: `${runId}:${step.id}`,
          outcome: 'ok',
          relatedId: plan.delegationId ?? undefined,
        });
        if (run.status === 'running') await enqueue(tx, 'advance', { runId });
        return;
      }

      if (failure.violation) {
        await audit(tx, {
          actorId: executorId,
          action: 'module.violation_blocked',
          subjectType: 'module',
          subjectId: module.id,
          outcome: 'denied',
          errorType: failure.errorType,
          relatedId: runId,
        });
        // Repeated refused calls stop the Flow (and the agent that started the run); dry runs never count.
        if (!run.dry) {
          const version = (await this.d.flows.getVersion(tx, run.flow_version_id))!;
          await noteBlockedCall(tx, { flowId: version.flowId, agentId: run.mcp_token_id, runId, code: failure.errorType, kind: 'violation' }, version.definition);
        }
      }
      const autoRetry = failure.retryable && row.attempts < 1 + this.d.config.retry.autoRetries;
      if (autoRetry) {
        const delay = this.d.config.retry.backoffMs * 2 ** (row.attempts - 1);
        const resumeAt = new Date(Date.now() + delay);
        await this.setStep(tx, runId, step.id, { status: 'pending', error_type: failure.errorType, lease_until: null, resume_at: resumeAt });
        await this.setRun(tx, runId, 'waiting', 'retry');
        await enqueue(tx, 'advance', { runId }, resumeAt);
        log.info('step_retry_scheduled', { runId, stepId: step.id, attempt: row.attempts, errorType: failure.errorType });
        return;
      }
      if (plan.delegationId) await this.closeDelegation(tx, plan.delegationId, 'failed', executorId);
      await this.failStep(tx, run, step.id, failure.errorType);
    });
  }

  // ---------------------------------------------------------------- state helpers

  private async skipDry(tx: Tx, runId: string, stepId: string, reason: 'dry_run' | 'dry_run_input_missing'): Promise<void> {
    await this.setStep(tx, runId, stepId, { status: 'skipped', error_type: reason, started_at: new Date(), finished_at: new Date() });
  }

  private async setStep(tx: Tx, runId: string, stepId: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    await tx.query(`UPDATE run_steps SET ${sets} WHERE run_id = $1 AND step_id = $2`, [runId, stepId, ...keys.map((k) => fields[k])]);
  }

  private async setRun(tx: Tx, runId: string, status: RunStatus, waitReason: string | null): Promise<void> {
    await tx.query(
      `UPDATE runs SET status = $2, wait_reason = $3, updated_at = now(),
         finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE finished_at END
       WHERE id = $1`,
      [runId, status, waitReason],
    );
  }

  /** Two automatic retries are used up (or the error is not retryable): pause and tell the member. */
  private async failStep(tx: Tx, run: RunRow, stepId: string, errorType: string, detail?: string): Promise<void> {
    await this.setStep(tx, run.id, stepId, {
      status: 'failed',
      error_type: errorType,
      lease_until: null,
      finished_at: new Date(),
      ...(detail ? { detail_enc: this.d.cipher.encrypt(detail.slice(0, 2000), this.aadDetail(run.id, stepId)) } : {}),
    });
    await this.setRun(tx, run.id, 'paused', errorType);
    await audit(tx, { actorId: null, action: 'run.paused', subjectType: 'run', subjectId: run.id, outcome: 'failed', errorType });
    await notify(tx, run.run_as, 'run_paused', { runId: run.id, stepId });
    log.warn('run_paused', { runId: run.id, stepId, errorType });
    // Many failures in a short time stop the Flow (src/governance/auto-stop.ts); dry runs never count.
    if (!run.dry) {
      const version = (await this.d.flows.getVersion(tx, run.flow_version_id))!;
      const step = version.definition.steps.find((s) => s.id === stepId);
      const module = step?.type === 'action' ? step.module.split('@')[0]! : null;
      await noteRunFailure(tx, { flowId: version.flowId, runId: run.id, errorType, module }, version.definition);
    }
  }

  /**
   * End a run. Statuses stay for the run screen. Inputs and step outputs are kept,
   * encrypted, for the organization's retention period so the people who ran it can
   * see the results, then maintenance deletes them; with a period of 0 they are
   * deleted now. Progress and delegation inputs are always deleted now.
   */
  private async finishRun(tx: Tx, run: RunRow, status: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    await tx.query(`UPDATE run_steps SET status = 'not_run' WHERE run_id = $1 AND status IN ('pending', 'waiting', 'running')`, [
      run.id,
    ]);
    await this.setRun(tx, run.id, status, null);
    // Follow-ups read this run's inputs and outputs, so they start before retention clears them.
    if (status !== 'cancelled' && !run.dry) await this.startFollowups(tx, run, status);
    // A child run hands its result to its Super Flow before retention clears it; the parent moves on.
    if (run.parent_run_id) await this.reportToParent(tx, run, status);
    // A Super Flow that ends stops the Flows it started.
    await this.cancelChildren(tx, run.id);
    // Apps this run started stop with it.
    void this.d.apps?.stopRun(run.id).catch(() => undefined);
    await sayNow(tx, this.d.cipher, run.id, null, status === 'succeeded' ? 'The run finished' : status === 'failed' ? 'The run failed' : 'The run was cancelled');
    const { days } = await getRetention(tx, this.d.config.mode);
    if (days > 0) {
      await tx.query(`UPDATE runs SET data_expires_at = now() + make_interval(days => $2) WHERE id = $1`, [run.id, days]);
      await tx.query(`UPDATE run_steps SET progress_enc = NULL WHERE run_id = $1`, [run.id]);
    } else {
      await tx.query(`UPDATE runs SET inputs_enc = NULL, data_expires_at = NULL WHERE id = $1`, [run.id]);
      await tx.query(`UPDATE run_steps SET output_enc = NULL, progress_enc = NULL, sign_off_enc = NULL, log_enc = NULL, detail_enc = NULL WHERE run_id = $1`, [run.id]);
      await tx.query(`UPDATE run_children SET result_enc = NULL WHERE parent_run_id = $1`, [run.id]);
      await tx.query(`DELETE FROM run_commentary WHERE run_id = $1`, [run.id]);
    }
    await tx.query(
      `UPDATE delegations SET inputs_enc = NULL,
         status = CASE WHEN status IN ('pending', 'approved') THEN 'cancelled' ELSE status END
       WHERE run_id = $1`,
      [run.id],
    );
    await audit(tx, { actorId: null, action: `run.${status}`, subjectType: 'run', subjectId: run.id, outcome: status === 'succeeded' ? 'ok' : 'failed' });
    if (status !== 'cancelled') await notify(tx, run.run_as, status === 'succeeded' ? 'run_succeeded' : 'run_failed', { runId: run.id });
    log.info('run_finished', { runId: run.id, status });
  }

  /**
   * Start every Flow a flow step lists, at once, as the run's own member. All or
   * nothing: if one cannot start, the ones already started are cancelled and the
   * step fails (the run pauses, like any failed step).
   */
  private async startChildren(tx: Tx, run: RunRow, step: FlowStep, scope: TemplateScope): Promise<boolean> {
    let depth = 0;
    for (let cur = run.parent_run_id; cur && depth <= MAX_FLOW_NESTING; depth++) {
      cur = (await tx.query<{ parent_run_id: string | null }>(`SELECT parent_run_id FROM runs WHERE id = $1`, [cur])).rows[0]?.parent_run_id ?? null;
    }
    if (depth >= MAX_FLOW_NESTING) {
      await this.failStep(tx, run, step.id, 'flow_nesting_too_deep');
      return false;
    }
    // A retry starts the children again.
    await tx.query(`DELETE FROM run_children WHERE parent_run_id = $1 AND step_id = $2`, [run.id, step.id]);
    const started: string[] = [];
    try {
      for (const r of step.runs) {
        const versionId = (await tx.query<{ id: string }>(`SELECT id FROM flow_versions WHERE flow_id = $1 AND version = $2`, [r.flow, r.version])).rows[0]?.id;
        if (!versionId) throw notFound('flow_version');
        const childId = randomUUID();
        await this.startRunIn(tx, childId, versionId, run.run_as, resolve(r.input, scope), { actorId: run.run_as, parentRunId: run.id, dry: run.dry });
        await tx.query(`INSERT INTO run_children (parent_run_id, step_id, key, child_run_id) VALUES ($1, $2, $3, $4)`, [run.id, step.id, r.id, childId]);
        started.push(childId);
      }
      return true;
    } catch (err) {
      const code = err instanceof AppError ? err.code : err instanceof TemplateError ? 'template_unresolved' : 'child_flow_failed';
      for (const id of started) {
        const child = (await tx.query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [id])).rows[0];
        if (child) await this.finishRun(tx, child, 'cancelled');
      }
      await this.failStep(tx, run, step.id, code);
      return false;
    }
  }

  /** A finished child run: keep what its Super Flow needs, and wake the Super Flow. */
  private async reportToParent(tx: Tx, run: RunRow, status: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    const steps = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [run.id])).rows;
    const outputs = Object.fromEntries(
      steps.filter((s) => s.status === 'succeeded' && s.output_enc).map((s) => [s.step_id, this.d.cipher.decryptJson(s.output_enc!, this.aadOutput(run.id, s.step_id))]),
    );
    const result = { runId: run.id, status, steps: outputs };
    const { rowCount } = await tx.query(`UPDATE run_children SET status = $2, result_enc = $3 WHERE child_run_id = $1`, [
      run.id,
      status,
      this.d.cipher.encryptJson(result, childAad(run.id)),
    ]);
    if (rowCount) await enqueue(tx, 'advance', { runId: run.parent_run_id! });
  }

  private async cancelChildren(tx: Tx, runId: string): Promise<void> {
    const { rows } = await tx.query<RunRow>(
      `SELECT r.* FROM run_children c JOIN runs r ON r.id = c.child_run_id
       WHERE c.parent_run_id = $1 AND r.status IN ('running', 'waiting', 'paused') FOR UPDATE OF r`,
      [runId],
    );
    for (const child of rows) await this.finishRun(tx, child, 'cancelled');
  }

  /**
   * Start the follow-up Flows the run's own member set up for this Flow. They run
   * as that member (never as someone else), with inputs from the finished run.
   * A follow-up that cannot start is turned off when it never could again, and
   * its owner is told; the finished run is not affected.
   */
  private async startFollowups(tx: Tx, run: RunRow, status: 'succeeded' | 'failed'): Promise<void> {
    const { rows } = await tx.query<{ id: string; target_version_id: string; inputs_enc: string }>(
      `SELECT f.id, f.target_version_id, f.inputs_enc FROM flow_followups f JOIN flow_versions v ON v.flow_id = f.source_flow_id
       WHERE v.id = $1 AND f.run_as = $2 AND f.enabled AND f.on_status IN ($3, 'finished') ORDER BY f.created_at`,
      [run.flow_version_id, run.run_as, status],
    );
    if (!rows.length) return;
    let depth = 0;
    for (let cur = run.followup_of; cur && depth < MAX_FOLLOWUP_DEPTH; depth++) {
      cur = (await tx.query<{ followup_of: string | null }>(`SELECT followup_of FROM runs WHERE id = $1`, [cur])).rows[0]?.followup_of ?? null;
    }
    if (depth >= MAX_FOLLOWUP_DEPTH) {
      await audit(tx, { actorId: null, action: 'followup.skipped', subjectType: 'run', subjectId: run.id, outcome: 'failed', errorType: 'followup_chain_too_deep' });
      return;
    }
    const steps = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1`, [run.id])).rows;
    const scope = this.scope(run, steps);
    for (const f of rows) {
      const runId = randomUUID();
      try {
        const inputs = resolve(this.d.cipher.decryptJson(f.inputs_enc, followupAad(f.id)), scope);
        // Step outputs of a Flow with an AI step carry what a model wrote into the next Flow's inputs.
        const fromModel = /\bsteps\./.test(JSON.stringify(this.d.cipher.decryptJson(f.inputs_enc, followupAad(f.id)))) && (await this.d.flows.injection(tx, (await this.d.flows.getVersion(tx, run.flow_version_id))!.definition)).model;
        await this.startRunIn(tx, runId, f.target_version_id, run.run_as, inputs, { actorId: run.run_as, followupOf: run.id, inputsFromModel: fromModel });
        await tx.query(`UPDATE flow_followups SET last_run_id = $2 WHERE id = $1`, [f.id, runId]);
      } catch (err) {
        const code = err instanceof AppError ? err.code : err instanceof TemplateError ? 'template_unresolved' : 'followup_failed';
        const permanent = code === 'flow_version_not_approved' || code === 'approval_hash_mismatch' || code === 'not_in_team';
        if (permanent) await tx.query(`UPDATE flow_followups SET enabled = false, disabled_reason = $2 WHERE id = $1`, [f.id, code]);
        await audit(tx, { actorId: null, action: 'followup.start_failed', subjectType: 'trigger', subjectId: f.id, outcome: 'failed', errorType: code, relatedId: run.id });
        await notify(tx, run.run_as, 'followup_failed', { runId: run.id });
      }
    }
  }

  // ---------------------------------------------------------------- member actions

  private async lockRun(tx: Tx, runId: string): Promise<RunRow> {
    const run = (await tx.query<RunRow>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0];
    if (!run) throw notFound('run');
    return run;
  }

  /** Manual retry after a pause, up to the limit the Flow's creator set. */
  async retry(runId: string, actor: Member): Promise<void> {
    await withTx(this.db, async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (run.run_as !== actor.id) throw forbidden();
      if (run.status !== 'paused') throw conflict('run_not_paused');
      const version = await this.d.flows.assertRunnable(tx, run.flow_version_id, { allowSuperseded: run.reads_only });
      if (run.manual_retries_used >= version.version.definition.retry.manualRetryLimit) throw conflict('retry_limit_reached');
      // A retry starts the run's writes again: the same rules as starting it (hours, runs per day).
      if (!run.dry) await checkRunStart(tx, run.run_as, version.version.definition, version.modules);
      await tx.query(`UPDATE runs SET manual_retries_used = manual_retries_used + 1 WHERE id = $1`, [runId]);
      await tx.query(
        `UPDATE run_steps SET status = 'pending', attempts = 0, error_type = NULL, resume_at = NULL, lease_until = NULL
         WHERE run_id = $1 AND status = 'failed'`,
        [runId],
      );
      await this.setRun(tx, runId, 'running', null);
      await audit(tx, { actorId: actor.id, action: 'run.retried', subjectType: 'run', subjectId: runId, outcome: 'ok' });
      await enqueue(tx, 'advance', { runId });
    });
  }

  async cancel(runId: string, actor: Member): Promise<void> {
    await withTx(this.db, async (tx) => {
      const run = await this.lockRun(tx, runId);
      // At its cost cap, an approver of its team may end it too.
      if (run.status === 'waiting' && run.wait_reason === 'cost_cap' && actor.role !== 'admin') await this.assertCostDecider(tx, run, actor);
      else if (run.run_as !== actor.id && actor.role !== 'admin') throw forbidden();
      if (TERMINAL_RUN.includes(run.status)) throw conflict('run_finished');
      await this.finishRun(tx, run, 'cancelled');
      await audit(tx, { actorId: actor.id, action: 'run.cancel_requested', subjectType: 'run', subjectId: runId, outcome: 'ok' });
    });
  }

  private async gateDecision(tx: Tx, runId: string, stepId: string): Promise<string | null> {
    const d = await tx.query<{ decision: string }>(`SELECT decision FROM gate_decisions WHERE run_id = $1 AND step_id = $2`, [runId, stepId]);
    return d.rows[0]?.decision ?? null;
  }

  /**
   * `valuesSha256`: the hash of the values the approver saw on a sign-off before a guarded step (runView's signOff);
   * when they changed meanwhile, the decision is refused, so a sign-off never covers values nobody saw.
   */
  async decideGate(runId: string, stepId: string, actor: Member, decision: 'approved' | 'rejected', valuesSha256?: string): Promise<void> {
    if (!canApprove(actor)) throw forbidden('approver_only');
    await withTx(this.db, async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (this.d.config.mode === 'shared' && run.run_as === actor.id) throw forbidden('cannot_approve_own_run');
      // A break-glass run is started by the grant holder acting as someone else: they do not sign it off either.
      if (this.d.config.mode === 'shared' && run.breakglass_id) {
        const holder = (await tx.query<{ member_id: string }>(`SELECT member_id FROM breakglass_grants WHERE id = $1`, [run.breakglass_id])).rows[0]?.member_id;
        if (holder === actor.id) throw forbidden('cannot_approve_own_run');
      }
      const row = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 AND step_id = $2`, [runId, stepId])).rows[0];
      if (!row) throw notFound('step');
      const version = await this.d.flows.getVersion(tx, run.flow_version_id);
      const guard = row.status === 'waiting' && row.error_type === GUARD;
      if ((version!.definition.steps[row.idx]?.type !== 'approval' || row.status !== 'waiting') && !guard) throw conflict('not_waiting_for_approval');
      if (guard && valuesSha256 !== undefined && valuesSha256 !== row.sign_off_sha256) throw conflict('sign_off_values_changed');
      // With the team rule, only the Flow's team (or a stand-in for one of its approvers) decides; an org admin may step in.
      const owner = this.d.config.mode === 'shared' ? run.run_as : '';
      const by = await approvalAuthority(tx, actor, await this.teamOfRun(runId, tx), owner);
      await tx.query(`INSERT INTO gate_decisions (run_id, step_id, decided_by, decision, on_behalf_of, outside_team, values_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        runId,
        stepId,
        actor.id,
        decision,
        by.onBehalfOf,
        by.outsideTeam,
        guard ? (row.sign_off_sha256 ?? null) : null,
      ]);
      await this.setRun(tx, runId, 'running', null);
      await audit(tx, {
        actorId: actor.id,
        action: `gate.${decision}${by.onBehalfOf ? '_as_standin' : by.outsideTeam ? '_outside_team' : ''}`,
        subjectType: 'step',
        subjectId: `${runId}:${stepId}`,
        outcome: 'ok',
        relatedId: by.onBehalfOf ?? undefined,
      });
      // Sign-offs on what the AI wrote, rejected again and again, stop the Flow: the AI may be being steered.
      if (guard && decision === 'rejected' && !run.dry) await noteRejectedSignOff(tx, { flowId: version!.flowId, runId, stepId }, version!.definition);
      await enqueue(tx, 'advance', { runId });
    });
  }

  /** A run its Flow's automatic stop paused, once someone resumed the Flow: it goes on, or is cancelled. */
  async settleAutoStopped(tx: Tx, runId: string, decision: 'continue' | 'cancel', actorId: string): Promise<void> {
    const run = await this.lockRun(tx, runId);
    if (run.status !== 'waiting' || run.wait_reason !== 'auto_stop') return;
    if (decision === 'cancel') {
      await this.finishRun(tx, run, 'cancelled');
      await audit(tx, { actorId, action: 'run.cancel_requested', subjectType: 'run', subjectId: runId, outcome: 'ok', errorType: 'flow_stopped' });
      return;
    }
    await tx.query(`UPDATE run_steps SET status = 'pending', error_type = NULL WHERE run_id = $1 AND status = 'waiting' AND error_type = $2`, [runId, AUTO_STOP]);
    await this.setRun(tx, runId, 'running', null);
    await audit(tx, { actorId, action: 'run.auto_stop_continued', subjectType: 'run', subjectId: runId, outcome: 'ok' });
    await enqueue(tx, 'advance', { runId });
  }

  /** The team of a run's Flow: its settings, credentials and notification channels apply. */
  async teamOfRun(runId: string, db: Queryable = this.db): Promise<string> {
    const r = await db.query<{ team_id: string }>(
      `SELECT f.team_id FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id WHERE r.id = $1`,
      [runId],
    );
    if (!r.rows[0]) throw notFound('run');
    return r.rows[0].team_id;
  }

  // ---------------------------------------------------------------- moving a paused run onto a newer version

  /**
   * The newest approved version of a run's Flow, when newer than the one it runs, and whether the run can go on there:
   * every step of its version is still there with the same type, the steps it finished come first in the same order
   * (so nothing new runs before them), and its inputs fit. Otherwise it can only start again on it.
   */
  private async newerVersion(db: Queryable, run: RunRow, steps: StepRow[]): Promise<{ version: FlowVersion; fits: boolean } | null> {
    const current = (await this.d.flows.getVersion(db, run.flow_version_id))!;
    const newest = (await db.query<{ id: string }>(
      `SELECT id FROM flow_versions WHERE flow_id = $1 AND status = 'approved' AND version > $2 ORDER BY version DESC LIMIT 1`,
      [current.flowId, current.version],
    )).rows[0];
    if (!newest) return null;
    const version = (await this.d.flows.getVersion(db, newest.id))!;
    const next = version.definition.steps;
    const byId = new Map(next.map((st, i) => [st.id, { st, i }]));
    const sameSteps = current.definition.steps.every((st) => byId.get(st.id)?.st.type === st.type);
    const done = steps.filter((r) => r.status === 'succeeded' || r.status === 'skipped').sort((a, b) => a.idx - b.idx);
    const doneFirst = done.every((r, i) => next[i]?.id === r.step_id);
    const inputs = run.inputs_enc ? this.d.cipher.decryptJson(run.inputs_enc, this.aadInputs(run.id)) : {};
    return { version, fits: sameSteps && doneFirst && ajv.validate(version.definition.inputs, inputs) };
  }

  /**
   * A paused run goes on with the newest approved version of its Flow (e.g. after its module was fixed and approved):
   * the steps it finished keep their results; the failed step and the rest run as the new version says. When the new
   * version does not fit (steps removed or reordered before what ran, inputs changed), it starts again there instead,
   * with the same inputs, and this run stays as it was. Returns the run that goes on.
   */
  async continueOnNewest(runId: string, actor: Member): Promise<{ runId: string; moved: boolean }> {
    const plan = await withTx(this.db, async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (run.run_as !== actor.id) throw forbidden();
      if (run.status !== 'paused') throw conflict('run_not_paused');
      const steps = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [runId])).rows;
      const newer = await this.newerVersion(tx, run, steps);
      if (!newer) throw conflict('no_newer_version');
      const inputs = run.inputs_enc ? this.d.cipher.decryptJson(run.inputs_enc, this.aadInputs(run.id)) : {};
      if (!newer.fits) return { restart: newer.version.id, inputs };
      // The same checks as starting it: approved with its pinned modules, not stopped, the organization's rules.
      const { modules } = await this.d.flows.assertRunnable(tx, newer.version.id);
      if (await isStopped(tx, 'flow', newer.version.flowId)) throw flowStopped();
      if (!run.dry) await checkRunStart(tx, run.run_as, newer.version.definition, modules);
      const rows = new Map(steps.map((r) => [r.step_id, r]));
      for (const [idx, step] of newer.version.definition.steps.entries()) {
        const row = rows.get(step.id);
        if (!row) await tx.query(`INSERT INTO run_steps (run_id, step_id, idx, status) VALUES ($1, $2, $3, 'pending')`, [runId, step.id, idx]);
        else if (row.status === 'succeeded' || row.status === 'skipped') await this.setStep(tx, runId, step.id, { idx });
        else await this.setStep(tx, runId, step.id, { idx, status: 'pending', attempts: 0, error_type: null, resume_at: null, lease_until: null, proposed_enc: null });
      }
      await tx.query(`UPDATE runs SET flow_version_id = $2, manual_retries_used = 0 WHERE id = $1`, [runId, newer.version.id]);
      await this.setRun(tx, runId, 'running', null);
      await audit(tx, { actorId: actor.id, action: 'run.moved_to_version', subjectType: 'run', subjectId: runId, outcome: 'ok', relatedId: run.flow_version_id });
      await enqueue(tx, 'advance', { runId });
      return null;
    });
    if (!plan) return { runId, moved: true };
    const started = await this.startRun(plan.restart, actor.id, plan.inputs, { actorId: actor.id });
    await audit(this.db, { actorId: actor.id, action: 'run.restarted_on_version', subjectType: 'run', subjectId: runId, outcome: 'ok', relatedId: started });
    return { runId: started, moved: false };
  }

  // ---------------------------------------------------------------- getting past a failed step

  /** Whether a step changes something outside the run (as for prompt-injection sinks): those need an approver to skip or fill in. */
  private async stepChanges(db: Queryable, step: Step): Promise<boolean> {
    if (step.type === 'action') {
      const module = (await this.d.flows.pinnedModules(db, { steps: [step] } as FlowDefinition)).get(step.module);
      return module?.manifest.actions.find((a) => a.name === step.action)?.effect !== 'read';
    }
    if (step.type === 'table') return step.op !== 'get' && step.op !== 'list';
    return step.type === 'app' || step.type === 'fix' || step.type === 'flow';
  }

  /** The output a person gives for a step must have the shape later steps expect (an action's output schema; a list for a forEach step). */
  private async checkGiven(db: Queryable, step: Step, output: unknown): Promise<void> {
    if (JSON.stringify(output ?? null).length > MAX_GIVEN_RESULT) throw badRequest('result_too_large');
    if (step.type !== 'action') return;
    const module = (await this.d.flows.pinnedModules(db, { steps: [step] } as FlowDefinition)).get(step.module);
    const schema = module?.manifest.actions.find((a) => a.name === step.action)?.output;
    if (!schema) return;
    const items = step.forEach ? output : [output];
    if (step.forEach && !Array.isArray(output)) throw new AppError('result_invalid', 400, 'This step runs once per item: give a list with one result per item.');
    const problems = (items as unknown[]).flatMap((o) => ajv.explain(schema, o, `the action ${step.action}`));
    if (problems.length) throw new AppError('result_invalid', 400, `The result does not have the shape the next steps expect: ${problems.slice(0, 3).join('; ')}`);
  }

  /**
   * The run's member gets past a failed step without retrying it: `skip` (later steps read its output as null) or
   * `result` (they continue with the output given here). A step that only reads is resolved at once; one that changes
   * data waits for an approver of the Flow's team (in local mode the single member may decide). Audited either way.
   */
  async resolveStep(runId: string, stepId: string, actor: Member, ask: { kind: 'skip' } | { kind: 'result'; output: unknown }): Promise<{ applied: boolean }> {
    return withTx(this.db, async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (run.run_as !== actor.id) throw forbidden();
      if (run.status !== 'paused') throw conflict('run_not_paused');
      const row = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 AND step_id = $2`, [runId, stepId])).rows[0];
      if (!row) throw notFound('step');
      if (row.status !== 'failed') throw conflict('step_not_failed');
      const def = (await this.d.flows.getVersion(tx, run.flow_version_id))!.definition;
      const step = def.steps[row.idx] as Step;
      if (ask.kind === 'result') await this.checkGiven(tx, step, ask.output);
      const changes = await this.stepChanges(tx, step);
      const selfDecides = !changes || (this.d.config.mode === 'local' && canApprove(actor));
      await tx.query(
        `INSERT INTO step_resolutions (run_id, step_id, kind, error_type, status, requested_by, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (run_id, step_id) DO UPDATE SET kind = $3, error_type = $4, status = $5, requested_by = $6, requested_at = now(), decided_by = $7, decided_at = $8`,
        [runId, stepId, ask.kind, row.error_type, selfDecides ? 'applied' : 'pending', actor.id, selfDecides ? actor.id : null, selfDecides ? new Date() : null],
      );
      const output = ask.kind === 'result' ? ask.output : null;
      await audit(tx, {
        actorId: actor.id,
        // Applied at once, or asked of an approver (then run.step_resolution_approved/rejected follows).
        action: `run.step_${ask.kind === 'skip' ? 'skipped' : 'result_given'}${selfDecides ? '' : '_requested'}`,
        subjectType: 'step',
        subjectId: `${runId}:${stepId}`,
        outcome: 'ok',
        errorType: row.error_type ?? undefined,
      });
      if (selfDecides) {
        await this.applyResolution(tx, run, stepId, ask.kind, output);
        return { applied: true };
      }
      await this.setStep(tx, runId, stepId, { proposed_enc: ask.kind === 'result' ? this.d.cipher.encryptJson(output, this.aadProposed(runId, stepId)) : null });
      await this.setRun(tx, runId, 'waiting', RESOLUTION_WAIT);
      await notifyApprovers(tx, await this.teamOfRun(runId, tx), run.run_as, 'approval_needed', { runId, stepId });
      return { applied: false };
    });
  }

  /** An approver lets a requested skip or given result through, or rejects it (the run is paused again, as before). */
  async decideResolution(runId: string, stepId: string, actor: Member, decision: 'approved' | 'rejected'): Promise<void> {
    if (!canApprove(actor)) throw forbidden('approver_only');
    await withTx(this.db, async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (this.d.config.mode === 'shared' && run.run_as === actor.id) throw forbidden('cannot_approve_own_run');
      const req = (await tx.query<{ kind: 'skip' | 'result'; status: string; error_type: string | null }>(`SELECT kind, status, error_type FROM step_resolutions WHERE run_id = $1 AND step_id = $2`, [runId, stepId])).rows[0];
      if (!req || req.status !== 'pending' || run.status !== 'waiting' || run.wait_reason !== RESOLUTION_WAIT) throw conflict('nothing_to_decide');
      const by = await approvalAuthority(tx, actor, await this.teamOfRun(runId, tx), this.d.config.mode === 'shared' ? run.run_as : '');
      await tx.query(`UPDATE step_resolutions SET status = $3, decided_by = $4, decided_at = now() WHERE run_id = $1 AND step_id = $2`, [runId, stepId, decision === 'approved' ? 'applied' : 'rejected', actor.id]);
      await audit(tx, { actorId: actor.id, action: `run.step_resolution_${decision}`, subjectType: 'step', subjectId: `${runId}:${stepId}`, outcome: 'ok', relatedId: by.onBehalfOf ?? undefined });
      const row = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 AND step_id = $2`, [runId, stepId])).rows[0]!;
      const output = req.kind === 'result' && row.proposed_enc ? this.d.cipher.decryptJson(row.proposed_enc, this.aadProposed(runId, stepId)) : null;
      await this.setStep(tx, runId, stepId, { proposed_enc: null });
      if (decision === 'approved') await this.applyResolution(tx, run, stepId, req.kind, output);
      else await this.setRun(tx, runId, 'paused', req.error_type);
    });
  }

  private async applyResolution(tx: Tx, run: RunRow, stepId: string, kind: 'skip' | 'result', output: unknown): Promise<void> {
    if (kind === 'skip') await this.setStep(tx, run.id, stepId, { status: 'skipped', error_type: SKIPPED_BY_PERSON, lease_until: null, finished_at: new Date() });
    else await this.setStep(tx, run.id, stepId, { status: 'succeeded', error_type: null, output_enc: this.d.cipher.encryptJson(output, this.aadOutput(run.id, stepId)), lease_until: null, finished_at: new Date() });
    await this.setRun(tx, run.id, 'running', null);
    await enqueue(tx, 'advance', { runId: run.id });
  }

  /** A failed step a person got past, or asked an approver to: what they chose, who, and when (null when none). */
  private async resolutionsOf(runId: string): Promise<Map<string, { kind: string; status: string; requestedBy: string | null; decidedBy: string | null; at: Date }>> {
    const rows = (await this.db.query<{ step_id: string; kind: string; status: string; rq: string | null; dc: string | null; at: Date }>(
      `SELECT r.step_id, r.kind, r.status, rq.handle AS rq, dc.handle AS dc, COALESCE(r.decided_at, r.requested_at) AS at
       FROM step_resolutions r LEFT JOIN members rq ON rq.id = r.requested_by LEFT JOIN members dc ON dc.id = r.decided_by WHERE r.run_id = $1`,
      [runId],
    )).rows;
    return new Map(rows.map((r) => [r.step_id, { kind: r.kind, status: r.status, requestedBy: r.rq, decidedBy: r.dc, at: r.at }]));
  }

  /** What stopped a paused run and how to get past it: what is missing is looked up now, so a fix made meanwhile is not listed. */
  private async nextStepsOf(run: RunRow, steps: StepRow[], def: FlowDefinition, isOwner: boolean, actor: Member): Promise<NextSteps | null> {
    const row = steps.find((s) => s.status === 'failed');
    if (!row) return null;
    const step = def.steps[row.idx];
    const ctx: BlockerContext = {
      stepId: row.step_id,
      stepTitle: step?.title ?? row.step_id,
      errorType: row.error_type ?? 'unknown',
      module: null,
      services: [],
      missingPersonal: [],
      missingTeam: [],
      missingSettings: [],
      tables: step?.type === 'table' ? [step.table] : [],
      flowVersionId: run.flow_version_id,
      retriesLeft: isOwner ? Math.max(0, def.retry.manualRetryLimit - run.manual_retries_used) : null,
      newer: isOwner ? await this.newerVersion(this.db, run, steps).then((n) => (n ? { version: n.version.version, fits: n.fits } : null)) : null,
      // In local mode the single member approves their own; elsewhere a step that changes data needs an approver.
      // A fix or app step that failed while installing, building or testing: what it printed is the only thing that says why.
      ...(row.log_enc && (isOwner || canApprove(actor)) ? { log: this.d.cipher.decrypt(row.log_enc, this.aadLog(run.id, row.step_id)) } : {}),
      ...(row.detail_enc && (isOwner || canApprove(actor)) ? { detail: this.d.cipher.decrypt(row.detail_enc, this.aadDetail(run.id, row.step_id)) } : {}),
      pastIt: isOwner && step ? { changesData: (await this.stepChanges(this.db, step as Step)) && !(this.d.config.mode === 'local' && canApprove(actor)), usedBy: def.steps.filter((s) => readsFrom(s as Step).has(row.step_id)).map((s) => s.title ?? s.id) } : null,
    };
    if (step?.type === 'action') {
      const module = (await this.d.flows.pinnedModules(this.db, { steps: [step] } as FlowDefinition)).get((step as ActionStep).module);
      if (module) {
        const teamId = await this.teamOfRun(run.id);
        const { personal, team } = await this.splitServices(this.db, teamId, module.name, servicesFor(module.manifest, (step as ActionStep).action));
        const stored = team.length ? await teamStoredServices(this.db, teamId) : new Set<string>();
        const missingSettings = resolveManifest(module.manifest, step.type === 'action' ? settingsOf(def, step) : {}).missing;
        const act = module.manifest.actions.find((a) => a.name === (step as ActionStep).action);
        const one = act ? sampleOf(act.output) : null;
        Object.assign(ctx, {
          action: (step as ActionStep).action,
          calls: row.calls_enc && (isOwner || canApprove(actor)) ? (this.d.cipher.decryptJson(row.calls_enc, this.aadCalls(run.id, row.step_id)) as string[]) : undefined,
          // A step that runs once per item gives a list, one result per item.
          result: act ? { example: (step as ActionStep).forEach ? [one] : one, fields: fieldsHint(act.output) } : undefined,
          canFixModule: isOwner && (actor.role === 'admin' || module.createdBy === actor.id),
          module: { name: module.name, versionId: module.id },
          services: personal,
          missingPersonal: await this.d.vault.has(run.run_as, personal),
          missingTeam: team.filter((s) => !stored.has(s)),
          missingSettings: missingSettings.map((id) => module.manifest.settings.find((st) => st.id === id)?.label ?? id),
        });
      }
    }
    return nextSteps(ctx);
  }

  /** A module's credential services, split by whose access the team uses for them. */
  private async splitServices(db: Queryable, teamId: string, moduleName: string, services: string[]): Promise<{ personal: string[]; team: string[] }> {
    const modes = await credentialModes(db, teamId, moduleName);
    return { personal: services.filter((s) => modes.get(s) !== 'team'), team: services.filter((s) => modes.get(s) === 'team') };
  }

  /** Where a step's secrets come from: the team's shared account, or the executor's own vault. */
  /** Whose secret a module's credential uses in a team: the team's shared one, or the member's own. */
  async secretResolver(teamId: string, moduleName: string, executorId: string): Promise<(service: string) => Promise<string | null>> {
    const modes = await credentialModes(this.db, teamId, moduleName);
    return (service) => (modes.get(service) === 'team' ? teamSecret(this.db, this.d.cipher, teamId, service) : this.d.secrets(executorId, service));
  }

  // ---------------------------------------------------------------- forms and input steps

  /** What a run's step configures its module with (the Flow's values), for a delegate or an undo. */
  async stepSettings(runId: string | null, stepId: string | null): Promise<Record<string, string>> {
    if (!runId || !stepId) return {};
    const run = (await this.db.query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [runId])).rows[0];
    if (!run) return {};
    const version = await this.d.flows.getVersion(this.db, run.flow_version_id);
    const step = version?.definition.steps.find((s) => s.id === stepId);
    return step?.type === 'action' ? settingsOf(version!.definition, step) : {};
  }

  /**
   * Run one approved READ action as `member`, outside any run, to fill a select box.
   * Same sandbox, broker, manifest and credential rules as a step.
   */
  /**
   * Run one action of an approved module outside any run (live choices, notification channels, agent tools): same
   * sandbox, broker, manifest and credential rules as a step. `secretFor` decides whose access it uses, and
   * `settings` is what the caller configured the module with (a module keeps no configuration of its own).
   */
  async invokeOutsideRun(
    module: ModuleVersion,
    actionName: string,
    input: unknown,
    teamId: string,
    secretFor: (service: string) => Promise<string | null>,
    opts: {
      settings?: Record<string, string>;
      /** Recording a test: wraps the network the broker uses. */
      wrapFetch?: (inner: FetchLike) => FetchLike;
    } = {},
  ): Promise<unknown> {
    const wrapFetch = opts.wrapFetch;
    const action = module.manifest.actions.find((a) => a.name === actionName);
    if (!action) throw notFound('action');
    const problems = ajv.explain(action.input, input);
    if (problems.length) throw new AppError('lookup_needs_input', 422, problems.join('; '));
    const resolved = resolveManifest(module.manifest, opts.settings ?? {});
    if (resolved.missing.length) throw conflict('module_settings_missing');
    const broker = new Broker({
      manifest: resolved.manifest,
      action: action.name,
      resolveSecret: secretFor,
      insecureHttpHosts: this.d.config.insecureHttpHosts,
      internalHosts: this.d.config.internalHosts,
      fetchImpl: wrapFetch
        ? wrapFetch(this.d.fetchImpl ?? guardedFetch({ internalHosts: this.d.config.internalHosts, loopbackHosts: this.d.config.insecureHttpHosts }))
        : this.d.fetchImpl,
      browser: this.d.browser,
    });
    const timeoutMs = Math.min(this.d.actionTimeoutMs ?? 30_000, 30_000);
    const r =
      module.origin === 'mcp'
        ? await this.d.mcp.invoke({ module, action: action.name, input, broker, timeoutMs, hosts: resolved.manifest.hosts, resolveSecret: secretFor })
        : await this.d.runner.invoke({ code: module.code, action: action.name, input, broker, timeoutMs, settings: resolved.settings }).finally(() => broker.close());
    if (broker.violations.length) throw new ViolationError(broker.violations[0]!);
    if (!r.ok) throw new AppError(r.errorType === 'credential_missing' ? 'missing_credential' : r.errorType, r.errorType === 'credential_missing' ? 409 : 502);
    // What the app answered must have the approved shape, as for a step (an undo is built from it).
    if (!ajv.validate(action.output, r.output)) throw new AppError('output_schema_mismatch', 502);
    return r.output;
  }

  /** Secrets from a team's shared accounts only (notification channels act for the team, not a person). */
  teamOnlySecrets(teamId: string): (service: string) => Promise<string | null> {
    return (service) => teamSecret(this.db, this.d.cipher, teamId, service);
  }

  /** Run one approved READ action as `member`, outside any run, to fill a select box. */
  private async lookupChoices(
    module: ModuleVersion,
    source: Extract<OptionsSource, { module: string }>,
    input: unknown,
    member: Member,
    teamId: string,
    settings: Record<string, string>,
  ): Promise<Choice[]> {
    const action = module.manifest.actions.find((a) => a.name === source.action);
    if (!action || action.effect !== 'read') throw badRequest('lookup_not_read_only');
    const output = await this.invokeOutsideRun(module, action.name, input, teamId, await this.secretResolver(teamId, module.name, member.id), { settings });
    log.info('choices_loaded', { memberId: member.id, action: action.name });
    return toChoices(lookup({ inputs: output, steps: {} }, `inputs${source.items ? `.${source.items}` : ''}`), source.value, source.label);
  }

  /** Choices for a run-form field that loads them from a module, given the other fields filled in so far. */
  async formChoices(versionId: string, fieldName: string, values: Record<string, unknown>, member: Member): Promise<Choice[]> {
    const { version, modules } = await this.d.flows.assertRunnable(this.db, versionId);
    const field = version.definition.form?.fields.find((f) => f.name === fieldName);
    if (!field?.options || !('module' in field.options)) throw notFound('field');
    let input: unknown;
    try {
      input = resolve(field.options.input, { inputs: values, steps: {} });
    } catch {
      throw new AppError('lookup_needs_input', 422); // a field it depends on is not filled in yet
    }
    const teamId = await this.d.flows.teamOfVersion(this.db, versionId);
    if (!(await canUseTeam(this.db, teamId, member))) throw forbidden('not_in_team');
    return this.lookupChoices(modules.get(field.options.module)!, field.options, input, member, teamId, version.definition.moduleSettings?.[field.options.module.split('@')[0]!] ?? {});
  }

  /** The input step `stepId` of a run waiting for its member, with what its fields offer. */
  private async waitingInput(runId: string, stepId: string, member: Member) {
    const run = (await this.db.query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [runId])).rows[0];
    if (!run) throw notFound('run');
    if (run.run_as !== member.id) throw forbidden('not_your_run');
    const steps = (await this.db.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [runId])).rows;
    const row = steps.find((s) => s.step_id === stepId);
    const version = await this.d.flows.getVersion(this.db, run.flow_version_id);
    const step = row ? version!.definition.steps[row.idx] : undefined;
    if (!row || step?.type !== 'input' || row.status !== 'waiting') throw conflict('not_waiting_for_input');
    return { run, steps, step, version: version! };
  }

  /** Choices for input-step fields known without a lookup: fixed, or from an earlier step's output. */
  private knownChoices(fields: FormField[], scope: TemplateScope): Map<string, Choice[]> {
    const out = new Map<string, Choice[]>();
    for (const f of fields) {
      const o = f.options;
      if (!o) continue;
      if ('fixed' in o) out.set(f.name, o.fixed.map((c) => ({ value: c.value, label: c.label ?? String(c.value) })));
      else if ('fromStep' in o) {
        let list: unknown = [];
        try {
          list = resolve(o.fromStep, scope);
        } catch {
          list = [];
        }
        out.set(f.name, toChoices(list, o.value, o.label));
      }
    }
    return out;
  }

  /** Live choices for an input-step field that loads them from a module, as the run's member. */
  async inputChoices(runId: string, stepId: string, fieldName: string, member: Member): Promise<Choice[]> {
    const { run, steps, step, version } = await this.waitingInput(runId, stepId, member);
    const field = step.fields.find((f) => f.name === fieldName);
    if (!field?.options || !('module' in field.options)) throw notFound('field');
    let input: unknown;
    try {
      input = resolve(field.options.input, this.scope(run, steps));
    } catch {
      throw new AppError('lookup_needs_input', 422);
    }
    const modules = await this.d.flows.pinnedModules(this.db, version.definition);
    return this.lookupChoices(modules.get(field.options.module)!, field.options, input, member, await this.teamOfRun(runId), version.definition.moduleSettings?.[field.options.module.split('@')[0]!] ?? {});
  }

  /** The run's member answers an input step; the answers become its output and the run goes on. */
  async submitInput(runId: string, stepId: string, member: Member, values: unknown): Promise<void> {
    await withTx(this.db, async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (run.run_as !== member.id) throw forbidden('not_your_run');
      const steps = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx FOR UPDATE`, [runId])).rows;
      const row = steps.find((s) => s.step_id === stepId);
      const version = await this.d.flows.getVersion(tx, run.flow_version_id);
      const step = row ? version!.definition.steps[row.idx] : undefined;
      if (!row || step?.type !== 'input' || row.status !== 'waiting') throw conflict('not_waiting_for_input');
      const checked = checkAnswers(step.fields, values, this.knownChoices(step.fields, this.scope(run, steps)));
      if (!checked.ok) throw badRequest('invalid_answers', checked.problems.join('; '));
      await tx.query(`UPDATE run_steps SET output_enc = $3, status = 'succeeded', finished_at = now() WHERE run_id = $1 AND step_id = $2`, [
        runId,
        stepId,
        this.d.cipher.encryptJson(checked.answers, this.aadOutput(runId, stepId)),
      ]);
      await this.setRun(tx, runId, 'running', null);
      await audit(tx, { actorId: member.id, action: 'input.submitted', subjectType: 'step', subjectId: `${runId}:${stepId}`, outcome: 'ok' });
      await enqueue(tx, 'advance', { runId });
    });
  }

  /** What the run page shows for a waiting input step: its fields, with the choices known now. */
  private defaultValue(value: string | number | boolean, scope: TemplateScope): unknown {
    if (typeof value !== 'string') return value;
    try {
      return resolve(value, scope);
    } catch {
      return null;
    }
  }

  private inputView(step: InputStep, scope: TemplateScope) {
    const known = this.knownChoices(step.fields, scope);
    return {
      intro: step.intro ?? null,
      fields: step.fields.map((f) => ({
        name: f.name,
        label: f.label,
        help: f.help ?? null,
        widget: f.widget,
        placeholder: f.placeholder ?? null,
        required: f.required === true,
        choices: known.get(f.name) ?? null,
        /** What the field starts with, e.g. the checks an AI step proposed. */
        default: f.default === undefined ? null : this.defaultValue(f.default, scope),
        /** Choices come from a module: load them with POST .../choices. */
        live: !!(f.options && 'module' in f.options),
      })),
    };
  }

  // ---------------------------------------------------------------- delegation

  private delegationHash(runId: string, stepId: string, moduleVersionId: string, action: string, inputs: ResolvedInputs): string {
    return sha256Hex(canonicalJson({ runId, stepId, moduleVersionId, action, inputs }));
  }

  private async openDelegationFor(tx: Tx, runId: string, stepId: string, statuses: string[]): Promise<DelegationRow | null> {
    const { rows } = await tx.query<DelegationRow>(
      `SELECT * FROM delegations WHERE run_id = $1 AND step_id = $2 AND status = ANY($3) ORDER BY created_at DESC LIMIT 1`,
      [runId, stepId, statuses],
    );
    return rows[0] ?? null;
  }

  private async openDelegation(
    tx: Tx,
    run: RunRow,
    step: ActionStep,
    module: ModuleVersion,
    inputs: ResolvedInputs,
    requesterId: string,
    delegateId: string,
  ): Promise<string> {
    if (requesterId === delegateId) throw badRequest('cannot_delegate_to_self');
    const delegate = await tx.query<{ disabled: boolean }>(`SELECT disabled FROM members WHERE id = $1`, [delegateId]);
    if (!delegate.rows[0] || delegate.rows[0].disabled) throw badRequest('unknown_delegate');
    const id = randomUUID();
    const hash = this.delegationHash(run.id, step.id, module.id, step.action, inputs);
    const expires = new Date(Date.now() + this.d.config.delegationTtlHours * 3600_000);
    await tx.query(
      `INSERT INTO delegations (id, run_id, step_id, requester_id, delegate_id, module_version_id, action, inputs_enc, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
      [id, run.id, step.id, requesterId, delegateId, module.id, step.action, this.d.cipher.encryptJson(inputs, this.aadDelegation(id)), hash, expires],
    );
    await this.setStep(tx, run.id, step.id, { status: 'waiting', error_type: null, started_at: new Date() });
    await this.setRun(tx, run.id, 'waiting', 'delegation');
    await audit(tx, {
      actorId: requesterId,
      action: 'delegation.requested',
      subjectType: 'delegation',
      subjectId: id,
      outcome: 'ok',
      relatedId: delegateId,
    });
    await notify(tx, delegateId, 'delegation_requested', { runId: run.id, stepId: step.id, delegationId: id });
    return id;
  }

  /** The run's member lacks access for a step: ask a teammate to run that one action. */
  async requestDelegation(runId: string, stepId: string, actor: Member, delegateId: string): Promise<string> {
    return withTx(this.db, async (tx) => {
      const loaded = await this.loadRun(tx, runId);
      if (!loaded) throw notFound('run');
      const { run, steps, definition } = loaded;
      if (run.run_as !== actor.id) throw forbidden();
      const row = steps.find((s) => s.step_id === stepId);
      const step = row ? definition.steps[row.idx] : undefined;
      if (!row || !step || step.type !== 'action') throw notFound('step');
      if (run.status !== 'paused' || row.status !== 'failed') throw conflict('step_not_failed');
      const module = await this.moduleFor(tx, step);
      await checkDelegation(tx, module.name);
      let inputs: ResolvedInputs;
      try {
        inputs = this.resolveInputs(step, this.scope(run, steps));
      } catch {
        throw conflict('inputs_unresolvable');
      }
      await tx.query(`UPDATE run_steps SET attempts = 0 WHERE run_id = $1 AND step_id = $2`, [runId, stepId]);
      return this.openDelegation(tx, run, step, module, inputs, actor.id, delegateId);
    });
  }

  /** What the delegate sees before deciding: the exact request, and what the module may do. */
  async delegationDetails(id: string, actor: Member) {
    const del = (await this.db.query<DelegationRow>(`SELECT * FROM delegations WHERE id = $1`, [id])).rows[0];
    if (!del) throw notFound('delegation');
    if (del.delegate_id !== actor.id && del.requester_id !== actor.id) throw forbidden();
    const module = (await this.db.query<{ name: string; version: string; manifest: Manifest }>(
      `SELECT name, version, manifest FROM module_versions WHERE id = $1`,
      [del.module_version_id],
    )).rows[0]!;
    const action = module.manifest.actions.find((a) => a.name === del.action);
    return {
      id: del.id,
      status: del.status,
      runId: del.run_id,
      stepId: del.step_id,
      requesterId: del.requester_id,
      delegateId: del.delegate_id,
      module: `${module.name}@${module.version}`,
      action: { name: del.action, title: action?.title, effect: action?.effect, description: action?.description },
      hosts: resolveManifest(module.manifest, await this.stepSettings(del.run_id, del.step_id)).manifest.hosts,
      expiresAt: del.expires_at,
      // Only the delegate sees the inputs they are asked to act on.
      inputs:
        del.delegate_id === actor.id && del.inputs_enc
          ? this.d.cipher.decryptJson<ResolvedInputs>(del.inputs_enc, this.aadDelegation(del.id)).items
          : undefined,
    };
  }

  async listDelegations(actor: Member) {
    const { rows } = await this.db.query(
      `SELECT id, run_id, step_id, requester_id, delegate_id, action, status, created_at, expires_at
       FROM delegations WHERE delegate_id = $1 OR requester_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [actor.id],
    );
    return rows;
  }

  async decideDelegation(id: string, actor: Member, decision: 'approved' | 'rejected'): Promise<void> {
    const outcome = await withTx(this.db, async (tx): Promise<'ok' | 'expired'> => {
      const del = (await tx.query<DelegationRow>(`SELECT * FROM delegations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!del) throw notFound('delegation');
      if (del.delegate_id !== actor.id) throw forbidden('not_the_delegate');
      if (del.status !== 'pending') throw conflict('delegation_not_pending');
      const run = await this.lockRun(tx, del.run_id);
      if (del.expires_at <= new Date()) {
        await tx.query(`UPDATE delegations SET status = 'expired', inputs_enc = NULL WHERE id = $1`, [id]);
        await this.failStep(tx, run, del.step_id, 'delegation_expired');
        return 'expired';
      }
      if (decision === 'approved') {
        // Approving means running it with your own account, so you need the access the action uses.
        const manifest = (await tx.query<{ manifest: Manifest }>(`SELECT manifest FROM module_versions WHERE id = $1`, [del.module_version_id]))
          .rows[0]!.manifest;
        // Credentials the team shares are not the delegate's to provide.
        const { personal } = await this.splitServices(tx, await this.teamOfRun(del.run_id, tx), manifest.name, servicesFor(manifest, del.action));
        const missing = await this.d.vault.has(actor.id, personal, tx);
        if (missing.length > 0) throw conflict('delegate_missing_credential');
      }
      await tx.query(`UPDATE delegations SET status = $2, decided_at = now() WHERE id = $1`, [id, decision]);
      await audit(tx, {
        actorId: actor.id,
        action: `delegation.${decision}`,
        subjectType: 'delegation',
        subjectId: id,
        outcome: 'ok',
        relatedId: del.requester_id,
      });
      await notify(tx, del.requester_id, 'delegation_decided', { runId: del.run_id, stepId: del.step_id, delegationId: id });
      if (decision === 'rejected') {
        await tx.query(`UPDATE delegations SET inputs_enc = NULL WHERE id = $1`, [id]);
        await this.failStep(tx, run, del.step_id, 'delegation_rejected');
        return 'ok';
      }
      await this.setRun(tx, run.id, 'running', null);
      await enqueue(tx, 'advance', { runId: run.id });
      return 'ok';
    });
    // Raised after commit so the expiry is recorded.
    if (outcome === 'expired') throw conflict('delegation_expired');
  }

  /** The requester hands a pending request to a different teammate. The request itself is unchanged. */
  async reassignDelegation(id: string, actor: Member, newDelegateId: string): Promise<string> {
    return withTx(this.db, async (tx) => {
      const del = (await tx.query<DelegationRow>(`SELECT * FROM delegations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!del) throw notFound('delegation');
      if (del.requester_id !== actor.id) throw forbidden('not_the_requester');
      if (del.status !== 'pending') throw conflict('delegation_not_pending');
      if (newDelegateId === del.delegate_id) throw badRequest('same_delegate');
      const run = await this.lockRun(tx, del.run_id);
      const inputs = this.d.cipher.decryptJson<ResolvedInputs>(del.inputs_enc!, this.aadDelegation(del.id));
      if (this.delegationHash(del.run_id, del.step_id, del.module_version_id, del.action, inputs) !== del.request_hash) {
        throw conflict('delegation_tampered');
      }
      await tx.query(`UPDATE delegations SET status = 'cancelled', inputs_enc = NULL WHERE id = $1`, [id]);
      const version = await this.d.flows.getVersion(tx, run.flow_version_id);
      const stepRow = (await tx.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 AND step_id = $2`, [run.id, del.step_id])).rows[0]!;
      const step = version!.definition.steps[stepRow.idx] as ActionStep;
      const module = await this.moduleFor(tx, step);
      const newId = await this.openDelegation(tx, run, step, module, inputs, actor.id, newDelegateId);
      await tx.query(`UPDATE delegations SET replaced_by = $2 WHERE id = $1`, [id, newId]);
      await audit(tx, { actorId: actor.id, action: 'delegation.reassigned', subjectType: 'delegation', subjectId: id, outcome: 'ok', relatedId: newId });
      await notify(tx, del.delegate_id, 'delegation_cancelled', { runId: run.id, stepId: del.step_id, delegationId: id });
      return newId;
    });
  }

  /** The requester withdraws a pending request. The run pauses so they can choose what to do next. */
  async cancelDelegation(id: string, actor: Member): Promise<void> {
    await withTx(this.db, async (tx) => {
      const del = (await tx.query<DelegationRow>(`SELECT * FROM delegations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!del) throw notFound('delegation');
      if (del.requester_id !== actor.id) throw forbidden('not_the_requester');
      if (del.status !== 'pending') throw conflict('delegation_not_pending');
      const run = await this.lockRun(tx, del.run_id);
      await tx.query(`UPDATE delegations SET status = 'cancelled', inputs_enc = NULL WHERE id = $1`, [id]);
      await audit(tx, { actorId: actor.id, action: 'delegation.cancelled', subjectType: 'delegation', subjectId: id, outcome: 'ok', relatedId: del.delegate_id });
      await notify(tx, del.delegate_id, 'delegation_cancelled', { runId: run.id, stepId: del.step_id, delegationId: id });
      await this.failStep(tx, run, del.step_id, 'delegation_cancelled');
    });
  }

  /**
   * Offboarding (SCIM): pending requests the person made, or was asked to run, are cancelled and the
   * other person is told. A request to them pauses the requester's run, as a withdrawn one does; the
   * person's own runs are cancelled by the caller once this commits. Returns what was cancelled.
   */
  async cancelDelegationsOf(tx: Tx, memberId: string, actorId: string): Promise<{ id: string; asRequester: boolean }[]> {
    const { rows } = await tx.query<DelegationRow>(
      `SELECT * FROM delegations WHERE status = 'pending' AND (requester_id = $1 OR delegate_id = $1) ORDER BY created_at FOR UPDATE`,
      [memberId],
    );
    const out: { id: string; asRequester: boolean }[] = [];
    for (const del of rows) {
      const run = await this.lockRun(tx, del.run_id);
      const asRequester = del.requester_id === memberId;
      await tx.query(`UPDATE delegations SET status = 'cancelled', inputs_enc = NULL, cancelled_for = $2 WHERE id = $1`, [del.id, memberId]);
      await audit(tx, { actorId, action: 'delegation.cancelled_offboarded', subjectType: 'delegation', subjectId: del.id, outcome: 'ok', relatedId: memberId });
      const refs = { runId: run.id, stepId: del.step_id, delegationId: del.id };
      if (asRequester) await notify(tx, del.delegate_id, 'delegation_cancelled', refs);
      else {
        await notify(tx, del.requester_id, 'delegation_delegate_offboarded', refs);
        if (run.status === 'waiting') await this.failStep(tx, run, del.step_id, 'delegate_offboarded');
      }
      out.push({ id: del.id, asRequester });
    }
    return out;
  }

  /**
   * Reminders and expiry for pending requests. Halfway to expiry the teammate is
   * reminded. At expiry the run pauses, the requester is told, and approvers are
   * notified so someone can step in (escalation).
   */
  async sweepDelegations(now = new Date()): Promise<{ reminded: number; expired: number }> {
    const reminded = await this.db.query<{ id: string; delegate_id: string; run_id: string; step_id: string }>(
      `UPDATE delegations SET reminded_at = $1
       WHERE status = 'pending' AND reminded_at IS NULL AND expires_at > $1
         AND created_at + (expires_at - created_at) / 2 <= $1
       RETURNING id, delegate_id, run_id, step_id`,
      [now],
    );
    for (const r of reminded.rows) {
      await notify(this.db, r.delegate_id, 'delegation_reminder', { runId: r.run_id, stepId: r.step_id, delegationId: r.id });
    }
    let expired = 0;
    const due = await this.db.query<{ id: string }>(`SELECT id FROM delegations WHERE status = 'pending' AND expires_at <= $1`, [now]);
    for (const { id } of due.rows) {
      await withTx(this.db, async (tx) => {
        const del = (await tx.query<DelegationRow>(`SELECT * FROM delegations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!del || del.status !== 'pending') return;
        const run = await this.lockRun(tx, del.run_id);
        await tx.query(`UPDATE delegations SET status = 'expired', inputs_enc = NULL WHERE id = $1`, [id]);
        await audit(tx, { actorId: null, action: 'delegation.expired', subjectType: 'delegation', subjectId: id, outcome: 'failed', errorType: 'delegation_expired' });
        await this.failStep(tx, run, del.step_id, 'delegation_expired');
        await notify(tx, del.requester_id, 'delegation_expired', { runId: run.id, stepId: del.step_id, delegationId: id });
        await notifyRole(tx, ['admin', 'approver'], 'delegation_escalated', { runId: run.id, stepId: del.step_id }, del.requester_id);
        expired++;
      });
    }
    return { reminded: reminded.rowCount ?? 0, expired };
  }

  private async closeDelegation(tx: Tx, id: string, status: 'completed' | 'failed', executorId: string): Promise<void> {
    const del = (await tx.query<DelegationRow>(`UPDATE delegations SET status = $2, inputs_enc = NULL WHERE id = $1 RETURNING *`, [id, status]))
      .rows[0]!;
    // Both names are recorded: the delegate who ran it and the member who asked.
    await audit(tx, {
      actorId: executorId,
      action: `delegation.${status === 'completed' ? 'executed' : 'execution_failed'}`,
      subjectType: 'delegation',
      subjectId: id,
      outcome: status === 'completed' ? 'ok' : 'failed',
      relatedId: del.requester_id,
    });
  }

  // ---------------------------------------------------------------- run screen

  /**
   * Statuses for the run's member, approvers and anyone who ran a step of it.
   * Outputs (and inputs) only for the run's own member, plus each step's output
   * for the teammate who ran that step for them.
   */
  private async costCapView(run: RunRow, steps: StepRow[], definition: FlowDefinition) {
    const row = steps.find((s) => s.status === 'waiting' && s.error_type === COST_CAP);
    const step = row ? definition.steps[row.idx] : undefined;
    const cap = step ? await capReached(this.db, run.id, definition, step) : null;
    return { stepId: row?.step_id ?? null, scope: cap?.scope ?? null, reason: cap?.reason ?? 'cost cap reached', spent: cap?.spent ?? null, cap: cap?.cap ?? null };
  }

  /**
   * A run started from an app, as the app's pages show it (the same shape an exported app returns). An app is
   * shared by its team, so every member who may open it sees its runs' results; only the person who started a
   * run gets its input forms. The caller checks the viewer may open the app.
   */
  async appRunView(runId: string, appId: string, viewer: Member) {
    const run = (await this.db.query<RunRow & { app_id: string | null; created_at: Date; finished_at: Date | null }>(`SELECT * FROM runs WHERE id = $1`, [runId])).rows[0];
    if (!run || run.app_id !== appId) throw notFound('run');
    const steps = (await this.db.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [runId])).rows;
    const version = (await this.d.flows.getVersion(this.db, run.flow_version_id))!;
    const defs = version.definition.steps;
    const output = (s: StepRow) => (s.output_enc ? this.d.cipher.decryptJson(s.output_enc, this.aadOutput(run.id, s.step_id)) : null);
    const shared = (s: StepRow) => !s.executed_by || s.executed_by === run.run_as || s.executed_by === viewer.id;
    const waiting = steps
      .filter((s) => s.status === 'waiting' && (defs[s.idx]?.type === 'approval' || defs[s.idx]?.type === 'input' || s.error_type === GUARD))
      .map((s) => {
        const def = defs[s.idx]!;
        const input = def.type === 'input';
        return {
          stepId: s.step_id,
          kind: input ? 'input' : 'approval',
          title: def.title ?? null,
          form: input && run.run_as === viewer.id ? this.inputView(def as InputStep, this.scope(run, steps)) : undefined,
          // A sign-off before a step text an AI wrote could steer: exactly what that step will do.
          signOff: s.error_type === GUARD && s.sign_off_enc && (run.run_as === viewer.id || canApprove(viewer)) ? { values: this.d.cipher.decryptJson(s.sign_off_enc, this.aadSignOff(run.id, s.step_id)), sha256: s.sign_off_sha256 } : undefined,
        };
      });
    const last = [...steps].reverse().find((s) => s.status === 'succeeded' && s.output_enc);
    return {
      id: run.id,
      flowVersionId: run.flow_version_id,
      status: run.status,
      waitReason: run.wait_reason,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
      mine: run.run_as === viewer.id,
      // A step a teammate ran on their own access (a delegated step) shows its output only to them.
      steps: steps.map((s) => ({ id: s.step_id, type: defs[s.idx]?.type, title: defs[s.idx]?.title ?? null, status: s.status, errorType: s.error_type, output: shared(s) ? output(s) : null })),
      waiting,
      result: last && shared(last) ? output(last) : null,
    };
  }

  /**
   * For "Have the AI fix <module>" on a run: the module version's ref ("name@version"), once the actor may see the run
   * (its member or an approver). src/modules/run-fix.ts checks the run uses it.
   */
  async runFixTarget(runId: string, moduleVersionId: string, actor: Member): Promise<string> {
    await this.runView(runId, actor);
    const mv = (await this.db.query<{ name: string; version: string }>(`SELECT name, version FROM module_versions WHERE id = $1`, [moduleVersionId])).rows[0];
    if (!mv) throw notFound('module');
    return `${mv.name}@${mv.version}`;
  }

  /**
   * The member's own runs going on now (or that ended in the last minute), each with its latest commentary lines,
   * for the Live panel.
   */
  async liveRuns(actor: Member) {
    const runs = (await this.db.query<{ id: string; status: string; flow_name: string; created_at: Date }>(
      `SELECT r.id, r.status, f.name AS flow_name, r.created_at FROM runs r
       JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
       WHERE r.run_as = $1 AND (r.status IN ('running', 'waiting', 'paused') OR r.finished_at > now() - interval '1 minute')
       ORDER BY r.created_at DESC LIMIT 5`,
      [actor.id],
    )).rows;
    return Promise.all(
      runs.map(async (r) => ({
        runId: r.id,
        flowName: r.flow_name,
        status: r.status,
        startedAt: r.created_at,
        lines: (await commentaryOf(this.db, this.d.cipher, r.id, { limit: 30 })).map((l) => ({ id: l.id, at: l.at, text: l.text })),
      })),
    );
  }

  async runView(runId: string, actor: Member) {
    const run = (
      await this.db.query<RunRow & { created_at: Date; finished_at: Date | null; data_expires_at: Date | null }>(`SELECT * FROM runs WHERE id = $1`, [runId])
    ).rows[0];
    if (!run) throw notFound('run');
    const isOwner = run.run_as === actor.id;
    const steps = (await this.db.query<StepRow>(`SELECT * FROM run_steps WHERE run_id = $1 ORDER BY idx`, [runId])).rows;
    const ranAStep = steps.some((s) => s.executed_by === actor.id);
    if (!isOwner && !ranAStep && !canApprove(actor)) throw forbidden();
    const seesOutput = (s: StepRow) => isOwner || s.executed_by === actor.id;
    const version = await this.d.flows.getVersion(this.db, run.flow_version_id);
    const flowName = (await this.db.query<{ name: string }>(`SELECT name FROM flows WHERE id = $1`, [version!.flowId])).rows[0]?.name;
    const defs = version!.definition.steps;
    // A Super Flow's child runs, per flow step (links only; each child run has its own page).
    const kids = (await this.db.query<{ step_id: string; key: string; child_run_id: string; status: string; flow_name: string; version: number }>(
      `SELECT c.step_id, c.key, c.child_run_id, r.status, f.name AS flow_name, v.version
       FROM run_children c JOIN runs r ON r.id = c.child_run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
       WHERE c.parent_run_id = $1 ORDER BY c.key`,
      [runId],
    )).rows;
    // Who decided each sign-off, for whom when a stand-in did, and whether from outside the team.
    // A sign-off released by its evidence gate has no person: by is null and evidence says why.
    const decisions = new Map(
      (await this.db.query<{ step_id: string; decision: string; decided_at: Date; by: string | null; for_handle: string | null; outside_team: boolean; auto_evidence: unknown }>(
        `SELECT g.step_id, g.decision, g.decided_at, m.handle AS by, o.handle AS for_handle, g.outside_team, g.auto_evidence
         FROM gate_decisions g LEFT JOIN members m ON m.id = g.decided_by LEFT JOIN members o ON o.id = g.on_behalf_of WHERE g.run_id = $1`,
        [runId],
      )).rows.map((d) => [d.step_id, { decision: d.decision, at: d.decided_at, by: d.by, for: d.for_handle, outsideTeam: d.outside_team, automatic: d.auto_evidence ?? null }]),
    );
    const parent = run.parent_run_id
      ? (await this.db.query<{ id: string; name: string }>(
          `SELECT r.id, f.name FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id WHERE r.id = $1`,
          [run.parent_run_id],
        )).rows[0] ?? null
      : null;
    const resolutions = await this.resolutionsOf(runId);
    const stops = await stopsOfRun(this.db, run.id);
    // The one still holding this run back, if any: what the Result panel must explain and link to.
    const waitingStop = stops.find((s) => s.thisRun === 'waiting') ?? null;
    const viewSteps = steps.map((s) => ({
      id: s.step_id,
      type: defs[s.idx]?.type,
      title: defs[s.idx]?.title ?? null,
      module: defs[s.idx]?.type === 'action' ? (defs[s.idx] as ActionStep).module.split('@')[0] : null,
      action: defs[s.idx]?.type === 'action' ? (defs[s.idx] as ActionStep).action : null,
      status: s.status,
      attempts: s.attempts,
      errorType: s.error_type,
      executedBy: s.executed_by,
      output: seesOutput(s) && s.output_enc ? this.d.cipher.decryptJson(s.output_enc, this.aadOutput(run.id, s.step_id)) : undefined,
      input:
        isOwner && s.status === 'waiting' && defs[s.idx]?.type === 'input' ? this.inputView(defs[s.idx] as InputStep, this.scope(run, steps)) : undefined,
      /** A person got past this failed step (skipped it or typed in its result), or asked an approver to. */
      resolution: resolutions.get(s.step_id) ?? undefined,
      /** A requested result waiting for an approver: what the run would continue with (owner and approvers). */
      proposed:
        s.proposed_enc && (isOwner || canApprove(actor)) ? this.d.cipher.decryptJson(s.proposed_enc, this.aadProposed(run.id, s.step_id)) : undefined,
      /** A refused step: what the check that refused it said, field by field (the run's member and approvers). */
      detail: s.status === 'failed' && s.detail_enc && (isOwner || canApprove(actor)) ? this.d.cipher.decrypt(s.detail_enc, this.aadDetail(run.id, s.step_id)) : undefined,
      /** A failed fix or app step: what it printed before it failed, secrets redacted (the run's member and approvers). */
      log: s.status === 'failed' && s.log_enc && (isOwner || canApprove(actor)) ? this.d.cipher.decrypt(s.log_enc, this.aadLog(run.id, s.step_id)) : undefined,
      /** A failed step: what it called before it failed and how each call answered (the run's member and approvers). */
      calls: s.status === 'failed' && s.calls_enc && (isOwner || canApprove(actor)) ? (this.d.cipher.decryptJson(s.calls_enc, this.aadCalls(run.id, s.step_id)) as string[]) : undefined,
      /** For a sign-off: who decided, and for whom when they stood in for someone. */
      decision: decisions.get(s.step_id) ?? undefined,
      /** A step text an AI wrote could steer, waiting for a sign-off: exactly what it will do, and the hash a decision covers. */
      signOff:
        s.status === 'waiting' && s.error_type === GUARD && s.sign_off_enc && (isOwner || canApprove(actor))
          ? { values: this.d.cipher.decryptJson(s.sign_off_enc, this.aadSignOff(run.id, s.step_id)), sha256: s.sign_off_sha256 }
          : undefined,
      children:
        defs[s.idx]?.type === 'flow'
          ? kids.filter((k) => k.step_id === s.step_id).map((k) => ({ key: k.key, runId: k.child_run_id, status: k.status, flowName: k.flow_name, version: k.version }))
          : undefined,
    }));
    return {
      flowName,
      /** What the run did, line by line, the latest last (the run's member and approvers). */
      commentary: isOwner || canApprove(actor) ? (await commentaryOf(this.db, this.d.cipher, run.id, { limit: 80 })).map((l) => ({ id: l.id, stepId: l.stepId, at: l.at, text: l.text })) : [],
      /** Set when a Super Flow started this run. */
      parent: parent ? { runId: parent.id, flowName: parent.name } : null,
      flowId: version!.flowId,
      version: version!.version,
      id: run.id,
      flowVersionId: run.flow_version_id,
      runAs: run.run_as,
      /** The model it was started with ("provider:model"); null: its Flow's. */
      aiModel: run.ai_model ?? null,
      /** A dry run: reads ran, changes were skipped. */
      dry: run.dry,
      /** Started under break-glass access. */
      breakglass: run.breakglass_id !== null,
      status: run.status,
      waitReason: run.wait_reason,
      manualRetriesUsed: run.manual_retries_used,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
      /** When a finished run's inputs and outputs are deleted; null when nothing is kept. */
      dataExpiresAt: run.data_expires_at,
      /** What its AI steps spent so far (tokens; money where the model has a price). */
      aiSpend: await runSpend(this.db, run.id),
      /** Why it waits at its cost cap: what was spent of what. */
      costCap: run.status === 'waiting' && run.wait_reason === 'cost_cap' ? await this.costCapView(run, steps, version!.definition) : null,
      /** Automatic stops of its Flow that paused this run (src/governance/auto-stop.ts). */
      autoStops: stops,
      inputs: isOwner && run.inputs_enc ? this.d.cipher.decryptJson(run.inputs_enc, this.aadInputs(run.id)) : undefined,
      steps: viewSteps,
      /** A paused run: the step it stopped at, why in plain words, and how to get it going (src/engine/next-steps.ts). */
      nextSteps: run.status === 'paused' && (isOwner || canApprove(actor)) ? await this.nextStepsOf(run, steps, version!.definition, isOwner, actor) : null,
      /** How it ended or where it stands, from its steps (src/engine/outcome.ts). */
      outcome: runOutcome({ status: run.status, waitReason: run.wait_reason, dry: run.dry }, viewSteps, {
        ...(waitingStop ? { autoStop: { id: waitingStop.id, triggerName: waitingStop.triggerName, summary: waitingStop.summary } } : {}),
      }),
    };
  }
}

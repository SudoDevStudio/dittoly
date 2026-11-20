import { randomUUID } from 'node:crypto';
import { Broker, type EndpointCaller, type FetchLike } from '../../runtime/broker.js';
import { ajv, resolveManifest, servicesFor } from '../../runtime/manifest.js';
import { TemplateError } from '../../runtime/template.js';
import { canonicalJson, sha256Hex } from '../../runtime/crypto.js';
import type { AiStep, Choice, Column, FormField, Manifest, ReportStep } from '../../runtime/types.js';
import type { ActionStepCode, AiStepCode, FlowCode, FlowStepCode, InputStepCode, Scope, StepCode, TableStepCode } from './flow.js';
import type { InvokeParams, InvokeResult } from './pool.js';
import { isActive, type RunRecord, type RunStatus, type StepRecord, type Store } from './store.js';

/**
 * Runs the app's Flows: steps in order, conditions, automatic
 * retries with backoff for errors the module marks retryable (never for a change that may already
 * have reached the app), sign-offs and forms that wait, delays, child Flows that start together,
 * table steps. A step that cannot go on pauses the run. Everything runs in this process; state is
 * kept in the store after each step only so that waiting runs survive a restart.
 */

export interface ModuleDef {
  ref: string;
  name: string;
  version: string;
  manifest: Manifest;
  /** Its file inside the sandbox folder. */
  file: string;
  codeSha256: string;
}

export interface TableDef { name: string; keyColumn: string; columns: Column[] }

export interface EngineDeps {
  flows: Map<string, FlowCode>;
  modules: Map<string, ModuleDef>;
  tables: Map<string, TableDef>;
  store: Store;
  sandbox: { invoke(p: InvokeParams): Promise<InvokeResult> };
  /** Module settings by module name, and credentials by service: from the environment. */
  settings: Record<string, Record<string, string>>;
  credentials: Record<string, string>;
  /** Runs AI steps (ai-steps.ts); only apps with AI steps have it. */
  aiSteps?: AiSteps;
  /** Report, input and table steps; only apps whose Flows have them pass them. */
  steps?: StepKinds;
  /** SMTP, message, WebSocket, SSE and database calls (endpoint-calls.ts); only apps whose modules have endpoints have it. */
  calls?: EndpointCaller;
  /** Google service account keys to access tokens (google-auth.ts); only apps whose modules use one have it. */
  googleToken?: (secret: string, scopes: readonly string[]) => Promise<string>;
  insecureHttpHosts: string[];
  internalHosts: string[];
  /** Days a finished run is kept; 0 deletes its data when it ends. */
  retentionDays: number;
  /** A run started waiting for a person. */
  onWaiting?: (run: RunRecord, stepId: string) => void;
  retry?: { autoRetries: number; backoffMs: number };
  actionTimeoutMs?: number;
  /** Test hooks. */
  fetchImpl?: FetchLike;
}

/** Step kinds only some Flows have (report.ts, input-steps.ts, table-steps.ts). */
export interface StepKinds {
  report?: (step: ReportStep, items: unknown, link: string | undefined) => unknown;
  input?: {
    /** The choices known now for fields that have them (fixed, or from an earlier step). */
    choices(fields: FormField[], scope: Scope): Map<string, Choice[]>;
    check(fields: FormField[], values: unknown, choices: Map<string, Choice[]>): { ok: true; answers: Record<string, unknown> } | { ok: false; problems: string[] };
  };
  table?: (t: TableDef, def: TableStepCode, scope: Scope, store: Store) => Promise<unknown>;
}

/** AI steps: the organization's AI (AI_PROVIDER) or the key a step names, from the environment. */
export interface AiSteps {
  run(step: AiStep, input: unknown, secret: (service: string) => Promise<string | null>): Promise<unknown>;
}

export class EngineError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(code);
  }
}

/** A step waiting for a sign-off because text an AI wrote could steer it (its errorType while it waits). */
const GUARD = 'awaiting_sign_off';

/** What a guarded step will do, every value resolved, and its hash: what its sign-off covers (as src/flows/sign-off.ts). */
function signOffOf(def: StepCode, scope: Scope): { values: unknown; sha256: string } {
  let values: unknown;
  switch (def.type) {
    case 'action': {
      const base = { module: def.module, action: def.action };
      if (!def.forEach) values = { ...base, input: def.input(scope) };
      else {
        const list = def.forEach(scope);
        if (!Array.isArray(list) || list.length > 100) throw new TemplateError();
        values = { ...base, each: list.map((item) => def.input({ ...scope, item })) };
      }
      break;
    }
    case 'table':
      values = { table: def.table, op: def.op, key: def.key?.(scope), values: def.values?.(scope), column: def.column, by: def.by?.(scope) };
      break;
    case 'flow':
      values = { runs: def.runs.map((r) => ({ id: r.id, flow: r.flow, input: r.input(scope) })) };
      break;
    default:
      values = { type: def.type };
  }
  return { values, sha256: sha256Hex(canonicalJson(values)) };
}
const UNCERTAIN = new Set(['network_error', 'upstream_timeout', 'action_timeout', 'sandbox_exited']);
const MAX_NESTING = 5;
const now = () => new Date().toISOString();

export class AppEngine {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private readonly retry: { autoRetries: number; backoffMs: number };

  constructor(private readonly d: EngineDeps) {
    this.retry = d.retry ?? { autoRetries: 2, backoffMs: 2000 };
  }

  // ---------------------------------------------------------------- start and resume

  /** Start a run of a Flow; it advances in the background. */
  async start(flowKey: string, inputs: unknown, parent: RunRecord['parent'] = null): Promise<RunRecord> {
    const flow = this.d.flows.get(flowKey);
    if (!flow) throw new EngineError('not_found', 404);
    const problems = ajv.explain(flow.inputs, inputs ?? {});
    if (problems.length) throw new EngineError('invalid_inputs', 400, problems.join('; '));
    const run: RunRecord = {
      id: randomUUID(),
      flow: flow.key,
      status: 'running',
      waitReason: null,
      createdAt: now(),
      finishedAt: null,
      inputs: inputs ?? {},
      steps: flow.steps.map((s) => ({ id: s.id, status: 'pending', attempts: 0, errorType: null })),
      parent,
      notified: [],
      expiresAt: null,
    };
    await this.d.store.putRun(run);
    this.kick(run.id);
    return run;
  }

  /** After a restart: carry on with every run that was going. */
  async resume(): Promise<number> {
    const runs = await this.d.store.activeRuns();
    for (const r of runs) if (r.status !== 'paused') this.kick(r.id);
    return runs.length;
  }

  /** Advance a run soon, outside the caller's turn. */
  kick(runId: string, delayMs = 0): void {
    if (this.closed) return;
    const prev = this.timers.get(runId);
    if (prev && delayMs > 0) return; // the earlier timer will do
    if (prev) clearTimeout(prev);
    // Timers hold at most ~24.8 days; a longer delay checks again then.
    const t = setTimeout(() => {
      this.timers.delete(runId);
      void this.advance(runId);
    }, Math.min(delayMs, 2_000_000_000));
    t.unref?.();
    this.timers.set(runId, t);
  }

  /** Wait until the run stops moving (finished, waiting or paused), up to `ms`. */
  async settle(runId: string, ms: number): Promise<RunRecord | null> {
    const until = Date.now() + ms;
    for (;;) {
      await this.locks.get(runId);
      const run = await this.d.store.getRun(runId);
      const left = until - Date.now();
      if (!run || run.status !== 'running' || left <= 0) return run;
      // Woken when the run's next turn ends (or soon anyway, for a step another turn started).
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(runId) ?? new Set();
        this.waiters.set(runId, set);
        const done = () => {
          clearTimeout(t);
          set.delete(done);
          if (!set.size) this.waiters.delete(runId);
          resolve();
        };
        const t = setTimeout(done, Math.min(left, 250));
        set.add(done);
      });
    }
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** One thing at a time per run: steps, decisions and answers never interleave. */
  private locked<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(runId, tail);
    void tail.then(() => {
      if (this.locks.get(runId) === tail) this.locks.delete(runId);
    });
    return next;
  }

  // ---------------------------------------------------------------- people

  /** `valuesSha256`: the hash of the values the approver saw (a guarded step's signOff); changed meanwhile, the decision is refused. */
  async decide(runId: string, stepId: string, decision: 'approved' | 'rejected', valuesSha256?: string): Promise<void> {
    await this.locked(runId, async () => {
      const run = await this.d.store.getRun(runId);
      const rec = run?.steps.find((s) => s.id === stepId);
      const def = run ? this.flow(run).steps.find((s) => s.id === stepId) : undefined;
      const guard = rec?.status === 'waiting' && rec.errorType === GUARD;
      if (!run || !rec || (def?.type !== 'approval' && !guard) || rec.status !== 'waiting' || rec.decision) throw new EngineError('not_waiting_for_approval', 409);
      if (guard && valuesSha256 !== undefined && valuesSha256 !== rec.signOff?.sha256) throw new EngineError('sign_off_values_changed', 409);
      rec.decision = { decision, at: now(), valuesSha256: guard ? (rec.signOff?.sha256 ?? null) : null };
      await this.d.store.putRun(run);
    });
    this.kick(runId);
  }

  async submitInput(runId: string, stepId: string, values: unknown): Promise<void> {
    await this.locked(runId, async () => {
      const run = await this.d.store.getRun(runId);
      const rec = run?.steps.find((s) => s.id === stepId);
      const def = run ? this.flow(run).steps.find((s) => s.id === stepId) : undefined;
      if (!run || !rec || def?.type !== 'input' || rec.status !== 'waiting') throw new EngineError('not_waiting_for_input', 409);
      const input = this.kind('input');
      const checked = input.check(def.fields, values, input.choices(def.fields, this.scope(run)));
      if (!checked.ok) throw new EngineError('invalid_answers', 400, checked.problems.join('; '));
      Object.assign(rec, { status: 'succeeded', output: checked.answers, finishedAt: now() });
      run.status = 'running';
      run.waitReason = null;
      await this.d.store.putRun(run);
    });
    this.kick(runId);
  }

  async markNotified(runId: string, stepId: string): Promise<void> {
    await this.locked(runId, async () => {
      const run = await this.d.store.getRun(runId);
      if (!run || run.notified.includes(stepId)) return;
      run.notified.push(stepId);
      await this.d.store.putRun(run);
    });
  }

  /** The form a waiting input step shows: its fields, with the choices and defaults known now. */
  inputView(run: RunRecord, stepId: string) {
    const def = this.flow(run).steps.find((s) => s.id === stepId);
    if (def?.type !== 'input') return undefined;
    const scope = this.scope(run);
    const known = this.kind('input').choices(def.fields, scope);
    let defaults: Record<string, unknown> = {};
    try {
      defaults = def.defaults(scope);
    } catch {
      defaults = {};
    }
    return {
      intro: def.intro,
      fields: def.fields.map((f) => ({
        name: f.name,
        label: f.label,
        help: f.help ?? null,
        widget: f.widget,
        placeholder: f.placeholder ?? null,
        required: f.required === true,
        choices: known.get(f.name) ?? null,
        default: defaults[f.name] ?? null,
        live: false,
      })),
    };
  }


  // ---------------------------------------------------------------- advance

  flow(run: RunRecord): FlowCode {
    const f = this.d.flows.get(run.flow);
    if (!f) throw new EngineError('flow_missing', 500);
    return f;
  }

  scope(run: RunRecord): Scope {
    const steps: Scope['steps'] = {};
    for (const s of run.steps) {
      if (s.status === 'succeeded' && s.output !== undefined) steps[s.id] = { output: s.output };
      // Skipped by its condition: its output is null, as in Dittoly.
      else if (s.status === 'skipped') steps[s.id] = { output: null };
    }
    return { inputs: run.inputs, steps };
  }

  advance(runId: string): Promise<void> {
    return this.locked(runId, async () => {
      const run = await this.d.store.getRun(runId);
      if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
      await this.drive(run);
    })
      .catch(() => undefined)
      .finally(() => {
        for (const wake of [...(this.waiters.get(runId) ?? [])]) wake();
      });
  }

  private async save(run: RunRecord) {
    await this.d.store.putRun(run);
  }

  private async drive(run: RunRecord): Promise<void> {
    const flow = this.flow(run);
    for (let i = 0; i < flow.steps.length; i++) {
      const def = flow.steps[i]!;
      const rec = run.steps[i]!;
      if (rec.status === 'succeeded' || rec.status === 'skipped') continue;

      if (rec.status === 'running') {
        // Left running by a process that stopped. A change may have reached the app: never repeat it blindly.
        if (def.type === 'action' && this.effect(def) === 'write' && !this.idempotent(def)) return this.fail(run, rec, 'uncertain_outcome');
        if (rec.attempts >= 1 + this.retry.autoRetries) return this.fail(run, rec, 'worker_crashed');
        rec.status = 'pending';
      }

      if (rec.status === 'waiting' && rec.errorType === GUARD) {
        // Waiting for a sign-off before a step that text an AI wrote could steer.
        if (!rec.decision) return;
        if (rec.decision.decision === 'rejected') {
          Object.assign(rec, { status: 'failed', errorType: 'sign_off_rejected', finishedAt: now() });
          await this.finish(run, 'failed');
          return;
        }
        // The sign-off covers the values the approver saw. Should the step's values differ now, it asks again.
        if (rec.signOff) {
          let current: { values: unknown; sha256: string };
          try {
            current = signOffOf(def, this.scope(run));
          } catch {
            return this.fail(run, rec, 'template_unresolved');
          }
          if (current.sha256 !== rec.decision.valuesSha256) {
            Object.assign(rec, { decision: undefined, signOff: current });
            await this.save(run);
            this.d.onWaiting?.(run, def.id);
            return;
          }
        }
        Object.assign(rec, { status: 'pending', errorType: null });
        this.setRun(run, 'running', null);
      } else if (rec.status === 'waiting') {
        const next = await this.checkWaiting(run, rec, def);
        if (next === 'continue') continue;
        return;
      }

      if (rec.status !== 'pending') return; // failed or not run: paused or finished

      if (rec.resumeAt && rec.resumeAt > now()) {
        this.kick(run.id, Date.parse(rec.resumeAt) - Date.now());
        return;
      }
      const scope = this.scope(run);
      if (def.when && !this.safely(() => def.when!(scope))) {
        Object.assign(rec, { status: 'skipped', finishedAt: now() });
        continue;
      }
      if (def.guard && !rec.decision) {
        // The approver sees, and signs off, exactly what the step will do.
        let signOff: { values: unknown; sha256: string };
        try {
          signOff = signOffOf(def, scope);
        } catch {
          return this.fail(run, rec, 'template_unresolved');
        }
        Object.assign(rec, { status: 'waiting', startedAt: now(), errorType: GUARD, signOff });
        this.setRun(run, 'waiting', 'approval');
        await this.save(run);
        this.d.onWaiting?.(run, def.id);
        return;
      }
      switch (def.type) {
        case 'approval':
        case 'input':
          Object.assign(rec, { status: 'waiting', startedAt: now() });
          this.setRun(run, 'waiting', def.type === 'approval' ? 'approval' : 'input_needed');
          await this.save(run);
          this.d.onWaiting?.(run, def.id);
          return;
        case 'delay': {
          const resumeAt = new Date(Date.now() + def.seconds * 1000).toISOString();
          Object.assign(rec, { status: 'waiting', startedAt: now(), resumeAt });
          this.setRun(run, 'waiting', 'delay');
          await this.save(run);
          this.kick(run.id, def.seconds * 1000);
          return;
        }
        case 'report':
          try {
            const output = this.kind('report')(def.step, def.items(scope), def.link ? String(def.link(scope)) : undefined);
            Object.assign(rec, { status: 'succeeded', output, startedAt: now(), finishedAt: now() });
          } catch (err) {
            return this.fail(run, rec, err instanceof TemplateError ? 'template_unresolved' : 'report_failed');
          }
          continue;
        case 'table':
          try {
            const t = this.d.tables.get(def.table);
            if (!t) throw new EngineError('table_not_found', 404);
            const output = await this.kind('table')(t, def, scope, this.d.store);
            Object.assign(rec, { status: 'succeeded', output, startedAt: now(), finishedAt: now() });
          } catch (err) {
            return this.fail(run, rec, err instanceof TemplateError ? 'template_unresolved' : err instanceof EngineError ? err.code : codeOf(err) ?? 'table_failed');
          }
          await this.save(run);
          continue;
        case 'flow':
          if (!(await this.startChildren(run, rec, def, scope))) return;
          Object.assign(rec, { status: 'waiting', startedAt: now() });
          this.setRun(run, 'waiting', 'child_flows');
          await this.save(run);
          for (const c of rec.children ?? []) this.kick(c.runId);
          return;
        case 'ai':
          if (!(await this.runAi(run, rec, def, scope))) return;
          continue;
        case 'action':
          if (!(await this.runAction(run, rec, def, scope))) return;
          continue;
      }
    }
    await this.finish(run, 'succeeded');
  }

  private safely(f: () => boolean): boolean {
    try {
      return f();
    } catch {
      return false;
    }
  }

  private setRun(run: RunRecord, status: RunStatus, waitReason: string | null) {
    run.status = status;
    run.waitReason = waitReason;
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') run.finishedAt = now();
  }

  private async checkWaiting(run: RunRecord, rec: StepRecord, def: StepCode): Promise<'continue' | 'stop'> {
    if (def.type === 'approval') {
      if (!rec.decision) return 'stop';
      if (rec.decision.decision === 'approved') {
        Object.assign(rec, { status: 'succeeded', finishedAt: now() });
        this.setRun(run, 'running', null);
        return 'continue';
      }
      Object.assign(rec, { status: 'failed', errorType: 'approval_rejected', finishedAt: now() });
      await this.finish(run, 'failed');
      return 'stop';
    }
    if (def.type === 'input') return 'stop';
    if (def.type === 'delay') {
      if (rec.resumeAt && rec.resumeAt <= now()) {
        Object.assign(rec, { status: 'succeeded', finishedAt: now() });
        this.setRun(run, 'running', null);
        return 'continue';
      }
      if (rec.resumeAt) this.kick(run.id, Date.parse(rec.resumeAt) - Date.now());
      return 'stop';
    }
    if (def.type === 'flow') {
      const kids = await Promise.all((rec.children ?? []).map(async (c) => ({ c, run: await this.d.store.getRun(c.runId) })));
      // The app has no manual retry, so a child that pauses has failed.
      if (kids.some((k) => k.run && (k.run.status === 'running' || k.run.status === 'waiting'))) return 'stop';
      if (kids.length === (def as FlowStepCode).runs.length && kids.every((k) => k.run?.status === 'succeeded')) {
        const output = Object.fromEntries(
          kids.map((k) => [k.c.key, { runId: k.run!.id, status: 'succeeded', steps: Object.fromEntries(k.run!.steps.filter((s) => s.status === 'succeeded' && s.output !== undefined).map((s) => [s.id, s.output])) }]),
        );
        Object.assign(rec, { status: 'succeeded', output, finishedAt: now() });
        this.setRun(run, 'running', null);
        return 'continue';
      }
      await this.fail(run, rec, 'child_flow_failed');
      return 'stop';
    }
    return 'stop';
  }

  // ---------------------------------------------------------------- steps

  private effect(def: ActionStepCode): 'read' | 'write' {
    const m = this.d.modules.get(def.module);
    return m?.manifest.actions.find((a) => a.name === def.action)?.effect === 'read' ? 'read' : 'write';
  }

  /** The module says repeating this write changes nothing more, so a lost answer is retried. */
  private idempotent(def: ActionStepCode): boolean {
    return this.d.modules.get(def.module)?.manifest.actions.find((a) => a.name === def.action)?.idempotent === true;
  }

  /** True when the step succeeded; false when the run stops here (failed, retry later). */
  private async runAction(run: RunRecord, rec: StepRecord, def: ActionStepCode, scope: Scope): Promise<boolean> {
    const mod = this.d.modules.get(def.module);
    const action = mod?.manifest.actions.find((a) => a.name === def.action);
    if (!mod || !action) {
      await this.fail(run, rec, 'module_missing');
      return false;
    }
    let items: unknown[];
    try {
      if (def.forEach) {
        const list = def.forEach(scope);
        if (!Array.isArray(list) || list.length > 100) throw new TemplateError();
        items = list.map((item) => def.input({ ...scope, item }));
      } else items = [def.input(scope)];
    } catch (err) {
      await this.fail(run, rec, err instanceof TemplateError ? 'template_unresolved' : 'input_resolution_failed');
      return false;
    }
    if (!items.every((i) => ajv.validate(action.input, i))) {
      await this.fail(run, rec, 'input_invalid');
      return false;
    }
    const resolved = resolveManifest(mod.manifest, this.d.settings[mod.name] ?? {}, { useDefaults: true });
    if (resolved.missing.length) {
      await this.fail(run, rec, 'module_settings_missing');
      return false;
    }
    if (servicesFor(mod.manifest, action.name).some((svc) => !this.d.credentials[svc])) {
      await this.fail(run, rec, 'missing_credential');
      return false;
    }

    Object.assign(rec, { status: 'running', attempts: rec.attempts + 1, startedAt: now(), errorType: null, resumeAt: undefined });
    this.setRun(run, 'running', null);
    // Recorded before the call, so a restart knows the step may have started.
    await this.save(run);

    const outputs: Record<string, unknown> = { ...(rec.progress ?? {}) };
    let failure: { errorType: string; retryable: boolean } | null = null;
    for (const [i, input] of items.entries()) {
      if (Object.hasOwn(outputs, String(i))) continue;
      const broker = new Broker({
        manifest: resolved.manifest,
        action: action.name,
        resolveSecret: async (svc) => this.d.credentials[svc] ?? null,
        insecureHttpHosts: this.d.insecureHttpHosts,
        internalHosts: this.d.internalHosts,
        ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}),
        ...(this.d.calls ? { calls: this.d.calls } : {}),
        ...(this.d.googleToken ? { googleToken: this.d.googleToken } : {}),
      });
      const r = await this.d.sandbox
        // Warm workers are shared only within one run: another run gets a fresh one.
        .invoke({ moduleFile: mod.file, action: action.name, input, broker, timeoutMs: this.d.actionTimeoutMs ?? 60_000, settings: resolved.settings, caller: run.id })
        .finally(() => broker.close());
      if (broker.violations.length) {
        failure = { errorType: broker.violations[0]!, retryable: false };
        break;
      }
      if (!r.ok) {
        failure = action.effect === 'write' && !action.idempotent && broker.writeSent && UNCERTAIN.has(r.errorType) ? { errorType: 'uncertain_outcome', retryable: false } : r;
        break;
      }
      if (!ajv.validate(action.output, r.output)) {
        failure = { errorType: 'output_schema_mismatch', retryable: false };
        break;
      }
      outputs[String(i)] = r.output;
      if (def.forEach) {
        rec.progress = { ...outputs };
        await this.save(run);
      }
    }
    if (!failure) {
      const output = def.forEach ? items.map((_, i) => outputs[String(i)]) : outputs['0'];
      Object.assign(rec, { status: 'succeeded', output: output ?? null, progress: undefined, finishedAt: now() });
      await this.save(run);
      return true;
    }
    await this.failOrRetry(run, rec, failure);
    return false;
  }

  private async runAi(run: RunRecord, rec: StepRecord, def: AiStepCode, scope: Scope): Promise<boolean> {
    let input: unknown;
    try {
      input = def.input(scope);
    } catch (err) {
      await this.fail(run, rec, err instanceof TemplateError ? 'template_unresolved' : 'input_resolution_failed');
      return false;
    }
    Object.assign(rec, { status: 'running', attempts: rec.attempts + 1, startedAt: now(), errorType: null, resumeAt: undefined });
    this.setRun(run, 'running', null);
    await this.save(run);
    try {
      if (!this.d.aiSteps) throw new EngineError('ai_unavailable', 500);
      const output = await this.d.aiSteps.run(def.step, input, async (svc) => this.d.credentials[svc] ?? null);
      Object.assign(rec, { status: 'succeeded', output, finishedAt: now() });
      await this.save(run);
      return true;
    } catch (err) {
      // AI errors carry a code, and whether trying again may help (rate limits, outages).
      const retryable = (err as { retryable?: unknown })?.retryable === true;
      await this.failOrRetry(run, rec, { errorType: codeOf(err) ?? 'ai_failed', retryable });
      return false;
    }
  }

  /** A step kind's code; src/main.ts passes it whenever a Flow has such a step. */
  private kind<K extends keyof StepKinds>(k: K): NonNullable<StepKinds[K]> {
    const code = this.d.steps?.[k];
    if (!code) throw new EngineError(`${k}_steps_unavailable`, 500);
    return code;
  }

  private async startChildren(run: RunRecord, rec: StepRecord, def: FlowStepCode, scope: Scope): Promise<boolean> {
    let depth = 0;
    for (let cur = run.parent; cur && depth <= MAX_NESTING; depth++) cur = (await this.d.store.getRun(cur.runId))?.parent ?? null;
    if (depth >= MAX_NESTING) {
      await this.fail(run, rec, 'flow_nesting_too_deep');
      return false;
    }
    const planned: { key: string; flow: string; inputs: unknown }[] = [];
    try {
      for (const r of def.runs) {
        const child = this.d.flows.get(r.flow);
        if (!child) throw new EngineError('flow_version', 404);
        const inputs = r.input(scope);
        if (ajv.explain(child.inputs, inputs).length) throw new EngineError('invalid_inputs', 400);
        planned.push({ key: r.id, flow: r.flow, inputs });
      }
    } catch (err) {
      await this.fail(run, rec, err instanceof EngineError ? err.code : err instanceof TemplateError ? 'template_unresolved' : 'child_flow_failed');
      return false;
    }
    rec.children = [];
    for (const p of planned) {
      const child: RunRecord = {
        id: randomUUID(),
        flow: p.flow,
        status: 'running',
        waitReason: null,
        createdAt: now(),
        finishedAt: null,
        inputs: p.inputs,
        steps: this.d.flows.get(p.flow)!.steps.map((s) => ({ id: s.id, status: 'pending', attempts: 0, errorType: null })),
        parent: { runId: run.id, stepId: rec.id, key: p.key },
        notified: [],
        expiresAt: null,
      };
      await this.d.store.putRun(child);
      rec.children.push({ key: p.key, runId: child.id });
    }
    return true;
  }

  // ---------------------------------------------------------------- endings

  private async failOrRetry(run: RunRecord, rec: StepRecord, failure: { errorType: string; retryable: boolean }) {
    if (failure.retryable && rec.attempts < 1 + this.retry.autoRetries) {
      const delay = this.retry.backoffMs * 2 ** (rec.attempts - 1);
      Object.assign(rec, { status: 'pending', errorType: failure.errorType, resumeAt: new Date(Date.now() + delay).toISOString() });
      this.setRun(run, 'waiting', 'retry');
      await this.save(run);
      this.kick(run.id, delay);
      return;
    }
    await this.fail(run, rec, failure.errorType);
  }

  /** A step that cannot go on pauses the run. */
  private async fail(run: RunRecord, rec: StepRecord, errorType: string): Promise<void> {
    Object.assign(rec, { status: 'failed', errorType, finishedAt: now(), progress: undefined });
    this.setRun(run, 'paused', errorType);
    this.expire(run);
    await this.save(run);
    if (run.parent) this.kick(run.parent.runId);
  }

  private expire(run: RunRecord) {
    const days = this.d.retentionDays;
    run.expiresAt = new Date(Date.now() + Math.max(days, 1) * 86_400_000).toISOString();
  }

  private async finish(run: RunRecord, status: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    for (const s of run.steps) if (s.status === 'pending' || s.status === 'waiting' || s.status === 'running') s.status = 'not_run';
    this.setRun(run, status, null);
    this.expire(run);
    // A Super Flow that ends stops the Flows it started.
    for (const s of run.steps) {
      for (const c of s.children ?? []) {
        if (c.runId === run.id) continue;
        const child = await this.d.store.getRun(c.runId);
        if (child && isActive(child)) {
          for (const cs of child.steps) if (cs.status === 'pending' || cs.status === 'waiting' || cs.status === 'running') cs.status = 'not_run';
          this.setRun(child, 'cancelled', null);
          this.expire(child);
          await this.d.store.putRun(child);
        }
      }
    }
    // With no retention, a finished run keeps only its statuses (a Super Flow's children too, once it is done).
    if (this.d.retentionDays === 0 && !run.parent) {
      await this.strip(run);
      for (const s of run.steps) for (const c of s.children ?? []) {
        const child = await this.d.store.getRun(c.runId);
        if (child) await this.d.store.putRun((await this.strip(child), child));
      }
    }
    await this.save(run);
    if (run.parent) this.kick(run.parent.runId);
  }

  private async strip(run: RunRecord) {
    run.inputs = {};
    for (const s of run.steps) delete s.output;
  }
}

function codeOf(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z0-9_]{1,40}$/.test(c) ? c : null;
}

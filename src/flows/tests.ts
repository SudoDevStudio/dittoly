import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Db, Queryable } from '../db/db.js';
import { formatReport } from '../engine/builtin.js';
import type { Engine } from '../engine/engine.js';
import { ajv } from '../modules/manifest.js';
import type { ModuleVersion } from '../modules/registry.js';
import type { FlowDefinition } from './definition.js';
import type { FlowService } from './service.js';
import { evaluate, lookup, resolve, TemplateError, type TemplateScope } from './template.js';

/**
 * Flow tests: a run played with recorded answers instead of real apps. A test gives the run
 * inputs, what each step that talks to an app (or an AI, or another Flow) answers, how sign-offs
 * are decided, and what should come out. It never calls an app: it checks the Flow's own logic,
 * that each step sends an app the inputs its action accepts and gets back what the action
 * promises, conditions, loops, reports and the run's outcome. Approvers see the results of every
 * test on each version before they approve it.
 */

const answerSchema = z
  .object({
    /** The step's output (an action's output, an AI's answer, a form's answers...). */
    output: z.unknown().optional(),
    /** For a step that runs once per item (forEach): one output per item, in order. */
    outputs: z.array(z.unknown()).max(100).optional(),
    /** The step fails with this error instead. */
    fail: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  })
  .strict();

const expectValue = z
  .object({
    /** A path like steps.<id>.output.<field> or inputs.<name>. */
    path: z.string().regex(/^(inputs|steps)(\.[A-Za-z0-9_]+)+$/),
    equals: z.unknown().optional(),
    contains: z.string().max(2000).optional(),
    notEmpty: z.boolean().optional(),
  })
  .strict();

export const testCaseSchema = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    answers: z.record(z.string(), answerSchema).default({}),
    /** Sign-off decisions; a sign-off without one is approved. */
    decisions: z.record(z.string(), z.enum(['approved', 'rejected'])).default({}),
    expect: z
      .object({
        status: z.enum(['succeeded', 'failed']).optional(),
        steps: z.record(z.string(), z.enum(['succeeded', 'skipped', 'failed', 'not_run'])).optional(),
        values: z.array(expectValue).max(50).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type TestCase = z.infer<typeof testCaseSchema>;

export interface StepResult { id: string; status: 'succeeded' | 'skipped' | 'failed' | 'not_run'; error?: string; output?: unknown }
export interface TestResult { testId: string; name: string; passed: boolean; status: 'succeeded' | 'failed'; problems: string[]; steps: StepResult[] }

/** Play one test against a version's definition, with the version's pinned modules for their schemas. */
export function playTest(def: FlowDefinition, modules: Map<string, ModuleVersion>, test: TestCase): { status: 'succeeded' | 'failed'; steps: StepResult[]; problems: string[] } {
  const problems: string[] = [];
  const steps: StepResult[] = def.steps.map((s) => ({ id: s.id, status: 'not_run' }));
  const scope: TemplateScope = { inputs: test.inputs, steps: {} };
  /**
   * What each step would send the app, kept for the test's own checks ("who would this message go to?"). It is NOT
   * in the scope the Flow's templates read, because a run has no such path: an example that passes here must pass
   * there too.
   */
  const sent: Record<string, unknown> = {};
  const inputProblems = ajv.explain(def.inputs, test.inputs);
  if (inputProblems.length) {
    problems.push(`the test's inputs do not fit the Flow's inputs: ${inputProblems.join('; ')}`);
    return { status: 'failed', steps, problems };
  }
  let status = 'succeeded' as 'succeeded' | 'failed';
  const fail = (i: number, error: string) => {
    steps[i] = { id: def.steps[i]!.id, status: 'failed', error };
    status = 'failed';
  };
  const done = (i: number, output: unknown) => {
    steps[i] = { id: def.steps[i]!.id, status: 'succeeded', ...(output === undefined ? {} : { output }) };
    if (output !== undefined) scope.steps[def.steps[i]!.id] = { output };
  };
  for (const [i, step] of def.steps.entries()) {
    try {
      if (step.when && !evaluate(step.when, scope)) {
        steps[i] = { id: step.id, status: 'skipped' };
        continue;
      }
    } catch {
      fail(i, 'template_unresolved');
      break;
    }
    const answer = test.answers[step.id];
    if (answer?.fail) {
      fail(i, answer.fail);
      break;
    }
    try {
      switch (step.type) {
        case 'approval':
          if ((test.decisions[step.id] ?? 'approved') === 'rejected') fail(i, 'approval_rejected');
          else done(i, undefined);
          break;
        case 'delay':
          done(i, undefined);
          break;
        case 'report':
          done(i, formatReport(step, resolve(step.items, scope), step.link ? String(resolve(step.link, scope)) : undefined));
          break;
        case 'action': {
          const mv = modules.get(step.module);
          const action = mv?.manifest.actions.find((a) => a.name === step.action);
          if (!action) throw new Problem(`step ${step.id}: ${step.module} has no action ${step.action}`);
          let items: unknown[];
          if (step.forEach) {
            const list = resolve(step.forEach, scope);
            if (!Array.isArray(list) || list.length > 100) throw new TemplateError();
            items = list.map((item) => resolve(step.input, { ...scope, item }));
          } else items = [resolve(step.input, scope)];
          sent[step.id] = step.forEach ? items : items[0];
          // What the step would send the app must be what the action accepts.
          for (const [n, input] of items.entries()) {
            const why = ajv.explain(action.input, input);
            if (why.length) {
              problems.push(`step ${step.id}${step.forEach ? ` item ${n + 1}` : ''} would send ${step.action} inputs it does not accept: ${why.join('; ')}`);
              throw new StepFailed('input_invalid');
            }
          }
          if (!answer) throw new Problem(`step ${step.id}: the test has no recorded answer for it`);
          const outs = step.forEach ? (answer.outputs ?? items.map(() => answer.output)) : [answer.output];
          if (outs.length !== items.length) throw new Problem(`step ${step.id}: ${items.length} item(s) but ${outs.length} recorded output(s)`);
          // And the recorded answer must be what the action promises to return.
          for (const [n, out] of outs.entries()) {
            const why = ajv.explain(action.output, out);
            if (why.length) throw new Problem(`step ${step.id}${step.forEach ? ` item ${n + 1}` : ''}: the recorded answer does not match ${step.action}'s output: ${why.join('; ')}`);
          }
          done(i, step.forEach ? outs : outs[0]);
          break;
        }
        default: {
          // Forms, AI and browser steps, apps, other Flows and tables: their recorded answers stand in.
          if (step.type === 'table' || step.type === 'ai' || step.type === 'browse' || step.type === 'app' || step.type === 'fix' || step.type === 'flow') {
            // Still resolve what the step would use, so a broken template shows up.
            if (step.type === 'table') {
              const [key, values] = resolve([step.key ?? '', step.values ?? {}, step.by ?? '', step.where?.equals ?? ''], scope) as unknown[];
              sent[step.id] = { key, values };
            }
            if (step.type === 'ai') sent[step.id] = resolve(step.input, scope);
            if (step.type === 'browse') resolve([step.url, step.checks], scope);
            if (step.type === 'app') resolve([step.repo, step.ref], scope);
            if (step.type === 'fix') resolve([step.repo, step.ref, step.instruction, step.context, step.limits?.onlyFilesIn ?? ''], scope);
            if (step.type === 'flow') resolve(step.runs.map((r) => r.input), scope);
          }
          if (!answer || (answer.output === undefined && answer.outputs === undefined)) throw new Problem(`step ${step.id} (${step.type}): the test has no recorded answer for it`);
          done(i, answer.output ?? answer.outputs);
        }
      }
    } catch (err) {
      if (err instanceof Problem) {
        problems.push(err.message);
        fail(i, 'test_problem');
      } else if (err instanceof StepFailed) fail(i, err.code);
      else if (err instanceof TemplateError) fail(i, 'template_unresolved');
      else throw err;
      break;
    }
    if (steps[i]!.status === 'failed') break;
  }

  // Compare with what the test expects.
  const e = test.expect;
  if (e.status && e.status !== status) problems.push(`the run ${status === 'failed' ? `failed at ${steps.find((s) => s.status === 'failed')?.id} (${steps.find((s) => s.status === 'failed')?.error})` : 'succeeded'}, expected it to ${e.status === 'failed' ? 'fail' : 'succeed'}`);
  for (const [id, want] of Object.entries(e.steps ?? {})) {
    const got = steps.find((s) => s.id === id);
    if (!got) problems.push(`expected a step ${id}, but the Flow has none`);
    else if (got.status !== want) problems.push(`step ${id} ${got.status}, expected ${want}`);
  }
  // "steps.<id>.input…" asks what the step would have sent; everything else is read from the run as it played.
  const checked: TemplateScope = {
    inputs: scope.inputs,
    steps: Object.fromEntries(def.steps.map((s) => [s.id, { ...(scope.steps[s.id] ?? {}), ...(s.id in sent ? { input: sent[s.id] } : {}) }])),
  } as TemplateScope;
  for (const v of e.values ?? []) {
    let got: unknown;
    try {
      got = lookup(checked, v.path);
    } catch {
      problems.push(`${v.path}: nothing there`);
      continue;
    }
    if (v.equals !== undefined && JSON.stringify(got) !== JSON.stringify(v.equals)) problems.push(`${v.path} is ${JSON.stringify(got)}, expected ${JSON.stringify(v.equals)}`);
    if (v.contains !== undefined && !(typeof got === 'string' ? got : JSON.stringify(got)).includes(v.contains)) problems.push(`${v.path} does not contain "${v.contains}"`);
    if (v.notEmpty && (got === null || got === undefined || got === '' || (Array.isArray(got) && got.length === 0))) problems.push(`${v.path} is empty`);
  }
  return { status, steps, problems };
}

class Problem extends Error {}
class StepFailed extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// ---------------------------------------------------------------- stored tests

export class FlowTests {
  constructor(private readonly db: Db, private readonly cipher: Cipher, private readonly flows: FlowService, private readonly engine: Engine) {}

  private aad(id: string) {
    return `flow-test:${id}:case`;
  }

  /** The Flow's owner, its team's admins and org admins manage its tests. */
  private async assertManage(db: Queryable, actor: Member, flowId: string): Promise<void> {
    const f = (await db.query<{ created_by: string; team_id: string }>(`SELECT created_by, team_id FROM flows WHERE id = $1`, [flowId])).rows[0];
    if (!f) throw notFound('flow');
    if (actor.role === 'admin' || f.created_by === actor.id) return;
    const admin = await db.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2 AND role = 'admin'`, [f.team_id, actor.id]);
    if (!admin.rowCount) throw forbidden('owner_only');
  }

  async list(actor: Member, flowId: string): Promise<{ id: string; name: string; case: TestCase; updatedAt: Date }[]> {
    await this.flows.assertCanSee(this.db, actor, { flowId });
    return this.load(this.db, flowId);
  }

  /** A Flow's test cases, for Dittoly's own checks (self-fixing); people use list(). */
  async casesFor(flowId: string): Promise<{ name: string; case: TestCase }[]> {
    return (await this.load(this.db, flowId)).map((t) => ({ name: t.name, case: t.case }));
  }

  private async load(db: Queryable, flowId: string) {
    const { rows } = await db.query<{ id: string; name: string; case_enc: string; updated_at: Date }>(
      `SELECT id, name, case_enc, updated_at FROM flow_tests WHERE flow_id = $1 ORDER BY created_at`,
      [flowId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, case: testCaseSchema.parse(this.cipher.decryptJson(r.case_enc, this.aad(r.id))), updatedAt: r.updated_at }));
  }

  async save(actor: Member, flowId: string, body: unknown, testId?: string): Promise<{ id: string }> {
    await this.assertManage(this.db, actor, flowId);
    const b = z.object({ name: z.string().trim().min(1).max(120), case: testCaseSchema }).strict().safeParse(body);
    if (!b.success) throw badRequest('invalid_test', b.error.issues.map((i) => `${i.path.join('.') || 'test'}: ${i.message}`).join('; '));
    const encoded = JSON.stringify(b.data.case);
    if (encoded.length > 500_000) throw badRequest('invalid_test', 'a test holds at most 500 KB');
    let id = testId;
    if (id) {
      const r = await this.db.query(`UPDATE flow_tests SET name = $3, case_enc = $4, updated_at = now() WHERE id = $1 AND flow_id = $2`, [id, flowId, b.data.name, this.cipher.encryptJson(b.data.case, this.aad(id))]);
      if (!r.rowCount) throw notFound('test');
    } else {
      const count = (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM flow_tests WHERE flow_id = $1`, [flowId])).rows[0]!.n;
      if (count >= 50) throw badRequest('too_many_tests', 'at most 50 tests per Flow');
      id = (await this.db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      await this.db.query(`INSERT INTO flow_tests (id, flow_id, name, case_enc, created_by) VALUES ($1, $2, $3, $4, $5)`, [id, flowId, b.data.name, this.cipher.encryptJson(b.data.case, this.aad(id)), actor.id]);
    }
    await audit(this.db, { actorId: actor.id, action: testId ? 'flow.test_changed' : 'flow.test_added', subjectType: 'flow', subjectId: flowId, outcome: 'ok', relatedId: id });
    return { id };
  }

  async remove(actor: Member, flowId: string, testId: string): Promise<void> {
    await this.assertManage(this.db, actor, flowId);
    const r = await this.db.query(`DELETE FROM flow_tests WHERE id = $1 AND flow_id = $2`, [testId, flowId]);
    if (!r.rowCount) throw notFound('test');
    await audit(this.db, { actorId: actor.id, action: 'flow.test_removed', subjectType: 'flow', subjectId: flowId, outcome: 'ok', relatedId: testId });
  }

  /**
   * A test from a finished run of yours: its inputs, every step's actual output as the recorded
   * answer, how its sign-offs were decided, and its outcome as what to expect.
   */
  async fromRun(actor: Member, runId: string, name: string): Promise<{ id: string; flowId: string }> {
    const view = await this.engine.runView(runId, actor);
    if (view.runAs !== actor.id) throw forbidden('own_runs_only');
    if (view.status !== 'succeeded' && view.status !== 'failed') throw badRequest('run_not_finished');
    if (view.dry) throw badRequest('dry_run', 'a dry run skipped its changes; use a real run');
    const decisions = Object.fromEntries(
      (await this.db.query<{ step_id: string; decision: 'approved' | 'rejected' }>(`SELECT step_id, decision FROM gate_decisions WHERE run_id = $1`, [runId])).rows.map((r) => [r.step_id, r.decision]),
    );
    const answers: TestCase['answers'] = {};
    for (const s of view.steps) {
      if (s.type === 'approval' || s.type === 'delay' || s.type === 'report') continue;
      if (s.status === 'succeeded' && s.output !== undefined) answers[s.id] = Array.isArray(s.output) && s.type === 'action' ? { outputs: s.output } : { output: s.output };
      else if (s.status === 'failed' && s.errorType) answers[s.id] = { fail: /^[a-z0-9_]{1,40}$/.test(s.errorType) ? s.errorType : 'step_failed' };
    }
    const testCase: TestCase = {
      inputs: (view.inputs ?? {}) as Record<string, unknown>,
      answers,
      decisions,
      expect: {
        status: view.status,
        steps: Object.fromEntries(view.steps.map((s) => [s.id, (['succeeded', 'skipped', 'failed'].includes(s.status) ? s.status : 'not_run') as 'succeeded' | 'skipped' | 'failed' | 'not_run'])),
      },
    };
    const { id } = await this.save(actor, view.flowId, { name, case: testCase });
    return { id, flowId: view.flowId };
  }

  /**
   * The examples the AI wrote with a draft, kept as the Flow's own tests, and played at once against the version
   * it drafted. A Flow that compiles can still do the wrong thing; this is where that shows, before an approver
   * reads it. One bad example never costs the draft: it is left out and named in `problems`.
   */
  async keepDrafted(flowId: string, versionId: string, tests: { name: string; case: TestCase }[], askedBy: string): Promise<{ total: number; passed: number; results: TestResult[] }> {
    const version = await this.flows.getVersion(this.db, versionId);
    if (!version) throw notFound('flow_version');
    const existing = await this.load(this.db, flowId);
    const taken = new Set(existing.map((t) => t.name));
    let modules: Map<string, ModuleVersion>;
    try {
      modules = await this.flows.pinnedModules(this.db, version.definition);
    } catch {
      modules = new Map();
    }
    const results: TestResult[] = [];
    for (const t of tests.slice(0, 3)) {
      // The same ceiling a person's tests have.
      if (existing.length + results.length >= 50) break;
      const name = taken.has(t.name) ? `${t.name} (${results.length + 1})`.slice(0, 70) : t.name;
      taken.add(name);
      const played = playTest(version.definition, modules, t.case);
      // Kept under the person who asked for the draft; the version's own record says the AI wrote it.
      const id = (await this.db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      await this.db.query(`INSERT INTO flow_tests (id, flow_id, name, case_enc, created_by) VALUES ($1, $2, $3, $4, $5)`, [
        id,
        flowId,
        name,
        this.cipher.encryptJson(t.case, this.aad(id)),
        askedBy,
      ]);
      results.push({ testId: id, name, passed: played.problems.length === 0, status: played.status, problems: played.problems, steps: played.steps });
    }
    const out = { total: results.length, passed: results.filter((r) => r.passed).length, results };
    // Kept with the version, so its review says how many examples it came with and how many passed.
    await this.db.query(
      `UPDATE flow_versions SET generation = coalesce(generation, '{}'::jsonb) || jsonb_build_object('examples', jsonb_build_object('total', $2::int, 'passed', $3::int)) WHERE id = $1`,
      [versionId, out.total, out.passed],
    );
    return out;
  }

  /** Every test of the Flow, played against this version. */
  async results(actor: Member, versionId: string): Promise<{ total: number; passed: number; results: TestResult[] }> {
    const version = await this.flows.getVersion(this.db, versionId);
    if (!version) throw notFound('flow_version');
    await this.flows.assertCanSee(this.db, actor, { flowId: version.flowId });
    let modules: Map<string, ModuleVersion>;
    try {
      modules = await this.flows.pinnedModules(this.db, version.definition);
    } catch {
      modules = new Map();
    }
    const results = (await this.load(this.db, version.flowId)).map((t) => {
      const r = playTest(version.definition, modules, t.case);
      return { testId: t.id, name: t.name, passed: r.problems.length === 0, status: r.status, problems: r.problems, steps: r.steps };
    });
    return { total: results.length, passed: results.filter((r) => r.passed).length, results };
  }
}

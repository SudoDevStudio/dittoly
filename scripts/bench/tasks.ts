/**
 * Task benchmark: does Dittoly build what a person actually asked for? Where scripts/bench/ai-model.ts asks
 * whether a model can write something Dittoly accepts, this asks the harder question — whether the automation does
 * the job. Each task in scripts/bench/tasks.json is a real request with what the answer must contain and must not,
 * and every draft is judged against the task, not against its own ambition.
 *
 *   DITTOLY_AI_PROVIDER=ollama DITTOLY_AI_MODEL=gemma4:26b npm run bench:tasks
 *   DITTOLY_AI_PROVIDER=anthropic npm run bench:tasks        (a baseline to compare against)
 *
 * Options (env): BENCH_TASKS (a file of tasks; default scripts/bench/tasks.json), BENCH_ONLY (comma-separated task
 * names), BENCH_TRIES (1), BENCH_OUT (write the Markdown report there too), BENCH_REPAIR (1: how many times a draft
 * that Dittoly refuses is sent back to the model with the problems, as the app itself does), BENCH_MOCK (a JSON
 * file of answers, with DITTOLY_AI_PROVIDER=mock: judges drafts you already have, and tests this harness).
 *
 * What is measured, per task and in total:
 *   first-attempt success   accepted by Dittoly AND does what the task asked, with no repair round
 *   success                 the same, after the repair rounds the app itself would do
 *   needs correction        Dittoly accepts it, but a person would have to change it (a "must" is missing)
 *   refused                 the model said it cannot, when the task says it can
 *   broken                  nothing usable came back
 *   tokens, seconds         what it cost and how long it took, per successful task
 * A task marked "cannotDraft" passes only when the model refuses it: inventing an action is a failure.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProvider } from '../../src/ai/factory.js';
import { draftFlow, type CatalogAction } from '../../src/ai/generate-flow.js';
import { AiError, MockProvider, type AiProvider } from '../../src/ai/provider.js';
import { setLogSink } from '../../src/core/log.js';
import { parseFlowDefinition, type FlowDefinition } from '../../src/flows/definition.js';
import { checkSettings, checkStepInputs } from '../../src/flows/service.js';
import { optionalServicesFor, parseManifest, servicesFor } from '../../src/modules/manifest.js';
import type { ModuleVersion } from '../../src/modules/registry.js';
import type { AiProviderId, DeploymentMode } from '../../src/config.js';

setLogSink(() => undefined);

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules');
const TRIES = Math.max(1, Number(process.env.BENCH_TRIES ?? 1));
const REPAIRS = Math.max(0, Number(process.env.BENCH_REPAIR ?? 1));
const ONLY = (process.env.BENCH_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);

interface Task {
  name: string;
  department: string;
  request: string;
  must?: {
    /** Action names that must be called (any module). */
    actions?: string[];
    /** Step types that must be there: ai, approval, table, fix… */
    stepTypes?: string[];
    /** Table operations that must be used. */
    tableOps?: string[];
    /** How many values the run form must ask for, at least. */
    inputs?: number;
    /** No more steps than this: one job per step, not a tour. */
    maxSteps?: number;
    /** A person must sign off before the first step that changes anything. */
    approvalBeforeWrite?: boolean;
    /** Something that changes data must be behind a condition ("only if there are any"). */
    conditionOnWrite?: boolean;
    /** The write must use what an earlier step found, not a value written into the Flow. */
    writeUsesEarlierOutput?: boolean;
    /** Rows are remembered by the fingerprint of a text, not by a whole message. */
    fingerprint?: boolean;
    /** The Flow declares the table it needs instead of asking a person to make one. */
    declaresTable?: boolean;
    /** A put that writes back what the Flow read says which revision it read. */
    ifRevision?: boolean;
    /** Pushing is behind the fix step's own verdict (autoApproveWhen). */
    evidenceGate?: boolean;
    /** What a module is told comes from the run form, not a value written into the Flow. */
    settingFromRun?: boolean;
    /** The model must refuse: no approved module can do this. */
    cannotDraft?: boolean;
  };
  mustNot?: { actions?: string[]; stepTypes?: string[] };
}

type Verdict = 'first_attempt' | 'after_repair' | 'needs_correction' | 'refused' | 'broken';
interface Attempt { verdict: Verdict; seconds: number; tokens: number; why: string[]; rounds: number }

/** Every fixture module, as the drafting catalog and the Flow checks see them. */
async function fixtures(): Promise<{ catalog: CatalogAction[]; modules: Map<string, ModuleVersion> }> {
  const catalog: CatalogAction[] = [];
  const modules = new Map<string, ModuleVersion>();
  for (const name of (await readdir(FIXTURES, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const parsed = parseManifest(JSON.parse(await readFile(path.join(FIXTURES, name, 'manifest.json'), 'utf8')));
    if (!parsed.ok) continue;
    const manifest = parsed.manifest;
    const ref = `${manifest.name}@${manifest.version}`;
    modules.set(ref, { name: manifest.name, version: manifest.version, manifest } as ModuleVersion);
    for (const a of manifest.actions) {
      catalog.push({
        module: ref,
        moduleTitle: manifest.title,
        action: a.name,
        title: a.title,
        description: a.description,
        effect: a.effect,
        input: a.input,
        output: a.output,
        access: { required: servicesFor(manifest, a.name), optional: optionalServicesFor(manifest, a.name) },
        ...(manifest.settings?.length ? { settings: manifest.settings } : {}),
      });
    }
  }
  return { catalog, modules };
}

const writes = (def: FlowDefinition, modules: Map<string, ModuleVersion>) =>
  def.steps.filter(
    (s) =>
      (s.type === 'action' && modules.get(s.module)?.manifest.actions.find((a) => a.name === s.action)?.effect === 'write') ||
      (s.type === 'table' && s.op !== 'get' && s.op !== 'list') ||
      s.type === 'app' ||
      s.type === 'fix',
  );

/** What the task asked for, checked against what was drafted. Every "no" is one line a person would have to fix. */
function judge(task: Task, def: FlowDefinition, modules: Map<string, ModuleVersion>): string[] {
  const why: string[] = [];
  const m = task.must ?? {};
  const actions = def.steps.flatMap((s) => (s.type === 'action' ? [s.action] : []));
  const types = new Set(def.steps.map((s) => s.type));
  const text = JSON.stringify(def);
  for (const a of m.actions ?? []) if (!actions.includes(a)) why.push(`does not call ${a}`);
  for (const t of m.stepTypes ?? []) if (!types.has(t as (typeof def.steps)[number]['type'])) why.push(`has no ${t} step`);
  for (const op of m.tableOps ?? []) if (!def.steps.some((s) => s.type === 'table' && s.op === op)) why.push(`no table step that does "${op}"`);
  for (const a of task.mustNot?.actions ?? []) if (actions.includes(a)) why.push(`calls ${a}, which the task does not ask for`);
  for (const t of task.mustNot?.stepTypes ?? []) if (types.has(t as (typeof def.steps)[number]['type'])) why.push(`has a ${t} step, which the task does not ask for`);
  if (m.inputs !== undefined && Object.keys((def.inputs as { properties?: object }).properties ?? {}).length < m.inputs) {
    why.push(`asks for fewer than ${m.inputs} values when the run starts`);
  }
  if (m.maxSteps !== undefined && def.steps.length > m.maxSteps) why.push(`${def.steps.length} steps, more than the ${m.maxSteps} the task needs`);
  const changing = writes(def, modules);
  if (m.approvalBeforeWrite) {
    const firstWrite = def.steps.findIndex((s) => changing.includes(s));
    const approval = def.steps.findIndex((s) => s.type === 'approval');
    if (approval === -1 || firstWrite === -1 || approval > firstWrite) why.push('changes something before anyone signs off');
  }
  if (m.conditionOnWrite && changing.length && !changing.some((s) => s.when)) why.push('changes something whatever was found, with no condition');
  if (m.writeUsesEarlierOutput && !changing.some((s) => JSON.stringify(s).includes('steps.'))) why.push('writes a value of its own instead of what an earlier step found');
  if (m.fingerprint && !text.includes('fingerprint(')) why.push('does not key its table by the error’s fingerprint');
  if (m.declaresTable && !(def.tables ?? []).length && types.has('table')) why.push('uses a table without declaring it, so somebody has to make it by hand');
  if (m.ifRevision && !def.steps.some((s) => s.type === 'table' && s.op === 'put' && s.ifRevision !== undefined)) {
    why.push('writes back what it read without saying which revision it read');
  }
  if (m.evidenceGate && !def.steps.some((s) => s.type === 'action' && s.autoApproveWhen)) why.push('pushes without the fix step’s own verdict behind it');
  if (m.settingFromRun) {
    const told = JSON.stringify(def.moduleSettings ?? {}) + JSON.stringify(def.steps.flatMap((s) => (s.type === 'action' ? [s.settings ?? {}] : [])));
    if (!told.includes('inputs.')) why.push('writes the site into the Flow instead of asking for it when the run starts');
  }
  return why;
}

async function run(task: Task, provider: AiProvider, fx: Awaited<ReturnType<typeof fixtures>>): Promise<Attempt> {
  const started = Date.now();
  let tokens = 0;
  const counted: AiProvider = {
    id: provider.id,
    generateJson: (req) => provider.generateJson({ ...req, onUsage: (u) => (tokens += u.inputTokens + u.outputTokens) }),
  };
  const secs = () => Math.round((Date.now() - started) / 100) / 10;
  let previous: { definition: unknown; feedback: string; problems?: string } | undefined;
  const out = (verdict: Verdict, why: string[], rounds: number): Attempt => ({ verdict, seconds: secs(), tokens, why, rounds });

  for (let round = 0; round <= REPAIRS; round++) {
    let drafted;
    try {
      drafted = await draftFlow(counted, task.request, fx.catalog, previous);
    } catch (err) {
      const ai = err instanceof AiError ? err : null;
      return out('broken', [ai ? `${ai.code}${ai.detail ? `: ${ai.detail}` : ''}` : String(err)], round);
    }
    if (drafted.definition === null || drafted.definition === undefined) {
      const said = drafted.missing?.map((x) => x.capability).join('; ') || drafted.explanation.slice(0, 160);
      if (task.must?.cannotDraft) return out(round === 0 ? 'first_attempt' : 'after_repair', [], round);
      return out('refused', [`said it cannot: ${said}`], round);
    }
    if (task.must?.cannotDraft) return out('needs_correction', ['drafted a Flow although no approved module can do it'], round);
    const parsed = parseFlowDefinition(drafted.definition);
    if (!parsed.ok) {
      previous = { definition: drafted.definition, feedback: 'Fix the validation problems and keep everything else the same.', problems: parsed.issues.join('; ') };
      if (round === REPAIRS) return out('broken', [`definition rejected: ${parsed.issues.slice(0, 2).join('; ')}`], round);
      continue;
    }
    const unknown = parsed.definition.steps.filter((s) => s.type === 'action' && !fx.modules.has(s.module));
    const issues = unknown.length
      ? [`uses modules that are not in the catalog: ${[...new Set(unknown.map((s) => (s.type === 'action' ? s.module : '')))].join(', ')}`]
      : [...checkStepInputs(parsed.definition, fx.modules), ...checkSettings(parsed.definition, fx.modules)];
    if (issues.length) {
      previous = { definition: drafted.definition, feedback: 'Fix the validation problems and keep everything else the same.', problems: issues.join('; ') };
      if (round === REPAIRS) return out('broken', issues.slice(0, 2), round);
      continue;
    }
    const why = judge(task, parsed.definition, fx.modules);
    if (why.length) return out('needs_correction', why, round);
    return out(round === 0 ? 'first_attempt' : 'after_repair', [], round);
  }
  return out('broken', ['no draft'], REPAIRS);
}

const MARK: Record<Verdict, string> = { first_attempt: '✓', after_repair: '✓′', needs_correction: '~', refused: '✗', broken: '✗' };

async function main(): Promise<void> {
  const id = (process.env.DITTOLY_AI_PROVIDER ?? 'none') as AiProviderId;
  const mode = (process.env.DITTOLY_MODE ?? 'local') as DeploymentMode;
  const num = (name: string) => (process.env[name] === undefined ? undefined : Number(process.env[name]));
  const provider = createProvider(mode, id, {
    model: process.env.DITTOLY_AI_MODEL,
    ollamaUrl: process.env.DITTOLY_OLLAMA_URL,
    ollama: {
      ...(num('DITTOLY_OLLAMA_NUM_CTX') !== undefined ? { maxContext: num('DITTOLY_OLLAMA_NUM_CTX')! } : {}),
      ...(num('DITTOLY_AI_TEMPERATURE') !== undefined ? { temperature: num('DITTOLY_AI_TEMPERATURE')! } : {}),
      ...(num('DITTOLY_AI_TOP_P') !== undefined ? { topP: num('DITTOLY_AI_TOP_P')! } : {}),
      ...(num('DITTOLY_AI_TOP_K') !== undefined ? { topK: num('DITTOLY_AI_TOP_K')! } : {}),
    },
  });
  if (!provider) {
    console.error('Set DITTOLY_AI_PROVIDER (and DITTOLY_AI_MODEL for ollama) to the model to benchmark.');
    process.exit(2);
  }
  // Answers from a file instead of a model (BENCH_MOCK with DITTOLY_AI_PROVIDER=mock): how this harness is tested,
  // and how a draft kept from an earlier run is judged again after the rules change.
  if (provider instanceof MockProvider && process.env.BENCH_MOCK) {
    for (const answer of JSON.parse(await readFile(process.env.BENCH_MOCK, 'utf8')) as Record<string, unknown>[]) provider.enqueue(answer);
  }
  const file = process.env.BENCH_TASKS ?? path.join(import.meta.dirname, 'tasks.json');
  const all = (JSON.parse(await readFile(file, 'utf8')) as { tasks: Task[] }).tasks;
  const tasks = ONLY.length ? all.filter((t) => ONLY.includes(t.name)) : all;
  const fx = await fixtures();
  console.log(`Model: ${process.env.DITTOLY_AI_MODEL ?? id} (${id}) · ${tasks.length} tasks × ${TRIES} · up to ${REPAIRS} repair round(s) · ${fx.catalog.length} actions\n`);

  const rows: { task: Task; attempts: Attempt[] }[] = [];
  for (const task of tasks) {
    const attempts: Attempt[] = [];
    for (let i = 0; i < TRIES; i++) {
      const a = await run(task, provider, fx);
      attempts.push(a);
      console.log(`${MARK[a.verdict]} ${task.name}${TRIES > 1 ? ` #${i + 1}` : ''} · ${a.seconds}s${a.tokens ? ` · ${a.tokens} tokens` : ''}${a.why.length ? ` · ${a.why.join('; ')}` : ''}`);
    }
    rows.push({ task, attempts });
  }

  const all_ = rows.flatMap((r) => r.attempts);
  const share = (f: (a: Attempt) => boolean) => (all_.length ? Math.round((all_.filter(f).length / all_.length) * 100) : 0);
  const good = all_.filter((a) => a.verdict === 'first_attempt' || a.verdict === 'after_repair');
  const perGood = (xs: number[]) => (good.length ? Math.round(xs.reduce((s, x) => s + x, 0) / good.length) : 0);
  const summary = [
    '',
    `first-attempt success: ${share((a) => a.verdict === 'first_attempt')}%   success after repair: ${share((a) => a.verdict === 'first_attempt' || a.verdict === 'after_repair')}%`,
    `needs correction: ${share((a) => a.verdict === 'needs_correction')}%   wrongly refused: ${share((a) => a.verdict === 'refused')}%   unusable: ${share((a) => a.verdict === 'broken')}%`,
    `per working automation: ${perGood(good.map((a) => a.seconds))}s, ${perGood(good.map((a) => a.tokens))} tokens`,
  ].join('\n');
  console.log(summary);

  if (process.env.BENCH_OUT) {
    const md = [
      `# Task benchmark: ${process.env.DITTOLY_AI_MODEL ?? id}`,
      '',
      `Provider \`${id}\`, ${tasks.length} tasks × ${TRIES}, up to ${REPAIRS} repair round(s), ${new Date().toISOString().slice(0, 10)}.`,
      '',
      '| Task | Department | Result | s | Tokens | What a person would have to fix |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows.map((r) => {
        const last = r.attempts.at(-1)!;
        const firsts = r.attempts.filter((a) => a.verdict === 'first_attempt').length;
        return `| ${r.task.name} | ${r.task.department} | ${firsts}/${r.attempts.length} first try | ${last.seconds} | ${last.tokens} | ${(r.attempts.find((a) => a.why.length)?.why.join('; ') ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`;
      }),
      '',
      summary.trim(),
      '',
    ].join('\n');
    await writeFile(process.env.BENCH_OUT, md);
    console.log(`\nWritten to ${process.env.BENCH_OUT}`);
  }
  process.exit(share((a) => a.verdict === 'first_attempt' || a.verdict === 'after_repair') === 0 ? 1 : 0);
}

await main();

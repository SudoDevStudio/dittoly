import { z } from 'zod';
import { SKILL_SETS, skillPrompt } from './skills.js';
import { MAX_QUESTIONS, type Question } from './classify.js';
import { AiError, looseJson, rawExcerpt, type AiProvider } from './provider.js';

/**
 * Reads a plan (the text of an uploaded PDF) and breaks it into the modules to
 * build and the Flows to draft. The AI only proposes: each module and Flow it
 * names is drafted by the usual builders and reviewed like any other.
 */

export interface PlannedModule {
  key: string;
  title: string;
  /** A request for the module builder, written from the plan. */
  request: string;
  /** An approved module this adds actions to (its name): drafted as its next version, keeping every action it has. */
  extends?: string;
  /** An approved module this starts from (its name): a NEW module with its own name; the original stays as it is. */
  clones?: string;
}

export interface PlannedFlow {
  key: string;
  title: string;
  /** A request for the Flow builder, written from the plan. */
  request: string;
  /** Keys of the new modules this Flow needs (approved modules need no key). */
  needs: string[];
  /** An approved Flow this starts from: a NEW Flow made from a copy of it; the original stays as it is. */
  from?: { flow: string; version: number };
}

/** An approved Flow that already does part of the plan: used as it is. */
export interface ReusedFlow {
  key: string;
  flow: string; // flow id
  version: number;
  title: string;
  why: string;
}

/** A Super Flow connecting the plan's Flows (new and reused), when they belong together. */
export interface PlannedSuperFlow {
  title: string;
  request: string;
  /** Keys of the new Flows and reused Flows it runs. */
  uses: string[];
}

export interface PlanAnalysis {
  title: string;
  summary: string;
  questions: Question[];
  modules: PlannedModule[];
  flows: PlannedFlow[];
  reuse: ReusedFlow[];
  superFlow: PlannedSuperFlow | null;
}

/** Approved Flows the planner may reuse (the uploader can see and run them). */
export interface ApprovedFlowBrief {
  flow: string;
  name: string;
  version: number;
  description: string;
}

/** How much of the document the AI reads. */
export const PLAN_TEXT_LIMIT = 60_000;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: { planJson: { type: 'string' } },
  required: ['planJson'],
  additionalProperties: false,
} as const;

/** Text the AI wrote: too long is cut to the limit rather than failing the whole plan. */
const text = (max: number) => z.string().transform((v) => v.trim().slice(0, max));
const key = text(60);
/** A list: extra entries are dropped; an entry that does not fit is left out (and reported) rather than failing the plan. */
const list = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(z.unknown()).max(500).default([]).transform((v) => ({ item, entries: v.slice(0, max) }));
const question = z.object({ id: text(40).default(''), question: text(300).pipe(z.string().min(1)), options: z.array(text(120)).default([]).transform((o) => o.filter(Boolean).slice(0, 5)) });
/** A name the AI wrote, as a plain value or null; a module name may come with its @version. */
const ref = z.union([z.string(), z.null()]).optional().transform((v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/@.*$/, '').slice(0, 80) : undefined));
const moduleItem = z.object({ key, title: text(120).default(''), request: text(4000).pipe(z.string().min(1)), extends: ref, clones: ref });
const flowItem = z.object({
  key,
  title: text(120).default(''),
  request: text(4000).pipe(z.string().min(1)),
  needs: z.array(key).default([]).transform((n) => n.slice(0, 10)),
  from: z.union([z.object({ flow: z.string(), version: z.coerce.number().int() }), z.null()]).optional().catch(undefined),
});
const reuseItem = z.object({ key, flow: z.string(), version: z.coerce.number().int(), title: text(120).default(''), why: text(400).default('') });
const raw = z.object({
  title: text(120).default(''),
  summary: text(2000).default(''),
  questions: list(question, 10),
  modules: list(moduleItem, 20),
  flows: list(flowItem, 20),
  reuse: list(reuseItem, 10),
  superFlow: z.unknown().optional(),
});
const superFlowItem = z.object({ title: text(120).default(''), request: text(4000).pipe(z.string().min(1)), uses: z.array(key).default([]).transform((u) => u.slice(0, 12)) });

/** The entries of a list that fit their schema; what did not fit goes to `problems`. */
function entries<T extends z.ZodTypeAny>(field: string, l: { item: T; entries: unknown[] }, problems: string[]): z.infer<T>[] {
  const out: z.infer<T>[] = [];
  for (const [i, e] of l.entries.entries()) {
    const r = l.item.safeParse(e);
    if (r.success) out.push(r.data);
    else problems.push(`${field}[${i}] left out: ${issues(r.error)}`);
  }
  return out;
}
const issues = (e: z.ZodError) => e.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(value)'}: ${i.message}`).join('; ');

/** The rules the AI breaks plans down by: skills/ (dittoly-basics, plan-breakdown). */
const SYSTEM = skillPrompt(SKILL_SETS.plan);

/** The plan, or why the AI's answer could not be used. Entries that do not fit are left out and listed in `problems`. */
/**
 * A planned "module" that is really the job of a built-in Flow step: cloning a repository, reproducing an error, fixing
 * and verifying code with tests in a sandbox (the fix step), or building and running an app (the app step). A module
 * connects one app (its title names it, "GitHub: ..."), so a title that names an app is never treated as one.
 */
const BUILT_IN = /\b(clon(e|es|ing) (a|the) (git )?repo(sitory)?|reproduc(e|es|ing) (an?|the) (error|bug|failure)|regression tests?|fix(es|ing)? and verif(y|ies)|verif(y|ies|ying) (a|the) fix|(run|build)s? (it |the app |the tests? )?in (a|the) sandbox)\b/i;
export function builtInWork(title: string, request: string): boolean {
  if (/^[\p{L}\p{N} .&+-]{2,40}:/u.test(title.trim())) return false;
  return BUILT_IN.test(`${title}\n${request}`);
}
const BUILT_IN_NOTE = 'Do this with Dittoly\'s built-in fix step (it clones the repository into a sandbox, reproduces the error, writes the fix with a regression test and verifies it with the tests), not a module: ';

export function parsePlan(out: unknown, approved: ApprovedFlowBrief[] = []): { plan: PlanAnalysis; problems: string[] } | { error: string; raw?: string } {
  const text = (out as { planJson?: unknown })?.planJson;
  if (typeof text !== 'string') return { error: 'the answer has no planJson text', raw: rawExcerpt(JSON.stringify(out ?? null)) };
  let json: unknown;
  try {
    json = looseJson(text);
  } catch {
    return { error: 'planJson is not valid JSON', raw: rawExcerpt(text) };
  }
  const r = raw.safeParse(json);
  if (!r.success) return { error: `planJson does not have the expected shape: ${issues(r.error)}`, raw: rawExcerpt(text) };
  const problems: string[] = [];
  const data = {
    ...r.data,
    questions: entries('questions', r.data.questions, problems),
    modules: entries('modules', r.data.modules, problems),
    flows: entries('flows', r.data.flows, problems),
    reuse: entries('reuse', r.data.reuse, problems),
    superFlow: r.data.superFlow == null ? null : (entries('superFlow', { item: superFlowItem, entries: [r.data.superFlow] }, problems)[0] ?? null),
  };
  const slug = (s: string, fallback: string) => {
    const k = s.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return k || fallback;
  };
  const modules: PlannedModule[] = [];
  // Work a built-in step does is never a module: the Flow does it with that step instead (see builtInWork).
  const builtIn = new Map<string, string>();
  for (const [i, m] of data.modules.entries()) {
    const k = slug(m.key, `module_${i + 1}`);
    if (modules.some((x) => x.key === k)) continue;
    if (!m.extends && !m.clones && builtInWork(m.title, m.request)) {
      builtIn.set(k, m.request);
      continue;
    }
    // A module name to extend is checked when it is drafted (it must be approved).
    const name = (v: string | undefined) => (v && /^[a-z][a-z0-9-]{1,39}$/.test(v) ? v : undefined);
    const ext = name(m.extends);
    // Cloning wins over extending when both are named: the original must stay as it is.
    const clone = name(m.clones);
    modules.push({ key: k, title: m.title || k, request: m.request, ...(clone ? { clones: clone } : ext ? { extends: ext } : {}) });
  }
  const known = new Set(modules.map((m) => m.key));
  const flows: PlannedFlow[] = [];
  for (const [i, f] of data.flows.entries()) {
    const k = slug(f.key, `flow_${i + 1}`);
    if (flows.some((x) => x.key === k)) continue;
    // Only keys of modules this plan builds; anything else is an approved module or a mistake.
    // Only an approved Flow the person can use can be the start of a new one.
    const from = f.from ? approved.find((a) => a.flow === f.from!.flow && a.version === f.from!.version) : undefined;
    const needs = [...new Set(f.needs.map((n) => slug(n, '')))];
    // What it asked a "module" for that a built-in step does goes to the Flow, said as that step's job.
    const moved = needs.filter((n) => builtIn.has(n)).map((n) => builtIn.get(n)!);
    const request = moved.length ? `${f.request}\n\n${moved.map((r) => `${BUILT_IN_NOTE}${r}`).join('\n\n')}` : f.request;
    flows.push({ key: k, title: f.title || k, request, needs: needs.filter((n) => known.has(n)), ...(from ? { from: { flow: from.flow, version: from.version } } : {}) });
  }
  // A built-in job no Flow named goes to the first Flow.
  const unclaimed = [...builtIn].filter(([key]) => !data.flows.some((f) => f.needs.map((n) => slug(n, '')).includes(key)));
  if (unclaimed.length && flows[0]) flows[0].request += `\n\n${unclaimed.map(([, r]) => `${BUILT_IN_NOTE}${r}`).join('\n\n')}`;
  const questions = data.questions
    .slice(0, MAX_QUESTIONS)
    .map((q, i) => ({ id: /^[a-z0-9_]{1,40}$/.test(q.id) ? q.id : `q${i + 1}`, question: q.question, options: q.options.slice(0, 4) }));
  // Only Flows that exist, are approved and the person can use; anything else is dropped.
  const reuse: ReusedFlow[] = [];
  for (const [i, x] of data.reuse.entries()) {
    const match = approved.find((a) => a.flow === x.flow && a.version === x.version);
    const k = slug(x.key, `existing_${i + 1}`);
    if (!match || reuse.some((y) => y.key === k || y.flow === x.flow) || modules.some((m) => m.key === k) || flows.some((f) => f.key === k)) continue;
    reuse.push({ key: k, flow: match.flow, version: match.version, title: x.title || match.name, why: x.why });
  }
  let superFlow: PlannedSuperFlow | null = null;
  if (data.superFlow) {
    const runnable = new Set([...flows.slice(0, 8).map((f) => f.key), ...reuse.map((x) => x.key)]);
    const uses = [...new Set(data.superFlow.uses.map((u) => slug(u, '')))].filter((u) => runnable.has(u));
    // A Super Flow connects at least two Flows.
    if (uses.length >= 2) superFlow = { title: data.superFlow.title || 'Super Flow', request: data.superFlow.request, uses };
  }
  // Everything left out is no plan: the AI gets told why and tries again.
  if (problems.length && !modules.length && !flows.length && !reuse.length && !superFlow && !questions.length) return { error: problems.slice(0, 5).join('; ') };
  return { plan: { title: data.title, summary: data.summary, questions, modules: modules.slice(0, 8), flows: flows.slice(0, 8), reuse, superFlow }, problems };
}

/** What the planner builds from: the approved actions, the approved Flows it may reuse, the organization's instructions. */
export function planContext(input: { catalog: string; flows?: ApprovedFlowBrief[] | undefined; instructions?: string | undefined }): string {
  let prompt = `APPROVED ACTIONS:\n${input.catalog || '(none yet)'}`;
  prompt += `\n\nAPPROVED FLOWS (reuse them when they already do a process):\n${(input.flows ?? []).map((f) => `- flow ${f.flow} version ${f.version}: "${f.name}". ${f.description}`).join('\n') || '(none yet)'}`;
  if (input.instructions) prompt += `\n\nORGANIZATION INSTRUCTIONS:\n${input.instructions}`;
  return prompt;
}

export async function analyzePlan(
  provider: AiProvider,
  input: { text: string; catalog: string; flows?: ApprovedFlowBrief[]; instructions?: string | undefined; answers?: Record<string, string> | undefined },
): Promise<PlanAnalysis> {
  const truncated = input.text.length > PLAN_TEXT_LIMIT;
  let prompt = planContext(input);
  prompt += `\n\nTHE PLAN DOCUMENT${truncated ? ` (first ${PLAN_TEXT_LIMIT} characters)` : ''}:\n<<<PLAN\n${input.text.slice(0, PLAN_TEXT_LIMIT)}\nPLAN>>>`;
  if (input.answers && Object.keys(input.answers).length) {
    prompt += `\n\nTHE PERSON ALREADY ANSWERED:\n${Object.entries(input.answers).map(([q, a]) => `- ${q}: ${a}`).join('\n')}`;
  } else if (input.answers) {
    prompt += `\n\nThe person chose not to answer more questions: decide the rest yourself and return no questions.`;
  }
  let out = parsePlan(await provider.generateJson({ system: SYSTEM, prompt, schema: RESPONSE_SCHEMA, webSearch: true }), input.flows ?? []);
  // An answer that cannot be used gets one more try, told what was wrong.
  if ('error' in out) {
    const retry = `${prompt}\n\nYOUR PREVIOUS ANSWER COULD NOT BE USED: ${out.error}. Return planJson again: one JSON object in the shape described, within the limits.`;
    out = parsePlan(await provider.generateJson({ system: SYSTEM, prompt: retry, schema: RESPONSE_SCHEMA, webSearch: true }), input.flows ?? []);
  }
  if ('error' in out) throw new AiError('ai_invalid_plan', out.error, out.raw);
  return out.plan;
}

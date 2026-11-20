import { z } from 'zod';
import type { AiImage, AiProvider } from '../../ai/provider.js';
import { AiError } from '../../ai/provider.js';
import type { Manifest } from '../../modules/manifest.js';

/**
 * The frontend of an exported app is described by a plan: pages, what each shows and which
 * Flow it runs. The AI drafts the plan from the app's Flows and modules (and a brief or a
 * layout image); it never writes code. Each framework template reads the plan at run time, so
 * every export builds from the same tested components.
 */

const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);
const path = z.string().regex(/^\/([a-z0-9-]+(\/[a-z0-9-]+)*)?$/);
const label = z.string().trim().min(1).max(60);
const dotted = z.string().regex(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\.\d+)*$/).max(120);

/** Where in a run's results to look: a step's output, and optionally a path inside it. */
const resultSource = z.object({ step: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(), path: dotted.optional() }).strict();
const columns = z.array(z.object({ key: dotted, label }).strict()).max(12);
const card = z
  .object({ title: dotted, subtitle: dotted.optional(), image: dotted.optional(), price: dotted.optional(), badge: dotted.optional(), text: dotted.optional() })
  .strict();
/** A button on each item that opens another page with fields filled in from the item. */
const itemAction = z.object({ label, page: id, fill: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), dotted).default({}) }).strict();

export const pageSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('home'), title: label, path, headline: z.string().max(120), text: z.string().max(400).default(''), links: z.array(id).max(6).default([]) }).strict(),
  /** A form for the Flow's inputs; the run's result is shown below it. */
  z
    .object({
      id, kind: z.literal('form'), title: label, path, flow: key,
      intro: z.string().max(400).default(''),
      fields: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)).max(30).optional(),
      submitLabel: label.default('Submit'),
      result: z.object({ source: resultSource.default({}), display: z.enum(['auto', 'fields', 'table', 'cards', 'message']).default('auto'), message: z.string().max(200).optional(), columns: columns.optional(), card: card.optional() }).strict().default({ source: {}, display: 'auto' }),
    })
    .strict(),
  /** Runs the Flow when the page opens (fixed inputs) and lists the items it returns. */
  z
    .object({
      id, kind: z.enum(['table', 'cards']), title: label, path, flow: key,
      intro: z.string().max(400).default(''),
      inputs: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
      source: resultSource.default({}),
      columns: columns.optional(),
      card: card.optional(),
      action: itemAction.optional(),
      search: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/).optional(),
    })
    .strict(),
  /** Steps waiting for a person: approve, reject or fill in (needs the admin token). */
  z.object({ id, kind: z.literal('inbox'), title: label, path }).strict(),
  /** Recent runs and their results (needs a token). */
  z.object({ id, kind: z.literal('runs'), title: label, path }).strict(),
]);
export type UiPage = z.infer<typeof pageSchema>;

export const uiPlanSchema = z
  .object({
    layout: z.object({ nav: z.enum(['sidebar-left', 'sidebar-right', 'top', 'none']).default('top'), width: z.enum(['narrow', 'wide', 'full']).default('wide') }).strict().default({ nav: 'top', width: 'wide' }),
    pages: z.array(pageSchema).min(1).max(12),
    /** The page shown at "/". */
    home: id,
  })
  .strict();
export type UiPlan = z.infer<typeof uiPlanSchema>;

/** What the planner knows about each Flow of the app. */
export interface PlanFlow {
  key: string;
  name: string;
  description: string;
  access: 'public' | 'token';
  inputs: Record<string, unknown>;
  steps: { id: string; type: string; title?: string; module?: string; action?: string; output?: unknown }[];
  humanSteps: boolean;
}

/** Plan problems that a schema can't see: unknown Flows, fields, steps, pages and paths. */
export function checkPlan(plan: UiPlan, flows: PlanFlow[]): string[] {
  const problems: string[] = [];
  const pages = new Map(plan.pages.map((p) => [p.id, p]));
  if (pages.size !== plan.pages.length) problems.push('page ids must be unique');
  const paths = plan.pages.map((p) => p.path);
  if (new Set(paths).size !== paths.length) problems.push('page paths must be unique');
  if (!pages.has(plan.home)) problems.push(`home page ${plan.home} does not exist`);
  for (const p of plan.pages) {
    if (p.kind === 'home') for (const l of p.links) if (!pages.has(l)) problems.push(`page ${p.id} links to unknown page ${l}`);
    if (p.kind === 'form' || p.kind === 'table' || p.kind === 'cards') {
      const f = flows.find((x) => x.key === p.flow);
      if (!f) {
        problems.push(`page ${p.id} uses unknown Flow ${p.flow}`);
        continue;
      }
      const props = Object.keys((f.inputs as { properties?: object }).properties ?? {});
      const source = p.kind === 'form' ? p.result.source : p.source;
      if (source.step && !f.steps.some((s) => s.id === source.step)) problems.push(`page ${p.id} reads unknown step ${source.step}`);
      if (p.kind === 'form') for (const name of p.fields ?? []) if (!props.includes(name)) problems.push(`page ${p.id} shows unknown input ${name}`);
      if (p.kind !== 'form') {
        for (const name of Object.keys(p.inputs)) if (!props.includes(name)) problems.push(`page ${p.id} sets unknown input ${name}`);
        if (p.search && !props.includes(p.search)) problems.push(`page ${p.id} searches with unknown input ${p.search}`);
        if (p.action) {
          const target = pages.get(p.action.page);
          if (!target || target.kind !== 'form') problems.push(`page ${p.id} action opens ${p.action.page}, which is not a form page`);
          else {
            const tf = flows.find((x) => x.key === target.flow);
            const tprops = Object.keys((tf?.inputs as { properties?: object })?.properties ?? {});
            for (const name of Object.keys(p.action.fill)) if (!tprops.includes(name)) problems.push(`page ${p.id} action fills unknown input ${name}`);
          }
        }
      }
    }
  }
  return problems;
}

const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** A plain plan without AI: a form (or a list, for Flows without inputs) per Flow, and the inbox when people take part. */
export function defaultPlan(flows: PlanFlow[], o: { nav?: UiPlan['layout']['nav'] } = {}): UiPlan {
  const pages: UiPage[] = [];
  for (const f of flows.slice(0, 10)) {
    const props = Object.keys((f.inputs as { properties?: object }).properties ?? {});
    const required = ((f.inputs as { required?: string[] }).required ?? []).length;
    pages.push(
      props.length === 0 || required === 0
        ? { id: f.key.slice(0, 40), kind: 'table', title: titleCase(f.name).slice(0, 60), path: `/${f.key}`, flow: f.key, intro: f.description.slice(0, 400), inputs: {}, source: {} }
        : { id: f.key.slice(0, 40), kind: 'form', title: titleCase(f.name).slice(0, 60), path: `/${f.key}`, flow: f.key, intro: f.description.slice(0, 400), submitLabel: 'Run', result: { source: {}, display: 'auto' } },
    );
  }
  if (flows.some((f) => f.humanSteps)) pages.push({ id: 'inbox', kind: 'inbox', title: 'Waiting for you', path: '/inbox' });
  pages.push({ id: 'runs', kind: 'runs', title: 'Runs', path: '/runs' });
  return { layout: { nav: o.nav ?? (pages.length > 5 ? 'sidebar-left' : 'top'), width: 'wide' }, pages, home: pages[0]!.id };
}

/** The Flows as the planner sees them, with each action's declared output shape from its module. */
export function planFlows(flows: { key: string; name: string; description: string; access: 'public' | 'token'; exposed: boolean; definition: Record<string, unknown> }[], modules: { name: string; version: string; manifest: Manifest }[]): PlanFlow[] {
  return flows
    .filter((f) => f.exposed)
    .map((f) => {
      const steps = ((f.definition.steps as Record<string, unknown>[] | undefined) ?? []).map((s) => {
        const ref = typeof s.module === 'string' ? s.module : undefined;
        const m = ref ? modules.find((x) => `${x.name}@${x.version}` === ref) : undefined;
        const a = m?.manifest.actions.find((x) => x.name === s.action);
        return { id: String(s.id), type: String(s.type), title: typeof s.title === 'string' ? s.title : undefined, module: ref, action: typeof s.action === 'string' ? s.action : undefined, output: a?.output };
      });
      return { key: f.key, name: f.name, description: f.description, access: f.access, inputs: (f.definition.inputs as Record<string, unknown>) ?? {}, steps, humanSteps: steps.some((s) => s.type === 'approval' || s.type === 'input') };
    });
}

const SYSTEM = `You design the frontend of a small web app built on Dittoly Flows. Each Flow is a fixed, approved
automation with inputs (a JSON Schema) and steps whose outputs are JSON. The app's pages can only run these Flows; you
cannot add features they do not support, invent data, or call anything else.

Return a page plan as JSON in "planJson" (and one or two sentences in "explanation"). Plan format:
{ "layout": { "nav": "sidebar-left" | "sidebar-right" | "top" | "none", "width": "narrow" | "wide" | "full" },
  "home": "<page id>",
  "pages": [ ... 1 to 12 pages ... ] }
Page kinds (ids and paths lowercase with dashes; paths start with "/", the home page may use "/"):
- { "id", "kind": "home", "title", "path", "headline", "text", "links": [page ids] }
- { "id", "kind": "form", "title", "path", "flow": "<flow key>", "intro", "fields"?: [input names, in order],
    "submitLabel", "result": { "source": { "step"?: "<step id>", "path"?: "items.0" }, "display": "auto"|"fields"|"table"|"cards"|"message",
    "message"?: "Thanks! Your order is placed.", "columns"?: [{ "key", "label" }], "card"?: { "title", "subtitle"?, "image"?, "price"?, "badge"?, "text"? } } }
- { "id", "kind": "table" | "cards", "title", "path", "flow", "intro", "inputs": { fixed input values },
    "source": { "step"?, "path"? } (where the list is in the results), "columns"? (table), "card"? (cards: item fields),
    "action"?: { "label": "Buy", "page": "<form page id>", "fill": { "<that form's input>": "<item field>" } }, "search"?: "<input name>" }
- { "id", "kind": "inbox", "title", "path" } for steps waiting for a person; { "id", "kind": "runs", "title", "path" } for run history.
Rules: use only Flow keys, input names and step ids given; "source.step" is the step whose output holds the data (by
default the last step); fields of items (card, columns, fill) are dot paths inside one item. Prefer cards with images for
catalogues, tables for records, a form for anything that changes data. Include "inbox" when a Flow waits for people.
Follow the person's brief and layout image where the Flows allow it; say in "explanation" what you could not do.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: { planJson: { type: 'string' }, explanation: { type: 'string' } },
  required: ['planJson', 'explanation'],
  additionalProperties: false,
} as const;

/** The AI's plan, checked; one retry with the problems when it does not fit the Flows. */
export async function draftPlan(ai: AiProvider, flows: PlanFlow[], input: { brief?: string | undefined; image?: AiImage | undefined; appName: string }): Promise<{ plan: UiPlan; explanation: string }> {
  const facts = JSON.stringify(
    flows.map((f) => ({ key: f.key, name: f.name, description: f.description, access: f.access, inputs: f.inputs, steps: f.steps, waitsForPeople: f.humanSteps })),
  );
  let prompt = `App: ${input.appName}\nFlows: ${facts}\n\nBrief from the person: ${input.brief?.trim() || '(none: make a clean, simple layout)'}${input.image ? '\nThe attached image is the layout they want; follow its structure (navigation, columns, where things are).' : ''}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ai.generateJson({ system: SYSTEM, prompt, schema: RESPONSE_SCHEMA, ...(input.image ? { images: [input.image] } : {}) });
    let raw: unknown;
    try {
      raw = JSON.parse(String(out.planJson));
    } catch {
      prompt += '\n\nYour planJson was not valid JSON. Return valid JSON.';
      continue;
    }
    const parsed = uiPlanSchema.safeParse(raw);
    const problems = parsed.success ? checkPlan(parsed.data, flows) : parsed.error.issues.slice(0, 15).map((i) => `${i.path.join('.')}: ${i.message}`);
    if (parsed.success && problems.length === 0) return { plan: parsed.data, explanation: String(out.explanation ?? '').slice(0, 500) };
    prompt += `\n\nYour plan has problems; fix them and return the whole plan again:\n- ${problems.join('\n- ')}`;
  }
  throw new AiError('ai_plan_invalid');
}

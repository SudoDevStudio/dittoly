import { cleanNotes } from '../core/guides.js';
import type { MissingCapability } from './classify.js';
import { draftSources, namedSources, sourceCollector, type DraftSource } from './sources.js';
import { AiError, looseJson, rawExcerpt, type AiProvider } from './provider.js';
import { tidyDefinition } from '../flows/tidy.js';
import { testCaseSchema, type TestCase } from '../flows/tests.js';
import { SKILL_SETS, skillPrompt } from './skills.js';

/**
 * Chat-driven Flow drafting. The AI only proposes a definition; it is
 * validated like any Flow and runs only after an approver signs it off.
 */

export interface CatalogAction {
  module: string; // "gitlab@1.0.0"
  moduleTitle: string;
  action: string;
  title: string;
  description: string;
  effect: 'read' | 'write';
  input: unknown;
  output: unknown;
  /** Credentials the runner must have, and ones used only when stored. Absent = none. */
  access?: { required: string[]; optional: string[] };
  /** The module builder's notes (from its MODULE.md), shown once per module. */
  moduleNotes?: string;
  /** What this module must be told (the Flow gives it in "moduleSettings"), shown once per module. */
  settings?: { id: string; type: string; label: string; pattern?: string; default?: string; help?: string; example?: string }[];
}

/** An approved Flow that a Super Flow may run with a flow step. */
export interface CatalogFlow {
  flow: string; // flow id
  name: string;
  version: number;
  description: string;
  inputs: unknown;
  /** The child's steps, so later steps know what steps.<id>.output.<run>.steps.<child step> holds. */
  steps: { id: string; type: string; title?: string | undefined }[];
  /** The Flow builder's notes (from its FLOW.md). */
  notes?: string;
}

function accessText(a: CatalogAction): string {
  const req = a.access?.required ?? [];
  const opt = a.access?.optional ?? [];
  if (!req.length && !opt.length) return 'no key needed';
  return [req.length ? `needs ${req.join(', ')} key` : 'no key needed', opt.length ? `optional ${opt.join(', ')} key` : ''].filter(Boolean).join(', ');
}

/** The rules the AI drafts Flows and Super Flows by: skills/ (dittoly-basics, flow-authoring, flow-ai-steps, super-flow-authoring). */
export const FLOW_SYSTEM_PROMPT = skillPrompt(SKILL_SETS.flow);

export const FLOW_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    definitionJson: { type: 'string' },
    explanation: { type: 'string' },
    missingJson: { type: 'string' },
    splitJson: { type: 'string' },
    sourcesJson: { type: 'string' },
    notesMd: { type: 'string' },
    /** Examples that prove the Flow does what was asked, played with recorded answers (see the skill). */
    testsJson: { type: 'string' },
  },
  required: ['name', 'definitionJson', 'explanation', 'missingJson', 'splitJson', 'sourcesJson', 'notesMd', 'testsJson'],
  additionalProperties: false,
} as const;

export interface DraftedFlow {
  name: string;
  definition: unknown;
  explanation: string;
  /** When it cannot draft: the actions it needs that no approved module has (missingJson). */
  missing?: MissingCapability[];
  /** When one Flow cannot do it all: the Flows to build instead, which a Super Flow then runs together (splitJson). */
  split?: FlowPart[];
  /** The docs it read or relied on, for the approver. */
  sources?: DraftSource[];
  /** Short notes for the next builder (FLOW.md, src/core/guides.ts). */
  notes?: string;
  /** Examples the AI wrote to show the Flow does what was asked; played before anyone reviews it. */
  tests?: { name: string; case: TestCase }[];
}

/** One of the Flows a request too big for one Flow is split into. */
export interface FlowPart {
  title: string;
  /** A self-contained request for that Flow, as for any Flow. */
  request: string;
}

/** splitJson: [{ title, request }], 2-5 parts, read leniently (absent, empty, broken or a single part is none). */
function splitOf(v: unknown): FlowPart[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  let list: unknown;
  try {
    list = looseJson(v);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const parts = list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({ title: typeof p.title === 'string' ? p.title.trim().slice(0, 120) : '', request: typeof p.request === 'string' ? p.request.trim().slice(0, 4000) : '' }))
    .filter((p) => p.title && p.request)
    .slice(0, 5);
  return parts.length >= 2 ? parts : [];
}

/** missingJson: [{ capability, moduleRequest, module? }], read leniently (absent, empty or broken is none). */
function missingOf(v: unknown): MissingCapability[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  let list: unknown;
  try {
    list = looseJson(v);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => ({
      capability: typeof m.capability === 'string' ? m.capability.trim().slice(0, 200) : '',
      moduleRequest: typeof m.moduleRequest === 'string' ? m.moduleRequest.trim().slice(0, 1000) : '',
      ...(typeof m.module === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(m.module.replace(/@.*$/, '')) ? { module: m.module.replace(/@.*$/, '') } : {}),
    }))
    .filter((m) => m.capability && m.moduleRequest)
    .slice(0, 5);
}

/**
 * testsJson: [{ name, case }] — the examples the AI wrote to show the Flow does what was asked, each played with
 * recorded answers instead of real apps. Read leniently (absent, empty or broken is none): a Flow is not lost over
 * a malformed example, and what survives is checked against the real schema before it is kept.
 */
function testsOf(v: unknown): { name: string; case: TestCase }[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  let list: unknown;
  try {
    list = looseJson(v);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: { name: string; case: TestCase }[] = [];
  for (const item of list.slice(0, 5)) {
    if (!item || typeof item !== 'object') continue;
    const { name, case: body } = item as { name?: unknown; case?: unknown };
    const parsed = testCaseSchema.safeParse(body);
    if (!parsed.success) continue;
    out.push({ name: (typeof name === 'string' && name.trim() ? name.trim() : 'Example').slice(0, 70), case: parsed.data });
  }
  return out;
}

function catalogText(catalog: CatalogAction[]): string {
  const noted = new Set<string>();
  return catalog
    .map((a) => {
      // The module builder's notes, once per module, before its first action.
      const notes = a.moduleNotes && !noted.has(a.module) ? `* ${a.module} notes (MODULE.md): ${a.moduleNotes.replace(/\s+/g, ' ').slice(0, 600)}\n` : '';
      // What the Flow must tell this module, once per module: it goes in "moduleSettings" (see SETTINGS).
      const settings =
        a.settings?.length && !noted.has(a.module)
          ? `* ${a.module} must be told: ${a.settings
              .map(
                (st) =>
                  `"${st.id}" (${st.type}${st.pattern ? `, a host matching ${st.pattern}` : ''}): ${st.label}${st.help ? `. ${st.help.replace(/\s+/g, ' ').slice(0, 300)}` : ''}${st.example ? ` e.g. ${st.example}` : st.default ? ` e.g. ${st.default}` : ''}`,
              )
              .join('; ')}\n`
          : '';
      noted.add(a.module);
      return `${notes}${settings}- ${a.module} ${a.action} (${a.effect}; ${accessText(a)}): ${a.title}. ${a.description}\n  input: ${JSON.stringify(a.input)}\n  output: ${JSON.stringify(a.output)}`;
    })
    .join('\n');
}

/** A team's data table, for table steps. */
export interface CatalogTable { name: string; keyColumn: string; columns: { name: string; type: string }[]; description: string | null }

function tablesText(tables: CatalogTable[]): string {
  return tables
    .map((t) => `- "${t.name}": key column ${t.keyColumn}; columns ${t.columns.map((c) => `${c.name} (${c.type})`).join(', ') || '(none)'}${t.description ? `. ${t.description}` : ''}`)
    .join('\n');
}

export function flowsText(flows: CatalogFlow[]): string {
  return flows
    .map((f) => `- "${f.name}" flow ${f.flow} version ${f.version}: ${f.description || '(no description)'}\n  inputs: ${JSON.stringify(f.inputs)}\n  steps: ${f.steps.map((s) => `${s.id} (${s.type}${s.title ? `: ${s.title}` : ''})`).join(', ')}${f.notes ? `\n  notes (FLOW.md): ${f.notes.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`)
    .join('\n');
}

export async function draftFlow(
  provider: AiProvider,
  request: string,
  catalog: CatalogAction[],
  previous?: { definition: unknown; feedback: string; problems?: string },
  context?: { instructions?: string | undefined; guidance?: string | undefined; flows?: CatalogFlow[] | undefined; tables?: CatalogTable[] | undefined },
): Promise<DraftedFlow> {
  let prompt = `CATALOG OF APPROVED ACTIONS:\n${catalogText(catalog)}`;
  if (context?.flows?.length) prompt += `\n\nAPPROVED FLOWS (run them with a flow step):\n${flowsText(context.flows)}`;
  prompt += context?.tables?.length
    ? `\n\nDATA TABLES of the Flow's team (read and write them with table steps; declare a new one in "tables"):\n${tablesText(context.tables)}`
    : `\n\nDATA TABLES of the Flow's team: none yet. A table step needs its table declared in the definition's "tables".`;
  prompt += `\n\nTHE PERSON WANTS:\n${request}`;
  if (previous) {
    prompt += `\n\nREVISE THIS EARLIER DRAFT:\n${JSON.stringify(previous.definition)}\n`;
    if (previous.problems) prompt += `It failed validation: ${previous.problems}\n`;
    prompt += `Requested changes:\n${previous.feedback}`;
  }
  if (context?.instructions) {
    prompt += `\n\nORGANIZATION INSTRUCTIONS (from this organization's admins; follow them unless they conflict with the rules above):\n${context.instructions}`;
  }
  if (context?.guidance) prompt += context.guidance;
  const web = sourceCollector();
  const out = await provider.generateJson({ system: FLOW_SYSTEM_PROMPT, prompt, schema: FLOW_RESPONSE_SCHEMA, webSearch: true, onSources: web.onSources });
  const { name, definitionJson, explanation, missingJson, splitJson, sourcesJson } = out as Record<string, unknown>;
  const sources = draftSources(web.found, namedSources(sourcesJson));
  if (typeof name !== 'string' || typeof definitionJson !== 'string' || typeof explanation !== 'string') {
    throw new AiError('ai_response_shape');
  }
  // An empty answer is the AI saying it cannot build this Flow (like "null"): the caller explains it, no retry.
  if (!definitionJson.trim() || definitionJson.trim() === 'null') {
    const split = splitOf(splitJson);
    return { name: name.slice(0, 120), definition: null, explanation: explanation.slice(0, 2000), missing: missingOf(missingJson), ...(split.length ? { split } : {}), sources };
  }
  let definition: unknown;
  try {
    definition = looseJson(definitionJson);
  } catch (err) {
    // The parser's message says where it stopped ("Unexpected end of JSON input", "... at position 4120").
    throw new AiError('ai_response_not_json', `${(err as Error).message.slice(0, 200)} (the draft was ${definitionJson.length} characters long)`, rawExcerpt(definitionJson));
  }
  const notes = cleanNotes((out as Record<string, unknown>).notesMd);
  const tests = testsOf((out as Record<string, unknown>).testsJson);
  // Name any step the model left unnamed, as a manifest's small slips are fixed: it costs a whole draft otherwise.
  return {
    name: name.slice(0, 120),
    definition: tidyDefinition(definition),
    explanation: explanation.slice(0, 2000),
    sources,
    ...(notes ? { notes } : {}),
    ...(tests.length ? { tests } : {}),
  };
}

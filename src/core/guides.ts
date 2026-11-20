import { describeConfigAction, type ModuleConfig } from '../modules/module-config.js';
import { BASE_VERSION, CAPABILITIES, hasBase, kindsUsed } from '../modules/module-base.js';

/**
 * MODULE.md and FLOW.md: what a module or Flow does and how to use it, for the next builder (the AI that drafts a
 * Flow from the module, or a Super Flow from the Flow), for reviewers, and in git. The reference part is written by
 * Dittoly from the manifest, config or definition, so it is always exactly what was approved; the AI adds only short
 * notes ("notes": when to use which action, limits, what to watch for) when it drafts.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** "title (string, required), labels (array)" from a JSON Schema object. */
function fieldsOf(schema: unknown, limit = 12): string {
  if (!isObj(schema) || !isObj(schema.properties)) return '(none)';
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const names = Object.keys(schema.properties);
  const list = names.slice(0, limit).map((n) => {
    const p = (schema.properties as Obj)[n];
    const type = isObj(p) ? (Array.isArray(p.type) ? p.type.join('|') : str(p.type) || (p.enum ? 'enum' : 'any')) : 'any';
    return `${n} (${type}${required.has(n) ? ', required' : ''})`;
  });
  return (list.join(', ') || '(none)') + (names.length > limit ? `, and ${names.length - limit} more` : '');
}

/** Notes from the AI: plain text, a few lines; never instructions to the reader. */
export function cleanNotes(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
  return s || undefined;
}

export function moduleGuide(manifest: unknown, opts: { version?: string; notes?: string | undefined; config?: ModuleConfig | null; source?: string | null } = {}): string {
  const m = isObj(manifest) ? manifest : {};
  const name = str(m.name) || 'module';
  const lines = [`# ${str(m.title) || name} (${name}${opts.version ? `@${opts.version}` : ''})`, '', str(m.description)];
  // What the kinds it is built on can do (the same for every module on the Dittoly base).
  const kinds = [...new Set([...Object.values(opts.config?.actions ?? {}).map((a) => a.kind), ...kindsUsed(opts.source)])].filter((k) => k in CAPABILITIES);
  if (hasBase(opts.source)) lines.push('', `Built on the Dittoly base v${BASE_VERSION}${opts.config?.baseUrl ? `; HTTP actions call ${opts.config.baseUrl}` : ''}.`);
  if (kinds.length) {
    lines.push('', '## What its kinds can do');
    for (const k of kinds) lines.push(`- ${k} (${CAPABILITIES[k]!.calls}): ${CAPABILITIES[k]!.can.join('; ')}`);
  }
  const settings = Array.isArray(m.settings) ? m.settings.filter(isObj) : [];
  if (settings.length) lines.push('', '## What a Flow must tell it (it keeps nothing itself)', ...settings.map((s) => `- ${str(s.id)}: ${str(s.label)}${s.example ? ` (e.g. ${str(s.example)})` : ''}`));
  const creds = Array.isArray(m.credentials) ? m.credentials.filter(isObj) : [];
  if (creds.length) lines.push('', '## Credentials (each person stores their own)', ...creds.map((c) => `- ${str(c.id)}: ${str(c.label)}${c.optional ? ' (optional)' : ''}`));
  const actions = Array.isArray(m.actions) ? m.actions.filter(isObj) : [];
  lines.push('', '## Actions');
  for (const a of actions) {
    const configured = opts.config?.actions[str(a.name)];
    lines.push(
      '',
      `### ${str(a.name)} (${str(a.effect) === 'write' ? 'write: changes data' : 'read'})`,
      `${str(a.title)}. ${str(a.description)}`.trim(),
      ...(configured ? [`- Does: ${describeConfigAction(configured)}`] : []),
      `- Input: ${fieldsOf(a.input)}`,
      `- Output: ${fieldsOf(a.output)}`,
      ...(isObj(a.undo) ? [`- Undo: ${str((a.undo as Obj).action)}`] : []),
    );
  }
  if (opts.notes) lines.push('', '## Notes from the builder', opts.notes);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

interface FlowStep { id: string; type: string; title?: string; module?: string; action?: string; runs?: { id: string; flow: string; version: number }[] }

/**
 * FLOW.md. For a Super Flow it is the whole process (the factory manager's view): every Flow it runs, with what that
 * Flow does and the modules under it.
 */
export function flowGuide(
  definition: unknown,
  opts: { name: string; version?: number; notes?: string | undefined; effects?: Map<string, string>; children?: { id: string; name: string; version: number; description: string; modules: string[] }[] } = { name: 'Flow' },
): string {
  const d = isObj(definition) ? definition : {};
  const steps = (Array.isArray(d.steps) ? d.steps : []).filter(isObj) as unknown as FlowStep[];
  const superFlow = steps.some((s) => s.type === 'flow');
  const lines = [`# ${opts.name}${opts.version ? ` (v${opts.version})` : ''}${superFlow ? ': Super Flow' : ''}`, '', str(d.description)];
  lines.push('', '## Starts with', `Inputs: ${fieldsOf(d.inputs)}`);
  lines.push('', '## Steps');
  const changes: string[] = [];
  steps.forEach((s, i) => {
    let what = s.type;
    if (s.type === 'action') {
      const effect = opts.effects?.get(`${s.module}:${s.action}`);
      what = `${s.module} ${s.action}${effect ? ` (${effect})` : ''}`;
      if (effect === 'write') changes.push(`${s.module} ${s.action}`);
    } else if (s.type === 'flow') {
      what = `runs ${(s.runs ?? []).map((r) => opts.children?.find((c) => c.id === r.flow && c.version === r.version)?.name ?? `Flow ${r.flow} v${r.version}`).join(' and ')} (at the same time)`;
    }
    lines.push(`${i + 1}. ${s.title ? `${s.title}: ` : ''}${what} [${s.id}]`);
  });
  if (changes.length) lines.push('', '## Changes data in', ...changes.map((c) => `- ${c}`));
  if (opts.children?.length) {
    lines.push('', '## The Flows it runs');
    for (const c of opts.children) lines.push(`- ${c.name} v${c.version}: ${c.description || '(no description)'}${c.modules.length ? ` Modules: ${c.modules.join(', ')}.` : ''}`);
  }
  if (opts.notes) lines.push('', '## Notes from the builder', opts.notes);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

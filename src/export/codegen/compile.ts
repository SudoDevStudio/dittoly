/**
 * Approved Flow definitions written out as TypeScript. Templates become expressions: a value that
 * is exactly "{{ path }}" becomes ref(s, 'path') (any type, missing fails the step), "{{ path }}"
 * inside text becomes a template literal, "{{ fingerprint(path) }}" becomes fingerprint(ref(s, 'path')),
 * conditions become comparisons. Nothing else changes:
 * the generated file does what the approved definition says, step by step.
 */

import { withFlowInstructions } from '../../runtime/ai-step.js';

// The same templates as src/flows/template.ts: a path, or fingerprint(path).
const WHOLE = /^\{\{\s*(?:(fingerprint)\(\s*([A-Za-z0-9_.]+)\s*\)|([A-Za-z0-9_.]+))\s*\}\}$/;
const ANY = /\{\{\s*(?:(fingerprint)\(\s*([A-Za-z0-9_.]+)\s*\)|([A-Za-z0-9_.]+))\s*\}\}/g;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Condition = { notEmpty: string } | { isTrue: string } | { equals: [string, string | number | boolean | null] };

/** Helpers a file uses, so it imports only those. */
class Uses {
  readonly names = new Set<string>();
  use(name: string): string {
    this.names.add(name);
    return name;
  }
}

const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`;
const key = (k: string) => (IDENT.test(k) ? k : str(k));
const literal = (v: unknown) => JSON.stringify(v ?? null);

/** One "{{ … }}" as an expression: the value at its path, fingerprinted when it asks for that. */
const value = (m: RegExpMatchArray | RegExpExecArray, u: Uses) =>
  m[1] ? `${u.use('fingerprint')}(${u.use('ref')}(s, ${str(m[2]!)}))` : `${u.use('ref')}(s, ${str(m[3]!)})`;

/** A template value as an expression of the scope `s`. */
export function expr(v: unknown, u: Uses, indent = ''): string {
  if (typeof v === 'string') {
    const whole = WHOLE.exec(v);
    if (whole) return value(whole, u);
    ANY.lastIndex = 0;
    if (!ANY.test(v)) return str(v);
    // test() moved the shared regex on; matchAll copies its position.
    ANY.lastIndex = 0;
    let out = '`';
    let last = 0;
    for (const m of v.matchAll(ANY)) {
      out += v.slice(last, m.index).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
      out += `\${${u.use('text')}(${value(m, u)})}`;
      last = m.index + m[0].length;
    }
    out += v.slice(last).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    return out + '`';
  }
  if (Array.isArray(v)) return v.length ? `[${v.map((x) => expr(x, u, indent)).join(', ')}]` : '[]';
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    const inner = `${indent}  `;
    return `{\n${entries.map(([k, x]) => `${inner}${key(k)}: ${expr(x, u, inner)},`).join('\n')}\n${indent}}`;
  }
  return literal(v);
}

/** Whether a template value reads anything at run time. */
const dynamic = (v: unknown): boolean =>
  typeof v === 'string' ? (ANY.lastIndex = 0, ANY.test(v)) : Array.isArray(v) ? v.some(dynamic) : v && typeof v === 'object' ? Object.values(v).some(dynamic) : false;

const fn = (v: unknown, u: Uses, indent: string) => {
  const body = expr(v, u, indent);
  // An object literal as an arrow's body needs parentheses.
  return `(${dynamic(v) ? 's' : '_s'}) => ${body.startsWith('{') ? `(${body})` : body}`;
};

export function condition(c: Condition, u: Uses): string {
  if ('notEmpty' in c) return `(s) => ${u.use('notEmpty')}(${u.use('look')}(s, ${str(c.notEmpty)}))`;
  if ('isTrue' in c) return `(s) => ${u.use('look')}(s, ${str(c.isTrue)}) === true`;
  return `(s) => ${u.use('look')}(s, ${str(c.equals[0])}) === ${literal(c.equals[1])}`;
}

type StepDef = Record<string, unknown> & { id: string; type: string; title?: string; when?: Condition };

/** One step as an object literal of a FlowCode. */
function step(s: StepDef, u: Uses, childKey: (flowId: string, version: number) => string, I: string, guarded: boolean): string {
  const lines: string[] = [`id: ${str(s.id)}`, `type: ${str(s.type)}`, `title: ${s.title ? str(s.title) : 'null'}`];
  if (s.when) lines.push(`when: ${condition(s.when, u)}`);
  if (guarded) lines.push('guard: true');
  switch (s.type) {
    case 'action':
      lines.push(`module: ${str(String(s.module))}`, `action: ${str(String(s.action))}`);
      if (s.forEach) lines.push(`forEach: ${fn(s.forEach, u, I)}`);
      lines.push(`input: ${fn(s.input ?? {}, u, I)}`);
      break;
    case 'approval':
      break;
    case 'input': {
      const fields = (s.fields as { name: string; default?: unknown }[]) ?? [];
      const defaults = Object.fromEntries(fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]));
      lines.push(`intro: ${s.intro ? str(String(s.intro)) : 'null'}`, `fields: ${literal(fields)}`, `defaults: ${fn(defaults, u, I)}`);
      break;
    }
    case 'delay':
      lines.push(`seconds: ${Number(s.seconds)}`);
      break;
    case 'ai':
      lines.push(`step: ${literal({ id: s.id, ai: s.ai, ...(s.provider ? { provider: s.provider } : {}), instruction: s.instruction, output: s.output ?? 'text', ...(s.schema ? { schema: s.schema } : {}) })}`, `input: ${fn(s.input ?? {}, u, I)}`);
      break;
    case 'report':
      lines.push(`step: ${literal({ id: s.id, heading: s.heading })}`, `items: ${fn(s.items, u, I)}`);
      if (s.link !== undefined) lines.push(`link: ${fn(s.link, u, I)}`);
      break;
    case 'flow': {
      const runs = (s.runs as { id: string; flow: string; version: number; input?: unknown }[]).map(
        (r) => `{ id: ${str(r.id)}, flow: ${str(childKey(r.flow, r.version))}, input: ${fn(r.input ?? {}, u, `${I}  `)} }`,
      );
      lines.push(`runs: [\n${runs.map((r) => `${I}  ${r},`).join('\n')}\n${I}]`);
      break;
    }
    case 'table':
      lines.push(`table: ${str(String(s.table))}`, `op: ${str(String(s.op))}`);
      if (s.key !== undefined) lines.push(`key: ${fn(s.key, u, I)}`);
      if (s.values !== undefined) lines.push(`values: ${fn(s.values, u, I)}`);
      if (s.column !== undefined) lines.push(`column: ${str(String(s.column))}`);
      if (s.by !== undefined) lines.push(`by: ${fn(s.by, u, I)}`);
      if (s.where) {
        const w = s.where as { column: string; equals: unknown };
        lines.push(`where: { column: ${str(w.column)}, equals: ${fn(w.equals, u, I)} }`);
      }
      if (s.limit !== undefined) lines.push(`limit: ${Number(s.limit)}`);
      break;
    default:
      // The export refuses steps it cannot run before code is written.
      throw new Error(`step type ${s.type} cannot be exported`);
  }
  return `{\n${lines.map((l) => `${I}${l},`).join('\n')}\n${I.slice(2)}}`;
}

export interface FlowSource {
  key: string;
  name: string;
  description: string;
  version: number;
  access: 'public' | 'token';
  exposed: boolean;
  definition: Record<string, unknown>;
  /** Steps a person signs off before they run (text an AI wrote could steer them). */
  guarded?: string[];
}

/** A Flow as a TypeScript module: `export default defineFlow({...})`. `lib` is the import path of the runtime's flow.js. */
export function compileFlow(f: FlowSource, childKey: (flowId: string, version: number) => string, lib: string): string {
  const u = new Uses();
  // An exported app's AI steps follow the Flow's instructions as they did in Dittoly.
  const instructions = typeof f.definition.instructions === 'string' ? f.definition.instructions : undefined;
  const steps = ((f.definition.steps as StepDef[]) ?? []).map((s) => (s.type === 'ai' ? withFlowInstructions(s as StepDef & { instruction: string }, instructions) : s)).map((s) => `    ${step(s, u, childKey, '      ', !!f.guarded?.includes(s.id))},`).join('\n');
  const body = [
    `export default ${u.use('defineFlow')}({`,
    `  key: ${str(f.key)},`,
    `  name: ${str(f.name)},`,
    `  description: ${str(f.description)},`,
    `  version: ${f.version},`,
    `  access: ${str(f.access)},`,
    `  exposed: ${f.exposed},`,
    `  inputs: ${literal(f.definition.inputs ?? { type: 'object', properties: {} })},`,
    `  form: ${literal(f.definition.form ?? null)},`,
    `  steps: [`,
    steps,
    `  ],`,
    `});`,
    '',
  ].join('\n');
  return [
    `// ${oneLine(f.name)}, version ${f.version}: written out from the approved definition by Dittoly.`,
    '// Changing this file makes the app do something other than what was approved.',
    `import { ${[...u.names].sort().join(', ')} } from ${str(lib)};`,
    '',
    body,
  ].join('\n');
}

/** For names inside generated comments: a line break would end the comment and make the rest code. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');

import { createHash } from 'node:crypto';

export interface TemplateScope {
  inputs: unknown;
  steps: Record<string, { output: unknown }>;
  item?: unknown;
}

export class TemplateError extends Error {
  readonly code = 'template_unresolved';
}

export function lookup(scope: TemplateScope, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && part === 'length') cur = cur.length;
    else if (typeof cur === 'object' && Object.hasOwn(cur, part)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/**
 * A short, stable name for an error, so the same error seen twice (another request id, another
 * time, another line) gets the same value, e.g. to remember in a team table which errors were
 * already handled. What changes between occurrences is replaced before hashing: timestamps,
 * UUIDs, hex ids, quoted values and numbers (line numbers in paths too). Case and spacing do not count.
 */
export function fingerprint(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const normal = text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`\n]*`/g, '<str>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha256').update(normal).digest('hex').slice(0, 16);
}

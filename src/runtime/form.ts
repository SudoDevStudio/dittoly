import type { Choice, FormField } from './types.js';

export type { Choice };

/**
 * Choices and answers for run forms and input steps. Choices are plain
 * values with labels; answers are checked against the fields before a run
 * continues, so a later step only ever sees what the form allowed.
 */

export const MAX_CHOICES = 200;

/** Value at a dot path ("" = the value itself). */
export function at(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Turn a list (from a module or an earlier step) into choices. Items without a plain value are left out. */
export function toChoices(list: unknown, valuePath: string, labelPath: string | undefined): Choice[] {
  if (!Array.isArray(list)) return [];
  const out: Choice[] = [];
  for (const item of list) {
    const v = at(item, valuePath);
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const l = labelPath ? at(item, labelPath) : undefined;
    out.push({ value: v, label: String(l ?? v).slice(0, 200) });
    if (out.length >= MAX_CHOICES) break;
  }
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Check answers to an input step. `choices` holds the allowed values of fields
 * whose choices are known on the server (fixed, or from an earlier step);
 * live module choices are re-checked by type only.
 */
export function checkAnswers(
  fields: FormField[],
  values: unknown,
  choices: Map<string, Choice[]>,
): { ok: true; answers: Record<string, unknown> } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const answers: Record<string, unknown> = {};
  const given = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
  for (const k of Object.keys(given)) if (!fields.some((f) => f.name === k)) problems.push(`${k}: is not a field of this form`);
  for (const f of fields) {
    const v = given[f.name];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) problems.push(`${f.name}: is required`);
      else if (f.widget === 'checkbox') answers[f.name] = false;
      continue;
    }
    const allowed = choices.get(f.name);
    const inChoices = (x: unknown) => !allowed || allowed.some((c) => c.value === x);
    switch (f.widget) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${f.name}: must be a number`);
        break;
      case 'checkbox':
        if (typeof v !== 'boolean') problems.push(`${f.name}: must be true or false`);
        break;
      case 'multiselect':
        if (!Array.isArray(v) || v.length > MAX_CHOICES || !v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) problems.push(`${f.name}: must be a list of choices`);
        else if (!v.every(inChoices)) problems.push(`${f.name}: has a value that is not one of the choices`);
        break;
      case 'checklist': {
        // Rows of { check, expect? }, as edited and approved by the person.
        const rows = Array.isArray(v) ? v : null;
        const ok =
          rows &&
          rows.length <= 30 &&
          rows.every((r) => r && typeof r === 'object' && typeof (r as { check?: unknown }).check === 'string' && (r as { check: string }).check.length <= 500 && ((r as { expect?: unknown }).expect === undefined || (typeof (r as { expect?: unknown }).expect === 'string' && ((r as { expect: string }).expect).length <= 500)) && Object.keys(r).every((k) => k === 'check' || k === 'expect'));
        if (!ok) problems.push(`${f.name}: must be a list of checks (at most 30)`);
        else {
          const clean = rows!.map((r) => r as { check: string; expect?: string }).filter((r) => r.check.trim());
          if (f.required && !clean.length) problems.push(`${f.name}: is required`);
          answers[f.name] = clean.map((r) => ({ check: r.check.trim(), ...(r.expect?.trim() ? { expect: r.expect.trim() } : {}) }));
        }
        continue;
      }
      case 'select':
        if (!['string', 'number', 'boolean'].includes(typeof v)) problems.push(`${f.name}: must be one of the choices`);
        else if (!inChoices(v)) problems.push(`${f.name}: is not one of the choices`);
        break;
      default:
        if (typeof v !== 'string' || v.length > 10_000) problems.push(`${f.name}: must be text`);
        else if (f.widget === 'email' && !EMAIL.test(v)) problems.push(`${f.name}: must be an email address`);
        else if (f.widget === 'url' && !/^https?:\/\/\S+$/.test(v)) problems.push(`${f.name}: must be a URL starting with http:// or https://`);
        else if (f.widget === 'date' && !DATE.test(v)) problems.push(`${f.name}: must be a date (YYYY-MM-DD)`);
    }
    answers[f.name] = v;
  }
  return problems.length ? { ok: false, problems } : { ok: true, answers };
}

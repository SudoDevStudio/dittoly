import { checkAnswers, toChoices, type Choice } from '../../runtime/form.js';
import type { FormField } from '../../runtime/types.js';
import type { StepKinds } from './engine.js';
import type { Scope } from './flow.js';

/** Input steps: a form a run waits on. Only apps whose Flows have one carry this file. */

function choices(fields: FormField[], scope: Scope): Map<string, Choice[]> {
  const out = new Map<string, Choice[]>();
  for (const f of fields) {
    const o = f.options;
    if (!o) continue;
    if ('fixed' in o) out.set(f.name, o.fixed.map((c) => ({ value: c.value, label: c.label ?? String(c.value) })));
    else if ('fromStep' in o) {
      const path = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/.exec(o.fromStep)?.[1] ?? '';
      let list: unknown = [];
      try {
        list = path.split('.').reduce<unknown>((cur, p) => (cur && typeof cur === 'object' && Object.hasOwn(cur, p) ? (cur as Record<string, unknown>)[p] : undefined), scope) ?? [];
      } catch {
        list = [];
      }
      out.set(f.name, toChoices(list, o.value, o.label));
    }
  }
  return out;
}

export const inputSteps: NonNullable<StepKinds['input']> = { choices, check: checkAnswers };

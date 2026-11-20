import type { Step } from './definition.js';
import { resolve, TemplateError, type TemplateScope } from './template.js';

/**
 * What a step will do, with every value resolved: what a person signs off when text an AI wrote could steer the step
 * (src/flows/injection.ts). Its condition, when it has one, is shown as written: it held, which is why the step runs.
 * A step done once per list item shows each item's values. The sign-off is bound to the hash of exactly this.
 */
export function signOffValues(step: Step, scope: TemplateScope): unknown {
  const { id: _id, title: _title, autoApproveWhen: _gate, forEach, ...rest } = step as Record<string, unknown>;
  if (forEach === undefined) return resolve(rest, scope);
  const list = resolve(forEach, scope);
  if (!Array.isArray(list) || list.length > 100) throw new TemplateError();
  const { input, ...fixed } = rest;
  return { ...fixed, each: list.map((item) => resolve(input, { ...scope, item })) };
}

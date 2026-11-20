import { fingerprint, lookup, TemplateError, type TemplateScope } from '../runtime/template.js';
import type { Condition } from './definition.js';

export { fingerprint, lookup, TemplateError, type TemplateScope };

/** "{{ path }}" or "{{ fingerprint(path) }}": the only function a template may call. */
const WHOLE = /^\{\{\s*(?:(fingerprint)\(\s*([A-Za-z0-9_.]+)\s*\)|([A-Za-z0-9_.]+))\s*\}\}$/;
const ANY = /\{\{\s*(?:(fingerprint)\(\s*([A-Za-z0-9_.]+)\s*\)|([A-Za-z0-9_.]+))\s*\}\}/g;

function valueOf(scope: TemplateScope, fn: string | undefined, path: string): unknown {
  const v = lookup(scope, path);
  if (v === undefined) throw new TemplateError();
  return fn === 'fingerprint' ? fingerprint(v) : v;
}

/** Resolve templates in a step's input. Values from earlier steps are data; they are never evaluated. */
export function resolve(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return valueOf(scope, whole[1], whole[2] ?? whole[3]!);
    return value.replace(ANY, (_, fn: string | undefined, arg: string | undefined, p: string | undefined) => {
      const v = valueOf(scope, fn, arg ?? p!);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, scope)]));
  }
  return value;
}

export function evaluate(cond: Condition, scope: TemplateScope): boolean {
  if ('notEmpty' in cond) {
    const v = lookup(scope, cond.notEmpty);
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.length > 0;
    if (v && typeof v === 'object') return Object.keys(v).length > 0;
    return v !== undefined && v !== null;
  }
  if ('isTrue' in cond) return lookup(scope, cond.isTrue) === true;
  return lookup(scope, cond.equals[0]) === cond.equals[1];
}

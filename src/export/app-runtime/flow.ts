import type { AiStep, FormField, ReportStep } from '../../runtime/types.js';
import { lookup, TemplateError, type TemplateScope } from '../../runtime/template.js';

/** "{{ fingerprint(path) }}" in an approved Flow: the same short name for the same error as in Dittoly. */
export { fingerprint } from '../../runtime/template.js';

/**
 * What a Flow file is made of. The app's Flows are code: each step's inputs
 * are functions of what came before (the run form, earlier steps' outputs, the forEach item),
 * written out from the approved definition. The engine (engine.ts) runs the steps in order with
 * conditions, retries, sign-offs, forms and child Flows.
 */

export type Scope = TemplateScope;
type Value<T = unknown> = (s: Scope) => T;

interface Base {
  id: string;
  title: string | null;
  /** Skipped when this is false. */
  when?: Value<boolean>;
  /** Text an AI wrote could steer this step: a person signs it off before it runs. */
  guard?: boolean;
}

export interface ActionStepCode extends Base {
  type: 'action';
  /** The pinned module, "name@x.y.z". */
  module: string;
  action: string;
  /** Once per element of this list (at most 100). */
  forEach?: Value;
  input: Value;
}
export interface ApprovalStepCode extends Base { type: 'approval' }
export interface InputStepCode extends Base {
  type: 'input';
  intro: string | null;
  fields: FormField[];
  /** What each field starts with, where the Flow sets it. */
  defaults: Value<Record<string, unknown>>;
}
export interface DelayStepCode extends Base { type: 'delay'; seconds: number }
export interface AiStepCode extends Base { type: 'ai'; step: AiStep; input: Value }
export interface ReportStepCode extends Base { type: 'report'; step: ReportStep; items: Value; link?: Value }
export interface FlowStepCode extends Base { type: 'flow'; runs: { id: string; flow: string; input: Value }[] }
export interface TableStepCode extends Base {
  type: 'table';
  table: string;
  op: 'get' | 'put' | 'delete' | 'increment' | 'list';
  key?: Value;
  values?: Value;
  column?: string;
  by?: Value;
  where?: { column: string; equals: Value };
  limit?: number;
}
export type StepCode = ActionStepCode | ApprovalStepCode | InputStepCode | DelayStepCode | AiStepCode | ReportStepCode | FlowStepCode | TableStepCode;

export interface FlowCode {
  key: string;
  name: string;
  description: string;
  /** The approved version it was generated from. */
  version: number;
  /** public: anyone may start it (rate limited); token: needs APP_API_TOKEN. */
  access: 'public' | 'token';
  /** False for Flows only included because another Flow runs them. */
  exposed: boolean;
  /** JSON Schema of the run form's values. */
  inputs: Record<string, unknown>;
  form: unknown;
  steps: StepCode[];
}

export const defineFlow = (f: FlowCode): FlowCode => f;

/** The value at a path; a missing value fails the step (template_unresolved). */
export function ref(s: Scope, path: string): unknown {
  const v = lookup(s, path);
  if (v === undefined) throw new TemplateError();
  return v;
}

/** The value at a path, or undefined: for conditions. */
export const look = (s: Scope, path: string): unknown => lookup(s, path);

/** A value inside text: strings as they are, anything else as JSON. */
export const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** Has something in it: a non-empty list, string or object, or any other value. */
export function notEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return v !== undefined && v !== null;
}

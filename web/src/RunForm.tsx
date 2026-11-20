import { useEffect, useMemo, useState } from 'react';
import { ApiError, describeError, post } from './api';
import { Link } from './router';
import { InfoTip } from './ui';

/**
 * Super views: the run form a Flow declares (or one derived from its input
 * schema), and the forms input steps show mid-run. Select boxes get their
 * choices from the Flow (fixed), an earlier step, or live from a module run
 * with the person's own access.
 */

export interface Choice { value: string | number | boolean; label: string }
type Options =
  | { fixed: { value: string | number | boolean; label?: string }[] }
  | { module: string; action: string; input: Record<string, unknown>; items?: string; value?: string; label?: string }
  | { fromStep: string; value?: string; label?: string };
export interface Field {
  name: string;
  label: string;
  help?: string | null;
  /** A short example value, shown with the help behind the "i". */
  example?: string | null;
  widget: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'email' | 'url' | 'checklist';
  placeholder?: string | null;
  required?: boolean;
  options?: Options;
  /** Input steps: choices already resolved by the server. */
  choices?: Choice[] | null;
  /** Input steps: choices come from a module and are loaded on request. */
  live?: boolean;
  /** Input steps: the value the field starts with (e.g. checks an AI step proposed). */
  default?: unknown;
}

interface ChecklistRow {
  check: string;
  expect?: string;
}

/** An editable list of checks: change, add, remove or reorder before approving. */
function ChecklistEditor({ id, value, onChange }: { id: string; value: unknown; onChange: (v: ChecklistRow[]) => void }) {
  const rows: ChecklistRow[] = Array.isArray(value) ? (value as ChecklistRow[]) : [];
  const set = (i: number, patch: Partial<ChecklistRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: number) => {
    const next = [...rows];
    const [r] = next.splice(i, 1);
    next.splice(i + d, 0, r!);
    onChange(next);
  };
  return (
    <div className="checklist-editor" id={id} role="group">
      {rows.map((r, i) => (
        <div className="checklist-row" key={i}>
          <span className="checklist-num">{i + 1}</span>
          <input aria-label={`Check ${i + 1}`} value={r.check} placeholder="What to do" onChange={(e) => set(i, { check: e.target.value })} />
          <input aria-label={`Expected result ${i + 1}`} value={r.expect ?? ''} placeholder="What should be seen" onChange={(e) => set(i, { expect: e.target.value })} />
          <button type="button" className="ghost" aria-label={`Move check ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
          <button type="button" className="ghost" aria-label={`Remove check ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="ghost" disabled={rows.length >= 30} onClick={() => onChange([...rows, { check: '', expect: '' }])}>
        Add a check
      </button>
    </div>
  );
}
interface SchemaProp { type?: string | string[]; description?: string; enum?: unknown[]; format?: string; examples?: unknown[]; pattern?: string; items?: { enum?: unknown[] } }
export interface FlowDefinitionView {
  description?: string;
  inputs: { properties?: Record<string, SchemaProp>; required?: string[] } | unknown;
  form?: { intro?: string; fields: Field[] };
}

const humanize = (s: string) => s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** The run form's fields: as the Flow declares them, else derived from its input schema. */
export function formFields(def: FlowDefinitionView): Field[] {
  const schema = (def.inputs ?? {}) as { properties?: Record<string, SchemaProp>; required?: string[] };
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const declared = def.form?.fields ?? [];
  const fromSchema = (name: string, p: SchemaProp): Field => {
    const type = Array.isArray(p.type) ? p.type[0] : p.type;
    const base = { name, label: humanize(name), help: p.description ?? null, example: p.examples?.length ? String(p.examples[0]) : null, placeholder: p.examples?.length ? String(p.examples[0]) : null };
    if (p.enum?.length) return { ...base, widget: 'select', options: { fixed: p.enum.map((v) => ({ value: v as string })) } };
    if (type === 'array' && p.items?.enum?.length) return { ...base, widget: 'multiselect', options: { fixed: p.items.enum.map((v) => ({ value: v as string })) } };
    if (type === 'boolean') return { ...base, widget: 'checkbox' };
    if (type === 'number' || type === 'integer') return { ...base, widget: 'number' };
    if (p.format === 'email' || p.format === 'date') return { ...base, widget: p.format };
    if (p.format === 'uri') return { ...base, widget: 'url' };
    return { ...base, widget: 'text' };
  };
  const fields = declared.length ? declared.filter((f) => f.name in props) : [];
  // Inputs the form does not mention still get a field.
  for (const [name, p] of Object.entries(props)) if (!fields.some((f) => f.name === name)) fields.push(fromSchema(name, p));
  return fields.map((f) => ({ ...f, required: f.required ?? required.has(f.name), help: f.help ?? props[f.name]?.description ?? null, example: f.example ?? (props[f.name]?.examples?.length ? String(props[f.name]!.examples![0]) : null) }));
}

/** Names of the other inputs a field's live choices depend on ({{ inputs.x }}). */
function dependsOn(f: Field): string[] {
  if (!f.options || !('module' in f.options)) return [];
  return [...JSON.stringify(f.options.input ?? {}).matchAll(/\{\{\s*inputs\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Problems to fix before submitting, by field name. */
export function fieldProblems(fields: Field[], values: Record<string, unknown>, inputs?: FlowDefinitionView['inputs']): Record<string, string> {
  const props = ((inputs ?? {}) as { properties?: Record<string, SchemaProp> }).properties ?? {};
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (isEmpty(v)) {
      if (f.required && f.widget !== 'checkbox') out[f.name] = 'Required.';
      continue;
    }
    if (typeof v === 'string') {
      const pattern = props[f.name]?.pattern;
      if (pattern) {
        try {
          if (!new RegExp(pattern, 'u').test(v)) out[f.name] = `Does not match the expected format${props[f.name]?.examples?.length ? ` (e.g. ${String(props[f.name]!.examples![0])})` : ''}.`;
        } catch {
          // Left to the server.
        }
      }
      if (f.widget === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) out[f.name] = 'Must be an email address.';
      if (f.widget === 'url' && !/^https?:\/\/\S+$/.test(v)) out[f.name] = 'Must be a full URL, e.g. https://…';
    }
  }
  return out;
}

interface ChoiceState { choices: Choice[] | null; loading: boolean; error: string | null; waitingFor: string[] }

/** Loads live choices for every field that has them, again whenever the fields they depend on change. */
function useLiveChoices(fields: Field[], values: Record<string, unknown>, load: (field: string, values: Record<string, unknown>) => Promise<Choice[]>) {
  const [state, setState] = useState<Record<string, ChoiceState>>({});
  const live = fields.filter((f) => f.live || (f.options && 'module' in f.options));
  const key = JSON.stringify(live.map((f) => [f.name, dependsOn(f).map((d) => values[d] ?? null)]));
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const f of live) {
        const waitingFor = dependsOn(f).filter((d) => isEmpty(values[d]));
        if (waitingFor.length) {
          setState((s) => ({ ...s, [f.name]: { choices: null, loading: false, error: null, waitingFor } }));
          continue;
        }
        setState((s) => ({ ...s, [f.name]: { choices: s[f.name]?.choices ?? null, loading: true, error: null, waitingFor: [] } }));
        load(f.name, values).then(
          (choices) => !cancelled && setState((s) => ({ ...s, [f.name]: { choices, loading: false, error: null, waitingFor: [] } })),
          (err: unknown) =>
            !cancelled &&
            setState((s) => ({
              ...s,
              [f.name]: { choices: null, loading: false, error: err instanceof ApiError && err.code === 'missing_credential' ? 'missing_credential' : describeError(err), waitingFor: [] },
            })),
        );
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function fixedChoices(f: Field): Choice[] | null {
  if (f.choices) return f.choices;
  if (f.options && 'fixed' in f.options) return f.options.fixed.map((c) => ({ value: c.value, label: c.label ?? String(c.value) }));
  return null;
}

function FieldInput({ f, value, onChange, live, problem }: { f: Field; value: unknown; onChange: (v: unknown) => void; live?: ChoiceState; problem?: string }) {
  const id = `f-${f.name}`;
  const choices = fixedChoices(f) ?? live?.choices ?? null;
  const helpId = `${id}-help`;
  const problemId = `${id}-problem`;
  const describedBy = [f.help || f.example ? helpId : '', problem ? problemId : ''].filter(Boolean).join(' ') || undefined;
  const label = (
    <span className="label-row">
      <label htmlFor={id}>
        {f.label}
        {f.required ? <span className="req"> *</span> : null}
      </label>
      <InfoTip id={helpId} label={f.label} text={f.help} example={f.example} />
    </span>
  );
  let control;
  if (f.widget === 'checklist') {
    control = <ChecklistEditor id={id} value={value} onChange={onChange} />;
  } else if (f.widget === 'checkbox') {
    control = <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  } else if (f.widget === 'select' || f.widget === 'multiselect') {
    if (!choices) {
      control = (
        <p className="muted choice-state" id={id}>
          {live?.waitingFor.length ? `Fill in ${live.waitingFor.map(humanize).join(', ')} first.` : live?.error === 'missing_credential' ? (
            <>
              Needs your own credential for this app. <Link to="/credentials">Add it</Link>, then come back.
            </>
          ) : live?.error ? (
            live.error
          ) : (
            'Loading choices…'
          )}
        </p>
      );
    } else if (f.widget === 'select') {
      const index = choices.findIndex((c) => c.value === value);
      control = (
        <select id={id} value={index === -1 ? '' : String(index)} aria-describedby={describedBy} aria-invalid={problem ? true : undefined} onChange={(e) => onChange(e.target.value === '' ? undefined : choices[Number(e.target.value)]!.value)}>
          <option value="">{live?.loading ? 'Loading…' : 'Choose…'}</option>
          {choices.map((c, i) => (
            <option key={i} value={String(i)}>
              {c.label}
            </option>
          ))}
        </select>
      );
    } else {
      const picked = Array.isArray(value) ? value : [];
      control = (
        <div className="choice-list" role="group" aria-labelledby={id} id={id}>
          {choices.length === 0 ? <p className="muted">Nothing to choose from.</p> : null}
          {choices.map((c, i) => (
            <label key={i} className="choice">
              <input
                type="checkbox"
                checked={picked.includes(c.value)}
                onChange={(e) => onChange(e.target.checked ? [...picked, c.value] : picked.filter((x) => x !== c.value))}
              />
              {c.label}
            </label>
          ))}
          {choices.length > 1 ? (
            <button type="button" className="ghost" onClick={() => onChange(picked.length === choices.length ? [] : choices.map((c) => c.value))}>
              {picked.length === choices.length ? 'Clear all' : 'Select all'}
            </button>
          ) : null}
        </div>
      );
    }
  } else if (f.widget === 'textarea') {
    control = <textarea id={id} rows={4} value={String(value ?? '')} placeholder={f.placeholder ?? undefined} aria-describedby={describedBy} aria-invalid={problem ? true : undefined} onChange={(e) => onChange(e.target.value)} />;
  } else {
    const type = f.widget === 'number' ? 'number' : f.widget === 'date' ? 'date' : f.widget === 'email' ? 'email' : f.widget === 'url' ? 'url' : 'text';
    control = (
      <input
        id={id}
        type={type}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={f.placeholder ?? undefined}
        aria-describedby={describedBy}
        aria-invalid={problem ? true : undefined}
        onChange={(e) => onChange(f.widget === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
      />
    );
  }
  return (
    <div className={`field ${f.widget === 'checkbox' ? 'check' : ''}`}>
      {f.widget === 'checkbox' ? (
        <>
          {control}
          {label}
        </>
      ) : (
        <>
          {label}
          {control}
        </>
      )}
      {problem ? <small id={problemId} className="field-error">{problem}</small> : null}
    </div>
  );
}

/** The fields of a form, controlled. Live choices load through `load`. */
export function FormFields({
  fields,
  values,
  onChange,
  load,
  problems = {},
}: {
  fields: Field[];
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  load: (field: string, values: Record<string, unknown>) => Promise<Choice[]>;
  problems?: Record<string, string>;
}) {
  const live = useLiveChoices(fields, values, load);
  if (fields.length === 0) return <p className="muted">This Flow takes no inputs.</p>;
  return (
    <div className="form-grid super-form">
      {fields.map((f) => (
        <FieldInput
          key={f.name}
          f={f}
          value={values[f.name]}
          live={live[f.name]}
          problem={problems[f.name]}
          onChange={(v) => {
            // Changing a field resets the choices that depend on it.
            const next: Record<string, unknown> = { ...values, [f.name]: v };
            for (const other of fields) if (dependsOn(other).includes(f.name)) delete next[other.name];
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

/** The run form of an approved Flow version. */
export function RunFormFields({
  versionId,
  definition,
  values,
  onChange,
  showProblems,
}: {
  versionId: string;
  definition: FlowDefinitionView;
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  showProblems: boolean;
}) {
  const fields = useMemo(() => formFields(definition), [definition]);
  const problems = showProblems ? fieldProblems(fields, values, definition.inputs) : {};
  const load = (field: string, v: Record<string, unknown>) => post<{ choices: Choice[] }>(`/flow-versions/${versionId}/choices`, { field, values: v }).then((r) => r.choices);
  return (
    <>
      {definition.form?.intro ? <p className="muted">{definition.form.intro}</p> : null}
      <FormFields fields={fields} values={values} onChange={onChange} load={load} problems={problems} />
    </>
  );
}

/** Problems with run-form values; empty when they can be submitted. */
export function runFormProblems(definition: FlowDefinitionView, values: Record<string, unknown>) {
  return fieldProblems(formFields(definition), values, definition.inputs);
}

/** An input step waiting for this member: fill in, submit, and the run goes on. */
export function InputStepForm({ runId, stepId, view, onDone }: { runId: string; stepId: string; view: { intro: string | null; fields: Field[] }; onDone: () => void }) {
  // Fields start from their defaults, e.g. the checks an AI step proposed for approval.
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(view.fields.filter((f) => f.default !== undefined && f.default !== null).map((f) => [f.name, f.default])),
  );
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = tried ? fieldProblems(view.fields, values) : {};
  const load = (field: string) => post<{ choices: Choice[] }>(`/runs/${runId}/steps/${stepId}/choices`, { field }).then((r) => r.choices);
  return (
    <form
      className="input-step"
      onSubmit={async (e) => {
        e.preventDefault();
        setTried(true);
        if (Object.keys(fieldProblems(view.fields, values)).length) return;
        setBusy(true);
        setError(null);
        try {
          await post(`/runs/${runId}/steps/${stepId}/input`, { values });
          onDone();
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {view.intro ? <p>{view.intro}</p> : null}
      <FormFields fields={view.fields} values={values} onChange={setValues} load={load} problems={problems} />
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Sending…' : 'Continue the run'}
      </button>
    </form>
  );
}

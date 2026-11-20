import { useState, type DragEvent } from 'react';
import { api, post } from './api';
import { Card, ErrorText, Loading, useAction, useLoad } from './components';
import { navigate } from './router';
import { useTeams } from './teams';
import { Icon } from './ui';

/**
 * Build a Flow by dragging steps: approved module actions, sign-offs and waits from the
 * palette onto the canvas, in order; drag cards to reorder. The team's data tables are in the
 * palette too (a table step reads or changes one row, or lists rows). The selected step's inputs are
 * a form made from the action's input schema, with earlier steps' outputs and the Flow's
 * inputs offered as values. Saving creates a draft version that still needs approval.
 * Step kinds the editor has no form for (AI, browse, apps, Super Flow steps) stay as they
 * are and can still be moved.
 */

interface JsonSchema { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; description?: string; items?: JsonSchema }
interface CatalogAction { module: string; moduleTitle: string; action: string; title: string; description: string; effect: 'read' | 'write'; input: JsonSchema; output: JsonSchema }
type Step = { id: string; type: string; title?: string; [k: string]: unknown };
interface FlowInput { name: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'any'; required: boolean }
interface TableInfo { name: string; keyColumn: string; columns: { name: string; type: 'text' | 'number' | 'boolean' | 'date' }[] }
type PaletteItem = { kind: 'action'; a: CatalogAction } | { kind: 'approval' } | { kind: 'delay' } | { kind: 'table'; t: TableInfo };

const EDITABLE = new Set(['action', 'approval', 'delay', 'table']);
const TABLE_OPS: { op: string; label: string }[] = [
  { op: 'get', label: 'Read a row' },
  { op: 'put', label: 'Add or change a row' },
  { op: 'increment', label: 'Add to a number' },
  { op: 'delete', label: 'Delete a row' },
  { op: 'list', label: 'List rows' },
  { op: 'claim', label: 'Reserve a row for this run' },
];
/** A table step's default title: it follows the action until someone types their own. */
const TABLE_VERB: Record<string, string> = { get: 'Read', put: 'Update', increment: 'Count in', delete: 'Delete from', list: 'List', claim: 'Reserve in' };
const tableTitle = (op: string, table: string) => `${TABLE_VERB[op] ?? op} ${table}`;
const paletteLabel = (p: PaletteItem) => (p.kind === 'action' ? p.a.title : p.kind === 'table' ? `Table: ${p.t.name}` : p.kind === 'approval' ? 'Sign-off' : 'Wait');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's_$1').slice(0, 36) || 'step';
const typeOf = (s: JsonSchema | undefined) => (Array.isArray(s?.type) ? s?.type[0] : s?.type) ?? 'string';

function uniqueId(base: string, steps: Step[]): string {
  let id = slug(base);
  if (!/^[a-z]/.test(id)) id = `s_${id}`;
  let n = 2;
  const taken = new Set(steps.map((s) => s.id));
  let out = id;
  while (taken.has(out)) out = `${id}_${n++}`.slice(0, 40);
  return out;
}

/** A typed form value: templates stay text; numbers and booleans are converted. */
function typedValue(v: string, type: string): unknown {
  if (/\{\{.*\}\}/.test(v)) return v.trim();
  if ((type === 'integer' || type === 'number') && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (type === 'boolean') return v === 'true';
  return v;
}

function inputsFrom(schema: unknown): FlowInput[] {
  const s = (schema ?? {}) as JsonSchema;
  // An input with no "type" takes any JSON (e.g. a Flow URL's whole body): keep it that way.
  return Object.entries(s.properties ?? {}).map(([name, p]) => ({ name, type: (p && !('type' in p) ? 'any' : typeOf(p)) as FlowInput['type'], required: (s.required ?? []).includes(name) }));
}

export function FlowEditor({ flowId, initial, onClose }: { flowId?: string; initial?: { name: string; definition: { description?: string; instructions?: string; inputs?: unknown; steps: Step[] } & Record<string, unknown> }; onClose?: () => void }) {
  const { current: team } = useTeams();
  const catalog = useLoad(() => api<CatalogAction[]>('/catalog'));
  const tables = useLoad(() => api<TableInfo[]>(flowId ? `/flow-tables?flowId=${flowId}` : `/flow-tables${team ? `?teamId=${team}` : ''}`), [flowId, team]);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.definition.description ?? '');
  const [instructions, setInstructions] = useState(initial?.definition.instructions ?? '');
  const [inputs, setInputs] = useState<FlowInput[]>(() => inputsFrom(initial?.definition.inputs));
  const [steps, setSteps] = useState<Step[]>(initial?.definition.steps ?? []);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const act = useAction();

  const byRef = new Map((catalog.data ?? []).map((a) => [`${a.module}#${a.action}`, a]));
  const actionOf = (s: Step) => (s.type === 'action' ? byRef.get(`${s.module as string}#${s.action as string}`) : undefined);

  const newStep = (item: PaletteItem): Step => {
    if (item.kind === 'approval') return { id: uniqueId('signoff', steps), type: 'approval', title: 'Sign-off' };
    if (item.kind === 'delay') return { id: uniqueId('wait', steps), type: 'delay', title: 'Wait', seconds: 3600 };
    if (item.kind === 'table') return { id: uniqueId(`table_${item.t.name}`, steps), type: 'table', title: tableTitle('get', item.t.name), table: item.t.name, op: 'get', key: '' };
    const input: Record<string, unknown> = {};
    // Inputs of the same name as a Flow input are filled from it.
    for (const k of Object.keys(item.a.input.properties ?? {})) if (inputs.some((i) => i.name === k)) input[k] = `{{ inputs.${k} }}`;
    return { id: uniqueId(item.a.action, steps), type: 'action', title: item.a.title, module: item.a.module, action: item.a.action, input };
  };
  const insert = (item: PaletteItem, at: number) => {
    const s = newStep(item);
    setSteps((xs) => [...xs.slice(0, at), s, ...xs.slice(at)]);
    setSelected(s.id);
  };
  const move = (from: number, to: number) => {
    setSteps((xs) => {
      if (to < 0 || to > xs.length || from === to || from + 1 === to) return xs;
      const copy = [...xs];
      const [s] = copy.splice(from, 1);
      copy.splice(to > from ? to - 1 : to, 0, s!);
      return copy;
    });
  };
  const update = (id: string, patch: Partial<Step>) => setSteps((xs) => xs.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  // ---- drag and drop (HTML5): palette items carry "palette:<index>", cards "step:<index>"
  const palette: PaletteItem[] = [
    { kind: 'approval' },
    { kind: 'delay' },
    ...(tables.data ?? []).map((t) => ({ kind: 'table' as const, t })),
    ...(catalog.data ?? []).map((a) => ({ kind: 'action' as const, a })),
  ];
  const onDrop = (at: number) => (e: DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const data = e.dataTransfer.getData('text/plain');
    const [kind, n] = data.split(':');
    if (kind === 'palette' && palette[Number(n)]) insert(palette[Number(n)]!, at);
    if (kind === 'step') move(Number(n), at);
  };
  const dropZone = (at: number) => (
    <div
      key={`drop-${at}`}
      className={`drop-zone ${dragOver === at ? 'over' : ''}`}
      data-testid={`drop-${at}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(at); }}
      onDragLeave={() => setDragOver((x) => (x === at ? null : x))}
      onDrop={onDrop(at)}
    />
  );

  const definition = () => {
    // An input keeps its own schema (description, limits) while its kind is unchanged.
    const before = ((initial?.definition.inputs ?? {}) as JsonSchema).properties ?? {};
    const schemaOf = (i: FlowInput) => {
      const old = before[i.name];
      if (old && (('type' in old ? typeOf(old) : 'any') === i.type)) return old;
      return i.type === 'any' ? {} : { type: i.type };
    };
    const properties = Object.fromEntries(inputs.filter((i) => i.name).map((i) => [i.name, schemaOf(i)]));
    const required = inputs.filter((i) => i.name && i.required).map((i) => i.name);
    // Fields left empty are left out (and an emptied one is removed), not saved as "".
    const { description: _d, instructions: _i, ...base } = (initial?.definition ?? {}) as Record<string, unknown>;
    return { ...base, ...(description.trim() ? { description } : {}), ...(instructions.trim() ? { instructions } : {}), inputs: { type: 'object', properties, required, additionalProperties: false }, steps };
  };
  const save = () =>
    act.run(async () => {
      if (flowId) {
        await api(`/flows/${flowId}`, { method: 'PUT', body: { definition: definition() } });
        onClose?.();
        navigate(`/flows/${flowId}`);
        return;
      }
      const v = await post<{ flowId: string }>('/flows', { name, definition: definition(), ...(team ? { teamId: team } : {}) });
      navigate(`/flows/${v.flowId}`);
    }, flowId ? 'New version drafted; it needs approval before it runs' : 'Flow drafted; it needs approval before it runs');

  const sel = steps.find((s) => s.id === selected) ?? null;
  const shown = palette.map((p, i) => ({ p, i })).filter(({ p }) => !filter || (p.kind === 'action' ? `${p.a.moduleTitle} ${p.a.title}` : `${paletteLabel(p)} ${p.kind}`).toLowerCase().includes(filter.toLowerCase()));

  // Why the save button is off, said next to it (the name field may be scrolled out of view).
  const blocked = !flowId && !name.trim() ? 'name' : steps.length === 0 ? 'steps' : null;
  return (
    <Card title={<><Icon name="flow" />{flowId ? 'Edit visually' : 'Build a Flow visually'}</>}>
      {!flowId ? (
        <div className="field">
          <label htmlFor="editor-name">Name</label>
          <input id="editor-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly release" />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="editor-description">What it does (optional)</label>
        <input id="editor-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="editor-instructions">Instructions for its AI steps (optional)</label>
        <textarea id="editor-instructions" rows={3} maxLength={4000} value={instructions} placeholder="e.g. Write in a friendly tone. Skip videos shorter than a minute." onChange={(e) => setInstructions(e.target.value)} />
        <small className="muted">Every AI step in this Flow follows these. They guide answers only; what the Flow does stays its steps. Changing them needs approval again.</small>
      </div>
      <fieldset className="editor-inputs">
        <legend>Run form (what people fill in)</legend>
        {inputs.map((inp, k) => (
          <div className="row" key={k}>
            <input aria-label={`Input ${k + 1} name`} value={inp.name} placeholder="name, e.g. release" onChange={(e) => setInputs((xs) => xs.map((x, j) => (j === k ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') } : x)))} />
            <select aria-label={`Input ${k + 1} type`} value={inp.type} onChange={(e) => setInputs((xs) => xs.map((x, j) => (j === k ? { ...x, type: e.target.value as FlowInput['type'] } : x)))}>
              <option value="string">text</option><option value="number">number</option><option value="integer">whole number</option><option value="boolean">yes/no</option>
              <option value="object">object (JSON)</option><option value="array">list</option><option value="any">any JSON</option>
            </select>
            <label className="check"><input type="checkbox" checked={inp.required} onChange={(e) => setInputs((xs) => xs.map((x, j) => (j === k ? { ...x, required: e.target.checked } : x)))} />required</label>
            <button type="button" className="ghost" aria-label={`Remove input ${inp.name || k + 1}`} onClick={() => setInputs((xs) => xs.filter((_, j) => j !== k))}><Icon name="close" size={14} /></button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => setInputs((xs) => [...xs, { name: '', type: 'string', required: true }])}><Icon name="plus" size={14} />Add an input</button>
      </fieldset>

      <div className="editor">
        <aside className="editor-palette" aria-label="Steps you can add">
          <input aria-label="Filter steps" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {!catalog.data ? <Loading /> : null}
          <ul>
            {shown.map(({ p, i }) => (
              <li key={i} draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', `palette:${i}`); e.dataTransfer.effectAllowed = 'copy'; }} className="palette-item">
                <span>
                  {p.kind === 'action' ? <><strong>{p.a.title}</strong><small className="muted">{p.a.moduleTitle}{p.a.effect === 'write' ? ' · changes data' : ''}</small></>
                    : p.kind === 'table' ? <><strong>{p.t.name}</strong><small className="muted">Data table · read or change rows</small></>
                    : <strong>{paletteLabel(p)}</strong>}
                </span>
                <button type="button" className="ghost" aria-label={`Add ${paletteLabel(p)}`} onClick={() => insert(p, steps.length)}><Icon name="plus" size={14} /></button>
              </li>
            ))}
          </ul>
        </aside>

        <ol className="editor-canvas" aria-label="Steps in order">
          {dropZone(0)}
          {steps.length === 0 ? <p className="muted">Drag steps here, or use + in the list.</p> : null}
          {steps.map((s, k) => {
            const a = actionOf(s);
            return [
              <li
                key={s.id}
                className={`editor-step ${selected === s.id ? 'selected' : ''} ${EDITABLE.has(s.type) ? '' : 'locked'}`}
                draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', `step:${k}`); e.dataTransfer.effectAllowed = 'move'; }}
                onClick={() => setSelected(s.id)}
                aria-label={`Step ${k + 1}: ${s.title ?? s.id}`}
              >
                <span className="step-index">{k + 1}</span>
                <span className="step-text">
                  <strong>{s.title ?? s.id}</strong>
                  <small className="muted">
                    {s.type === 'action' ? `${a?.moduleTitle ?? s.module} · ${a?.title ?? s.action}` : s.type === 'table' ? `Data table ${s.table as string} · ${TABLE_OPS.find((o) => o.op === s.op)?.label ?? s.op}` : s.type}
                    {a?.effect === 'write' || (s.type === 'table' && ['put', 'delete', 'increment', 'claim'].includes(s.op as string)) ? ' · changes data' : ''}
                  </small>
                </span>
                <span className="row">
                  <button type="button" className="ghost" aria-label={`Move ${s.title ?? s.id} up`} disabled={k === 0} onClick={(e) => { e.stopPropagation(); move(k, k - 1); }}><Icon name="arrow" size={13} className="up" /></button>
                  <button type="button" className="ghost" aria-label={`Move ${s.title ?? s.id} down`} disabled={k === steps.length - 1} onClick={(e) => { e.stopPropagation(); move(k, k + 2); }}><Icon name="arrow" size={13} className="down" /></button>
                  <button type="button" className="ghost" aria-label={`Remove ${s.title ?? s.id}`} onClick={(e) => { e.stopPropagation(); setSteps((xs) => xs.filter((x) => x.id !== s.id)); if (selected === s.id) setSelected(null); }}><Icon name="close" size={13} /></button>
                </span>
              </li>,
              dropZone(k + 1),
            ];
          })}
        </ol>

        <section className="editor-panel" aria-label="Selected step">
          {sel ? <StepForm step={sel} steps={steps} inputs={inputs} action={actionOf(sel)} catalog={byRef} tables={tables.data ?? []} onChange={(patch) => update(sel.id, patch)} /> : <p className="muted">Select a step to fill in what it does.</p>}
        </section>
      </div>

      <div className="row">
        <button type="button" className="primary" disabled={act.busy || blocked !== null} onClick={save}>{flowId ? 'Save as new version' : 'Create Flow'}</button>
        {onClose ? <button type="button" onClick={onClose}>Cancel</button> : null}
        {blocked === 'name' ? (
          <span className="muted" role="status">
            Give the Flow a name first{' '}
            <button type="button" className="link" onClick={() => document.getElementById('editor-name')?.focus()}>(Name, at the top)</button>.
          </span>
        ) : blocked === 'steps' ? (
          <span className="muted" role="status">Add at least one step first.</span>
        ) : (
          <span className="muted">Saved Flows are drafts until an approver approves them.</span>
        )}
      </div>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** Values a field can take from: the Flow's inputs and earlier steps' outputs. */
function references(step: Step, steps: Step[], inputs: FlowInput[], catalog: Map<string, CatalogAction>, tables: TableInfo[] = []): { label: string; value: string }[] {
  const out = inputs.filter((i) => i.name).map((i) => ({ label: `Run form: ${i.name}`, value: `{{ inputs.${i.name} }}` }));
  for (const s of steps) {
    if (s.id === step.id) break;
    if (s.type === 'table') {
      const t = tables.find((x) => x.name === s.table);
      const name = s.title ?? s.id;
      const cols = t ? [t.keyColumn, ...t.columns.map((c) => c.name)] : [];
      if (s.op === 'get' || s.op === 'put' || s.op === 'increment') for (const c of cols) out.push({ label: `${name}: ${c}`, value: `{{ steps.${s.id}.output.row.${c} }}` });
      if (s.op === 'get') out.push({ label: `${name}: found`, value: `{{ steps.${s.id}.output.found }}` });
      if (s.op === 'increment') out.push({ label: `${name}: new value`, value: `{{ steps.${s.id}.output.value }}` });
      if (s.op === 'claim') out.push({ label: `${name}: reserved for this run`, value: `{{ steps.${s.id}.output.claimed }}` });
      if (s.op === 'list') {
        out.push({ label: `${name}: rows`, value: `{{ steps.${s.id}.output.rows }}` });
        out.push({ label: `${name}: how many rows`, value: `{{ steps.${s.id}.output.count }}` });
      }
      continue;
    }
    if (s.type !== 'action') continue;
    const a = catalog.get(`${s.module as string}#${s.action as string}`);
    for (const [k, p] of Object.entries(a?.output.properties ?? {})) {
      out.push({ label: `${s.title ?? s.id}: ${k}`, value: `{{ steps.${s.id}.output.${k} }}` });
      if (typeOf(p) === 'array') out.push({ label: `${s.title ?? s.id}: how many ${k}`, value: `{{ steps.${s.id}.output.${k}.length }}` });
    }
  }
  return out;
}

function StepForm({ step, steps, inputs, action, catalog, tables, onChange }: { step: Step; steps: Step[]; inputs: FlowInput[]; action: CatalogAction | undefined; catalog: Map<string, CatalogAction>; tables: TableInfo[]; onChange: (patch: Partial<Step>) => void }) {
  if (!EDITABLE.has(step.type)) return <p className="muted">This {step.type} step is kept as it is. Change it by asking for a revision in words.</p>;
  const refs = references(step, steps, inputs, catalog, tables);
  const values = (step.input ?? {}) as Record<string, unknown>;
  return (
    <div className="step-form">
      <div className="field">
        <label htmlFor="step-title">Title</label>
        <input id="step-title" value={step.title ?? ''} maxLength={80} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
      {step.type === 'delay' ? (
        <div className="field">
          <label htmlFor="step-minutes">Wait (minutes)</label>
          <input id="step-minutes" type="number" min={1} value={Math.round(Number(step.seconds ?? 60) / 60)} onChange={(e) => onChange({ seconds: Math.max(1, Number(e.target.value)) * 60 })} />
        </div>
      ) : null}
      {step.type === 'approval' ? <p className="muted">An approver signs off before the next steps run.</p> : null}
      {step.type === 'table' ? <TableStepForm step={step} tables={tables} refs={refs} onChange={onChange} /> : null}
      {step.type === 'action' && action ? (
        <>
          <p className="muted">{action.description}</p>
          {Object.entries(action.input.properties ?? {}).map(([k, p]) => {
            const type = typeOf(p);
            const v = values[k];
            const text = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
            const id = `in-${step.id}-${k}`;
            const set = (s: string) => {
              const next = { ...values };
              if (s === '') delete next[k];
              else next[k] = type === 'array' || type === 'object' ? (() => { try { return JSON.parse(s); } catch { return s; } })() : typedValue(s, type);
              onChange({ input: next });
            };
            return (
              <div className="field" key={k}>
                <label htmlFor={id}>{k}{(action.input.required ?? []).includes(k) ? ' *' : ''}{p.description ? <small className="muted"> {p.description}</small> : null}</label>
                <div className="row">
                  {p.enum ? (
                    <select id={id} value={text} onChange={(e) => set(e.target.value)}>
                      <option value="">—</option>
                      {p.enum.map((x) => <option key={String(x)} value={String(x)}>{String(x)}</option>)}
                    </select>
                  ) : (
                    <input id={id} value={text} onChange={(e) => set(e.target.value)} placeholder={type} />
                  )}
                  {refs.length ? (
                    <select aria-label={`Use a value for ${k}`} value="" onChange={(e) => e.target.value && set(e.target.value)}>
                      <option value="">Use…</option>
                      {refs.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  ) : null}
                </div>
              </div>
            );
          })}
          <div className="field">
            <label htmlFor={`foreach-${step.id}`}>Repeat for each item of (optional)</label>
            <select id={`foreach-${step.id}`} value={(step.forEach as string) ?? ''} onChange={(e) => onChange({ forEach: e.target.value || undefined })}>
              <option value="">Run once</option>
              {refs.filter((r) => r.value.includes('.output.') && !r.value.includes('.length')).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            {step.forEach ? <small className="muted">Use {'{{ item.<field> }}'} in the inputs above for the current item.</small> : null}
          </div>
        </>
      ) : null}
      {step.type === 'action' && !action ? <p className="muted">This step's module version is no longer approved; pick an approved one from the list.</p> : null}
    </div>
  );
}

/** A value box with "Use…" for the Flow's inputs and earlier steps' outputs. */
function ValueField({ id, label, value, refs, onChange }: { id: string; label: string; value: string; refs: { label: string; value: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row">
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
        {refs.length ? (
          <select aria-label={`Use a value for ${label}`} value="" onChange={(e) => e.target.value && onChange(e.target.value)}>
            <option value="">Use…</option>
            {refs.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        ) : null}
      </div>
    </div>
  );
}

/** Fields of a table step: which table, what to do, the row's key and the values. Only fields of the chosen action are kept. */
function TableStepForm({ step, tables, refs, onChange }: { step: Step; tables: TableInfo[]; refs: { label: string; value: string }[]; onChange: (patch: Partial<Step>) => void }) {
  const t = tables.find((x) => x.name === step.table);
  const op = (step.op as string) ?? 'get';
  const values = (step.values ?? {}) as Record<string, unknown>;
  const where = step.where as { column: string; equals: unknown } | undefined;
  const text = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  // The step's shape depends on the action: switching clears what the new action does not take.
  const defaultTitle = step.title === tableTitle(op, (step.table as string) ?? '');
  const setOp = (next: string) =>
    onChange({
      ...(defaultTitle ? { title: tableTitle(next, (step.table as string) ?? '') } : {}),
      op: next,
      key: next === 'list' ? undefined : ((step.key as string) ?? ''),
      values: next === 'put' ? values : undefined,
      column: next === 'increment' ? (step.column ?? t?.columns.find((c) => c.type === 'number')?.name) : undefined,
      by: next === 'increment' ? (step.by ?? 1) : undefined,
      where: next === 'list' ? where : undefined,
      limit: next === 'list' ? step.limit : undefined,
      hours: next === 'claim' ? (step.hours ?? 6) : undefined,
    });
  return (
    <>
      <div className="row">
        <div className="field">
          <label htmlFor={`table-${step.id}`}>Data table</label>
          <select id={`table-${step.id}`} value={(step.table as string) ?? ''} onChange={(e) => onChange({ table: e.target.value, ...(defaultTitle ? { title: tableTitle(op, e.target.value) } : {}), values: op === 'put' ? {} : undefined, where: undefined })}>
            {!t ? <option value={(step.table as string) ?? ''}>{(step.table as string) ?? 'Choose…'} (not in this team)</option> : null}
            {tables.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`op-${step.id}`}>What it does</label>
          <select id={`op-${step.id}`} value={op} onChange={(e) => setOp(e.target.value)}>
            {TABLE_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </select>
        </div>
      </div>
      {op !== 'list' ? <ValueField id={`key-${step.id}`} label={`Which row (${t?.keyColumn ?? 'key'})`} value={text(step.key)} refs={refs} onChange={(v) => onChange({ key: v })} /> : null}
      {op === 'put' && t ? (
        <fieldset className="field">
          <legend>Values (empty: left as they are)</legend>
          {t.columns.map((c) => (
            <ValueField key={c.name} id={`val-${step.id}-${c.name}`} label={`${c.name} (${c.type === 'boolean' ? 'yes/no' : c.type})`} value={text(values[c.name])} refs={refs}
              onChange={(v) => { const next = { ...values }; if (v === '') delete next[c.name]; else next[c.name] = v; onChange({ values: next }); }} />
          ))}
        </fieldset>
      ) : null}
      {op === 'increment' && t ? (
        <div className="row">
          <div className="field">
            <label htmlFor={`col-${step.id}`}>Number column</label>
            <select id={`col-${step.id}`} value={(step.column as string) ?? ''} onChange={(e) => onChange({ column: e.target.value })}>
              {t.columns.filter((c) => c.type === 'number').map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor={`by-${step.id}`}>Add</label><input id={`by-${step.id}`} value={text(step.by)} onChange={(e) => onChange({ by: e.target.value === '' ? undefined : /^-?\d+(\.\d+)?$/.test(e.target.value) ? Number(e.target.value) : e.target.value })} /></div>
        </div>
      ) : null}
      {op === 'list' && t ? (
        <div className="row">
          <div className="field">
            <label htmlFor={`where-${step.id}`}>Only rows where</label>
            <select id={`where-${step.id}`} value={where?.column ?? ''} onChange={(e) => onChange({ where: e.target.value ? { column: e.target.value, equals: where?.equals ?? '' } : undefined })}>
              <option value="">All rows</option>
              {[t.keyColumn, ...t.columns.map((c) => c.name)].map((c) => <option key={c} value={c}>{c} equals…</option>)}
            </select>
          </div>
          {where ? <ValueField id={`equals-${step.id}`} label="equals" value={text(where.equals)} refs={refs} onChange={(v) => onChange({ where: { column: where.column, equals: v } })} /> : null}
          <div className="field"><label htmlFor={`limit-${step.id}`}>At most</label><input id={`limit-${step.id}`} type="number" min={1} max={500} value={(step.limit as number | undefined) ?? 100} onChange={(e) => onChange({ limit: Math.min(500, Math.max(1, Number(e.target.value) || 100)) })} /></div>
        </div>
      ) : null}
      {op === 'claim' ? (
        <>
          <div className="field"><label htmlFor={`hours-${step.id}`}>Reserved for (hours)</label><input id={`hours-${step.id}`} type="number" min={1} max={168} value={(step.hours as number | undefined) ?? 6} onChange={(e) => onChange({ hours: Math.min(168, Math.max(1, Number(e.target.value) || 6)) })} /></div>
          <p className="muted">Of runs reserving the same row at the same time, only one gets it; it is free again after these hours. Later steps can go on only when it was reserved: use "reserved for this run" as their condition.</p>
        </>
      ) : null}
      {op === 'put' || op === 'delete' || op === 'increment' || op === 'claim' ? <p className="muted">This changes the table. A dry run skips it.</p> : null}
    </>
  );
}

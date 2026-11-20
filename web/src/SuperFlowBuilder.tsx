import { useState } from 'react';
import { api, post } from './api';
import { Card, ErrorText, useAction, useLoad } from './components';
import { navigate } from './router';
import { teamQuery, useTeams } from './teams';
import { Icon } from './ui';
import type { Runnable } from './pages/RunHub';

interface InputSchema { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
interface Child { key: string; flowId: string; version: number; name: string; inputs: InputSchema; steps: { id: string }[]; values: Record<string, string> }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 30) || 'flow';
const TEMPLATE = /^\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}$/;

/** A value as typed: templates stay text; numbers and booleans are converted for typed inputs. */
function typed(v: string, type: string | undefined): unknown {
  if (/\{\{.*\}\}/.test(v)) return v.trim();
  if ((type === 'integer' || type === 'number') && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (type === 'boolean') return v === 'true';
  return v;
}

/**
 * Connect approved Flows into a Super Flow: stages run in order, and the Flows in
 * one stage run at the same time. Each child's inputs default to a Super Flow input
 * of the same name, so shared values are asked once.
 */
export function SuperFlowBuilder() {
  const { current: team } = useTeams();
  const runnable = useLoad(() => api<Runnable[]>(`/runnable${teamQuery(team)}`), [team]);
  const [name, setName] = useState('');
  const [stages, setStages] = useState<Child[][]>([[]]);
  const [picking, setPicking] = useState<Record<number, string>>({});
  const act = useAction();

  const add = (stage: number) => act.run(async () => {
    const r = runnable.data?.find((x) => x.versionId === picking[stage]);
    if (!r) return;
    const review = await api<{ definition: { inputs: InputSchema; steps: { id: string }[] } }>(`/flow-versions/${r.versionId}/review`);
    const used = new Set(stages.flat().map((c) => c.key));
    let key = slug(r.name);
    for (let n = 2; used.has(key); n++) key = `${slug(r.name)}_${n}`;
    const values = Object.fromEntries(Object.keys(review.definition.inputs.properties ?? {}).map((p) => [p, `{{ inputs.${p} }}`]));
    setStages(stages.map((s, i) => (i === stage ? [...s, { key, flowId: r.flowId, version: r.version, name: r.name, inputs: review.definition.inputs, steps: review.definition.steps, values }] : s)));
    setPicking({ ...picking, [stage]: '' });
  });
  const update = (stage: number, key: string, field: string, value: string) =>
    setStages(stages.map((s, i) => (i === stage ? s.map((c) => (c.key === key ? { ...c, values: { ...c.values, [field]: value } } : c)) : s)));
  const remove = (stage: number, key: string) => setStages(stages.map((s, i) => (i === stage ? s.filter((c) => c.key !== key) : s)).filter((s, i, all) => s.length || i === all.length - 1 || all.length === 1));

  // The Super Flow's own inputs: every {{ inputs.x }} a child uses, typed like the child's input.
  const inputs: Record<string, { type: string; description?: string }> = {};
  const required = new Set<string>();
  for (const c of stages.flat()) {
    for (const [field, v] of Object.entries(c.values)) {
      const m = TEMPLATE.exec(v.trim());
      if (!m) continue;
      const prop = c.inputs.properties?.[field];
      inputs[m[1]!] ??= { type: prop?.type ?? 'string', ...(prop?.description ? { description: prop.description } : {}) };
      if (c.inputs.required?.includes(field)) required.add(m[1]!);
    }
  }
  const filled = stages.filter((s) => s.length);
  const definition = {
    description: `Runs ${filled.map((s) => s.map((c) => c.name).join(' and ')).join(', then ')}.`,
    inputs: { type: 'object', properties: inputs, required: [...required] },
    steps: filled.map((s, i) => ({
      id: `stage_${i + 1}`,
      type: 'flow',
      title: s.map((c) => c.name).join(' + ').slice(0, 80),
      runs: s.map((c) => ({ id: c.key, flow: c.flowId, version: c.version, input: Object.fromEntries(Object.entries(c.values).filter(([, v]) => v.trim() !== '').map(([f, v]) => [f, typed(v, c.inputs.properties?.[f]?.type)])) })),
    })),
  };
  const options = runnable.data?.filter((r) => !r.blocked) ?? [];

  return (
    <Card title={<><Icon name="flow" />Connect Flows into a Super Flow</>} actions={<span className="badge super">Super Flow</span>}>
      <p className="muted">
        Pick approved Flows and put them in stages. Stages run one after another; the Flows in a stage run at the same time, as the person running the Super Flow, each exactly the version you pick.
      </p>
      <div className="field">
        <label htmlFor="sf-name">Super Flow name</label>
        <input id="sf-name" value={name} maxLength={120} placeholder="e.g. Ticket QA and notify everyone" onChange={(e) => setName(e.target.value)} />
      </div>
      <ol className="sf-stages">
        {stages.map((stage, si) => (
          <li key={si} className="sf-stage">
            <div className="eyebrow">STAGE {si + 1}{stage.length > 1 ? ' · RUN AT THE SAME TIME' : ''}</div>
            {stage.map((c) => (
              <div className="sf-child" key={c.key}>
                <div className="row between">
                  <strong><Icon name="flow" size={14} /> {c.name} <code>v{c.version}</code></strong>
                  <button type="button" className="ghost" aria-label={`Remove ${c.name}`} onClick={() => remove(si, c.key)}><Icon name="close" size={14} /></button>
                </div>
                {Object.keys(c.inputs.properties ?? {}).map((f) => (
                  <div className="field" key={f}>
                    <label htmlFor={`sf-${c.key}-${f}`}>{f}{c.inputs.required?.includes(f) ? ' *' : ''}</label>
                    <input id={`sf-${c.key}-${f}`} value={c.values[f] ?? ''} onChange={(e) => update(si, c.key, f, e.target.value)} />
                  </div>
                ))}
                {si < stages.length - 1 || stage.length ? (
                  <p className="muted">Later stages can use its results: <code>{`{{ steps.stage_${filled.indexOf(stage) + 1}.output.${c.key}.steps.${c.steps.at(-1)?.id ?? '<step>'} }}`}</code></p>
                ) : null}
              </div>
            ))}
            <div className="row">
              <select aria-label={`Add a Flow to stage ${si + 1}`} value={picking[si] ?? ''} onChange={(e) => setPicking({ ...picking, [si]: e.target.value })}>
                <option value="">Add an approved Flow…</option>
                {options.map((r) => <option key={r.versionId} value={r.versionId}>{r.name} (v{r.version})</option>)}
              </select>
              <button type="button" disabled={!picking[si] || act.busy} onClick={() => add(si)}><Icon name="plus" size={14} />Add</button>
            </div>
          </li>
        ))}
      </ol>
      <div className="row">
        <button type="button" disabled={!stages.at(-1)?.length} onClick={() => setStages([...stages, []])}><Icon name="plus" size={14} />Add a stage after</button>
        <button
          type="button"
          className="primary"
          disabled={act.busy || !name.trim() || stages.flat().length < 2}
          onClick={() => act.run(async () => {
            const v = await post<{ flowId: string }>('/flows', { name: name.trim(), definition, ...(team ? { teamId: team } : {}) });
            navigate(`/flows/${v.flowId}`);
          }, 'Super Flow created. An approver must approve it before it runs.')}
        >
          Create Super Flow
        </button>
      </div>
      {Object.keys(inputs).length ? <p className="muted">It will ask for: {Object.keys(inputs).map((k) => <code key={k}>{k} </code>)}</p> : null}
      <ErrorText>{act.error ?? runnable.error}</ErrorText>
    </Card>
  );
}

import { useState } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, Pre, useAction, useLoad } from './components';
import { Icon } from './ui';

/**
 * Flow tests: a run played with recorded answers instead of real apps. Each version's page shows
 * how every test of the Flow does on it, so an approver sees what a change breaks before approving.
 */

interface Result { testId: string; name: string; passed: boolean; status: string; problems: string[]; steps: { id: string; status: string; error?: string }[] }
interface Test { id: string; name: string; case: unknown }
interface JsonSchema { type?: string | string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; enum?: unknown[] }
interface DefStep { id: string; type: string; title?: string; module?: string; action?: string; forEach?: string; op?: string }
interface Definition { inputs: unknown; steps: DefStep[] }
interface CatalogAction { module: string; action: string; output: JsonSchema }

const EXAMPLE = JSON.stringify(
  {
    inputs: { '<input>': '<value>' },
    answers: { '<step id>': { output: { '<field>': '<what the app answers>' } } },
    decisions: { '<sign-off step id>': 'approved' },
    expect: { status: 'succeeded', steps: { '<step id>': 'succeeded' }, values: [{ path: 'steps.<step id>.output.<field>', equals: '<value>' }] },
  },
  null,
  2,
);

export function FlowTestsCard({ flowId, versionId, canManage, definition }: { flowId: string; versionId: string; canManage: boolean; definition?: Definition }) {
  const results = useLoad(() => api<{ total: number; passed: number; results: Result[] }>(`/flow-versions/${versionId}/tests`), [versionId]);
  const tests = useLoad(() => (canManage ? api<Test[]>(`/flows/${flowId}/tests`) : Promise.resolve([] as Test[])), [flowId, canManage]);
  const act = useAction();
  const [name, setName] = useState('');
  const [json, setJson] = useState(EXAMPLE);
  const reload = () => { results.reload(); tests.reload(); };
  const r = results.data;
  return (
    <Card
      title={<><Icon name="check" />Tests</>}
      actions={r && r.total ? <span className={`badge ${r.passed === r.total ? 'tone-ok' : 'tone-danger'}`}>{r.passed} of {r.total} pass</span> : null}
    >
      <p className="muted">Each test plays a run of this version with recorded answers instead of the real apps: nothing is called or changed. It checks the steps send each app inputs it accepts, conditions, loops and reports, and the outcome. Save a finished run as a test from its page, or write one here.</p>
      {r?.results.length ? (
        <ul className="list" aria-label="Test results">
          {r.results.map((t) => (
            <li key={t.testId}>
              <span className={`badge ${t.passed ? 'tone-ok' : 'tone-danger'}`}>{t.passed ? 'Pass' : 'Fail'}</span> <strong>{t.name}</strong>
              <span className="muted"> · the run {t.status}</span>
              {t.problems.length ? <ul>{t.problems.map((p, i) => <li key={i} className="muted">{p}</li>)}</ul> : null}
              {canManage ? <button className="ghost" disabled={act.busy} onClick={() => act.run(async () => (await api(`/flows/${flowId}/tests/${t.testId}`, { method: 'DELETE' }), reload()), 'Test removed')}>Remove</button> : null}
            </li>
          ))}
        </ul>
      ) : r ? <Empty>No tests yet.</Empty> : null}
      {canManage ? (
        <details>
          <summary>Write a test</summary>
          {definition ? <TestForm flowId={flowId} definition={definition} onSaved={reload} /> : null}
        </details>
      ) : null}
      {canManage ? (
        <details>
          <summary>Write or edit a test as JSON</summary>
          <div className="field"><label htmlFor="test-name">Test name</label><input id="test-name" placeholder="e.g. Nothing to merge" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="test-case">Test (JSON)</label><textarea id="test-case" rows={12} value={json} onChange={(e) => setJson(e.target.value)} /></div>
          <p className="muted">A sign-off without a decision is approved. A step can be made to fail with {'{ "fail": "error_code" }'}; a step run once per item takes {'"outputs": [ ... ]'}.</p>
          <button className="primary" disabled={act.busy || !name.trim()} onClick={() => act.run(async () => {
            let parsed: unknown;
            try { parsed = JSON.parse(json); } catch { throw new Error('The test is not valid JSON.'); }
            await post(`/flows/${flowId}/tests`, { name, case: parsed });
            setName('');
            reload();
          }, 'Test added')}>Add test</button>
          {tests.data?.length ? <details><summary>Existing tests</summary>{tests.data.map((t) => <div key={t.id}><strong>{t.name}</strong><Pre>{JSON.stringify(t.case, null, 2)}</Pre></div>)}</details> : null}
        </details>
      ) : null}
      <ErrorText>{results.error ?? act.error}</ErrorText>
    </Card>
  );
}

/** On a finished run of your own: keep it as a test of its Flow. */
export function SaveRunAsTest({ runId, flowName }: { runId: string; flowName: string }) {
  const act = useAction();
  const [saved, setSaved] = useState(false);
  if (saved) return <span className="muted">Saved as a test of this Flow.</span>;
  return (
    <button disabled={act.busy} onClick={() => act.run(async () => { await post(`/runs/${runId}/save-test`, { name: `${flowName}: run of ${new Date().toLocaleDateString()}` }); setSaved(true); }, 'Saved as a test')}>
      Save as a test
    </button>
  );
}

/** What a value of this schema looks like, as a starting point for a recorded answer. */
function sample(schema: JsonSchema | undefined, depth = 0): unknown {
  const type = Array.isArray(schema?.type) ? schema?.type[0] : schema?.type;
  if (schema?.enum?.length) return schema.enum[0];
  if (depth > 4) return null;
  if (type === 'object' || schema?.properties) return Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([k, v]) => [k, sample(v, depth + 1)]));
  if (type === 'array') return [sample(schema?.items, depth + 1)];
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  return '';
}

/** Steps whose answer the test must record (the rest run as they are: sign-offs, waits, reports). */
const ANSWERED = new Set(['action', 'ai', 'browse', 'app', 'fix', 'flow', 'input', 'table']);
const STATUSES = ['', 'succeeded', 'skipped', 'failed', 'not_run'] as const;

/** A test as a form: the run form's values, each step's recorded answer, sign-off decisions and what to expect. */
function TestForm({ flowId, definition, onSaved }: { flowId: string; definition: Definition; onSaved: () => void }) {
  const catalog = useLoad(() => api<CatalogAction[]>('/catalog'));
  const act = useAction();
  const props = ((definition.inputs ?? {}) as { properties?: Record<string, JsonSchema> }).properties ?? {};
  const [name, setName] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, { mode: 'output' | 'fail'; text: string }>>({});
  const [decisions, setDecisions] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [outcome, setOutcome] = useState<'' | 'succeeded' | 'failed'>('succeeded');
  const [expectSteps, setExpectSteps] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<{ path: string; equals: string }[]>([]);
  const outputSchema = (s: DefStep) => catalog.data?.find((a) => `${a.module}` === s.module && a.action === s.action)?.output;
  const starter = (s: DefStep) => {
    const out = s.type === 'action' ? sample(outputSchema(s)) : s.type === 'table' ? (s.op === 'list' ? { rows: [], count: 0 } : s.op === 'get' ? { found: false, row: null } : {}) : {};
    return JSON.stringify(s.forEach ? [out] : out, null, 1);
  };
  const answer = (s: DefStep) => answers[s.id] ?? { mode: 'output' as const, text: catalog.data ? starter(s) : '' };
  const typed = (v: string, schema: JsonSchema | undefined) => {
    const t = Array.isArray(schema?.type) ? schema?.type[0] : schema?.type;
    if ((t === 'number' || t === 'integer') && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (t === 'boolean') return v === 'true';
    if (t === 'array' || t === 'object') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  };
  const build = () => {
    const recorded: Record<string, unknown> = {};
    for (const s of definition.steps.filter((x) => ANSWERED.has(x.type))) {
      const a = answer(s);
      if (a.mode === 'fail') {
        if (!/^[a-z0-9_]{1,40}$/.test(a.text)) throw new Error(`Step ${s.title ?? s.id}: an error code is lowercase letters, digits and _ (e.g. rate_limited).`);
        recorded[s.id] = { fail: a.text };
        continue;
      }
      if (!a.text.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(a.text); } catch { throw new Error(`Step ${s.title ?? s.id}: the answer is not valid JSON.`); }
      recorded[s.id] = s.forEach && s.type === 'action' && Array.isArray(value) ? { outputs: value } : { output: value };
    }
    const steps = Object.fromEntries(Object.entries(expectSteps).filter(([, v]) => v));
    const values = checks.filter((c) => c.path).map((c) => { let equals: unknown = c.equals; try { equals = JSON.parse(c.equals); } catch { /* text */ } return { path: c.path, equals }; });
    return {
      inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== '').map(([k, v]) => [k, typed(v, props[k])])),
      answers: recorded,
      decisions,
      expect: { ...(outcome ? { status: outcome } : {}), ...(Object.keys(steps).length ? { steps } : {}), ...(values.length ? { values } : {}) },
    };
  };
  return (
    <div className="test-form">
      <div className="field"><label htmlFor="form-test-name">Test name</label><input id="form-test-name" placeholder="e.g. Nothing to merge" value={name} onChange={(e) => setName(e.target.value)} /></div>
      {Object.keys(props).length ? (
        <fieldset className="field">
          <legend>Run form</legend>
          {Object.entries(props).map(([k, p]) => (
            <div className="field" key={k}><label htmlFor={`test-in-${k}`}>{k}</label><input id={`test-in-${k}`} placeholder={String(Array.isArray(p.type) ? p.type[0] : p.type ?? 'text')} value={inputs[k] ?? ''} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} /></div>
          ))}
        </fieldset>
      ) : null}
      <fieldset className="field">
        <legend>Each step</legend>
        {definition.steps.map((s) => (
          <div className="test-step" key={s.id}>
            <strong>{s.title ?? s.id}</strong> <span className="muted">{s.type === 'action' ? `${s.module} · ${s.action}` : s.type}{s.forEach ? ' · once per item' : ''}</span>
            {s.type === 'approval' ? (
              <div className="field">
                <label htmlFor={`test-dec-${s.id}`}>Decision</label>
                <select id={`test-dec-${s.id}`} value={decisions[s.id] ?? 'approved'} onChange={(e) => setDecisions({ ...decisions, [s.id]: e.target.value as 'approved' | 'rejected' })}><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
              </div>
            ) : null}
            {ANSWERED.has(s.type) ? (
              <>
                <div className="field">
                  <label htmlFor={`test-mode-${s.id}`}>Recorded answer</label>
                  <select id={`test-mode-${s.id}`} value={answer(s).mode} onChange={(e) => setAnswers({ ...answers, [s.id]: { mode: e.target.value as 'output' | 'fail', text: e.target.value === 'fail' ? 'step_failed' : starter(s) } })}>
                    <option value="output">It answers{s.forEach ? ' (one per item)' : ''}</option><option value="fail">It fails</option>
                  </select>
                </div>
                {answer(s).mode === 'fail' ? (
                  <div className="field"><label htmlFor={`test-fail-${s.id}`}>Error code</label><input id={`test-fail-${s.id}`} value={answer(s).text} onChange={(e) => setAnswers({ ...answers, [s.id]: { mode: 'fail', text: e.target.value } })} /></div>
                ) : (
                  <div className="field"><label htmlFor={`test-out-${s.id}`}>Answer (JSON, filled in from what the step returns)</label><textarea id={`test-out-${s.id}`} rows={4} value={answer(s).text} onChange={(e) => setAnswers({ ...answers, [s.id]: { mode: 'output', text: e.target.value } })} /></div>
                )}
              </>
            ) : null}
            <div className="field">
              <label htmlFor={`test-expect-${s.id}`}>Expect it to</label>
              <select id={`test-expect-${s.id}`} value={expectSteps[s.id] ?? ''} onChange={(e) => setExpectSteps({ ...expectSteps, [s.id]: e.target.value })}>
                {STATUSES.map((v) => <option key={v} value={v}>{v === '' ? 'Not checked' : v === 'not_run' ? 'not run' : v}</option>)}
              </select>
            </div>
          </div>
        ))}
      </fieldset>
      <fieldset className="field">
        <legend>What should come out</legend>
        <div className="field">
          <label htmlFor="test-outcome">The run</label>
          <select id="test-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}><option value="succeeded">succeeds</option><option value="failed">fails</option><option value="">Not checked</option></select>
        </div>
        {checks.map((c, i) => (
          <div className="row" key={i}>
            <input aria-label={`Check ${i + 1} path`} placeholder="steps.<step id>.output.<field>" value={c.path} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, path: e.target.value.trim() } : x)))} />
            <input aria-label={`Check ${i + 1} value`} placeholder="equals (text or JSON)" value={c.equals} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, equals: e.target.value } : x)))} />
            <button className="ghost" onClick={() => setChecks(checks.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button className="ghost" onClick={() => setChecks([...checks, { path: '', equals: '' }])}>Add a value check</button>
      </fieldset>
      <button className="primary" disabled={act.busy || !name.trim()} onClick={() => act.run(async () => {
        await post(`/flows/${flowId}/tests`, { name, case: build() });
        setName('');
        onSaved();
      }, 'Test added')}>Add test</button>
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}

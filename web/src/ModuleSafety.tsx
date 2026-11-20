import { useState } from 'react';
import { api, post } from './api';
import { Card, ErrorText, Loading, Pre, useAction, useLoad, When } from './components';
import { useMe } from './context';
import { Link, navigate } from './router';
import { Icon } from './ui';

/**
 * Module safety in the portal: what changed since the last approved version,
 * tests recorded against the real app, and warnings when an app seems to have changed.
 */

interface LineChange { op: ' ' | '+' | '-'; text: string }
interface ModuleDiff { against: { id: string; version: string } | null; changes: string[]; code: { lines: LineChange[]; added: number; removed: number; truncated: boolean } | null }

export function CodeDiff({ lines }: { lines: LineChange[] }) {
  return (
    <pre className="code-diff" aria-label="Code changes">
      {lines.map((l, i) => (
        <span key={i} className={l.op === '+' ? 'added' : l.op === '-' ? 'removed' : l.text.startsWith('… ') ? 'skipped' : ''}>
          {l.op === ' ' ? '  ' : `${l.op} `}{l.text}{'\n'}
        </span>
      ))}
    </pre>
  );
}

/** For a module version: what changed since the newest approved version. */
export function ModuleDiffCard({ id }: { id: string }) {
  const d = useLoad(() => api<ModuleDiff>(`/modules/${id}/diff`), [id]);
  if (!d.data?.against) return null;
  const { against, changes, code } = d.data;
  return (
    <Card title={<><Icon name="layers" />Changes since {against.version}</>} actions={code ? <span className="muted">+{code.added} −{code.removed} lines</span> : null}>
      {changes.length ? (
        <ul className="list" aria-label="What changed">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
      ) : <p className="muted">Same hosts, credentials and actions as {against.version}.</p>}
      {code && code.lines.length ? (
        <details>
          <summary>Code changes</summary>
          <CodeDiff lines={code.lines} />
          {code.truncated ? <p className="muted">Very long code: only the first 4,000 lines were compared.</p> : null}
        </details>
      ) : null}
    </Card>
  );
}

/** For a Flow version: what changed since the previous one. */
export function FlowDiff({ versionId }: { versionId: string }) {
  const d = useLoad(() => api<{ against: { id: string; version: number } | null; changes: string[] }>(`/flow-versions/${versionId}/diff`), [versionId]);
  if (!d.data?.against) return null;
  return (
    <>
      <h2>Changes since v{d.data.against.version}</h2>
      {d.data.changes.length ? <ul className="list" aria-label="Flow changes">{d.data.changes.map((c) => <li key={c}>{c}</li>)}</ul> : <p className="muted">No changes to the steps.</p>}
    </>
  );
}

interface Recording { id: string; action: string; name: string; fromVersion: string; recordedAt: string; recordedBy: string | null }
interface RecordedTest { name: string; action: string; input: unknown; http: { method: string; urlPrefix: string; status: number; json?: unknown; body?: string; contentType?: string }[] }

/** Approved module: record read actions against the real app; every later version must pass them. */
interface InputSchema { properties?: Record<string, { type?: string | string[]; description?: string; pattern?: string; enum?: unknown[]; format?: string }>; required?: string[] }

/** The fields an action takes, one line each: name, type, whether required, and what it must look like. */
function inputFields(schema: InputSchema | undefined): string[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([k, p]) => {
    const rules = [p.type ? [p.type].flat().join(' or ') : null, required.has(k) ? 'required' : 'optional', p.enum ? `one of ${p.enum.map(String).join(', ')}` : null, p.pattern ? `matches ${p.pattern}` : null, p.format ? `format ${p.format}` : null].filter(Boolean);
    return `${k} (${rules.join(', ')})${p.description ? `: ${p.description}` : ''}`;
  });
}

/** A starting input: the required fields, empty. */
function inputTemplate(schema: InputSchema | undefined): string {
  const props = schema?.properties ?? {};
  const out = Object.fromEntries((schema?.required ?? []).map((k) => [k, [props[k]?.type].flat()[0] === 'number' || [props[k]?.type].flat()[0] === 'integer' ? 0 : [props[k]?.type].flat()[0] === 'boolean' ? false : '']));
  return JSON.stringify(out);
}

export function RecordingsCard({ id, manifest }: { id: string; manifest: { actions: { name: string; title: string; effect: string; input?: InputSchema }[]; browser?: unknown; publicWeb?: string } }) {
  const { me } = useMe();
  const list = useLoad(() => api<Recording[]>(`/modules/${id}/recordings`), [id]);
  const act = useAction();
  const reads = manifest.actions.filter((a) => a.effect === 'read');
  const [action, setAction] = useState(reads[0]?.name ?? '');
  const schemaOf = (name: string) => reads.find((a) => a.name === name)?.input;
  const [input, setInput] = useState(() => inputTemplate(schemaOf(reads[0]?.name ?? '')));
  const fields = inputFields(schemaOf(action));
  const [name, setName] = useState('');
  const [result, setResult] = useState<{ test: RecordedTest; output: unknown } | null>(null);
  const canRecord = (me.role === 'admin' || me.role === 'approver') && reads.length > 0 && !manifest.browser && manifest.publicWeb !== 'read';
  return (
    <Card title={<><Icon name="check" />Recorded tests</>} actions={<span className="badge tone-info">{list.data?.length ?? 0}</span>}>
      <p className="muted">A read action run once against the real app, with your own access. Its requests and answers (your secrets replaced) become a test that every new version of this module must pass before it can be approved.</p>
      {!list.data ? <Loading /> : list.data.length ? (
        <ul className="list" aria-label="Recorded tests">
          {list.data.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong> <code>{t.action}</code> <span className="muted">from {t.fromVersion} by {t.recordedBy ?? 'someone'} · <When at={t.recordedAt} /></span>
              {me.role === 'admin' ? <button className="ghost" disabled={act.busy} onClick={() => act.run(async () => (await api(`/recordings/${t.id}`, { method: 'DELETE' }), list.reload()), 'Recorded test removed')}>Remove</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canRecord ? (
        <>
          <h3>Record a test</h3>
          <div className="field">
            <label htmlFor="rec-action">Action (read-only)</label>
            <select id="rec-action" value={action} onChange={(e) => { setAction(e.target.value); setInput(inputTemplate(schemaOf(e.target.value))); }}>{reads.map((a) => <option key={a.name} value={a.name}>{a.title}</option>)}</select>
          </div>
          <div className="field">
            <label htmlFor="rec-input">Input (JSON)</label>
            <textarea id="rec-input" rows={3} value={input} onChange={(e) => setInput(e.target.value)} />
            {fields.length ? <ul className="muted small" aria-label="Inputs this action takes">{fields.map((f) => <li key={f}><code>{f}</code></li>)}</ul> : <p className="muted small">This action takes no input: <code>{'{}'}</code></p>}
          </div>
          <div className="field">
            <label htmlFor="rec-name">Test name</label>
            <input id="rec-name" value={name} placeholder="e.g. lists open MRs of acme/app" onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <button disabled={act.busy || !name.trim()} onClick={() => act.run(async () => {
              let parsed: unknown;
              try { parsed = JSON.parse(input); } catch { throw new Error('The input is not valid JSON.'); }
              const r = await post<{ test: RecordedTest; output: unknown }>(`/modules/${id}/record`, { action, input: parsed, name: name.trim() });
              setResult(r);
              return r;
            }, (r) => `Recorded ${r.test.http.length} request${r.test.http.length === 1 ? '' : 's'}; check it, then save`)}>
              <Icon name="bolt" size={15} />Run and record
            </button>
          </div>
          {result ? (
            <div className="recording-result">
              <p>Recorded:</p>
              <ul className="list">{result.test.http.map((h, i) => <li key={i}><code>{h.method} {h.urlPrefix}</code> → {h.status}</li>)}</ul>
              <details><summary>Answers as recorded (check for personal data before saving)</summary><Pre>{result.test.http.map((h) => (h.body !== undefined ? h.body : JSON.stringify(h.json ?? null, null, 2))).join('\n\n')}</Pre></details>
              <div className="row">
                <button className="primary" disabled={act.busy} onClick={() => act.run(async () => (await post(`/modules/${id}/recordings`, { test: result.test }), setResult(null), setName(''), list.reload()), 'Recorded test saved')}>Save as test</button>
                <button disabled={act.busy} onClick={() => setResult(null)}>Discard</button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

interface FixedFlow { flowId: string; name: string; versionId?: string; status: 'proposed' | 'needs_person'; reason?: string }
interface DriftFix { attemptedAt: string; moduleVersionId: string | null; ref: string | null; status: string | null; error: string | null; flows: FixedFlow[] }
interface Drift { module: string; version: string; detectedAt: string; summary: { calls: number; failures: number; errors: Record<string, number>; actions: string[] }; fix: DriftFix | null }

/** What Dittoly did by itself about a drifting module: the fix it drafted, and each Flow that uses it. */
function FixStatus({ fix }: { fix: DriftFix }) {
  return (
    <div className="assistant-note" role="note">
      <p>
        <Icon name="sparkles" size={14} /> Dittoly drafted a fix by itself <When at={fix.attemptedAt} />:{' '}
        {fix.moduleVersionId ? <Link to={`/modules/${fix.moduleVersionId}`}>{fix.ref}</Link> : 'no draft'}{' '}
        {fix.error ? <span className="badge tone-danger">{fix.error}</span> : fix.status === 'pending_review' ? <span className="badge tone-warn">waiting for review</span> : fix.status ? <span className="badge">{fix.status.replace('_', ' ')}</span> : null}
      </p>
      {fix.flows.length ? (
        <ul className="list" aria-label={`Flows using ${fix.ref ?? 'the module'}`}>
          {fix.flows.map((f) => (
            <li key={f.flowId}>
              <Link to={`/flows/${f.flowId}`}>{f.name}</Link>{' '}
              {f.status === 'proposed' ? <span className="badge tone-ok">new version proposed, tests pass</span> : <><span className="badge tone-warn">needs a person</span> <span className="muted">{f.reason}</span></>}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface SelfFix { enabled: boolean; perDay: number; aiConfigured: boolean }

/** Admins: whether Dittoly drafts fixes for drifting modules by itself, and how many a day (they use the organization's AI). */
export function SelfFixCard() {
  const s = useLoad(() => api<SelfFix>('/admin/self-fix'));
  const act = useAction();
  const [perDay, setPerDay] = useState<string | null>(null);
  if (!s.data) return null;
  const save = (next: { enabled: boolean; perDay: number }) => act.run(async () => (await api('/admin/self-fix', { method: 'PUT', body: next }), s.reload()), next.enabled ? 'Self-fixing is on' : 'Self-fixing is off');
  const n = Number(perDay ?? s.data.perDay);
  return (
    <Card title={<><Icon name="sparkles" />Self-fixing Flows</>} actions={<span className={`badge ${s.data.enabled ? 'tone-ok' : ''}`}>{s.data.enabled ? 'on' : 'off'}</span>}>
      <p className="muted">When an app changes and a module starts failing, Dittoly asks the organization's AI for a fixed module. The fix runs the module's tests and the tests recorded against the real app. Each Flow that uses the module gets a new version pinned to the fix if the Flow's tests pass. Everything waits for approval, and the approved versions keep running until then. The AI is used only when something breaks.</p>
      {!s.data.aiConfigured ? <p className="muted">No organization AI is set up, so nothing is drafted.</p> : null}
      <div className="row">
        <label>Fixes a day, at most<input type="number" min={1} max={50} value={perDay ?? String(s.data.perDay)} onChange={(e) => setPerDay(e.target.value)} /></label>
        <button disabled={act.busy || !(n >= 1 && n <= 50)} onClick={() => save({ enabled: s.data!.enabled, perDay: n })}>Save</button>
        <button className={s.data.enabled ? 'danger' : 'primary'} disabled={act.busy} onClick={() => save({ enabled: !s.data!.enabled, perDay: s.data!.perDay })}>{s.data.enabled ? 'Turn off' : 'Turn on'}</button>
      </div>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** Admins: modules whose app seems to have changed. Renders nothing when all is well. */
export function DriftCard() {
  const { me } = useMe();
  const list = useLoad(() => api<Drift[]>('/modules-drift'));
  const act = useAction();
  if (!list.data?.length) return null;
  return (
    <Card title={<><Icon name="bolt" />Modules that may need a fix</>} actions={<span className="badge tone-warn">{list.data.length}</span>}>
      <p className="muted">Most calls in the last day failed the way they do when an app changes its API (not outages or expired tokens).</p>
      <ul className="list" aria-label="Drifting modules">
        {list.data.map((d) => (
          <li key={d.module} className="drift-item">
            <strong>{d.module}</strong> {d.version}: {d.summary.failures} of {d.summary.calls} calls failed ({Object.entries(d.summary.errors).map(([e, n]) => `${e.replace('http_', 'HTTP ')} ×${n}`).join(', ')}) in {d.summary.actions.join(', ')} · <When at={d.detectedAt} />
            {d.fix ? <FixStatus fix={d.fix} /> : null}
            {me.role === 'admin' ? (
              <>
                <button className="primary" disabled={act.busy} onClick={() => act.run(async () => {
                  const r = await post<{ id: string; version: string; passed: boolean }>(`/modules-drift/${d.module}/fix`);
                  navigate(`/modules/${r.id}`);
                  return r;
                }, (r) => `Drafted ${d.module} ${r.version}${r.passed ? '' : '; its tests do not pass yet'}`)}><Icon name="sparkles" size={14} />Propose a fix</button>
                <button disabled={act.busy} onClick={() => act.run(async () => (await post(`/modules-drift/${d.module}/dismiss`), list.reload()), 'Warning dismissed')}>Dismiss</button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

import { useState } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, Loading, Pre, Status, useAction, useLoad, When } from './components';
import { Icon, Notice } from './ui';

interface Endpoint {
  id: string; name: string; url: string; runAs: string | null; followsLatest: boolean; version: number | null; versionStatus: string | null;
  enabled: boolean; expiresAt: string | null; expired: boolean; previousTokenValidUntil: string | null; rateLimitPerMinute: number; lastUsedAt: string | null; createdAt: string;
  inputMap: Record<string, string> | null;
}

/** A JSON Pointer as people write it: "*" for the whole body, else the field's path ("summary", "errors/0/message"). */
const fromPointer = (p: string) => (p === '' ? '*' : p.replace(/^\//, ''));
const toPointer = (path: string) => (path.trim() === '*' ? '' : `/${path.trim().replace(/^\/+/, '')}`);

/**
 * Map a sender's own JSON onto the Flow's inputs, so it can call the URL without changing its payload.
 * Inputs left empty get nothing; fields of the body that are not mapped are ignored.
 */
function InputMapEditor({ endpoint, inputNames, onSaved }: { endpoint: Endpoint; inputNames: string[]; onSaved: (e: Endpoint) => void }) {
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(endpoint.inputMap ?? {}).map(([k, v]) => [k, fromPointer(v)])));
  const save = (map: Record<string, string> | null) =>
    act.run(async () => {
      onSaved(await api<Endpoint>(`/endpoints/${endpoint.id}`, { method: 'PATCH', body: { inputMap: map } }));
      setOpen(false);
    }, map ? 'Body mapping saved' : 'Body mapping removed: the body is the Flow\'s inputs again');
  const filled = Object.fromEntries(Object.entries(paths).filter(([, v]) => v.trim()).map(([k, v]) => [k, toPointer(v)]));
  if (!open) {
    return (
      <div className="row">
        <button type="button" className="ghost" onClick={() => setOpen(true)}>{endpoint.inputMap ? 'Edit body mapping' : 'Map the request body'}</button>
        {endpoint.inputMap ? <span className="muted">Maps {Object.entries(endpoint.inputMap).map(([k, v]) => `${k} ← ${fromPointer(v)}`).join(', ')}</span> : null}
      </div>
    );
  }
  return (
    <div className="stack" role="group" aria-label={`Body mapping for ${endpoint.name}`}>
      <p className="muted">
        For each input, the field of the posted JSON it comes from: <code>summary</code>, <code>errors/0/message</code>, or <code>*</code> for the whole body.
        Leave an input empty to give it nothing; other fields of the body are ignored.
      </p>
      {inputNames.length ? inputNames.map((n) => (
        <label key={n} className="field">
          <span>{n}</span>
          <input value={paths[n] ?? ''} placeholder="field path, or *" onChange={(e) => setPaths({ ...paths, [n]: e.target.value })} />
        </label>
      )) : <p className="muted">This Flow has no inputs to map to.</p>}
      <div className="row">
        <button type="button" className="primary" disabled={act.busy || !Object.keys(filled).length} onClick={() => save(filled)}>Save mapping</button>
        {endpoint.inputMap ? <button type="button" disabled={act.busy} onClick={() => save(null)}>Remove mapping</button> : null}
        <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}
type Issued = Endpoint & { token: string };

/** The address callers use, on the server the person is looking at. */
const urlOf = (id: string) => new URL(`/sflow/${id}`, location.origin).href;

/** The Flow's only input when it takes any JSON (no "type"): the server passes the whole body there. */
function anyJsonInput(inputs: unknown): string | null {
  const props = ((inputs ?? {}) as { properties?: Record<string, object> }).properties ?? {};
  const names = Object.keys(props);
  const schema = names.length === 1 ? props[names[0]!] : null;
  return schema && !['type', 'enum', 'const', '$ref'].some((k) => k in schema) ? names[0]! : null;
}

function curlExample(url: string, token: string, inputs: unknown): string {
  const props = Object.keys(((inputs ?? {}) as { properties?: object }).properties ?? {});
  const body = anyJsonInput(inputs) ? '{"any": "JSON your system sends"}' : JSON.stringify(Object.fromEntries(props.map((p) => [p, '…'])));
  return `curl -X POST '${url}' \\\n  -H 'x-sflow-token: ${token}' \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
}

/**
 * Flow URLs: other systems start this Flow by POSTing its inputs as
 * JSON with an x-sflow-token header. Runs are yours, with your own access.
 */
export function FlowUrlsCard({ flowId, versions, inputs }: { flowId: string; versions: { id: string; version: number; status: string }[]; inputs: unknown }) {
  const list = useLoad(() => api<Endpoint[]>(`/flows/${flowId}/endpoints`), [flowId]);
  const approved = versions.filter((v) => v.status === 'approved');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('latest');
  const [expires, setExpires] = useState('');
  const [overlap, setOverlap] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const act = useAction();
  const replace = (e: Endpoint) => list.setData((list.data ?? []).map((x) => (x.id === e.id ? e : x)));
  const copy = (text: string, what: string) => act.run(() => navigator.clipboard.writeText(text), `${what} copied`);

  return (
    <Card title={<><Icon name="globe" />Flow URLs</>} actions={<span className="badge tone-info">{list.data?.length ?? 0}</span>}>
      <p className="muted">
        Give another system its own URL to start this Flow: it sends the inputs as JSON with an <code>x-sflow-token</code> header and gets a run ID back
        to poll. Any JSON is accepted: a body that is not exactly the inputs goes whole to a Flow with one input, else each input takes the field of its
        name wherever it is; or map it yourself (Map the request body). Every run is yours, with your own access, so treat
        the token like a password.
      </p>

      {issued ? (
        <div className="token-reveal" role="region" aria-label="New token">
          <p><strong>Save this token now.</strong> It is shown once; only a fingerprint of it is stored.</p>
          <div className="manifest-box"><span>URL</span><code>{urlOf(issued.id)}</code><span>X-SFLOW-TOKEN</span><Pre>{issued.token}</Pre>
            {issued.previousTokenValidUntil ? <span>The previous token keeps working until {new Date(issued.previousTokenValidUntil).toLocaleString()}.</span> : null}
          </div>
          <div className="eyebrow">TRY IT</div>
          <Pre>{curlExample(urlOf(issued.id), issued.token, inputs)}</Pre>
          {anyJsonInput(inputs) && !issued.inputMap ? <p className="muted">This Flow takes any JSON: the whole body becomes its <code>{anyJsonInput(inputs)}</code> input, whatever its shape.</p> : null}
          <p className="muted">The answer is <code>202</code> with <code>runId</code> and <code>statusUrl</code>; GET the status URL with the same header to follow the run.</p>
          <div className="row">
            <button type="button" className="primary" onClick={() => copy(issued.token, 'Token')}><Icon name="key" size={15} />Copy token</button>
            <button type="button" onClick={() => copy(urlOf(issued.id), 'URL')}>Copy URL</button>
            <button type="button" onClick={() => copy(curlExample(urlOf(issued.id), issued.token, inputs), 'Example')}>Copy example</button>
            <button type="button" className="ghost" onClick={() => setIssued(null)}><Icon name="close" size={15} />I saved it</button>
          </div>
        </div>
      ) : null}

      <form className="form-grid" onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => {
          const body = {
            name: name.trim(),
            ...(pin === 'latest' ? { followLatest: true } : { versionId: pin }),
            ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
          };
          const created = await post<Issued>(`/flows/${flowId}/endpoints`, body);
          setIssued(created);
          setName('');
          setExpires('');
          list.reload();
        }, 'Flow URL created');
      }}>
        <div className="grid">
          <div className="field">
            <label htmlFor={`ep-name-${flowId}`}>Name</label>
            <input id={`ep-name-${flowId}`} value={name} maxLength={80} placeholder="e.g. CI pipeline" onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor={`ep-version-${flowId}`}>Version</label>
            <select id={`ep-version-${flowId}`} value={pin} onChange={(e) => setPin(e.target.value)}>
              <option value="latest">Always the latest approved version</option>
              {approved.map((v) => <option key={v.id} value={v.id}>Only version {v.version}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`ep-expires-${flowId}`}>Expires (optional)</label>
            <input id={`ep-expires-${flowId}`} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
        </div>
        {pin === 'latest'
          ? <p className="muted">Each new version still needs an approver; calls run whichever version is approved at the time.</p>
          : <p className="muted">When this version is replaced, the URL stops starting runs until you make a new one.</p>}
        <div><button type="submit" className="primary" disabled={act.busy || !name.trim()}><Icon name="plus" size={15} />Create URL</button></div>
      </form>
      <ErrorText>{act.error ?? list.error}</ErrorText>

      {list.loading && !list.data ? <Loading /> : list.data?.length ? (
        <ul className="plan-items">
          {list.data.map((e) => (
            <li key={e.id} className="plan-item">
              <div className="row between">
                <strong>{e.name}</strong>
                <Status value={e.expired ? 'expired' : e.enabled ? 'enabled' : 'disabled'} />
              </div>
              <code className="pre-wrap">{urlOf(e.id)}</code>
              <p className="muted">
                Runs as {e.runAs} · {e.followsLatest ? 'latest approved version' : `version ${e.version}${e.versionStatus !== 'approved' ? ' (no longer approved)' : ''}`}
                {' · '}{e.rateLimitPerMinute}/minute · {e.expiresAt ? <>expires <When at={e.expiresAt} /></> : 'no expiry'}
                {' · '}{e.lastUsedAt ? <>last used <When at={e.lastUsedAt} /></> : 'never used'}
              </p>
              {e.previousTokenValidUntil ? <p className="muted">The previous token works until <When at={e.previousTokenValidUntil} />.</p> : null}
              {anyJsonInput(inputs) && !e.inputMap ? <p className="muted">Takes any JSON: the whole body becomes the <code>{anyJsonInput(inputs)}</code> input.</p> : null}
              <InputMapEditor endpoint={e} inputNames={Object.keys(((inputs ?? {}) as { properties?: object }).properties ?? {})} onSaved={replace} />
              <div className="row">
                <button type="button" disabled={act.busy} onClick={() => act.run(async () => {
                  const rotated = await post<Issued>(`/endpoints/${e.id}/rotate`, { overlapSeconds: overlap ? 86_400 : 0 });
                  setIssued(rotated);
                  replace(rotated);
                }, overlap ? 'New token issued; the old one works for 24 hours' : 'New token issued; the old one stopped working')}>
                  <Icon name="refresh" size={14} />Rotate token
                </button>
                <button type="button" disabled={act.busy} onClick={() => act.run(async () => replace(await api<Endpoint>(`/endpoints/${e.id}`, { method: 'PATCH', body: { enabled: !e.enabled } })), e.enabled ? 'URL disabled' : 'URL enabled')}>
                  {e.enabled ? 'Disable' : 'Enable'}
                </button>
                <button type="button" className="danger" disabled={act.busy} onClick={() => {
                  if (!confirm(`Delete "${e.name}"? Callers using it will get 401.`)) return;
                  act.run(async () => { await api(`/endpoints/${e.id}`, { method: 'DELETE' }); list.reload(); }, 'URL deleted');
                }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      ) : <Empty>No URLs yet.</Empty>}
      {list.data?.length ? (
        <label className="choice"><input type="checkbox" checked={overlap} onChange={(e) => setOverlap(e.target.checked)} /> When rotating, keep the old token working for 24 hours</label>
      ) : null}
      <Notice>Only you (and admins) see your URLs. A URL can never do more than you could: the version must be approved and you must still be in the Flow's team.</Notice>
    </Card>
  );
}

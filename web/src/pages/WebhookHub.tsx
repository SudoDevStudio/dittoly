import { useState } from 'react';
import { api, post } from '../api';
import { Card, Empty, ErrorText, Loading, Pre, Status, useAction, useLoad } from '../components';
import { Icon, Notice } from '../ui';

interface Trigger { id: string; provider: string; enabled: boolean; flowName: string; version: number; flowVersionId: string; rateLimitPerMinute: number; versionStatus: string; url: string }
interface Flow { id: string; name: string; approvedVersionId: string | null }
interface Secret { secret: string; url: string; previousValidUntil?: string }

export function WebhookHub() {
  const triggers = useLoad(() => api<Trigger[]>('/triggers'));
  const flows = useLoad(() => api<Flow[]>('/flows'));
  const act = useAction();
  const [creating, setCreating] = useState(false);
  const [versionId, setVersionId] = useState('');
  const [provider, setProvider] = useState('standard');
  const [schema, setSchema] = useState('{"type":"object"}');
  const [inputMap, setInputMap] = useState('{}');
  const [rate, setRate] = useState(60);
  const [issued, setIssued] = useState<Secret | null>(null);
  const [copied, setCopied] = useState(false);
  const absoluteUrl = (url: string) => new URL(url, location.origin).href;
  const approved = flows.data?.filter(f => f.approvedVersionId) ?? [];
  return <>
    <div className="page-head"><div><div className="eyebrow">SIGNED INGRESS / AUTOMATED EXECUTION</div><h2>Webhook Trigger Hub</h2></div><button className="primary" onClick={() => setCreating(o => !o)} aria-expanded={creating}><Icon name="plus" size={16}/>{creating ? 'Close form' : 'Create Webhook'}</button></div>
    <Notice icon="bolt"><strong>Signed payloads. Pinned versions.</strong> Webhooks run one approved Flow version as you, validate incoming payloads, and map only the inputs you explicitly configure.</Notice>
    <ErrorText>{act.error ?? triggers.error ?? flows.error}</ErrorText>
    {issued ? <Card title="Save this webhook secret now" actions={<button onClick={() => { setIssued(null); setCopied(false); }}><Icon name="close" size={15}/>Dismiss</button>}><p className="muted">This secret is shown once. Store it with your webhook sender before dismissing this panel.</p><div className="manifest-box"><span>ENDPOINT</span><code>{absoluteUrl(issued.url)}</code><span>SIGNING SECRET</span><Pre>{issued.secret}</Pre>{issued.previousValidUntil ? <span>Previous secret works until {new Date(issued.previousValidUntil).toLocaleString()}.</span> : null}</div><button disabled={act.busy} onClick={() => act.run(async () => { await navigator.clipboard.writeText(issued.secret); setCopied(true); })}><Icon name={copied ? 'check' : 'key'} size={16}/>{copied ? 'Copied' : 'Copy secret'}</button></Card> : null}
    {creating ? <Card title="Create a signed webhook"><form className="form-grid" onSubmit={e => {
      e.preventDefault();
      let payloadSchema: unknown, mapping: unknown;
      try { payloadSchema = JSON.parse(schema); mapping = JSON.parse(inputMap); } catch { act.setError('Payload schema and input mapping must be valid JSON.'); return; }
      act.run(async () => { const result = await post<{ secret: string; url: string }>('/triggers', { flowVersionId: versionId, provider, payloadSchema, inputMap: mapping, rateLimitPerMinute: rate }); setIssued(result); setCopied(false); setCreating(false); triggers.reload(); });
    }}><div className="grid"><div className="field"><label htmlFor="trigger-flow">Approved Flow version</label><select id="trigger-flow" value={versionId} onChange={e => setVersionId(e.target.value)} required><option value="">Choose an approved Flow…</option>{approved.map(f => <option key={f.id} value={f.approvedVersionId!}>{f.name}</option>)}</select>{!approved.length ? <span className="muted">Approve a Flow before creating a webhook.</span> : null}</div><div className="field"><label htmlFor="trigger-provider">Signature provider</label><select id="trigger-provider" value={provider} onChange={e => setProvider(e.target.value)}><option value="standard">Standard Webhooks</option><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="token">Secret token header (Datadog, Grafana, Vector, Fluent Bit)</option></select></div></div><div className="grid"><div className="field"><label htmlFor="trigger-schema">Incoming payload JSON Schema</label><textarea id="trigger-schema" value={schema} onChange={e => setSchema(e.target.value)} rows={4} required/></div><div className="field"><label htmlFor="trigger-map">Flow input → payload JSON Pointer</label><textarea id="trigger-map" value={inputMap} onChange={e => setInputMap(e.target.value)} rows={4} placeholder='{"release":"/release"}' required/><span className="muted">Use exact input names from your approved Flow.</span></div></div><div className="field"><label htmlFor="trigger-rate">Maximum deliveries per minute</label><input id="trigger-rate" type="number" min={1} max={600} value={rate} onChange={e => setRate(Number(e.target.value))} required style={{ maxWidth: 180 }}/></div><div><button className="primary" type="submit" disabled={act.busy || !versionId}>{act.busy ? 'Creating…' : 'Create & Show Signing Secret'}</button></div></form></Card> : null}
    {!triggers.data ? triggers.error ? null : <Loading/> : !triggers.data.length ? <Card><Empty>No webhooks yet. Connect a signed trigger to an approved Flow.</Empty></Card> : triggers.data.map(t => <Card key={t.id}><div className="credential-head"><span className="brand-mark"><Icon name="bolt"/></span><div><strong>{t.flowName} · v{t.version}</strong><div className="muted">{t.provider} · {t.rateLimitPerMinute} deliveries/minute</div></div><span className="spacer"/><Status value={t.enabled && t.versionStatus === 'approved' ? 'running' : 'paused'}/></div><div className="manifest-box"><span>INGRESS ENDPOINT</span><code>{absoluteUrl(t.url)}</code>{t.versionStatus !== 'approved' ? <span className="tone-warn">This version is no longer approved; deliveries cannot start runs.</span> : null}</div><div className="row"><span className="muted">Rotation keeps the previous secret valid for 24 hours.</span><span className="spacer"/><button disabled={act.busy} onClick={() => act.run(async () => { const result = await post<{ secret: string; previousValidUntil: string }>(`/triggers/${t.id}/rotate-secret`, { overlapSeconds: 86400 }); setIssued({ ...result, url: t.url }); setCopied(false); })}><Icon name="refresh" size={15}/>Rotate Secret</button></div></Card>)}
  </>;
}

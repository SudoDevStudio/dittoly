import { useState } from 'react';
import { api } from './api';
import { Card, Empty, ErrorText, Loading, Page, useAction, useLoad, When } from './components';
import { Icon } from './ui';

/**
 * The AI system inventory (admins): every place AI is used, what its output can reach, and the
 * organization's own classification of each (risk class, purpose, owner, last reviewed).
 */

type RiskClass = 'not_classified' | 'minimal' | 'limited' | 'high' | 'prohibited_check';
interface Entry {
  key: string;
  kind: 'flow' | 'module' | 'agent' | 'feature';
  name: string;
  team: string | null;
  person: string | null;
  ai: string;
  detail: string;
  reach: { step: string; what: string; guarded: boolean }[];
  classification: { riskClass: RiskClass; purpose: string | null; owner: string | null; reviewedAt: string | null; reviewedBy: string | null };
}

const CLASSES: [RiskClass, string][] = [
  ['not_classified', 'Not classified yet'],
  ['minimal', 'Minimal risk'],
  ['limited', 'Limited risk (transparency)'],
  ['high', 'High risk'],
  ['prohibited_check', 'Check: possibly prohibited'],
];
const KINDS: Record<Entry['kind'], string> = { flow: 'Flows with AI', module: 'Modules drafted by AI', agent: 'AI agents (MCP)', feature: 'AI features' };
const TONE: Record<RiskClass, string> = { not_classified: 'warn', minimal: 'ok', limited: 'info', high: 'bad', prohibited_check: 'bad' };

export function AiInventoryPage() {
  const list = useLoad(() => api<{ entries: Entry[] }>('/admin/ai-inventory'));
  return (
    <Page
      title="AI inventory"
      eyebrow="GOVERNANCE / AI SYSTEMS"
      description="Every place AI is used here, built from what is set up now. Classify each one for your records: it is evidence for your AI register, not a legal assessment."
      actions={<><a className="button" href="/api/admin/ai-inventory?format=csv" download>Download CSV</a><a className="button" href="/api/admin/ai-inventory" target="_blank" rel="noreferrer">Open as JSON</a></>}
    >
      {list.error ? <ErrorText>{list.error}</ErrorText> : !list.data ? <Loading /> : !list.data.entries.length ? <Empty>No AI in use.</Empty> : (
        (Object.keys(KINDS) as Entry['kind'][]).map((kind) => {
          const entries = list.data!.entries.filter((e) => e.kind === kind);
          return entries.length ? (
            <Card key={kind} title={<><Icon name="sparkles" />{KINDS[kind]}</>}>
              <ul className="list">{entries.map((e) => <EntryRow key={e.key} entry={e} onSaved={list.reload} />)}</ul>
            </Card>
          ) : null;
        })
      )}
    </Page>
  );
}

function EntryRow({ entry: e, onSaved }: { entry: Entry; onSaved: () => void }) {
  const [riskClass, setRiskClass] = useState<RiskClass>(e.classification.riskClass);
  const [purpose, setPurpose] = useState(e.classification.purpose ?? '');
  const [owner, setOwner] = useState(e.classification.owner ?? '');
  const act = useAction();
  const save = () => act.run(async () => (await api(`/admin/ai-inventory/${e.key}`, { method: 'PUT', body: { riskClass, purpose, owner } }), onSaved()), 'Classification saved');
  const label = CLASSES.find(([c]) => c === e.classification.riskClass)![1];
  return (
    <li>
      <div className="row">
        <strong>{e.name}</strong>
        <span className={`badge tone-${TONE[e.classification.riskClass]}`}>{label}</span>
        {e.team ? <span className="muted">team {e.team}</span> : null}
        {e.person ? <span className="muted">· {e.person}</span> : null}
      </div>
      <p className="muted">{e.detail}. AI: {e.ai}.</p>
      {e.reach.length ? (
        <ul className="list" aria-label="What the AI output can reach">
          {e.reach.map((r) => (
            <li key={r.step}>{r.step}: {r.what} {r.guarded ? <span className="badge tone-ok">a person checks first</span> : <span className="badge tone-warn">not checked by a person (accepted by the approver)</span>}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>Classify{e.classification.reviewedAt ? <> · last reviewed <When at={e.classification.reviewedAt} /> by {e.classification.reviewedBy ?? '—'}</> : ' · never reviewed'}</summary>
        <div className="row">
          <div className="field">
            <label htmlFor={`rc-${e.key}`}>Risk class</label>
            <select id={`rc-${e.key}`} value={riskClass} onChange={(x) => setRiskClass(x.target.value as RiskClass)}>
              {CLASSES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor={`pp-${e.key}`}>Purpose</label><input id={`pp-${e.key}`} value={purpose} maxLength={500} onChange={(x) => setPurpose(x.target.value)} /></div>
          <div className="field"><label htmlFor={`ow-${e.key}`}>Owner</label><input id={`ow-${e.key}`} value={owner} maxLength={120} onChange={(x) => setOwner(x.target.value)} /></div>
        </div>
        <button className="primary" disabled={act.busy} onClick={save}>Save as reviewed today</button>
        {act.error ? <ErrorText>{act.error}</ErrorText> : null}
      </details>
    </li>
  );
}

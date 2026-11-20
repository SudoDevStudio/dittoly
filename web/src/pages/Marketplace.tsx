import { useState } from 'react';
import { api, post } from '../api';
import { Card, Empty, ErrorText, Loading, Page, Status, useAction, useLoad } from '../components';
import { useMe } from '../context';
import { Link, navigate } from '../router';
import { Icon, Metric, Notice, SearchField } from '../ui';

interface Listing {
  id: string;
  kind: 'module' | 'flow_template';
  title: string;
  summary: string;
  tags: string[];
  deprecated: boolean;
  latest?: { ref: string; id: string } | null;
  versions?: string[];
  hosts?: string[];
  actions?: { name: string; title: string; effect: string }[];
}

export function Marketplace() {
  const { me } = useMe();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [tag, setTag] = useState('');
  const list = useLoad(() => api<Listing[]>(`/marketplace?${new URLSearchParams({ ...(q ? { q } : {}), ...(kind ? { kind } : {}), ...(tag ? { tag } : {}) })}`), [q, kind, tag]);
  const tags = useLoad(() => api<{ tag: string; count: number }[]>('/marketplace/tags'));
  // While typing, tags that match come first: one click filters by the tag instead of the text.
  const typed = q.trim().toLowerCase().replace(/^#/, '');
  const chips = (tags.data ?? []).filter((t) => !typed || t.tag.includes(typed)).slice(0, typed ? 8 : 16);
  const act = useAction();

  return (
    <Page title="Marketplace" eyebrow="CONTROL PLANE / SHARED CATALOG" actions={<Link className="button primary" to="/modules"><Icon name="plus" size={16}/>Propose Integration</Link>}>
      <p className="muted">Integrations and Flow templates approved in your organization. Using a template gives you your own copy, which still needs approval before it runs.</p>
      <div className="metrics"><Metric label="Listed integrations" value={list.data ? list.data.filter(l => l.kind === 'module').length : '—'} detail="In the current catalog view" icon="layers"/><Metric label="Flow templates" value={list.data ? list.data.filter(l => l.kind === 'flow_template').length : '—'} detail="Copy into your own workspace" icon="flow"/><Metric label="Available listings" value={list.data ? list.data.filter(l => !l.deprecated).length : '—'} detail="Approved organization catalog" icon="shield"/><Metric label="Archived listings" value={list.data ? list.data.filter(l => l.deprecated).length : '—'} detail="Deprecated by your organization" icon="clock"/></div>
      <div className="toolbar">
        <SearchField value={q} onChange={setQ} placeholder="Filter by name, service, or tag…"/>
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">Everything</option>
          <option value="module">Integrations</option>
          <option value="flow_template">Flow templates</option>
        </select>
      </div>
      {chips.length || tag ? (
        <div className="tag-row" role="group" aria-label="Filter by tag">
          <span className="muted">{typed ? 'Matching tags:' : 'Popular tags:'}</span>
          {tag && !chips.some((c) => c.tag === tag) ? <button type="button" className="tag-chip selected" aria-pressed onClick={() => setTag('')}>#{tag} <Icon name="close" size={12} /></button> : null}
          {chips.map((c) => (
            <button type="button" key={c.tag} className={`tag-chip ${tag === c.tag ? 'selected' : ''}`} aria-pressed={tag === c.tag} onClick={() => { setTag(tag === c.tag ? '' : c.tag); if (typed) setQ(''); }}>
              #{c.tag} <span className="tag-count">{c.count}</span>
            </button>
          ))}
          {tag ? <button type="button" className="ghost" onClick={() => setTag('')}>Clear tag</button> : null}
        </div>
      ) : null}
      <ErrorText>{act.error ?? list.error}</ErrorText>
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty>Nothing listed yet.</Empty>
      ) : (
        <div className="market-grid">
          {list.data.map((l) => (
            <Card
              key={l.id}
              title={<><span className="brand-mark"><Icon name={l.kind === 'module' ? 'layers' : 'flow'}/></span>{l.title}</>}
              actions={l.deprecated ? <Status value="cancelled" /> : <span className="badge tone-info">{l.kind === 'module' ? 'integration' : 'template'}</span>}
            >
              <p>{l.summary}</p>
              {l.tags.length ? (
                <div className="tag-row">
                  {l.tags.map((t) => <button type="button" key={t} className={`tag-chip small ${tag === t ? 'selected' : ''}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>#{t}</button>)}
                </div>
              ) : null}
              {l.kind === 'module' && l.latest ? (
                <div className="manifest-box">
                  <p className="muted">
                    Latest approved: <Link to={`/modules/${l.latest.id}`}>{l.latest.ref}</Link> · connects to {l.hosts?.join(', ')}
                  </p>
                  <ul className="list">
                    {l.actions?.map((a) => (
                      <li key={a.name}>
                        {a.title} <span className={`badge ${a.effect === 'write' ? 'tone-warn' : 'tone-muted'}`}>{a.effect === 'write' ? 'changes data' : 'reads data'}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="row">
                {l.kind === 'module' && l.latest ? <Link to={`/modules/${l.latest.id}`} className="button"><Icon name="shield" size={15}/>Inspect Manifest</Link> : null}
                {l.kind === 'flow_template' && !l.deprecated ? (
                  <button className="primary" disabled={act.busy} onClick={() => act.run(async () => navigate(`/flows/${(await post<{ flowId: string }>(`/marketplace/${l.id}/use`)).flowId}`), 'Flow created from the template')}>
                    Use template
                  </button>
                ) : null}
                {me.role === 'admin' && !l.deprecated ? (
                  <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await post(`/marketplace/${l.id}/deprecate`), list.reload()))}>
                    Deprecate
                  </button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
      <Notice><strong>Copy-on-use governance.</strong> A Flow template creates a version in your own workspace. The copy must be approved before execution, and it runs with your credentials.</Notice>
    </Page>
  );
}

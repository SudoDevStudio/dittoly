import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ErrorText, useLoad } from './components';
import { navigate } from './router';
import { Icon, SearchField } from './ui';

/** Pages by their menu name; the older names still find them. */
const pages = [
  ['Home', '/', 'home', 'Home Command Center'], ['Create', '/create', 'plus', 'New Flow · New module · Synthesize'], ['Flows', '/flows', 'flow', 'Flows · AI Studio'],
  ['Super Flows', '/super-flows', 'superflow', ''],
  ['Apps', '/team-apps', 'grid', ''],
  ['Runs', '/runs', 'bolt', 'Live Runs & Executions'], ['Delegations', '/delegations', 'users', 'Teammate Delegations'],
  ['Modules', '/modules', 'layers', 'Super-Module Studio'], ['Marketplace', '/marketplace', 'market', 'Org Marketplace'],
  ['My credentials', '/credentials', 'key', 'Personal Credential Vault'], ['Members & Access', '/admin', 'shield', ''],
];

export function CommandSearch({ onClose, admin }: { onClose: () => void; admin: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const results = useLoad(async () => {
    const [flows, modules] = await Promise.all([
      api<{ id: string; name: string }[]>('/flows'),
      api<{ id: string; name: string; manifest: { title: string } }[]>('/modules'),
    ]);
    return [...flows.map(f => [f.name, `/flows/${f.id}`, 'flow']), ...modules.map(m => [m.manifest.title, `/modules/${m.id}`, 'layers'])];
  });
  useEffect(() => { dialog.current?.showModal(); }, []);
  const items = [...pages.filter(p => admin || p[1] !== '/admin'), ...(results.data ?? [])].filter(p => `${p[0]} ${p[3] ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return <dialog ref={dialog} className="command-dialog" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }} aria-label="Search workspace">
    <div className="command-head"><SearchField value={q} onChange={setQ} placeholder="Search pages, Flows, and modules…"/><button className="ghost icon-button" aria-label="Close search" onClick={onClose}><Icon name="close"/></button></div>
    <div className="eyebrow">QUICK JUMP</div><ErrorText>{results.error}</ErrorText>
    <div className="command-results">{items.map(([label, to, icon]) => <button key={to} onClick={() => { navigate(to!); onClose(); }}><Icon name={icon!}/><span>{label}</span><Icon name="arrow" size={16}/></button>)}{items.length === 0 ? <p className="empty muted">No matching pages, Flows, or modules.</p> : null}</div>
    <div className="command-foot">Search your workspace <kbd>ESC to close</kbd></div>
  </dialog>;
}

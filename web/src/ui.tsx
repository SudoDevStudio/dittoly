import { Link } from './router';
import { ModuleLink } from './ModuleLink';
import { useState, type ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" /></>,
  flow: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 7v2a4 4 0 0 1-4 4h-4a4 4 0 0 0-4 4"/></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-12h-7z" />,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3a4 4 0 0 1 0 8"/></>,
  layers: <><path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/></>,
  market: <><path d="M3 9h18l-2 12H5zM7 9V7a5 5 0 0 1 10 0v2"/></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></>,
  moon: <path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4M18 4h4"/></>,
  key: <><circle cx="8" cy="12" r="5"/><path d="M13 12h9m-3 0v3m-3-3v2"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  file: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></>,
  phone: <><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
  chart: <><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></>,
  alert: <><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.5v.01"/></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>,
  superflow: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4a3 3 0 0 1 3 3V14"/></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></>,
  bot: <><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 13v1M15 13v1M2 13v3M22 13v3"/></>,
  stop: <><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M9.5 9.5h5v5h-5z"/></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></>,
};

export function Icon({ name, size = 19, className = '' }: { name: string; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name] ?? paths.layers}</svg>;
}

export function Metric({ label, value, detail, icon, tone = '' }: { label: string; value: ReactNode; detail: string; icon: string; tone?: string }) {
  return <div className={`metric ${tone}`}><div className="metric-label"><span>{label}</span><Icon name={icon}/></div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div><div className="metric-rail"/></div>;
}

export function SearchField({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <div className="search-field"><Icon name="search" size={17}/><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)}/></div>;
}

export function Notice({ children, icon = 'shield' }: { children: ReactNode; icon?: string }) {
  return <div className="notice"><Icon name={icon}/><div>{children}</div></div>;
}

export function Avatar({ name }: { name: string }) {
  return <span className="avatar" aria-hidden="true">{name.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase()}</span>;
}

export interface GraphStep {
  id: string; type: string; title?: string | null; module?: string | null; action?: string | null; status?: string; input?: unknown;
  /** Flow steps (a Super Flow): the Flows it runs, as defined... */
  runs?: { id: string; flow: string; version: number }[];
  /** ...or as they ran. */
  children?: { key: string; flowName: string; version: number; status: string; runId?: string }[];
}

const NODE: Record<string, [label: string, icon: string, note: string]> = {
  approval: ['APPROVAL GATE', 'lock', 'Human sign-off required'],
  delay: ['DELAY', 'clock', 'Waits'],
  input: ['ASKS YOU', 'users', 'You fill in a form'],
  ai: ['AI', 'sparkles', 'AI answers'],
  browse: ['AI BROWSER', 'globe', 'Checks the app'],
  report: ['REPORT', 'check', 'Formats results'],
  app: ['APP', 'terminal', 'Builds and starts a branch'],
  fix: ['FIX & VERIFY', 'terminal', 'AI fixes, Dittoly checks'],
  flow: ['FLOWS', 'flow', ''],
};

/** The steps in order. A Super Flow's flow steps show the Flows they run, side by side (they run at the same time). */
export function FlowGraph({ steps, flowNames = {}, remove }: { steps: GraphStep[]; flowNames?: Record<string, string>; remove?: { onRemove: (stepId: string, title?: string | null, usedBy?: string[]) => void; busyId: string | null; busy: boolean; usedBy: (stepId: string) => string[] } }) {
  return <div className="flow-canvas"><div className="canvas-caption"><span>WORKFLOW / EXECUTION ORDER</span><span>{steps.length} NODES · SCROLL TO EXPLORE →</span></div><div className="graph-track" tabIndex={0} role="region" aria-label="Workflow steps, scroll horizontally to explore">{steps.map((s, i) => {
    const [label, icon, note] = NODE[s.type] ?? ['SUPER-MODULE', 'layers', s.id];
    const flows = s.type === 'flow'
      ? (s.children?.map((c) => ({ key: c.key, name: c.flowName, version: c.version, status: c.status, href: c.runId ? `/runs/${c.runId}` : undefined })) ?? s.runs?.map((r) => ({ key: r.id, name: flowNames[r.flow] ?? 'Flow', version: r.version, status: undefined as string | undefined, href: `/flows/${r.flow}` as string | undefined })) ?? [])
      : [];
    return <div className="graph-segment" key={s.id}><div className={`graph-node ${s.type === 'approval' ? 'gate' : ''} ${s.type === 'flow' ? 'flow-node' : ''}`}>
      <div className="node-label">{String(i + 1).padStart(2, '0')} · {s.type === 'flow' ? (flows.length > 1 ? `${flows.length} FLOWS AT ONCE` : 'RUNS A FLOW') : label}</div>
      <div className="node-title"><Icon name={icon}/><strong>{s.title ?? s.id}</strong></div>
      {s.type === 'flow'
        ? <div className="node-flows">{flows.map((f) => <div className="node-flow" key={f.key}><Icon name="flow" size={13}/>{f.href ? <Link to={f.href}>{f.name}</Link> : <span>{f.name}</span>}<code>v{f.version}</code>{f.status ? <span className="node-action">{f.status.replace(/_/g, ' ')}</span> : null}</div>)}</div>
        : s.module ? <code><ModuleLink refText={s.module} /></code> : <code>{note}</code>}
      {s.action ? <div className="node-action">{s.action}</div> : null}{s.status ? <div className="node-action">{s.status.replace(/_/g, ' ')}</div> : null}
      {remove && steps.length > 1 ? (() => {
        const users = remove.usedBy(s.id);
        return <button type="button" className="node-remove" disabled={remove.busy} onClick={() => remove.onRemove(s.id, s.title, users)} aria-label={`Remove step ${s.title ?? s.id} from the Flow`} title={users.length ? `Later steps use its result (${users.join(', ')}): the AI removes it and adjusts them. Makes a new version to approve.` : 'Makes a new version of the Flow without this step, to approve.'}>
          {remove.busyId === s.id ? 'Removing…' : users.length ? '✕ Remove with AI' : '✕ Remove'}
        </button>;
      })() : null}
    </div>{i < steps.length - 1 ? <span className="graph-connector"><Icon name="arrow"/></span> : null}</div>;
  })}</div></div>;
}

/**
 * An "i" next to a field's label: what the field is, in plain words, and a short example. It opens on
 * hover, focus or a tap; `id` lets the field point at it (aria-describedby).
 */
export function InfoTip({ id, label, text, example }: { id?: string; label: string; text?: string | null; example?: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text && !example) return null;
  return (
    <span className={`info-tip${open ? ' open' : ''}`}>
      <button type="button" className="info-tip-button" aria-label="Field help" title={`About ${label}`} aria-expanded={open} onClick={() => setOpen(!open)} onBlur={() => setOpen(false)}>
        <Icon name="info" size={14} />
      </button>
      <span role="tooltip" id={id} className="info-tip-text">
        {text}
        {example ? <span className="info-tip-example">Example: <code>{example}</code></span> : null}
      </span>
    </span>
  );
}

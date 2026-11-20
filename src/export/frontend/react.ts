/** React components for the page plan (React/Vite and Next.js templates). */
export const REACT_APP_TSX = String.raw`import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  asItems, autoDisplay, coerce, columnsFor, createClient, formatValue, formFields, humanize, isImageUrl, pageFor, pathOf, pick, resultValue, signOffText, statusText,
  type AppFlow, type AppInfo, type Card, type Column, type Field, type InboxItem, type Page, type Run, type Source,
} from './dittoly/core.js';

// Same address as the app by default; VITE_API_URL points a development build elsewhere.
const client = createClient({ baseUrl: (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? '' });
type Action = { label: string; page: string; fill: Record<string, string> };
type Go = (path: string) => void;

function usePath(): [string, Go] {
  const [path, setPath] = useState(() => (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search));
  useEffect(() => {
    const on = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const go = useCallback((p: string) => { window.history.pushState(null, '', p); setPath(p); window.scrollTo(0, 0); }, []);
  return [path, go];
}

function readForm(form: HTMLFormElement, fields: Field[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const f of fields) {
    const el = form.elements.namedItem(f.name);
    if (el instanceof HTMLInputElement) raw[f.name] = f.widget === 'checkbox' ? el.checked : el.value;
    else if (el instanceof HTMLSelectElement) raw[f.name] = f.widget === 'multiselect' ? [...el.selectedOptions].map((o) => o.value) : el.value;
    else if (el instanceof HTMLTextAreaElement) raw[f.name] = el.value;
  }
  return coerce(fields, raw);
}

function FieldInput({ f, value }: { f: Field; value?: string }) {
  const id = 'f-' + f.name;
  const initial = value ?? (f.default === undefined ? '' : String(f.default));
  if (f.widget === 'checkbox') return <div className="dty-check"><input id={id} name={f.name} type="checkbox" defaultChecked={!!(value ?? f.default)} /><label htmlFor={id}>{f.label}</label></div>;
  let input: ReactNode;
  if (f.widget === 'select') input = <select id={id} name={f.name} required={f.required} defaultValue={initial}>{f.required ? null : <option value="" />}{f.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>;
  else if (f.widget === 'multiselect') input = <select id={id} name={f.name} multiple>{f.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>;
  else if (f.widget === 'textarea') input = <textarea id={id} name={f.name} required={f.required} placeholder={f.placeholder || undefined} maxLength={f.maxLength} defaultValue={initial} />;
  else input = <input id={id} name={f.name} required={f.required} type={f.widget === 'number' ? 'number' : ['email', 'date', 'url'].includes(f.widget) ? f.widget : 'text'} placeholder={f.placeholder || undefined} min={f.min} max={f.max} step={f.widget === 'number' && !f.integer ? 'any' : undefined} maxLength={f.maxLength} defaultValue={initial} />;
  return <div className="dty-field"><label htmlFor={id}>{f.label}{f.required ? ' *' : ''}</label>{input}{f.help ? <small>{f.help}</small> : null}</div>;
}

function ActionButton({ item, action, plan, go }: { item: unknown; action: Action; plan: AppInfo['plan']; go: Go }) {
  return <button className="dty-btn primary" type="button" onClick={() => {
    const q = new URLSearchParams();
    for (const [input, field] of Object.entries(action.fill)) { const v = pick(item, field); if (v !== undefined) q.set(input, String(v)); }
    go(pathOf(plan, action.page) + (q.size ? '?' + q.toString() : ''));
  }}>{action.label}</button>;
}

function ItemCard({ item, card, action, plan, go }: { item: unknown; card: Card; action?: Action; plan: AppInfo['plan']; go: Go }) {
  const img = card.image ? pick(item, card.image) : undefined;
  return <article className="dty-item">
    {isImageUrl(img) ? <img src={String(img)} alt="" loading="lazy" /> : null}
    <div className="dty-item-body">
      {card.badge && pick(item, card.badge) !== undefined ? <span className="dty-badge">{formatValue(pick(item, card.badge))}</span> : null}
      <h3>{formatValue(pick(item, card.title))}</h3>
      {card.subtitle ? <span className="dty-muted">{formatValue(pick(item, card.subtitle))}</span> : null}
      {card.text ? <p>{formatValue(pick(item, card.text))}</p> : null}
      {card.price ? <span className="dty-price">{formatValue(pick(item, card.price))}</span> : null}
    </div>
    {action ? <div className="dty-item-foot"><ActionButton item={item} action={action} plan={plan} go={go} /></div> : null}
  </article>;
}

interface ShowOpts { message?: string; columns?: Column[]; card?: Card; action?: Action }
function ShowValue({ value, display, opts, plan, go }: { value: unknown; display: string; opts: ShowOpts; plan: AppInfo['plan']; go: Go }) {
  const mode = display === 'auto' || !display ? autoDisplay(value) : display;
  if (mode === 'message') return <p className="dty-notice">{opts.message ?? formatValue(value ?? 'Done.')}</p>;
  if (mode === 'fields') {
    const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
    return <dl className="dty-fields">{Object.entries(obj).map(([k, v]) => [<dt key={k + ':t'}>{humanize(k)}</dt>, <dd key={k + ':d'}>{isImageUrl(v) ? <img className="dty-thumb" src={String(v)} alt="" /> : formatValue(v)}</dd>])}</dl>;
  }
  const items = asItems(value) ?? [];
  if (!items.length) return <p className="dty-empty">Nothing to show.</p>;
  if (mode === 'cards') {
    const card = opts.card ?? { title: columnsFor(items)[0]!.key };
    return <div className="dty-grid">{items.map((it, i) => <ItemCard key={i} item={it} card={card} action={opts.action} plan={plan} go={go} />)}</div>;
  }
  const cols = columnsFor(items, opts.columns);
  return <div className="dty-table-wrap"><table className="dty-table">
    <thead><tr>{cols.map((c) => <th key={c.key} scope="col">{c.label}</th>)}{opts.action ? <th /> : null}</tr></thead>
    <tbody>{items.map((it, i) => <tr key={i}>{cols.map((c) => <td key={c.key}>{formatValue(c.key ? pick(it, c.key) : it)}</td>)}{opts.action ? <td><ActionButton item={it} action={opts.action} plan={plan} go={go} /></td> : null}</tr>)}</tbody>
  </table></div>;
}

function RunPanel({ run, onChange, source, display, opts, plan, go }: { run: Run; onChange: (r: Run) => void; source: Source; display: string; opts: ShowOpts; plan: AppInfo['plan']; go: Go }) {
  const [error, setError] = useState('');
  return <section className="dty-card dty-stack" aria-live="polite">
    <div className="dty-status" data-status={run.status}>{statusText(run)}</div>
    {run.waiting.map((w) => {
      if (w.kind === 'approval') return <p key={w.stepId} className="dty-muted">Someone has to approve this before it continues.</p>;
      const fields: Field[] = (w.form?.fields ?? []).map((f: { name: string; label: string; help?: string; placeholder?: string; widget: string; required: boolean; choices?: { value: string; label: string }[]; default?: unknown }) => ({ name: f.name, label: f.label, help: f.help ?? '', placeholder: f.placeholder ?? '', widget: f.widget, required: f.required, choices: f.choices ?? [], default: f.default, integer: false }));
      const submit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        try { await client.answer(run.id, w.stepId, readForm(e.currentTarget, fields)); onChange(await client.settle(await client.run(run.id))); } catch (err) { setError((err as Error).message); }
      };
      return <form key={w.stepId} className="dty-form" onSubmit={submit}>
        <h2>{w.title ?? 'A few more details'}</h2>
        {w.form?.intro ? <p>{w.form.intro}</p> : null}
        {fields.map((f) => <FieldInput key={f.name} f={f} />)}
        <div><button className="dty-btn primary" type="submit">Send</button></div>
      </form>;
    })}
    {error ? <p className="dty-error">{error}</p> : null}
    {run.status === 'succeeded' ? <ShowValue value={resultValue(run, source)} display={display} opts={opts} plan={plan} go={go} /> : null}
  </section>;
}

const problem = (err: unknown) => ((err as { status?: number }).status === 401 ? 'Sign in to use this page.' : (err as Error).message);

function FormPage({ page, flow, plan, go }: { page: Extract<Page, { kind: 'form' }>; flow: AppFlow; plan: AppInfo['plan']; go: Go }) {
  const fields = useMemo(() => formFields(flow, page.fields), [flow, page.fields]);
  const pre = Object.fromEntries(new URLSearchParams(window.location.search));
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true); setError(''); setRun(null);
    try { setRun(await client.settle(await client.startRun(page.flow, readForm(e.currentTarget, fields)))); } catch (err) { setError(problem(err)); }
    setBusy(false);
  };
  return <div className="dty-stack">
    <form className="dty-form" onSubmit={submit}>
      {fields.map((f) => <FieldInput key={f.name} f={f} value={pre[f.name]} />)}
      <div><button className="dty-btn primary" type="submit" disabled={busy}>{busy ? 'Working…' : page.submitLabel}</button></div>
    </form>
    {error ? <p className="dty-error">{error}</p> : null}
    {run ? <RunPanel run={run} onChange={setRun} source={page.result.source} display={page.result.display} opts={{ message: page.result.message, columns: page.result.columns, card: page.result.card }} plan={plan} go={go} /> : null}
  </div>;
}

function ListPage({ page, plan, go }: { page: Extract<Page, { kind: 'table' | 'cards' }>; plan: AppInfo['plan']; go: Go }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const load = useCallback(async (extra: Record<string, unknown>) => {
    setRun(null); setError('');
    try { setRun(await client.settle(await client.startRun(page.flow, { ...page.inputs, ...extra }))); } catch (err) { setError(problem(err)); }
  }, [page]);
  useEffect(() => { void load({}); }, [load]);
  return <>
    {page.search ? <form className="dty-search" role="search" onSubmit={(e) => { e.preventDefault(); void load(query ? { [page.search!]: query } : {}); }}>
      <input type="search" aria-label="Search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <button className="dty-btn" type="submit">Search</button>
    </form> : null}
    {error ? <p className="dty-error">{error}</p> : !run ? <p className="dty-muted">Loading…</p> : run.status === 'succeeded'
      ? <ShowValue value={resultValue(run, page.source)} display={page.kind} opts={{ columns: page.columns, card: page.card, action: page.action }} plan={plan} go={go} />
      : <RunPanel run={run} onChange={setRun} source={page.source} display={page.kind} opts={{}} plan={plan} go={go} />}
  </>;
}

function InboxPage({ flows }: { flows: Map<string, AppFlow> }) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => { try { setItems(await client.inbox()); } catch (err) { setError(problem(err)); } }, []);
  useEffect(() => { if (client.token) void load(); }, [load]);
  if (!client.token) return <p className="dty-notice">Sign in with the admin token to see what waits for you.</p>;
  if (error) return <p className="dty-error">{error}</p>;
  if (!items) return <p className="dty-muted">Loading…</p>;
  if (!items.length) return <p className="dty-empty">Nothing is waiting for you.</p>;
  return <div className="dty-stack">{items.map((it) => <article key={it.runId + it.stepId} className="dty-card dty-stack">
    <h2>{(it.title ?? humanize(it.stepId)) + ' · ' + (flows.get(it.flow ?? '')?.name ?? it.flow ?? '')}</h2>
    <p className="dty-muted">{new Date(it.createdAt).toLocaleString()}</p>
    {it.kind === 'approval' && it.signOff ? <><p className="dty-muted">Text an AI wrote could steer this step. Approving lets it run with exactly these values:</p><pre className="dty-values">{signOffText(it)}</pre></> : null}
    {it.kind === 'approval'
      ? <div className="dty-row">
          <button className="dty-btn primary" type="button" onClick={async () => { await client.decide(it.runId, it.stepId, 'approved', it.signOff?.sha256); await load(); }}>Approve</button>
          <button className="dty-btn danger" type="button" onClick={async () => { await client.decide(it.runId, it.stepId, 'rejected', it.signOff?.sha256); await load(); }}>Reject</button>
        </div>
      : <p className="dty-muted">This run waits for a form; open it from the page that started it.</p>}
  </article>)}</div>;
}

function RunsPage({ flows }: { flows: Map<string, AppFlow> }) {
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof client.runs>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (client.token) client.runs().then(setRuns, (err: unknown) => setError(problem(err))); }, []);
  if (!client.token) return <p className="dty-notice">Sign in to see runs.</p>;
  if (error) return <p className="dty-error">{error}</p>;
  if (!runs) return <p className="dty-muted">Loading…</p>;
  if (!runs.length) return <p className="dty-empty">No runs yet.</p>;
  return <div className="dty-table-wrap"><table className="dty-table">
    <thead><tr><th>Flow</th><th>Status</th><th>Started</th><th>Finished</th></tr></thead>
    <tbody>{runs.map((r) => <tr key={r.id}><td>{flows.get(r.flow ?? '')?.name ?? r.flow}</td><td><span className="dty-status" data-status={r.status}>{humanize(r.status)}</span></td><td>{new Date(r.createdAt).toLocaleString()}</td><td>{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : ''}</td></tr>)}</tbody>
  </table></div>;
}

function TokenDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('');
  return <div className="dty-dialog-wrap" role="dialog" aria-modal="true" aria-labelledby="dty-signin">
    <form className="dty-dialog dty-form" onSubmit={(e) => { e.preventDefault(); client.setToken(value); onClose(); }}>
      <h2 id="dty-signin">Sign in</h2>
      <p className="dty-muted">Paste the access token you were given. It stays in this browser tab only.</p>
      <div className="dty-field"><input type="password" autoComplete="off" aria-label="Access token" value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></div>
      <div className="dty-row">
        <button className="dty-btn primary" type="submit">Sign in</button>
        {client.token ? <button className="dty-btn" type="button" onClick={() => { client.setToken(null); onClose(); }}>Sign out</button> : null}
        <button className="dty-btn" type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  </div>;
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState('');
  const [path, go] = usePath();
  const [signIn, setSignIn] = useState(false);
  const [, refresh] = useState(0);
  useEffect(() => { client.app().then(setInfo, (err: unknown) => setError((err as Error).message)); }, []);
  const flows = useMemo(() => new Map((info?.flows ?? []).map((f) => [f.key, f])), [info]);
  if (error) return <main className="dty-main"><p className="dty-error">This app cannot be reached: {error}</p></main>;
  if (!info) return <main className="dty-main"><p className="dty-muted">Loading…</p></main>;
  const plan = info.plan;
  const page = pageFor(plan, path.split('?')[0]!);
  const link = (p: Page) => <a key={p.id} className="dty-link" href={p.path} aria-current={p.id === page?.id ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(p.path); }}>{p.title}</a>;
  let body: ReactNode = <><h1>Page not found</h1><p><a href="/" onClick={(e) => { e.preventDefault(); go('/'); }}>Go to the start</a></p></>;
  if (page) {
    const head = page.kind === 'home' ? null : <div className="dty-page-header"><h1>{page.title}</h1>{'intro' in page && page.intro ? <p>{page.intro}</p> : null}</div>;
    let content: ReactNode = null;
    if (page.kind === 'home') content = <section className="dty-hero"><h1>{page.headline || page.title}</h1>{page.text ? <p>{page.text}</p> : null}<div className="dty-links">{page.links.map((id, i) => <a key={id} className={'dty-btn' + (i === 0 ? ' primary' : '')} href={pathOf(plan, id)} onClick={(e) => { e.preventDefault(); go(pathOf(plan, id)); }}>{plan.pages.find((p) => p.id === id)?.title ?? id}</a>)}</div></section>;
    else if (page.kind === 'form') content = flows.get(page.flow) ? <FormPage key={path} page={page} flow={flows.get(page.flow)!} plan={plan} go={go} /> : null;
    else if (page.kind === 'table' || page.kind === 'cards') content = <ListPage key={page.id} page={page} plan={plan} go={go} />;
    else if (page.kind === 'inbox') content = <InboxPage flows={flows} />;
    else content = <RunsPage flows={flows} />;
    body = <>{head}{content}</>;
  }
  const brand = info.theme?.brand as { logo?: string } | undefined;
  return <div className="dty-app" data-nav={plan.layout.nav === 'none' ? 'top' : plan.layout.nav} data-width={plan.layout.width}>
    <nav className="dty-nav" aria-label="Main">
      <a className="dty-brand" href="/" onClick={(e) => { e.preventDefault(); go('/'); }}>{brand?.logo ? <img src={brand.logo} alt="" /> : null}{info.name}</a>
      {plan.layout.nav === 'none' ? null : plan.pages.filter((p) => !(p.kind === 'home' && p.id === plan.home)).map(link)}
      <span className="dty-spacer" />
      <button className="dty-btn" type="button" onClick={() => setSignIn(true)}>{client.token ? 'Signed in' : 'Sign in'}</button>
    </nav>
    <main className="dty-main" id="main">{body}</main>
    {signIn ? <TokenDialog onClose={() => { setSignIn(false); refresh((n) => n + 1); }} /> : null}
  </div>;
}
`;

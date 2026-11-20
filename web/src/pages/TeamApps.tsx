import { useEffect, useState, type ChangeEvent } from 'react';
import { api, post } from '../api';
import { Card, Empty, ErrorText, Loading, Page, Status, useAction, useLoad } from '../components';
import { useMe } from '../context';
import { Link, navigate } from '../router';
import { teamQuery, useTeams } from '../teams';
import { Icon, Notice } from '../ui';
import type { Runnable } from './RunHub';

/**
 * Apps: pages over a team's approved Flows, opened inside Dittoly (/a/<app>/) by the whole team and exported
 * later. The layout is the export's page plan; the AI drafts it and people edit it here. Each saved change is a
 * new version an approver signs off; its runs use the team's shared keys.
 */

interface PlanPage {
  id: string;
  kind: 'home' | 'form' | 'table' | 'cards' | 'inbox' | 'runs';
  title: string;
  path: string;
  flow?: string;
  intro?: string;
  headline?: string;
  text?: string;
  links?: string[];
  submitLabel?: string;
  result?: { source?: unknown; display?: string; message?: string };
  [k: string]: unknown;
}
interface Plan { layout: { nav: string; width: string }; pages: PlanPage[]; home: string }
interface Brand { name: string; primary: string; accent?: string; font: string; radius: string; logo?: string }
interface Spec { flows: { flowId: string; versionId?: string }[]; plan: Plan; brand?: Brand }
interface AppItem { id: string; name: string; team: { id: string; name: string }; createdBy: string; liveVersion: number | null; latest: { id: string; version: number; status: string } }
interface AppVersion { id: string; version: number; status: string; spec: Spec; createdBy: string; createdAt: string }
interface AppDetail { id: string; name: string; teamId: string; createdBy: string; archived: boolean; versions: AppVersion[]; flows: { key: string; flowId: string; name: string; version?: number; pinned?: boolean; retired?: boolean; current?: number | null }[]; problems: string[] }

const FONTS = ['system', 'humanist', 'geometric', 'serif', 'rounded', 'mono'];
const RADII = ['none', 'small', 'medium', 'large'];
const KIND_NAMES: Record<PlanPage['kind'], string> = { home: 'Start page', form: 'Form', table: 'Table', cards: 'Cards', inbox: 'Waiting for you', runs: 'Runs' };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'page';

export function TeamApps() {
  const { current: team } = useTeams();
  const apps = useLoad(() => api<AppItem[]>(`/apps${teamQuery(team)}`), [team]);
  return (
    <Page title="Apps" eyebrow="APPS / YOUR TEAM'S APPS" description="Pages over your team's approved Flows: forms, lists and cards that anyone in the team opens here. Every run uses the team's shared keys, so everyone gets the same results. Export an app later to run it on its own.">
      <Card title={<><Icon name="layers" />Your team's apps</>}>
        <ErrorText>{apps.error}</ErrorText>
        {!apps.data ? <Loading /> : apps.data.length === 0 ? <Empty>No apps yet. Build one below.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>App</th><th>Team</th><th>Live</th><th>Latest</th><th /></tr></thead><tbody>
            {apps.data.map((a) => (
              <tr key={a.id}>
                <td><Link to={`/team-apps/${a.id}`}>{a.name}</Link></td>
                <td className="muted">{a.team.name}</td>
                <td>{a.liveVersion ? `v${a.liveVersion}` : <span className="muted">not yet</span>}</td>
                <td>v{a.latest.version} <Status value={a.latest.status} /></td>
                <td>{a.liveVersion ? <a className="button" href={`/a/${a.id}/`} target="_blank" rel="noopener">Open<Icon name="arrow" size={15} /></a> : null}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </Card>
      <Card title={<><Icon name="sparkles" />Build an app</>}>
        <AppBuilder onSaved={(r) => navigate(`/team-apps/${r.appId}`)} />
      </Card>
    </Page>
  );
}

export function TeamAppPage({ id }: { id: string }) {
  const { me, mode } = useMe();
  const detail = useLoad(() => api<AppDetail>(`/apps/${id}`), [id]);
  const act = useAction();
  const [shown, setShown] = useState<string | null>(null);
  if (detail.error) return <ErrorText>{detail.error}</ErrorText>;
  const d = detail.data;
  if (!d) return <Loading />;
  const live = d.versions.find((v) => v.status === 'approved');
  const latest = d.versions[0]!;
  const previewed = d.versions.find((v) => v.id === shown) ?? latest;
  const canEdit = d.createdBy === me.id || me.role === 'admin';
  const approver = me.role === 'admin' || me.role === 'approver';
  const decide = (v: AppVersion, decision: 'approved' | 'rejected') =>
    act.run(async () => { await post(`/app-versions/${v.id}/decision`, { decision }); detail.reload(); }, decision === 'approved' ? `Version ${v.version} is live` : `Version ${v.version} rejected`);

  return (
    <Page
      title={d.name}
      eyebrow="APPS / APP"
      description="Shared by the team: everyone opens the live version and sees its runs. A change is a new version that an approver signs off."
      actions={<>
        {live ? <a className="button primary" href={`/a/${d.id}/`} target="_blank" rel="noopener"><Icon name="arrow" size={16} />Open app</a> : null}
        {live && approver ? <button type="button" onClick={() => navigate(`/apps?fromApp=${d.id}`)}><Icon name="download" size={16} />Export</button> : null}
        <Link to="/team-apps" className="button">All apps</Link>
      </>}
    >
      {d.problems.length ? <Notice icon="shield"><strong>Not ready for the team yet.</strong><ul>{d.problems.map((p) => <li key={p}>{p}</li>)}</ul>A team admin switches a credential to the team's shared key and stores it under Teams.</Notice> : null}
      <Card title="Versions">
        <ul className="list">
          {d.versions.map((v) => (
            <li key={v.id} className="row between">
              <span><button type="button" className={v.id === previewed.id ? 'primary' : ''} aria-pressed={v.id === previewed.id} onClick={() => setShown(v.id)}>v{v.version}</button> <Status value={v.status} /></span>
              <span className="row">
                <a href={`/a/${d.id}/v/${v.id}/`} target="_blank" rel="noopener">Preview</a>
                {v.status === 'pending' && approver && (mode === 'local' || v.createdBy !== me.id) ? <>
                  <button type="button" className="primary" disabled={act.busy} onClick={() => decide(v, 'approved')}>Approve</button>
                  <button type="button" className="danger" disabled={act.busy} onClick={() => decide(v, 'rejected')}>Reject</button>
                </> : null}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted">Previews run for real: their runs use the team's shared keys.</p>
        <ErrorText>{act.error}</ErrorText>
      </Card>
      <Card title={`Preview of v${previewed.version}`}>
        <iframe className="app-preview" title={`Preview of ${d.name} v${previewed.version}`} src={`/a/${d.id}/v/${previewed.id}/`} key={`${previewed.id}:${previewed.status}`} />
      </Card>
      {canEdit ? (
        <Card title={<><Icon name="sparkles" />Change the app</>}>
          <AppBuilder existing={d} onSaved={(r) => { detail.reload(); setShown(r.versionId); }} />
        </Card>
      ) : null}
      {canEdit ? (
        <Card title="Delete this app">
          <p className="muted">It stops opening for the team. Its versions and runs are kept.</p>
          <button type="button" className="danger" disabled={act.busy} onClick={() => { if (confirm(`Delete "${d.name}"?`)) act.run(async () => { await api(`/apps/${d.id}`, { method: 'DELETE' }); navigate('/team-apps'); }, `${d.name} deleted`); }}>Delete app</button>
        </Card>
      ) : null}
    </Page>
  );
}

/** Choose Flows, draft the layout (AI or plain), edit it and the look, and save a version. */
/**
 * Follow a Flow's current approved version (the default), or pin one. A pinned version keeps the app's pages as they
 * are; once a newer version is approved it still reads, but its steps that change data no longer run.
 */
function PinPicker({ flowId, value, onChange }: { flowId: string; value: string; onChange: (versionId: string) => void }) {
  const versions = useLoad(() => api<{ id: string; version: number; status: string }[]>(`/flows/${flowId}/versions`), [flowId]);
  const usable = (versions.data ?? []).filter((v) => v.status === 'approved' || v.status === 'superseded').sort((a, b) => b.version - a.version);
  return (
    <select aria-label="Which version the app runs" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Follow the current approved version</option>
      {usable.map((v) => (
        <option key={v.id} value={v.id}>Pin to v{v.version}{v.status === 'superseded' ? ' (replaced: reads only)' : ''}</option>
      ))}
    </select>
  );
}

function AppBuilder({ existing, onSaved }: { existing?: AppDetail; onSaved: (r: { appId: string; versionId: string }) => void }) {
  const { current } = useTeams();
  const team = existing?.teamId ?? current;
  const base = existing?.versions[0]?.spec;
  const runnable = useLoad(() => api<Runnable[]>(`/runnable${teamQuery(team)}`), [team]);
  const act = useAction();
  const [name, setName] = useState(existing?.name ?? '');
  const [picked, setPicked] = useState<string[]>(base?.flows.map((f) => f.flowId) ?? []);
  // flowId -> pinned version id; absent: follow the Flow's current approved version.
  const [pins, setPins] = useState<Record<string, string>>(Object.fromEntries((base?.flows ?? []).filter((f) => f.versionId).map((f) => [f.flowId, f.versionId!])));
  const refs = () => picked.map((flowId) => (pins[flowId] ? { flowId, versionId: pins[flowId] } : { flowId }));
  const [brief, setBrief] = useState('');
  const [nav, setNav] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(base?.plan ?? null);
  const [keys, setKeys] = useState<{ key: string; name: string }[]>(existing?.flows ?? []);
  const [note, setNote] = useState('');
  const [brand, setBrand] = useState<Brand>(base?.brand ?? { name: existing?.name ?? 'My app', primary: '#2f6fdf', font: 'system', radius: 'medium' });
  const [json, setJson] = useState<string | null>(null);
  const flows = (runnable.data ?? []).filter((r) => !r.blocked && (!team || r.team.id === team));
  const unique = [...new Map(flows.map((f) => [f.flowId, f])).values()];

  const toggle = (id: string) => { setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); setPlan(null); };
  const onImage = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) { act.setError('Choose an image smaller than 4 MB.'); return; }
    const r = new FileReader();
    r.onload = () => { setImage(String(r.result)); setPlan(null); };
    r.readAsDataURL(f);
  };
  const draft = () => act.run(async () => {
    const r = await post<{ plan: Plan; explanation: string; ai: boolean; flows: { key: string; name: string }[] }>('/apps/layout', {
      name: name.trim() || 'My app', flows: refs(), ...(team ? { teamId: team } : {}), ...(brief.trim() ? { brief: brief.trim() } : {}), ...(image ? { image } : {}), ...(nav ? { nav } : {}),
    });
    setPlan(r.plan); setKeys(r.flows); setNote(r.explanation); setJson(null);
  });
  const save = () => act.run(async () => {
    const spec = { flows: refs(), plan, brand: { ...brand, name: name.trim() || brand.name } };
    const r = existing
      ? await post<{ appId: string; versionId: string; version: number }>(`/apps/${existing.id}/versions`, { name: name.trim(), spec })
      : await post<{ appId: string; versionId: string; version: number }>('/apps', { name: name.trim(), ...(team ? { teamId: team } : {}), spec });
    onSaved(r);
    return r;
  }, (r) => `Saved version ${r.version}: an approver signs it off before the team sees it`);

  return (
    <div className="app-stack">
      <div className="field"><label htmlFor="app-name">Name</label><input id="app-name" maxLength={60} value={name} placeholder="Order desk" onChange={(e) => setName(e.target.value)} /></div>
      <fieldset className="field"><legend>Flows it runs (your team's approved Flows)</legend>
        <ErrorText>{runnable.error}</ErrorText>
        {!runnable.data ? <Loading /> : unique.length === 0 ? <Empty>No approved Flows in this team yet.</Empty> : unique.map((f) => (
          <div key={f.flowId} className="row">
            <label className="check"><input type="checkbox" checked={picked.includes(f.flowId)} onChange={() => toggle(f.flowId)} />{f.name}</label>
            {picked.includes(f.flowId) ? <PinPicker flowId={f.flowId} value={pins[f.flowId] ?? ''} onChange={(v) => { setPins((p) => { const n = { ...p }; if (v) n[f.flowId] = v; else delete n[f.flowId]; return n; }); setPlan(null); }} /> : null}
          </div>
        ))}
      </fieldset>
      <div className="field"><label htmlFor="app-brief">What the app should look like (optional)</label><textarea id="app-brief" rows={3} maxLength={2000} value={brief} placeholder="An order desk: product cards with a Buy button, then a checkout form. Sidebar on the left." onChange={(e) => setBrief(e.target.value)} /></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="app-image">Layout sketch or screenshot (optional)</label><input id="app-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onImage} /></div>
        <div className="field"><label htmlFor="app-nav">Navigation</label><select id="app-nav" value={nav} onChange={(e) => setNav(e.target.value)}><option value="">Let it choose</option><option value="top">Top bar</option><option value="sidebar-left">Sidebar, left</option><option value="sidebar-right">Sidebar, right</option><option value="none">None</option></select></div>
      </div>
      <div><button type="button" disabled={act.busy || picked.length === 0} onClick={draft}><Icon name="sparkles" size={16} />{brief.trim() || image ? 'Draft the layout with AI' : 'Make the default layout'}</button></div>
      {note ? <p className="muted">{note}</p> : null}

      {plan ? (
        <>
          <div className="app-builder">
            <div className="app-stack">
              <h3>Pages</h3>
              {json === null ? <PlanEditor plan={plan} keys={keys} onChange={setPlan} /> : (
                <div className="field"><label htmlFor="plan-json">Layout as JSON (cards, columns and buttons are edited here)</label>
                  <textarea id="plan-json" rows={16} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
                </div>
              )}
              <div className="row">
                {json === null
                  ? <button type="button" className="ghost" onClick={() => setJson(JSON.stringify(plan, null, 2))}>Edit as JSON</button>
                  : <button type="button" onClick={() => { try { setPlan(JSON.parse(json)); setJson(null); } catch { act.setError('That is not valid JSON.'); } }}>Use this JSON</button>}
              </div>
              <h3>Look</h3>
              <div className="form-grid">
                <div className="field"><label htmlFor="b-primary">Main colour</label><input id="b-primary" type="color" value={brand.primary} onChange={(e) => setBrand({ ...brand, primary: e.target.value })} /></div>
                <div className="field"><label htmlFor="b-accent">Accent colour</label><input id="b-accent" type="color" value={brand.accent ?? '#c2410c'} onChange={(e) => setBrand({ ...brand, accent: e.target.value })} /></div>
                <div className="field"><label htmlFor="b-font">Font</label><select id="b-font" value={brand.font} onChange={(e) => setBrand({ ...brand, font: e.target.value })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></div>
                <div className="field"><label htmlFor="b-radius">Corners</label><select id="b-radius" value={brand.radius} onChange={(e) => setBrand({ ...brand, radius: e.target.value })}>{RADII.map((r) => <option key={r}>{r}</option>)}</select></div>
              </div>
            </div>
            <Outline plan={plan} brand={brand} name={name || 'My app'} keys={keys} />
          </div>
          <div className="row"><button type="button" className="primary" disabled={act.busy || !name.trim() || picked.length === 0} onClick={save}>{existing ? 'Save as a new version' : 'Save the app'}</button>
            <span className="muted">Saved versions open in a preview; an approver makes one live for the team.</span></div>
        </>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}

/** Edit the pages: titles, paths, texts, what a form's result shows, table or cards, order; add or remove pages. */
function PlanEditor({ plan, keys, onChange }: { plan: Plan; keys: { key: string; name: string }[]; onChange: (p: Plan) => void }) {
  const set = (i: number, patch: Partial<PlanPage>) => onChange({ ...plan, pages: plan.pages.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const move = (i: number, by: number) => {
    const pages = [...plan.pages];
    const [p] = pages.splice(i, 1);
    pages.splice(Math.max(0, Math.min(pages.length, i + by)), 0, p!);
    onChange({ ...plan, pages });
  };
  const remove = (i: number) => {
    const pages = plan.pages.filter((_, j) => j !== i);
    const gone = plan.pages[i]!.id;
    onChange({ ...plan, pages: pages.map((p) => (p.links ? { ...p, links: p.links.filter((l) => l !== gone) } : p)), home: plan.home === gone ? (pages[0]?.id ?? '') : plan.home });
  };
  const unique = (id: string) => { let out = id; for (let n = 2; plan.pages.some((p) => p.id === out || p.path === `/${out}`); n++) out = `${id}-${n}`.slice(0, 40); return out; };
  const add = (what: string) => {
    if (!what) return;
    let page: PlanPage;
    if (what === 'home') page = { id: unique('start'), kind: 'home', title: 'Start', path: `/${unique('start')}`, headline: 'Welcome', text: '', links: [] };
    else if (what === 'inbox') page = { id: unique('inbox'), kind: 'inbox', title: 'Waiting for you', path: `/${unique('inbox')}` };
    else if (what === 'runs') page = { id: unique('runs'), kind: 'runs', title: 'Runs', path: `/${unique('runs')}` };
    else {
      const [kind, key] = what.split(':') as ['form' | 'table', string];
      const id = unique(slug(`${key}-${kind}`));
      const title = keys.find((k) => k.key === key)?.name ?? key;
      page = kind === 'form'
        ? { id, kind: 'form', title, path: `/${id}`, flow: key, intro: '', submitLabel: 'Submit', result: { source: {}, display: 'auto' } }
        : { id, kind: 'table', title, path: `/${id}`, flow: key, intro: '', inputs: {}, source: {} };
    }
    onChange({ ...plan, pages: [...plan.pages, page] });
  };
  return (
    <div className="app-stack">
      <div className="form-grid">
        <div className="field"><label htmlFor="pl-nav">Navigation</label><select id="pl-nav" value={plan.layout.nav} onChange={(e) => onChange({ ...plan, layout: { ...plan.layout, nav: e.target.value } })}><option value="top">Top bar</option><option value="sidebar-left">Sidebar, left</option><option value="sidebar-right">Sidebar, right</option><option value="none">None</option></select></div>
        <div className="field"><label htmlFor="pl-width">Width</label><select id="pl-width" value={plan.layout.width} onChange={(e) => onChange({ ...plan, layout: { ...plan.layout, width: e.target.value } })}><option value="narrow">Narrow</option><option value="wide">Wide</option><option value="full">Full</option></select></div>
        <div className="field"><label htmlFor="pl-home">First page</label><select id="pl-home" value={plan.home} onChange={(e) => onChange({ ...plan, home: e.target.value })}>{plan.pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>
      </div>
      <ol className="app-pages">
        {plan.pages.map((p, i) => (
          <li key={p.id} className="app-page-edit">
            <div className="row between"><strong>{KIND_NAMES[p.kind]}{p.flow ? ` · ${keys.find((k) => k.key === p.flow)?.name ?? p.flow}` : ''}</strong>
              <span className="row">
                <button type="button" className="ghost" aria-label={`Move ${p.title} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="ghost" aria-label={`Move ${p.title} down`} disabled={i === plan.pages.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="ghost" aria-label={`Remove ${p.title}`} disabled={plan.pages.length === 1} onClick={() => remove(i)}>Remove</button>
              </span>
            </div>
            <div className="form-grid">
              <div className="field"><label htmlFor={`pt-${p.id}`}>Title</label><input id={`pt-${p.id}`} maxLength={60} value={p.title} onChange={(e) => set(i, { title: e.target.value })} /></div>
              <div className="field"><label htmlFor={`pp-${p.id}`}>Address</label><input id={`pp-${p.id}`} maxLength={80} value={p.path} onChange={(e) => set(i, { path: e.target.value.toLowerCase() })} /></div>
              {p.kind === 'table' || p.kind === 'cards' ? (
                <div className="field"><label htmlFor={`pk-${p.id}`}>Show as</label><select id={`pk-${p.id}`} value={p.kind} onChange={(e) => set(i, { kind: e.target.value as 'table' | 'cards' })}><option value="table">Table</option><option value="cards">Cards</option></select></div>
              ) : null}
              {p.kind === 'form' ? <>
                <div className="field"><label htmlFor={`ps-${p.id}`}>Button</label><input id={`ps-${p.id}`} maxLength={60} value={p.submitLabel ?? 'Submit'} onChange={(e) => set(i, { submitLabel: e.target.value })} /></div>
                <div className="field"><label htmlFor={`pr-${p.id}`}>Result shows</label><select id={`pr-${p.id}`} value={p.result?.display ?? 'auto'} onChange={(e) => set(i, { result: { ...(p.result ?? {}), display: e.target.value } })}><option value="auto">Whatever fits</option><option value="fields">Fields</option><option value="table">A table</option><option value="cards">Cards</option><option value="message">A message</option></select></div>
              </> : null}
            </div>
            {p.kind === 'home' ? <>
              <div className="field"><label htmlFor={`ph-${p.id}`}>Headline</label><input id={`ph-${p.id}`} maxLength={120} value={p.headline ?? ''} onChange={(e) => set(i, { headline: e.target.value })} /></div>
              <div className="field"><label htmlFor={`px-${p.id}`}>Text</label><textarea id={`px-${p.id}`} rows={2} maxLength={400} value={p.text ?? ''} onChange={(e) => set(i, { text: e.target.value })} /></div>
            </> : null}
            {p.kind === 'form' || p.kind === 'table' || p.kind === 'cards' ? (
              <div className="field"><label htmlFor={`pi-${p.id}`}>Intro</label><textarea id={`pi-${p.id}`} rows={2} maxLength={400} value={p.intro ?? ''} onChange={(e) => set(i, { intro: e.target.value })} /></div>
            ) : null}
            {p.kind === 'form' && p.result?.display === 'message' ? (
              <div className="field"><label htmlFor={`pm-${p.id}`}>Message after it runs</label><input id={`pm-${p.id}`} maxLength={200} value={p.result?.message ?? ''} onChange={(e) => set(i, { result: { ...(p.result ?? {}), message: e.target.value } })} /></div>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="field"><label htmlFor="pl-add">Add a page</label>
        <select id="pl-add" value="" onChange={(e) => add(e.target.value)}>
          <option value="">Choose…</option>
          {keys.map((k) => <option key={`f${k.key}`} value={`form:${k.key}`}>Form: {k.name}</option>)}
          {keys.map((k) => <option key={`t${k.key}`} value={`table:${k.key}`}>List: {k.name}</option>)}
          <option value="home">Start page</option>
          <option value="inbox">Waiting for you</option>
          <option value="runs">Runs</option>
        </select>
      </div>
    </div>
  );
}

/** A live sketch of the app as it is edited: its navigation and pages, in its colours. */
function Outline({ plan, brand, name, keys }: { plan: Plan; brand: Brand; name: string; keys: { key: string; name: string }[] }) {
  const [page, setPage] = useState(plan.home);
  useEffect(() => { if (!plan.pages.some((p) => p.id === page)) setPage(plan.home); }, [plan, page]);
  const shown = plan.pages.find((p) => p.id === page) ?? plan.pages[0];
  const side = plan.layout.nav.startsWith('sidebar');
  const radius = { none: '0', small: '4px', medium: '8px', large: '14px' }[brand.radius] ?? '8px';
  const links = plan.layout.nav === 'none' ? [] : plan.pages.filter((p) => p.kind !== 'home' || p.id !== plan.home);
  return (
    <figure className="app-outline" aria-label="Layout sketch" data-nav={plan.layout.nav} style={{ borderRadius: radius }}>
      <div className={side ? 'app-outline-side' : 'app-outline-top'} style={{ order: plan.layout.nav === 'sidebar-right' ? 2 : 0 }}>
        <strong style={{ color: brand.primary }}>{name}</strong>
        {links.map((p) => <button key={p.id} type="button" className={p.id === shown?.id ? 'current' : ''} onClick={() => setPage(p.id)}>{p.title}</button>)}
      </div>
      <div className="app-outline-main">
        {shown ? <>
          <h4>{shown.kind === 'home' ? shown.headline || shown.title : shown.title}</h4>
          <p className="muted">{KIND_NAMES[shown.kind]}{shown.flow ? ` of ${keys.find((k) => k.key === shown.flow)?.name ?? shown.flow}` : ''} · {shown.path}</p>
          {shown.kind === 'form' ? <><span className="app-outline-field" /><span className="app-outline-field" /><span className="app-outline-button" style={{ background: brand.primary, borderRadius: radius }}>{shown.submitLabel ?? 'Submit'}</span></> : null}
          {shown.kind === 'cards' ? <div className="app-outline-cards">{[0, 1, 2].map((n) => <span key={n} style={{ borderRadius: radius }} />)}</div> : null}
          {shown.kind === 'table' || shown.kind === 'runs' || shown.kind === 'inbox' ? <div className="app-outline-rows">{[0, 1, 2].map((n) => <span key={n} />)}</div> : null}
          {shown.kind === 'home' ? <span className="app-outline-button" style={{ background: brand.primary, borderRadius: radius }}>{shown.links?.length ? plan.pages.find((p) => p.id === shown.links![0])?.title ?? 'Start' : 'Start'}</span> : null}
        </> : null}
      </div>
      <figcaption className="muted">Sketch. Save to see the real pages in the preview.</figcaption>
    </figure>
  );
}

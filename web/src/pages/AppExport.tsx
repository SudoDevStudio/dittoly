import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { api, ApiError, post } from '../api';
import { Card, Empty, ErrorText, Loading, Page, useAction, useLoad, When } from '../components';
import { Icon, Notice } from '../ui';

/**
 * Export approved Flows as an app that runs on its own (a Docker image, configured by
 * environment variables): a runner, a headless API, a simple branded UI, or a frontend in
 * React, Next.js, Angular, Astro or Vue whose layout the organization's AI drafts.
 */

type Kind = 'runner' | 'api' | 'ui' | 'custom';
type Framework = 'react' | 'next' | 'angular' | 'astro' | 'vue';
interface FlowRow { id: string; name: string; team: { name: string }; approvedVersionId: string | null }
interface Brand { name: string; tagline?: string; logo?: string; primary: string; accent?: string; font: string; radius: string }
interface Tokens { bg: string; surface: string; text: string; muted: string; primary: string; onPrimary: string; accent: string; onAccent: string; border: string }
interface Theme { brand: Brand; light: Tokens; dark: Tokens; font: string; radius: string }
interface SavedTheme { id: string; name: string; brand: Brand; theme: Theme; updatedAt: string }
interface EnvVar { name: string; kind: string; required: boolean; secret: boolean; description: string; example?: string }
interface PlanPage { id: string; kind: string; title: string; path: string; flow?: string }
interface Plan { layout: { nav: string; width: string }; pages: PlanPage[]; home: string }
interface Preview { flows: { key: string; name: string; access: string; exposed: boolean; version: number }[]; modules: string[]; schedules: { flow: string; cron: string; timezone: string }[]; hooks: { flow: string; provider: string; env: string }[]; tables: string[]; env: EnvVar[]; needs: { ai: boolean; humanSteps: boolean; state: boolean }; defaultPlan: Plan }
interface ExportRow { id: string; name: string; kind: Kind; framework: string | null; sha256: string; createdAt: string; createdBy: string | null; flows: number; reexportable: boolean; updates: 'new' | 'pending' | null }
interface StepChange { id: string; type: string; title: string | null }
interface ExportChanges {
  id: string;
  name: string;
  reexportable: boolean;
  changed: boolean;
  problem: string | null;
  flows: { key: string; name: string; from: number | null; to: number | null; added: StepChange[]; removed: StepChange[]; changed: StepChange[] }[];
  modules: { added: string[]; removed: string[] };
  env: { added: { name: string; required: boolean }[]; removed: string[]; nowRequired: string[] };
  state: boolean | null;
}

const KINDS: { kind: Kind; title: string; text: string; icon: string }[] = [
  { kind: 'runner', title: 'Runner', text: 'Runs the Flows on their schedules and webhooks. No API, no pages.', icon: 'clock' },
  { kind: 'api', title: 'Headless API', text: 'Start runs and read results over HTTP, with an OpenAPI description.', icon: 'bolt' },
  { kind: 'ui', title: 'API + simple UI', text: 'The API plus a branded web app: run forms, results, approvals.', icon: 'layers' },
  { kind: 'custom', title: 'Your framework', text: 'The API plus a frontend project in the framework you pick, laid out from your Flows.', icon: 'flow' },
];
const FRAMEWORKS: [Framework, string][] = [['react', 'React (Vite)'], ['next', 'Next.js'], ['angular', 'Angular'], ['astro', 'Astro'], ['vue', 'Vue']];
const FONTS = ['system', 'humanist', 'geometric', 'serif', 'rounded', 'mono'];
const DEFAULT_BRAND: Brand = { name: '', primary: '#2f6fdf', font: 'system', radius: 'medium' };

const readFile = (file: File, max: number) =>
  new Promise<string>((resolve, reject) => {
    if (file.size > max) return reject(new Error(`The file is larger than ${Math.round(max / 1024)} KB.`));
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsDataURL(file);
  });

async function download(body: unknown, endpoint = '/api/app-exports'): Promise<string> {
  const res = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'x-dittoly-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new ApiError(res.status, data.error ?? `http_${res.status}`, data.detail);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'app.tar.gz';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

const stepName = (s: StepChange) => s.title ?? s.id;

/** What exporting an app again would change, in what a deployer acts on. */
function Changes({ c }: { c: ExportChanges }) {
  if (c.problem) return <ErrorText>It cannot be exported again as it was: {c.problem}</ErrorText>;
  if (!c.changed) return <p className="muted">Nothing changed: an export made now would hold the same Flow versions, modules and settings.</p>;
  return (
    <div className="stack">
      {c.flows.map((f) => (
        <div key={f.key}>
          <strong>{f.name}</strong>{' '}
          <span className="muted">{f.from === null ? `new, version ${f.to}` : f.to === null ? `no longer included (was version ${f.from})` : `version ${f.from} → ${f.to}`}</span>
          <ul>
            {f.added.map((s) => <li key={`a${s.id}`}>Step added: {stepName(s)} <span className="muted">({s.type})</span></li>)}
            {f.removed.map((s) => <li key={`r${s.id}`}>Step removed: {stepName(s)} <span className="muted">({s.type})</span></li>)}
            {f.changed.map((s) => <li key={`c${s.id}`}>Step changed: {stepName(s)} <span className="muted">({s.type})</span></li>)}
            {f.from !== null && f.to !== null && !f.added.length && !f.removed.length && !f.changed.length ? <li className="muted">Same steps; other details changed (inputs, form, schedule).</li> : null}
          </ul>
        </div>
      ))}
      {c.modules.added.length || c.modules.removed.length ? (
        <p>Modules: {[...c.modules.added.map((m) => `+ ${m}`), ...c.modules.removed.map((m) => `− ${m}`)].join(', ')}</p>
      ) : null}
      {c.env.added.length || c.env.removed.length || c.env.nowRequired.length ? (
        <div>
          <strong>Settings to update where the app runs</strong>
          <ul>
            {c.env.added.map((v) => <li key={`a${v.name}`}>New: <code>{v.name}</code>{v.required ? ' (required)' : ''}</li>)}
            {c.env.nowRequired.map((n) => <li key={`q${n}`}>Now required: <code>{n}</code></li>)}
            {c.env.removed.map((n) => <li key={`r${n}`}>No longer used: <code>{n}</code></li>)}
          </ul>
        </div>
      ) : null}
      {c.state === true ? <Notice icon="layers">Some Flows now wait or keep table rows: the app needs a state store (<code>STATE_URL</code>, Redis or Postgres).</Notice> : null}
      {c.state === false ? <p className="muted">No Flow waits any more: the app keeps runs in memory and no longer uses <code>STATE_URL</code>.</p> : null}
    </div>
  );
}

function Swatches({ theme }: { theme: Theme }) {
  return (
    <div className="row" aria-label="Theme preview">
      {(['light', 'dark'] as const).map((mode) => {
        const t = theme[mode];
        return (
          <div key={mode} className="export-swatch" style={{ background: t.bg, color: t.text, borderColor: t.border, fontFamily: theme.font, borderRadius: theme.radius }}>
            <strong>{theme.brand.name || 'Your app'}</strong>
            <span style={{ color: t.muted }}>{mode === 'light' ? 'Light' : 'Dark'} theme</span>
            <span className="export-swatch-button" style={{ background: t.primary, color: t.onPrimary, borderRadius: theme.radius }}>Primary</span>
            <span className="export-swatch-button" style={{ background: t.accent, color: t.onAccent, borderRadius: theme.radius }}>Accent</span>
          </div>
        );
      })}
    </div>
  );
}

export function AppExport() {
  const flows = useLoad(() => api<FlowRow[]>('/flows'));
  const themes = useLoad(() => api<SavedTheme[]>('/brand-themes'));
  const history = useLoad(() => api<ExportRow[]>('/app-exports'));
  const [review, setReview] = useState<ExportChanges | null>(null);
  const act = useAction();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Record<string, 'public' | 'token'>>({});
  const [kind, setKind] = useState<Kind>('ui');
  const [framework, setFramework] = useState<Framework>('react');
  const [themeId, setThemeId] = useState<string>('');
  const [brand, setBrand] = useState<Brand>(DEFAULT_BRAND);
  const [brandTheme, setBrandTheme] = useState<Theme | null>(null);
  const [brandNote, setBrandNote] = useState('');
  const [description, setDescription] = useState('');
  const [brief, setBrief] = useState('');
  const [nav, setNav] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ plan: Plan; explanation: string; ai: boolean } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [schedules, setSchedules] = useState(true);
  const [webhooks, setWebhooks] = useState(true);
  /** Exporting an app made in Dittoly (?fromApp=<id>): its Flows, layout and look, as the team used them. */
  const [fromApp, setFromApp] = useState<{ name: string; version: number; brand?: Brand } | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('fromApp');
    if (!id) return;
    void act.run(async () => {
      const a = await api<{ name: string; versions: { version: number; status: string; spec: { flows: { flowId: string }[]; plan: Plan; brand?: Brand } }[] }>(`/apps/${encodeURIComponent(id)}`);
      const live = a.versions.find((v) => v.status === 'approved');
      if (!live) throw new Error('This app has no approved version to export yet.');
      setName(a.name);
      setPicked(Object.fromEntries(live.spec.flows.map((f) => [f.flowId, 'token' as const])));
      setKind('ui');
      setPlan({ plan: live.spec.plan, explanation: `The layout of ${a.name} v${live.version}, as the team uses it.`, ai: false });
      setFromApp({ name: a.name, version: live.version, ...(live.spec.brand ? { brand: live.spec.brand } : {}) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approved = useMemo(() => (flows.data ?? []).filter((f) => f.approvedVersionId), [flows.data]);
  const body = {
    name: name.trim() || 'My app',
    kind,
    flows: Object.entries(picked).map(([flowId, access]) => ({ flowId, access })),
    ...(kind === 'custom' ? { framework } : {}),
    ...(themeId && (kind === 'ui' || kind === 'custom') ? { themeId } : {}),
    ...((kind === 'custom' || kind === 'ui') && plan ? { plan: plan.plan } : {}),
    ...(!themeId && (kind === 'ui' || kind === 'custom') && fromApp?.brand ? { brand: { ...fromApp.brand, name: name.trim() || fromApp.brand.name } } : {}),
    includeSchedules: schedules,
    includeWebhooks: webhooks,
  };
  const branded = kind === 'ui' || kind === 'custom';
  const ready = Object.keys(picked).length > 0;
  const stale = () => { setPreview(null); setPlan(null); };

  const toggle = (id: string) => { stale(); setPicked((p) => { const n = { ...p }; if (n[id]) delete n[id]; else n[id] = 'token'; return n; }); };
  const onLogo = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) act.run(async () => { const logo = await readFile(f, 200 * 1024); setBrand((b) => ({ ...b, logo })); });
  };
  const onImage = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) act.run(async () => { setImage(await readFile(f, 4 * 1024 * 1024)); setPlan(null); });
  };

  return (
    <Page title="Export as an app" eyebrow="APPS / EXPORT" description="Package approved Flows as an app that runs anywhere Docker does: the Flows become TypeScript code, with no database of their own. Every setting and credential becomes an environment variable.">
      {fromApp ? <Notice icon="layers">Exporting the app <strong>{fromApp.name}</strong> (v{fromApp.version}): its Flows, layout and look are filled in below.</Notice> : null}
      <Notice icon="shield">Only approved Flows and the exact approved module code go into an export. No secrets are included: whoever runs the app sets them as environment variables. Admins and approvers can export.</Notice>

      <Card title={<><Icon name="flow" />1. Flows</>}>
        {!flows.data ? <Loading /> : approved.length === 0 ? <Empty>No approved Flows yet.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Include</th><th>Flow</th><th>Team</th><th>Who may start it</th></tr></thead><tbody>
            {approved.map((f) => (
              <tr key={f.id}>
                <td><input type="checkbox" aria-label={`Include ${f.name}`} checked={!!picked[f.id]} onChange={() => toggle(f.id)} /></td>
                <td>{f.name}</td>
                <td className="muted">{f.team.name}</td>
                <td>
                  <select aria-label={`Access for ${f.name}`} disabled={!picked[f.id]} value={picked[f.id] ?? 'token'} onChange={(e) => { stale(); setPicked({ ...picked, [f.id]: e.target.value as 'public' | 'token' }); }}>
                    <option value="token">Holders of the app's API token</option>
                    <option value="public">Anyone (public, rate limited)</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <div className="form-grid">
          <div className="field"><label htmlFor="app-name">App name</label><input id="app-name" value={name} maxLength={60} placeholder="Order desk" onChange={(e) => { setName(e.target.value); setBrand({ ...brand, name: e.target.value }); if (fromApp) setPreview(null); else stale(); }} /></div>
          <label className="row"><input type="checkbox" checked={schedules} onChange={(e) => { setSchedules(e.target.checked); stale(); }} /> Include the Flows' schedules</label>
          <label className="row"><input type="checkbox" checked={webhooks} onChange={(e) => { setWebhooks(e.target.checked); stale(); }} /> Include their webhooks (each gets its own secret from the environment)</label>
        </div>
      </Card>

      <Card title={<><Icon name="layers" />2. What kind of app</>}>
        <div className="export-kinds" role="radiogroup" aria-label="App kind">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={`export-kind${kind === k.kind ? ' selected' : ''}`} onClick={() => { setKind(k.kind); stale(); }}>
              <Icon name={k.icon} /><strong>{k.title}</strong><span className="muted">{k.text}</span>
            </button>
          ))}
        </div>
        {kind === 'custom' ? (
          <div className="field"><label htmlFor="fw">Framework</label>
            <select id="fw" value={framework} onChange={(e) => setFramework(e.target.value as Framework)}>{FRAMEWORKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
        ) : null}
      </Card>

      {branded ? (
        <Card title={<><Icon name="sparkles" />3. Branding</>}>
          <div className="field"><label htmlFor="theme">Theme</label>
            <select id="theme" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
              <option value="">Default theme</option>
              {(themes.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <details>
            <summary>Make a new theme</summary>
            <div className="form-grid">
              <div className="field"><label htmlFor="b-name">Name on the app</label><input id="b-name" value={brand.name} maxLength={60} onChange={(e) => setBrand({ ...brand, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-logo">Logo (PNG, JPEG, WebP or SVG, up to 200 KB)</label><input id="b-logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onLogo} />{brand.logo ? <img className="export-logo" src={brand.logo} alt="Logo preview" /> : null}</div>
              <div className="row">
                <div className="field"><label htmlFor="b-primary">Main colour</label><input id="b-primary" type="color" value={brand.primary} onChange={(e) => setBrand({ ...brand, primary: e.target.value })} /></div>
                <div className="field"><label htmlFor="b-accent">Accent</label><input id="b-accent" type="color" value={brand.accent ?? '#c2410c'} onChange={(e) => setBrand({ ...brand, accent: e.target.value })} /></div>
                <div className="field"><label htmlFor="b-font">Font</label><select id="b-font" value={brand.font} onChange={(e) => setBrand({ ...brand, font: e.target.value })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></div>
                <div className="field"><label htmlFor="b-radius">Corners</label><select id="b-radius" value={brand.radius} onChange={(e) => setBrand({ ...brand, radius: e.target.value })}>{['none', 'small', 'medium', 'large'].map((r) => <option key={r}>{r}</option>)}</select></div>
              </div>
              <div className="field"><label htmlFor="b-desc">Ask the AI for a palette (optional)</label><input id="b-desc" value={description} maxLength={400} placeholder="An organic grocery shop, calm and fresh" onChange={(e) => setDescription(e.target.value)} /></div>
              <div className="row">
                <button type="button" className="ghost" disabled={act.busy || !brand.name} onClick={() => act.run(async () => {
                  const r = await post<{ brand: Brand; theme: Theme; explanation: string }>('/brand-themes/palette', { name: brand.name, description, primary: brand.primary });
                  setBrand({ ...r.brand, logo: brand.logo }); setBrandTheme(r.theme); setBrandNote(r.explanation);
                })}><Icon name="sparkles" />Suggest a palette</button>
                <button type="button" className="primary" disabled={act.busy || !brand.name} onClick={() => act.run(async () => {
                  const r = await post<{ id: string; theme: Theme }>('/brand-themes', { name: brand.name, brand: Object.fromEntries(Object.entries(brand).filter(([, v]) => v !== undefined && v !== '')) });
                  setBrandTheme(r.theme); setThemeId(r.id); themes.reload();
                }, 'Theme saved')}>Save theme</button>
              </div>
              {brandNote ? <p className="muted">{brandNote}</p> : null}
              <p className="muted">Text colours are adjusted until they meet WCAG contrast, in light and dark, whatever colours you pick.</p>
            </div>
          </details>
          {(brandTheme ?? themes.data?.find((t) => t.id === themeId)?.theme) ? <Swatches theme={(brandTheme ?? themes.data!.find((t) => t.id === themeId)!.theme)} /> : null}
        </Card>
      ) : null}

      {kind === 'custom' ? (
        <Card title={<><Icon name="flow" />4. Layout</>}>
          <p className="muted">Without a brief, the app gets a plain layout: a page per Flow. With one, your organization's AI plans the pages from the Flows and their modules (an online shop gets product cards and a checkout form). It never writes code: the plan picks from tested components.</p>
          <div className="form-grid">
            <div className="field"><label htmlFor="brief">Brief (optional)</label><textarea id="brief" rows={3} maxLength={2000} value={brief} placeholder="A shop: product cards with images and a Buy button, then checkout. Sidebar on the left." onChange={(e) => { setBrief(e.target.value); setPlan(null); }} /></div>
            <div className="row">
              <div className="field"><label htmlFor="nav">Navigation</label><select id="nav" value={nav} onChange={(e) => { setNav(e.target.value); setPlan(null); }}><option value="">Let it choose</option><option value="top">Top bar</option><option value="sidebar-left">Sidebar, left</option><option value="sidebar-right">Sidebar, right</option><option value="none">None</option></select></div>
              <div className="field"><label htmlFor="layout-img">Layout image (optional, up to 4 MB)</label><input id="layout-img" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onImage} /></div>
            </div>
            {image ? <img className="export-layout" src={image} alt="Layout to follow" /> : null}
            <div><button type="button" className="primary" disabled={act.busy || !ready} onClick={() => act.run(async () => setPlan(await post('/app-exports/plan', { export: { ...body, plan: undefined }, ...(brief ? { brief } : {}), ...(image ? { image } : {}), ...(nav ? { nav } : {}) })))}>{brief || image ? 'Draft the layout with AI' : 'Make the default layout'}</button></div>
          </div>
          {plan ? (
            <div className="export-plan">
              <p className="muted">{plan.ai ? 'Drafted by your AI: ' : ''}{plan.explanation}</p>
              <p>Navigation: <strong>{plan.plan.layout.nav}</strong></p>
              <ol>{plan.plan.pages.map((p) => <li key={p.id}><strong>{p.title}</strong> <code>{p.path}</code> <span className="muted">— {p.kind}{p.flow ? ` of ${p.flow}` : ''}</span></li>)}</ol>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title={<><Icon name="check" />{branded ? (kind === 'custom' ? '5' : '4') : '3'}. Check and download</>}>
        <div className="row">
          <button type="button" className="ghost" disabled={act.busy || !ready} onClick={() => act.run(async () => setPreview(await post<Preview>('/app-exports/preview', { ...body, plan: undefined })))}>Check what it needs</button>
          <button type="button" className="primary" disabled={act.busy || !ready || (kind === 'custom' && !plan)} onClick={() => act.run(async () => { const f = await download(body); history.reload(); return f; }, (f) => `Downloaded ${f}`)}><Icon name="download" />Download bundle</button>
          {kind === 'custom' && !plan ? <span className="muted">Make the layout first.</span> : null}
        </div>
        <ErrorText>{act.error}</ErrorText>
        {preview ? (
          <div className="export-preview">
            <p>{preview.flows.length} Flow{preview.flows.length === 1 ? '' : 's'} ({preview.flows.filter((f) => !f.exposed).length} only run by others), modules {preview.modules.join(', ') || 'none'}{preview.tables.length ? `, tables ${preview.tables.join(', ')}` : ''}.</p>
            {preview.schedules.length ? <p className="muted">Schedules: {preview.schedules.map((s) => `${s.flow} ${s.cron} (${s.timezone})`).join('; ')}</p> : null}
            <p className="muted">{preview.needs.state ? 'Some Flows wait for people, wait a while or keep table rows: those runs are kept in Redis or Postgres (STATE_URL; the docker-compose.yml starts a Redis). Everything else runs in memory.' : 'No Flow waits or keeps rows: the app needs no database, runs live in memory.'}</p>
            <h3>Environment variables it needs</h3>
            <div className="table-wrap"><table><thead><tr><th>Variable</th><th>Required</th><th>What it is</th></tr></thead><tbody>
              {preview.env.filter((v) => v.required || v.kind !== 'app').map((v) => <tr key={v.name}><td><code>{v.name}</code></td><td>{v.required ? 'yes' : ''}</td><td>{v.description}{v.example ? <span className="muted"> (e.g. {v.example})</span> : null}</td></tr>)}
            </tbody></table></div>
            <p className="muted">The bundle's .env.example lists every variable. Run it with <code>docker compose up -d --build</code>.</p>
          </div>
        ) : null}
      </Card>

      <Card title={<><Icon name="clock" />Earlier exports</>}>
        {!history.data ? <Loading /> : history.data.length === 0 ? <Empty>No exports yet.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>App</th><th>Kind</th><th>Flows</th><th>By</th><th>When</th><th>Bundle</th><th></th></tr></thead><tbody>
            {history.data.map((e) => (
              <tr key={e.id}>
                <td>{e.name}{e.updates === 'new' ? <span className="badge tone-warn" style={{ marginLeft: 8 }}>New versions available</span> : e.updates === 'pending' ? <span className="badge tone-muted" style={{ marginLeft: 8 }} title="A Flow in it was changed; the change waits for approval">Flow change awaiting approval</span> : null}</td>
                <td>{e.kind}{e.framework ? ` (${e.framework})` : ''}</td><td>{e.flows}</td><td>{e.createdBy ?? ''}</td><td><When at={e.createdAt} /></td><td><code title={e.sha256}>{e.sha256.slice(0, 12)}</code></td>
                <td>{e.reexportable ? <button type="button" className="ghost" disabled={act.busy} onClick={() => act.run(async () => setReview(await api<ExportChanges>(`/app-exports/${e.id}/changes`)))}>Review</button> : null}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        {review ? (
          <div className="stack" aria-live="polite">
            <h3>Export {review.name} again</h3>
            <Changes c={review} />
            <div className="row">
              <button type="button" className="primary" disabled={act.busy || !!review.problem} onClick={() => act.run(async () => { const f = await download({}, `/api/app-exports/${review.id}/reexport`); setReview(null); history.reload(); return f; }, (f) => `Downloaded ${f}`)}><Icon name="download" />Download new export</button>
              <button type="button" className="ghost" onClick={() => setReview(null)}>Close</button>
            </div>
          </div>
        ) : null}
      </Card>
    </Page>
  );
}

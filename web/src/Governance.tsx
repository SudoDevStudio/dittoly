import { useState, type ReactElement } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, Loading, Status, useAction, useLoad, When } from './components';
import { useMe } from './context';
import { Link } from './router';
import { addAt } from './credential-links';
import { Icon, Notice } from './ui';

/**
 * Governance in the portal: what a Flow does with whose access before it runs,
 * organization rules, token scopes, break-glass, access reviews and the audit report.
 */

// ---------------------------------------------------------------- access preview

interface AccessUse { service: string; whose: 'yours' | 'team' | 'teammate'; optional: boolean; ready: boolean | null; scopes?: ScopeCheck | null; /** The secret env var an app or fix step passes it in. */ envVar?: string }
interface PhaseView { phase: string; reaches: { destination: string; source: string; allowed: boolean }[]; secrets: string[] }
interface StepNetworkView { mode: 'docker' | 'direct' | 'off'; phases: PhaseView[]; outsidePolicy: string[] }
interface StepAccess { stepId: string; title: string; kind: string; does: string; changesData: boolean; hosts: string[]; access: AccessUse[]; ai: string | null; dryRun: 'runs' | 'skipped'; network?: StepNetworkView }
interface Preview {
  steps: StepAccess[];
  missing: { step: string; service: string; whose: string }[];
  changesData: boolean;
  yourServices: string[];
  teamServices: string[];
  teammates: string[];
  rules: string[];
  approvals: { count: number; because: string | null };
}
const WHOSE = { yours: 'your own', team: "the team's shared", teammate: "a teammate's own" } as const;

function AddCredential({ service, whose, children }: { service: string; whose: string; children: ReactElement | string }) {
  const to = addAt(service, whose);
  return to ? <Link to={to} title={whose === 'team' ? `Add the team's ${service} on the Teams page` : `Add your own ${service}`}>{children}</Link> : <>{children}</>;
}

/** Before running: each step, what it changes, and whose access it uses. */
export function AccessPreviewCard({ versionId }: { versionId: string }) {
  const p = useLoad(() => api<Preview>(`/flow-versions/${versionId}/access`), [versionId]);
  if (!p.data) return <Card title="Before you run"><Loading /></Card>;
  const d = p.data;
  return (
    <Card title={<><Icon name="shield" />Before you run</>} actions={<span className={`badge ${d.changesData ? 'tone-warn' : 'tone-ok'}`}>{d.changesData ? 'Changes data' : 'Read-only'}</span>}>
      <p className="muted">
        Uses {d.yourServices.length ? <>your own <strong>{d.yourServices.join(', ')}</strong></> : 'none of your accounts'}
        {d.teamServices.length ? <>, the team's <strong>{d.teamServices.join(', ')}</strong></> : null}
        {d.teammates.length ? <>, and teammates' own access for <strong>{d.teammates.join(', ')}</strong></> : null}.
      </p>
      <ol className="access-steps" aria-label="Steps and access">
        {d.steps.map((s) => (
          <li key={s.stepId}>
            <div className="row">
              <strong>{s.title}</strong>
              {s.changesData ? <span className="badge tone-warn">changes data</span> : null}
              <span className="badge" title="In a dry run">{s.dryRun === 'runs' ? 'runs in a dry run' : 'skipped in a dry run'}</span>
            </div>
            <div className="muted">{s.does}{s.hosts.length ? ` · ${s.hosts.join(', ')}` : ''}{s.ai ? ` · AI: ${s.ai}` : ''}</div>
            {s.access.length ? (
              <ul className="inline-list">
                {s.access.map((a) => (
                  <li key={a.service + a.whose + (a.envVar ?? '')}>
                    <Icon name="key" size={13} />{a.envVar ? <><code>{a.envVar}</code> ← </> : null}{WHOSE[a.whose]} {a.service}{a.optional ? ' (if stored)' : ''}
                    {a.ready === false && !a.optional ? <AddCredential service={a.service} whose={a.whose}><span className="badge tone-danger">{addAt(a.service, a.whose) ? 'missing — add it' : 'missing'}</span></AddCredential> : null}
                    {a.scopes ? <ScopeBadge check={a.scopes} /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {s.network ? <NetworkTable view={s.network} /> : null}
          </li>
        ))}
      </ol>
      {d.missing.length ? (
        <ErrorText>
          Missing before it can run:{' '}
          {[...new Map(d.missing.map((m) => [`${m.service}:${m.whose}`, m])).values()].map((m, i) => (
            <span key={`${m.service}:${m.whose}`}>
              {i ? ', ' : ''}
              <AddCredential service={m.service} whose={m.whose}>{m.service}</AddCredential>
              {m.whose === 'teammate' ? ' (a teammate adds their own)' : ''}
            </span>
          ))}
          . Adding it takes you to the page that stores it; come back and the step turns green.
        </ErrorText>
      ) : null}
      {d.rules.length ? (
        <ul className="list muted">{d.rules.map((r) => <li key={r}><Icon name="shield" size={13} />{r}</li>)}</ul>
      ) : null}
    </Card>
  );
}

const PHASE_LABEL: Record<string, string> = { install: 'Install', build: 'Build', test: 'Tests', run: 'Running app' };

/** An app or fix step's phases: what each may reach and which secret env vars it gets. */
function NetworkTable({ view }: { view: StepNetworkView }) {
  return (
    <div className="stack" aria-label="Network and secrets">
      {view.mode === 'direct' ? (
        <Notice>This server runs project code directly (no container engine): every phase has this machine&apos;s full network. The lists below hold only in a container.</Notice>
      ) : view.mode === 'off' ? (
        <Notice>No Docker or Podman here and running project code directly is off: this step cannot run on this server.</Notice>
      ) : null}
      {view.outsidePolicy.length ? <ErrorText>{`Not in the team's allowed destinations (the step stops until an admin allows them): ${view.outsidePolicy.join(', ')}.`}</ErrorText> : null}
      <table>
        <thead>
          <tr><th>Phase</th><th>May reach</th><th>Secret env vars</th></tr>
        </thead>
        <tbody>
          {view.phases.map((p) => (
            <tr key={p.phase}>
              <td>{PHASE_LABEL[p.phase] ?? p.phase}</td>
              <td>
                {p.reaches.length ? (
                  <ul className="inline-list">
                    {p.reaches.map((r) => (
                      <li key={r.destination}>
                        {r.source === 'this step' ? <code>{r.destination}</code> : r.destination}
                        {r.allowed ? null : <span className="badge tone-danger">not allowed</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">nothing outside</span>
                )}
              </td>
              <td>{p.secrets.length ? p.secrets.map((n) => <code key={n}>{n} </code>) : <span className="muted">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Admins: outside services app and fix steps may declare. Team admins narrow it for their team (teamId). */
export function EgressCard({ teamId }: { teamId?: string }) {
  const url = teamId ? `/teams/${teamId}/egress` : '/settings/egress';
  const data = useLoad(() => api<{ destinations?: string[]; organization?: string[]; team?: string[] | null; effective?: string[] }>(url), [url]);
  const act = useAction();
  const [text, setText] = useState<string | null>(null);
  if (!data.data) return <Card title="Outside services for app and fix steps"><Loading /></Card>;
  const current = teamId ? (data.data.team ?? null) : (data.data.destinations ?? []);
  const shown = text ?? (current ?? data.data.organization ?? []).join('\n');
  const save = (list: string[] | null) =>
    act.run(async () => {
      await api(url, { method: 'PUT', body: { destinations: list } });
      setText(null);
      data.reload();
    }, 'Saved');
  const lines = () => shown.split(/[\s,]+/).filter(Boolean);
  return (
    <Card title={<><Icon name="shield" />Outside services for app and fix steps</>}>
      <p className="muted">
        {teamId
          ? "This team's steps may declare only these. Leave it on the organization's list, or narrow it: anything you list must be in the organization's list."
          : "The most an app or fix step may declare beyond the git host and package registries, per phase. A Flow declaring anything else is not approved, and stops when it runs if you remove it later."}{' '}
        One per line: <code>api.example.com</code> (port 443), <code>*.example.com</code> (one label in front), <code>**.example.com</code> (any depth), <code>testdb.example.com:5432</code> (a TCP database, exact host).
      </p>
      {teamId ? <p className="muted">Organization: {(data.data.organization ?? []).join(', ') || 'none'}. {current ? 'This team uses its own list.' : "This team uses the organization's list."}</p> : null}
      <div className="field">
        <label htmlFor={`egress-${teamId ?? 'org'}`}>Destinations</label>
        <textarea id={`egress-${teamId ?? 'org'}`} rows={5} value={shown} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="row">
        <button type="button" className="primary" onClick={() => save(lines())} disabled={act.busy}>Save</button>
        {teamId && current ? <button type="button" className="ghost" onClick={() => save(null)} disabled={act.busy}>Use the organization&apos;s list</button> : null}
      </div>
      {act.error ? <ErrorText>{act.error}</ErrorText> : null}
    </Card>
  );
}

// ---------------------------------------------------------------- scopes

export interface ScopeCheck { status: 'ok' | 'broader' | 'missing' | 'unknown' | 'error'; granted?: string[] | null; needed?: string[]; excess: string[]; missing: string[]; note?: string | null }

export function ScopeBadge({ check }: { check: ScopeCheck }) {
  const text = {
    ok: 'Scopes: just what is needed',
    broader: `Broader than needed: ${check.excess.join(', ')}`,
    missing: `Missing scopes: ${check.missing.join(', ')}`,
    unknown: 'Scopes not reported',
    error: 'Scope check failed',
  }[check.status];
  const tone = { ok: 'tone-ok', broader: 'tone-warn', missing: 'tone-danger', unknown: '', error: 'tone-warn' }[check.status];
  return <span className={`badge ${tone}`} title={check.note ?? undefined}>{text}</span>;
}

// ---------------------------------------------------------------- rules

interface Policy { id: string; kind: string; enabled: boolean; note: string | null; says: string }
const KIND_LABEL: Record<string, string> = {
  approvals_for_writes: 'Several approvers for Flows that change data',
  allowed_hosts: 'Modules may only connect to these hosts',
  no_delegation: 'No handing steps to teammates',
  run_window: 'Runs only in working hours',
  max_runs_per_day: 'Daily run limit per person',
  team_approvals: "Only a Flow's own team approves it",
  approval_deadlines: 'Remind and escalate waiting approvals',
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function PoliciesCard() {
  const list = useLoad(() => api<{ kinds: string[]; policies: Policy[] }>('/policies'));
  const act = useAction();
  const [kind, setKind] = useState('approvals_for_writes');
  const [f, setF] = useState({ count: '2', module: '', patterns: '', days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, writesOnly: true, note: '', remind: '4', escalate: '24', orgAdmins: '' });
  const config = () => {
    switch (kind) {
      case 'approvals_for_writes': return { count: Number(f.count), ...(f.module ? { module: f.module } : {}) };
      case 'allowed_hosts': return { patterns: f.patterns.split(/[\s,]+/).filter(Boolean) };
      case 'no_delegation': return f.module ? { module: f.module } : {};
      case 'run_window': return { days: f.days, from: f.from, to: f.to, timezone: f.timezone, writesOnly: f.writesOnly };
      case 'team_approvals': return {};
      case 'approval_deadlines': return { remindAfterHours: Number(f.remind), escalateAfterHours: Number(f.escalate), ...(f.orgAdmins ? { orgAdminsAfterHours: Number(f.orgAdmins) } : {}) };
      default: return { count: Number(f.count) };
    }
  };
  return (
    <Card title={<><Icon name="shield" />Organization rules</>}>
      <p className="muted">Rules are checked where things happen: when a module or Flow is approved, when a run starts, and when a step is handed to a teammate. A blocked action says which rule stopped it.</p>
      {!list.data ? <Loading /> : list.data.policies.length ? (
        <ul className="list" aria-label="Rules">
          {list.data.policies.map((p) => (
            <li key={p.id}>
              <span className={p.enabled ? '' : 'muted'}>{p.says}</span>{p.note ? <span className="muted"> · {p.note}</span> : null}
              <button disabled={act.busy} onClick={() => act.run(async () => (await api(`/policies/${p.id}`, { method: 'PUT', body: { enabled: !p.enabled } }), list.reload()), p.enabled ? 'Rule turned off' : 'Rule turned on')}>{p.enabled ? 'Turn off' : 'Turn on'}</button>
              <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await api(`/policies/${p.id}`, { method: 'DELETE' }), list.reload()), 'Rule removed')}>Remove</button>
            </li>
          ))}
        </ul>
      ) : <Empty>No rules yet.</Empty>}
      <h3>Add a rule</h3>
      <div className="field">
        <label htmlFor="policy-kind">Rule</label>
        <select id="policy-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {kind === 'approvals_for_writes' || kind === 'max_runs_per_day' ? (
        <div className="field">
          <label htmlFor="policy-count">{kind === 'max_runs_per_day' ? 'Runs per person per day' : 'Approvers needed'}</label>
          <input id="policy-count" type="number" min={kind === 'max_runs_per_day' ? 1 : 2} max={kind === 'max_runs_per_day' ? 10000 : 5} value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} />
        </div>
      ) : null}
      {kind === 'approvals_for_writes' || kind === 'no_delegation' ? (
        <div className="field">
          <label htmlFor="policy-module">Only for this module (empty: all modules)</label>
          <input id="policy-module" placeholder="e.g. gitlab" value={f.module} onChange={(e) => setF({ ...f, module: e.target.value.trim() })} />
        </div>
      ) : null}
      {kind === 'allowed_hosts' ? (
        <div className="field">
          <label htmlFor="policy-hosts">Allowed hosts (one per line; *.acme.com allows subdomains)</label>
          <textarea id="policy-hosts" rows={3} value={f.patterns} onChange={(e) => setF({ ...f, patterns: e.target.value })} />
        </div>
      ) : null}
      {kind === 'run_window' ? (
        <>
          <fieldset className="field">
            <legend>Days</legend>
            <div className="row">
              {DAYS.map((d, i) => (
                <label key={d} className="check">
                  <input type="checkbox" checked={f.days.includes(i)} onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i].sort() : f.days.filter((x) => x !== i) })} />{d}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="row">
            <div className="field"><label htmlFor="policy-from">From</label><input id="policy-from" type="time" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
            <div className="field"><label htmlFor="policy-to">To</label><input id="policy-to" type="time" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
            <div className="field"><label htmlFor="policy-tz">Time zone</label><input id="policy-tz" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></div>
          </div>
          <label className="check"><input type="checkbox" checked={f.writesOnly} onChange={(e) => setF({ ...f, writesOnly: e.target.checked })} />Only runs that change data</label>
        </>
      ) : null}
      {kind === 'team_approvals' ? (
        <p className="muted">New Flow versions and run sign-offs are approved only by approvers who are in the Flow's team, or by someone standing in for one of them. Org admins can still step in; their approval is marked as from outside the team.</p>
      ) : null}
      {kind === 'approval_deadlines' ? (
        <>
          <div className="row">
            <div className="field"><label htmlFor="policy-remind">Remind the approvers after (hours)</label><input id="policy-remind" type="number" min={1} max={720} value={f.remind} onChange={(e) => setF({ ...f, remind: e.target.value })} /></div>
            <div className="field"><label htmlFor="policy-escalate">Tell the team's admins after (hours)</label><input id="policy-escalate" type="number" min={1} max={720} value={f.escalate} onChange={(e) => setF({ ...f, escalate: e.target.value })} /></div>
            <div className="field"><label htmlFor="policy-org-admins">Tell org admins after (hours; empty: twice as long)</label><input id="policy-org-admins" type="number" min={1} max={1440} value={f.orgAdmins} onChange={(e) => setF({ ...f, orgAdmins: e.target.value })} /></div>
          </div>
          <p className="muted">Nothing is rejected on its own. A sign-off step can set its own times.</p>
        </>
      ) : null}
      <div className="field">
        <label htmlFor="policy-note">Note (why; optional)</label>
        <input id="policy-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      <div>
        <button className="primary" disabled={act.busy} onClick={() => act.run(async () => (await post('/policies', { kind, config: config(), ...(f.note ? { note: f.note } : {}) }), list.reload()), 'Rule added')}>Add rule</button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- audit report

interface Chain { ok: boolean; sealed: number; pending: number; head: { eventId: string; hash: string } | null; problems: string[] }

export function AuditReportCard() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const chain = useLoad(() => api<Chain>('/admin/audit-chain'));
  const query = new URLSearchParams({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59.999`).toISOString(), format: 'csv' });
  return (
    <Card title={<><Icon name="check" />Audit report</>} actions={chain.data ? <span className={`badge ${chain.data.ok ? 'tone-ok' : 'tone-danger'}`}>{chain.data.ok ? 'Audit chain intact' : 'Audit chain broken'}</span> : null}>
      <p className="muted">Who changed what, who approved it (anyone who approved their own work is flagged), who ran what as whom, break-glass use, rule changes and access reviews. Audit events cannot be changed or deleted, and each is chained to the one before it.</p>
      {chain.data?.problems.length ? <ErrorText>{chain.data.problems.join(' ')}</ErrorText> : null}
      {chain.data?.head ? (
        <p className="muted">
          {chain.data.sealed} events sealed{chain.data.pending ? `, ${chain.data.pending} waiting` : ''}. Keep the latest hash somewhere else to prove later that nothing was rewritten: <code>{chain.data.head.eventId}:{chain.data.head.hash.slice(0, 16)}…</code>
        </p>
      ) : null}
      <div className="row">
        <div className="field"><label htmlFor="report-from">From</label><input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label htmlFor="report-to">To</label><input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <div className="row">
        <a className="button primary" href={`/api/admin/audit-report?${query}`} download>Download CSV</a>
        <a className="button" href={`/api/admin/audit-report?${query.toString().replace('format=csv', 'format=json')}`} target="_blank" rel="noreferrer">Open as JSON</a>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- audit hash copies

interface Anchor { id: string; kind: 'email' | 'webhook'; target: string; enabled: boolean; lastDay: string | null; lastOk: boolean | null; lastError: string | null }

/** Admins: where a copy of the audit chain's latest hash goes every day. */
export function AuditAnchorsCard() {
  const list = useLoad(() => api<Anchor[]>('/admin/audit-anchors'));
  const act = useAction();
  const [kind, setKind] = useState<'email' | 'webhook'>('email');
  const [target, setTarget] = useState('');
  const [key, setKey] = useState<string | null>(null);
  return (
    <Card title={<><Icon name="lock" />Daily copy of the audit hash</>}>
      <p className="muted">Once a day the audit chain's latest hash is sent to these places, so a copy lives outside Dittoly. If the log were ever rewritten, the copies would no longer match. Webhooks are signed (<code>X-Dittoly-Signature: sha256=…</code>, HMAC of the body).</p>
      {list.data?.length ? (
        <ul className="list" aria-label="Audit hash copies">
          {list.data.map((a) => (
            <li key={a.id}>
              <Icon name={a.kind === 'email' ? 'bell' : 'globe'} size={14} />{a.target}
              {a.lastDay ? <span className={`badge ${a.lastOk ? 'tone-ok' : 'tone-danger'}`}>{a.lastOk ? `sent ${a.lastDay}` : `failed ${a.lastDay}: ${a.lastError ?? ''}`}</span> : <span className="muted">not sent yet</span>}
              <button disabled={act.busy} onClick={() => act.run(() => post<{ ok: boolean; error?: string }>(`/admin/audit-anchors/${a.id}/send`), (r) => (r.ok ? 'Sent' : `Could not send: ${r.error}`))}>Send now</button>
              <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await api(`/admin/audit-anchors/${a.id}`, { method: 'DELETE' }), list.reload()), 'Removed')}>Remove</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <select aria-label="Send the hash by" value={kind} onChange={(e) => setKind(e.target.value as 'email' | 'webhook')}><option value="email">Email</option><option value="webhook">Webhook</option></select>
        <input aria-label="Send the hash to" placeholder={kind === 'email' ? 'auditor@example.com' : 'https://…'} value={target} onChange={(e) => setTarget(e.target.value)} />
        <button disabled={act.busy || !target} onClick={() => act.run(async () => { const r = await post<{ signingKey?: string }>('/admin/audit-anchors', { kind, target }); setKey(r.signingKey ?? null); setTarget(''); list.reload(); }, 'Added')}>Add</button>
      </div>
      {key ? <p role="status">Signing key (shown once; give it to the receiver to check signatures): <code>{key}</code></p> : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

// ---------------------------------------------------------------- audit streaming

type StreamKind = 'splunk' | 'datadog' | 'https' | 'syslog' | 'otlp';
interface Stream { id: string; kind: StreamKind; name: string; target: string; enabled: boolean; sent: number; behind: number; lastSentAt: string | null; lastError: string | null; failingSince: string | null; nextAttemptAt: string | null }
const STREAM_KINDS: Record<StreamKind, string> = { splunk: 'Splunk (HTTP Event Collector)', datadog: 'Datadog (Logs API)', https: 'HTTPS (JSON lines)', syslog: 'Syslog over TLS', otlp: 'OpenTelemetry (OTLP/HTTP)' };
const DATADOG_SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ap2.datadoghq.com', 'uk1.datadoghq.com', 'ddog-gov.com', 'us2.ddog-gov.com'];

/** Admins: SIEMs that get every audit event, in order, as it is sealed. */
export function AuditStreamsCard() {
  const list = useLoad(() => api<Stream[]>('/admin/audit-streams'));
  const act = useAction();
  const [kind, setKind] = useState<StreamKind>('splunk');
  const [f, setF] = useState<Record<string, string>>({});
  const [key, setKey] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const field = (k: string, label: string, placeholder = '', type = 'text') => <label key={k}>{label}<input type={type} placeholder={placeholder} value={f[k] ?? ''} onChange={set(k)} /></label>;
  const fields: Record<StreamKind, ReactElement[]> = {
    splunk: [field('url', 'HEC address', 'https://splunk.example.com:8088'), field('token', 'HEC token', '', 'password'), field('index', 'Index (optional)', 'security'), field('sourcetype', 'Source type (optional)', 'dittoly:audit')],
    datadog: [
      <label key="site">Datadog site<select value={f.site ?? 'datadoghq.com'} onChange={set('site')}>{DATADOG_SITES.map((s) => <option key={s}>{s}</option>)}</select></label>,
      field('apiKey', 'API key', '', 'password'), field('service', 'Service (optional)', 'dittoly'), field('tags', 'Tags (optional)', 'env:prod,team:security'),
    ],
    https: [field('url', 'Address', 'https://collector.example.com/dittoly'), field('headerName', 'Auth header name (optional)', 'Authorization'), field('headerValue', 'Auth header value (optional)', 'Bearer …', 'password')],
    otlp: [field('url', 'OTLP/HTTP address', 'https://otel-collector.example.com:4318'), field('headerName', 'Auth header name (optional)', 'Authorization'), field('headerValue', 'Auth header value (optional)', 'Bearer …', 'password')],
    syslog: [field('host', 'Host', 'siem.example.com'), field('port', 'Port', '6514', 'number'), <label key="framing">Framing<select value={f.framing ?? 'octet'} onChange={set('framing')}><option value="octet">Octet counting (RFC 5425)</option><option value="newline">One message per line</option></select></label>],
  };
  const body = () => {
    const out: Record<string, unknown> = { kind, name: f.name || STREAM_KINDS[kind], startFrom: f.startFrom ?? 'now' };
    for (const [k, v] of Object.entries(f)) if (v && k !== 'name' && k !== 'startFrom' && (fields[kind].some((el) => el.key === k))) out[k] = k === 'port' ? Number(v) : v;
    if (kind === 'datadog' && !out.site) out.site = 'datadoghq.com';
    return out;
  };
  const status = (s: Stream) =>
    !s.enabled ? <span className="badge">paused</span>
      : s.lastError ? <span className="badge tone-danger">failing since {new Date(s.failingSince ?? '').toLocaleString()}: {s.lastError}</span>
        : s.behind > 0 ? <span className="badge">{s.behind} to send</span>
          : <span className="badge tone-ok">up to date{s.lastSentAt ? `, last sent ${new Date(s.lastSentAt).toLocaleString()}` : ''}</span>;
  return (
    <Card title={<><Icon name="shield" />Stream audit events to a SIEM</>}>
      <p className="muted">Every audit event goes to these places, in order, about a minute after it happens: who did what, to which Flow, module, team or run, and whether it was allowed. Never inputs, outputs or secrets. Each event carries its audit-chain hash, so the copy can be checked with <code>npm run audit:verify-export</code>. If a place is down, Dittoly keeps trying and sends everything it missed.</p>
      {list.data?.length ? (
        <ul className="list" aria-label="Audit streams">
          {list.data.map((s) => (
            <li key={s.id}>
              <Icon name="globe" size={14} /><strong>{s.name}</strong> <span className="muted">{s.target}</span> {status(s)} <span className="muted">{s.sent} sent</span>
              <button disabled={act.busy} onClick={() => act.run(() => post<{ ok: boolean; error?: string }>(`/admin/audit-streams/${s.id}/test`), (r) => (r.ok ? 'Test event sent' : `Could not send: ${r.error}`))}>Send a test event</button>
              <button disabled={act.busy} onClick={() => act.run(async () => (await api(`/admin/audit-streams/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }), list.reload()), s.enabled ? 'Paused' : 'Resumed')}>{s.enabled ? 'Pause' : 'Resume'}</button>
              <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await api(`/admin/audit-streams/${s.id}`, { method: 'DELETE' }), list.reload()), 'Removed')}>Remove</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="form-grid">
        <label>Send to<select aria-label="SIEM" value={kind} onChange={(e) => { setKind(e.target.value as StreamKind); setF({ name: f.name ?? '' }); }}>{(Object.keys(STREAM_KINDS) as StreamKind[]).map((k) => <option key={k} value={k}>{STREAM_KINDS[k]}</option>)}</select></label>
        <label>Stream name<input placeholder={STREAM_KINDS[kind]} value={f.name ?? ''} onChange={set('name')} /></label>
        {fields[kind]}
        <label>Start with<select value={f.startFrom ?? 'now'} onChange={set('startFrom')}><option value="now">New events from now on</option><option value="all">The whole audit history, then new events</option></select></label>
      </div>
      <button className="primary" disabled={act.busy} onClick={() => act.run(async () => { const r = await post<{ signingKey?: string }>('/admin/audit-streams', body()); setKey(r.signingKey ?? null); setF({}); list.reload(); }, 'Stream added')}>Add stream</button>
      {key ? <p role="status">Signing key (shown once; the receiver checks <code>X-Dittoly-Signature: sha256=…</code>, an HMAC of the body, with it): <code>{key}</code></p> : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

// ---------------------------------------------------------------- break-glass

interface Grant { id: string; member: string; actAs: string; actAsId: string; reason: string; startedAt: string; expiresAt: string; endedAt: string | null; active: boolean }
interface MemberRow { id: string; handle: string; displayName: string | null; breakglass?: boolean; disabled?: boolean }

/** Admins: who may use break-glass, and every use. */
export function BreakglassAdminCard() {
  const members = useLoad(() => api<MemberRow[]>('/members'));
  const grants = useLoad(() => api<Grant[]>('/breakglass'));
  const act = useAction();
  return (
    <Card title={<><Icon name="key" />Break-glass access</>}>
      <p className="muted">For emergencies: a member allowed here can run Flows as someone else for up to an hour, with a written reason. Admins and that person are told at once, and every run shows in the audit report.</p>
      {members.data ? (
        <ul className="list" aria-label="Break-glass members">
          {members.data.filter((m) => !m.disabled).map((m) => (
            <li key={m.id}>
              <label className="check">
                <input type="checkbox" aria-label={`Break-glass for ${m.handle}`} checked={m.breakglass === true} disabled={act.busy} onChange={(e) => act.run(async () => (await api(`/members/${m.id}/breakglass`, { method: 'PUT', body: { enabled: e.target.checked } }), members.reload()), e.target.checked ? `${m.handle} may use break-glass` : `${m.handle} may no longer use break-glass`)} />
                {m.displayName ?? m.handle}
              </label>
            </li>
          ))}
        </ul>
      ) : <Loading />}
      <GrantList grants={grants.data} reload={grants.reload} />
    </Card>
  );
}

function GrantList({ grants, reload }: { grants: Grant[] | null; reload: () => void }) {
  const act = useAction();
  if (!grants) return <Loading />;
  if (!grants.length) return <p className="muted">No break-glass use yet.</p>;
  return (
    <ul className="list" aria-label="Break-glass uses">
      {grants.map((g) => (
        <li key={g.id}>
          <strong>{g.member}</strong> as <strong>{g.actAs}</strong>: “{g.reason}” <span className="muted"><When at={g.startedAt} /></span>
          {g.active ? <><span className="badge tone-warn">active until <When at={g.expiresAt} /></span><button disabled={act.busy} onClick={() => act.run(async () => (await post(`/breakglass/${g.id}/end`), reload()), 'Break-glass ended')}>End now</button></> : <Status value="succeeded" />}
        </li>
      ))}
    </ul>
  );
}

/** For a member allowed to use break-glass: start one, and see active ones. */
export function BreakglassCard() {
  const { me } = useMe();
  const allowed = useLoad(() => api<{ allowed: boolean }>('/me/breakglass'));
  const members = useLoad(() => api<MemberRow[]>('/directory'));
  const grants = useLoad(() => api<Grant[]>('/breakglass'));
  const act = useAction();
  const [actAs, setActAs] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('30');
  if (!allowed.data?.allowed) return null;
  return (
    <Card title={<><Icon name="key" />Break-glass</>}>
      <Notice>Use only in an emergency. Admins and the person you act as are told at once, with your reason.</Notice>
      <div className="field">
        <label htmlFor="bg-as">Run as</label>
        <select id="bg-as" value={actAs} onChange={(e) => setActAs(e.target.value)}>
          <option value="">Choose a person</option>
          {members.data?.filter((m) => m.id !== me.id && !m.disabled).map((m) => <option key={m.id} value={m.id}>{m.displayName ?? m.handle}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="bg-reason">Reason (at least 10 characters)</label>
        <input id="bg-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="bg-minutes">For how long (minutes, up to 60)</label>
        <input id="bg-minutes" type="number" min={5} max={60} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </div>
      <div>
        <button className="danger" disabled={act.busy || !actAs || reason.trim().length < 10} onClick={() => act.run(async () => (await post('/breakglass', { actAs, reason, minutes: Number(minutes) }), setReason(''), grants.reload()), 'Break-glass started; admins were told')}>Start break-glass</button>
      </div>
      <GrantList grants={grants.data} reload={grants.reload} />
    </Card>
  );
}

/** Active break-glass grants of the signed-in member (for "run as" on a Flow). */
export function useMyGrants() {
  const { me } = useMe();
  const grants = useLoad(() => api<Grant[]>('/breakglass'));
  return (grants.data ?? []).filter((g) => g.active && g.member === me.handle);
}

// ---------------------------------------------------------------- access reviews

interface Reviews {
  credentials: { service: string; dueAt: string; removedAfter: string }[];
  teamCredentials: { teamId: string; team: string; service: string; dueAt: string; removedAfter: string }[];
  memberships: { teamId: string; team: string; memberId: string; handle: string; role: string; dueAt: string }[];
}

/** Access due for review: keep what is still needed, remove the rest. Renders nothing when nothing is due. */
export function ReviewsCard({ onChange }: { onChange?: () => void }) {
  const r = useLoad(() => api<Reviews>('/me/reviews'));
  const act = useAction();
  if (!r.data) return null;
  const { credentials, teamCredentials, memberships } = r.data;
  if (!credentials.length && !teamCredentials.length && !memberships.length) return null;
  const decide = (body: object, keep: boolean, what: string) =>
    act.run(async () => (await post('/reviews', { ...body, keep }), r.reload(), onChange?.()), keep ? `${what} kept for 90 more days` : `${what} removed`);
  const buttons = (body: object, what: string) => (
    <>
      <button disabled={act.busy} onClick={() => decide(body, true, what)}>Still needed</button>
      <button className="danger" disabled={act.busy} onClick={() => decide(body, false, what)}>Remove</button>
    </>
  );
  return (
    <Card title={<><Icon name="check" />Access to review</>}>
      <p className="muted">Every 90 days, confirm the access you hold is still needed. Credentials nobody confirms are removed 14 days after they are due.</p>
      <ul className="list" aria-label="Access to review">
        {credentials.map((c) => <li key={c.service}><Icon name="key" size={14} />Your <strong>{c.service}</strong> credential · due <When at={c.dueAt} />{buttons({ kind: 'credential', service: c.service }, c.service)}</li>)}
        {teamCredentials.map((c) => <li key={c.teamId + c.service}><Icon name="key" size={14} /><strong>{c.team}</strong>'s shared <strong>{c.service}</strong> · due <When at={c.dueAt} />{buttons({ kind: 'team_credential', teamId: c.teamId, service: c.service }, c.service)}</li>)}
        {memberships.map((m) => <li key={m.teamId + m.memberId}><Icon name="users" size={14} /><strong>{m.handle}</strong> in <strong>{m.team}</strong> ({m.role}) · due <When at={m.dueAt} />{buttons({ kind: 'membership', teamId: m.teamId, memberId: m.memberId }, `${m.handle} in ${m.team}`)}</li>)}
      </ul>
    </Card>
  );
}

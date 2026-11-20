import { useState } from 'react';
import { GitSyncCard } from '../GitSync';
import { api } from '../api';
import { Card, ErrorText, Loading, Page, Status, useAction, useLoad } from '../components';
import { useMe } from '../context';
import { Avatar, Icon, Metric, Notice, SearchField } from '../ui';
import { forgetMediaHosts } from '../MediaEmbed';
import { AuditAnchorsCard, AuditReportCard, AuditStreamsCard, BreakglassAdminCard, EgressCard, PoliciesCard } from '../Governance';
import { UndoWindowCard } from '../Undo';
import { Link } from '../router';
import { ProvisioningCard } from '../Provisioning';
import { OrgModelCard, RunCapCard } from '../Costs';
import { AutoStopSettingsCard } from '../AutoStops';

interface Member { id: string; handle: string; role: 'admin' | 'approver' | 'member'; email: string | null; displayName: string | null; disabled: boolean; sso: boolean; scim: boolean; roleFromScim: boolean }

export function Admin() {
  const { me } = useMe();
  const list = useLoad(() => api<Member[]>('/members'));
  const act = useAction();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const rows = list.data ?? [];
  const filtered = rows.filter(m => `${m.handle} ${m.email ?? ''} ${m.displayName ?? ''}`.toLowerCase().includes(q.toLowerCase()) && (!role || m.role === role) && (!status || m.disabled === (status === 'disabled')));
  if (me.role !== 'admin') return <ErrorText>Only admins can manage members.</ErrorText>;
  return (
    <Page title="Members & Access" eyebrow="ORGANIZATION / MEMBER MANAGEMENT" className="members-page" actions={<button onClick={list.reload}><Icon name="refresh" size={16}/>Refresh Members</button>}>
      <p className="muted">People join by signing in with your organization’s single sign-on, or are provisioned by your identity provider (SCIM), and start as members. Roles are managed here, or by groups you map to a role under Provisioning.</p>
      <div className="metrics"><Metric label="Total members" value={list.data ? rows.length : '—'} detail="Organization members" icon="users"/><Metric label="Administrators" value={list.data ? rows.filter(m => m.role === 'admin').length : '—'} detail="Module & member management" icon="shield"/><Metric label="Approvers" value={list.data ? rows.filter(m => m.role === 'approver').length : '—'} detail="Workflow & run approvals" icon="check"/><Metric label="Active accounts" value={list.data ? rows.filter(m => !m.disabled).length : '—'} detail="Enabled organization members" icon="key"/></div>
      <div className="toolbar"><SearchField value={q} onChange={setQ} placeholder="Filter by name, handle, or email…"/><select aria-label="Filter member role" value={role} onChange={e => setRole(e.target.value)}><option value="">All roles</option><option value="admin">Admin</option><option value="approver">Approver</option><option value="member">Member</option></select><select aria-label="Filter member status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All accounts</option><option value="active">Active</option><option value="disabled">Disabled</option></select></div>
      <ErrorText>{act.error ?? list.error}</ErrorText>
      <Card>
        {!list.data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="member-cell"><Avatar name={m.displayName ?? m.handle}/><div><strong>{m.displayName ?? m.handle}</strong>{m.id === me.id ? <span className="badge tone-info" style={{ marginLeft: 8 }}>You</span> : null}
                      <div className="muted">
                        {m.handle}
                        {m.email ? ` · ${m.email}` : ''}
                        {m.sso ? ' · SSO' : ' · API token'}
                        {m.scim ? ' · provisioned (SCIM)' : ''}
                        {m.roleFromScim ? ' · role from a SCIM group' : ''}
                      </div></div></div>
                    </td>
                    <td>
                      <select
                        aria-label={`Role for ${m.handle}`}
                        value={m.role}
                        disabled={act.busy}
                        onChange={(e) => act.run(async () => (await api(`/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }), list.reload()), 'Role changed')}
                      >
                        <option value="member">member</option>
                        <option value="approver">approver</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>
                      <Status value={m.disabled ? 'cancelled' : 'approved'} />
                    </td>
                    <td>
                      <button
                        className={m.disabled ? '' : 'danger'}
                        disabled={act.busy || m.id === me.id}
                        onClick={() => act.run(async () => (await api(`/members/${m.id}`, { method: 'PATCH', body: { disabled: !m.disabled } }), list.reload()), 'Account updated')}
                      >
                        {m.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-foot"><span>Showing {filtered.length} of {rows.length} members</span><span>Roles apply within Dittoly</span></div>
      </Card>
      <ProvisioningCard />
      <AiInstructionsCard />
      <McpAppsCard />
      <PoliciesCard />
      <AuditReportCard />
      <GitSyncCard teamId={null} />
      <ExhaustedJobsCard />
      <Card title={<><Icon name="eye" />AI inventory and changes</>}>
        <p className="muted">Every place AI is used here, with your risk classification of each, and every self-fix as a change record with its evidence and decisions. Both are in the audit report.</p>
        <div className="row"><Link className="button" to="/ai-inventory">AI inventory</Link><Link className="button" to="/changes">Changes</Link></div>
      </Card>
      <AuditAnchorsCard />
      <AuditStreamsCard />
      <BreakglassAdminCard />
      <RetentionCard />
      <ChatRetentionCard />
      <OrgModelCard />
      <RunCapCard />
      <AutoStopSettingsCard />
      <UndoWindowCard />
      <MediaHostsCard />
      <AppRunnerCard />
      <EgressCard />
      <Card title={<><Icon name="shield"/>Role & Privilege Boundaries</>}><div className="role-grid"><div className="role-panel"><h3>admin</h3><p>Manage members, review module manifests, publish templates, and approve workflow versions and run gates.</p></div><div className="role-panel"><h3>approver</h3><p>Create Flows and approve workflow versions and run gates. On shared servers, approvals require a different actor.</p></div><div className="role-panel"><h3>member</h3><p>Create Flows, execute approved versions, and delegate individual actions. Every member keeps their own credentials.</p></div></div></Card>
    </Page>
  );
}

interface Instructions { modules: string; flows: string; updatedAt: string | null; updatedBy: string | null }

/** Standing instructions the AI gets for every module and Flow it drafts in this organization. */
function AiInstructionsCard() {
  const current = useLoad(() => api<Instructions>('/ai/instructions'));
  const act = useAction();
  const [draft, setDraft] = useState<{ modules: string; flows: string } | null>(null);
  if (!current.data) return <Loading />;
  const value = draft ?? { modules: current.data.modules, flows: current.data.flows };
  const changed = draft !== null && (draft.modules !== current.data.modules || draft.flows !== current.data.flows);
  return (
    <Card title={<><Icon name="sparkles"/>AI instructions</>} actions={current.data.updatedAt ? <span className="muted">updated by {current.data.updatedBy ?? 'unknown'}</span> : null}>
      <p className="muted">Added to every module and Flow the AI drafts here (for example naming rules, preferred API versions, "never add delete actions"). They guide drafts; validation, the sandbox and review still decide what runs. Reviewers see the instructions each draft was made with.</p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            await api('/ai/instructions', { method: 'PUT', body: value });
            setDraft(null);
            current.reload();
          }, 'AI instructions saved');
        }}
      >
        <div className="field"><label htmlFor="ai-mod">For modules</label><textarea id="ai-mod" rows={4} maxLength={10000} value={value.modules} onChange={(e) => setDraft({ ...value, modules: e.target.value })} /></div>
        <div className="field"><label htmlFor="ai-flow">For Flows</label><textarea id="ai-flow" rows={4} maxLength={10000} value={value.flows} onChange={(e) => setDraft({ ...value, flows: e.target.value })} /></div>
        <div><button type="submit" className="primary" disabled={act.busy || !changed}>Save instructions</button></div>
      </form>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** How long finished runs keep their inputs and outputs, so people can check results and build the next step. */
function RetentionCard() {
  const current = useLoad(() => api<{ days: number; isDefault: boolean }>('/settings/run-retention'));
  const act = useAction();
  const [days, setDays] = useState<string | null>(null);
  if (!current.data) return <Loading />;
  const value = days ?? String(current.data.days);
  const n = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 90;
  return (
    <Card title={<><Icon name="shield"/>Run results</>} actions={current.data.isDefault ? <span className="muted">default</span> : null}>
      <p className="muted">
        Finished runs keep their inputs and step outputs, encrypted, for this many days. Only the member who ran a run sees them (and a teammate sees the step
        they ran); admins and approvers see statuses only. Then they are deleted. 0 deletes them as soon as a run ends. Shortening the period also applies to
        results already kept.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            await api('/settings/run-retention', { method: 'PUT', body: { days: n } });
            setDays(null);
            current.reload();
          }, 'Retention saved');
        }}
      >
        <div className="field">
          <label htmlFor="retention-days">Days to keep (0 to 90)</label>
          <input id="retention-days" type="number" min={0} max={90} value={value} onChange={(e) => setDays(e.target.value)} />
        </div>
        <button type="submit" className="primary" disabled={act.busy || !valid || n === current.data.days}>
          Save
        </button>
      </form>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** How long home chats are kept after their last message (their owner and team can open them until then). */
function ChatRetentionCard() {
  const current = useLoad(() => api<{ days: number; isDefault: boolean }>('/settings/chat-retention'));
  const act = useAction();
  const [days, setDays] = useState<string | null>(null);
  if (!current.data) return <Loading />;
  const value = days ?? String(current.data.days);
  const n = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 365;
  return (
    <Card title={<><Icon name="sparkles"/>Home chats</>} actions={current.data.isDefault ? <span className="muted">default</span> : null}>
      <p className="muted">
        Chats on the home page are kept, encrypted, for this many days after their last message, so their owner and their team can open them again.
        Then they are deleted; what was built from them stays. Shortening the period also applies to chats already kept.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            await api('/settings/chat-retention', { method: 'PUT', body: { days: n } });
            setDays(null);
            current.reload();
          }, 'Chat retention saved');
        }}
      >
        <div className="field">
          <label htmlFor="chat-retention-days">Days to keep (1 to 365)</label>
          <input id="chat-retention-days" type="number" min={1} max={365} value={value} onChange={(e) => setDays(e.target.value)} />
        </div>
        <button type="submit" className="primary" disabled={act.busy || !valid || n === current.data.days}>Save</button>
      </form>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** Where app steps build and run a branch's code. */
function AppRunnerCard() {
  const s = useLoad(() => api<{ mode: 'docker' | 'direct' | 'off'; directAllowed: boolean; localInstall: boolean }>('/settings/app-runner'));
  const act = useAction();
  if (!s.data) return <Loading />;
  const where = { docker: 'in containers', direct: 'directly on this machine', off: 'nowhere: app steps fail' }[s.data.mode];
  return (
    <Card title={<><Icon name="terminal"/>Building apps from code</>} actions={<span className={`badge ${s.data.mode === 'off' ? 'tone-warn' : 'tone-info'}`}>{s.data.mode}</span>}>
      <p className="muted">
        App steps clone a branch and run its code (install, build, start) so a browser step can check it. Right now they run {where}. A container engine — Docker,
        or Podman where that is what the machine has — is used whenever one answers, whatever the project is written in: installs reach only the git host and
        package registries, and the app only Dittoly&apos;s browser.
      </p>
      {s.data.localInstall ? (
        <label className="choice">
          <input
            type="checkbox"
            checked={s.data.directAllowed}
            disabled={act.busy}
            onChange={(e) => act.run(async () => (await api('/settings/app-runner', { method: 'PUT', body: { directAllowed: e.target.checked } }), s.reload()), 'Setting saved')}
          />
          With no container engine, run project code directly on this machine (in a temporary folder, as your user, with full network access, like running the branch yourself)
        </label>
      ) : (
        <p className="muted">Shared servers always use a container for this.</p>
      )}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** Hosts whose videos, audio, images, PDFs and pages may be shown inside run views. */
function MediaHostsCard() {
  const current = useLoad(() => api<{ hosts: string[] }>('/settings/media'));
  const act = useAction();
  const [text, setText] = useState<string | null>(null);
  if (!current.data) return <Loading />;
  const value = text ?? current.data.hosts.join('\n');
  return (
    <Card title={<><Icon name="layers"/>Media in run views</>}>
      <p className="muted">
        Links in run inputs and outputs play or show inside the page. YouTube (through youtube-nocookie.com) and Vimeo videos always play. Video and audio
        files, images, PDFs and web pages are shown only from the hosts listed here, one per line (for example <code>cdn.example.com</code> or{' '}
        <code>*.s3.amazonaws.com</code>); other links stay plain links. Media loads automatically, so the host sees the viewer&apos;s IP address.
      </p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            await api('/settings/media', { method: 'PUT', body: { hosts: value.split(/[\s,]+/).filter(Boolean) } });
            forgetMediaHosts();
            setText(null);
            current.reload();
          }, 'Media hosts saved');
        }}
      >
        <div className="field">
          <label htmlFor="media-hosts">Allowed media hosts</label>
          <textarea id="media-hosts" rows={4} value={value} placeholder="cdn.example.com" onChange={(e) => setText(e.target.value)} />
        </div>
        <div>
          <button type="submit" className="primary" disabled={act.busy || text === null}>
            Save hosts
          </button>
        </div>
      </form>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

type Preset = 'claude' | 'chatgpt' | 'copilot';
interface McpApps { presets: Record<Preset, boolean>; custom: { kind: 'client_id' | 'redirect_host'; value: string }[]; updatedAt: string | null; updatedBy: string | null }

const PRESETS: [Preset, string, string][] = [
  ['claude', 'Claude', 'claude.ai on the web, Desktop, mobile and Cowork (they come back to claude.ai or claude.com), and Claude Code on people\'s computers.'],
  ['chatgpt', 'ChatGPT', 'ChatGPT connectors and apps (they come back to chatgpt.com).'],
  ['copilot', 'Microsoft Copilot Studio', 'Copilot Studio agents (they come back to *.consent.azure-apim.net).'],
];

/**
 * Which AI apps may connect to Dittoly's MCP server by signing people in. Nothing may until an
 * admin allows it; people still pick on the consent page what each connection may use.
 */
function McpAppsCard() {
  const current = useLoad(() => api<McpApps>('/settings/mcp-apps'));
  const act = useAction();
  const [draft, setDraft] = useState<McpApps | null>(null);
  if (!current.data) return <Loading />;
  const value = draft ?? current.data;
  const none = !Object.values(value.presets).some(Boolean) && value.custom.length === 0;
  const setCustom = (custom: McpApps['custom']) => setDraft({ ...value, custom });
  return (
    <Card title={<><Icon name="sparkles"/>Apps that may connect</>} actions={current.data.updatedAt ? <span className="muted">updated by {current.data.updatedBy ?? 'unknown'}</span> : null}>
      <p className="muted">
        AI apps can connect to <code>{new URL('/mcp', location.origin).href}</code> by signing people in, instead of a token pasted from the Agents page. Each person then picks, on Dittoly&apos;s
        consent page, which Flows and app actions the connection may use, and it shows up on their Agents page. An app is recognized by where it sends people back after signing in, so another app
        cannot pass by using an allowed app&apos;s name. Signing in needs Dittoly on its public https address.
      </p>
      {none ? <Notice>No app may connect by signing in yet. Switch on the apps your organization uses.</Notice> : null}
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            await api('/settings/mcp-apps', { method: 'PUT', body: { presets: value.presets, custom: value.custom.filter((c) => c.value.trim()) } });
            setDraft(null);
            current.reload();
          }, 'Allowed apps saved');
        }}
      >
        {PRESETS.map(([key, label, detail]) => (
          <label key={key} className="field check">
            <input type="checkbox" checked={value.presets[key]} onChange={(e) => setDraft({ ...value, presets: { ...value.presets, [key]: e.target.checked } })} />
            <span><strong>{label}</strong> <span className="muted">{detail}</span></span>
          </label>
        ))}
        <div className="stack">
          <span className="muted">Other apps: an app&apos;s metadata URL (its client id, e.g. <code>https://app.example.com/oauth/client.json</code>) or a host it sends people back to (<code>app.example.com</code>, <code>*.example.com</code>).</span>
          {value.custom.map((c, i) => (
            <div key={i} className="row">
              <select aria-label="Kind" value={c.kind} onChange={(e) => setCustom(value.custom.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'client_id' | 'redirect_host' } : x)))}>
                <option value="client_id">Metadata URL</option>
                <option value="redirect_host">Sends people back to host</option>
              </select>
              <input aria-label="Value" value={c.value} maxLength={300} onChange={(e) => setCustom(value.custom.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <button type="button" className="ghost" onClick={() => setCustom(value.custom.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div><button type="button" className="ghost" onClick={() => setCustom([...value.custom, { kind: 'redirect_host', value: '' }])}><Icon name="plus" size={16}/>Add an app</button></div>
        </div>
        <div><button type="submit" className="primary" disabled={act.busy || draft === null}>Save allowed apps</button></div>
      </form>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** What background work is, in words (src/engine/jobs.ts kinds). */
const JOB_KIND: Record<string, string> = {
  advance: 'Continue a run',
  deliver_notification: 'Send a notification',
  plan_analyze: 'Read a plan',
  plan_item: 'Draft from a plan',
  git_export: 'Write to git',
  git_export_all: 'Write everything to git',
  git_import: 'Read from git',
  module_decided: 'Follow up a module decision',
  flow_decided: 'Follow up a Flow decision',
  model_change_check: 'Check a new AI model',
  reverse: 'Undo a change',
};

/** Background work that failed every attempt: kept with the reason until an admin runs it again. */
/** A wait in words: 45 s, 12 min, 3 h. */
const waited = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

function ExhaustedJobsCard() {
  const queue = useLoad(() => api<{ waiting: number; scheduled: number; running: number; failed: number; oldestWaitSeconds: number | null; sandboxes: { slots: number; busy: number; waiting: number } }>('/jobs/queue'), []);
  const jobs = useLoad(() => api<{ id: string; kind: string; attempts: number; lastError: string | null; failedAt: string }[]>('/jobs/exhausted'), []);
  const act = useAction();
  const q = queue.data;
  return (
    <Card title={<><Icon name="refresh" />Background work</>} actions={<button type="button" className="ghost" onClick={() => { queue.reload(); jobs.reload(); }}>Refresh</button>}>
      <p className="muted">Runs, notifications, plans and git sync happen in the background. Waiting work is due but not started yet; a long oldest wait means the server is busy or its worker stopped.</p>
      <div className="metrics">
        <Metric label="Waiting" value={q ? q.waiting : '—'} detail={q?.oldestWaitSeconds != null ? `Oldest waited ${waited(q.oldestWaitSeconds)}` : 'Nothing is waiting'} icon="clock" tone={q && q.oldestWaitSeconds != null && q.oldestWaitSeconds > 300 ? 'warning' : ''} />
        <Metric label="Running" value={q ? q.running : '—'} detail="Being worked on now" icon="bolt" />
        <Metric label="Scheduled" value={q ? q.scheduled : '—'} detail="Due later (delays, retries)" icon="refresh" />
        <Metric label="Failed" value={q ? q.failed : '—'} detail="Failed every attempt" icon="alert" tone={q?.failed ? 'warning' : ''} />
        <Metric
          label="Code sandboxes"
          value={q ? `${q.sandboxes.busy} / ${q.sandboxes.slots}` : '—'}
          detail={q?.sandboxes.waiting ? `${q.sandboxes.waiting} run${q.sandboxes.waiting === 1 ? '' : 's'} waiting for one` : 'App and fix steps building or testing'}
          icon="bolt"
          tone={q?.sandboxes.waiting ? 'warning' : ''}
        />
      </div>
      <ErrorText>{queue.error}</ErrorText>
      <h3>Failed every attempt</h3>
      <p className="muted">Work that failed every attempt is kept here instead of being dropped. Fix the cause (a credential, a setting, a service that was down), then run it again. Each retry is in the audit log.</p>
      <ErrorText>{jobs.error}</ErrorText>
      {jobs.loading && !jobs.data ? <Loading /> : null}
      {jobs.data && !jobs.data.length ? <p className="muted">Nothing has failed.</p> : null}
      {jobs.data?.length ? (
        <div className="table-wrap"><table><thead><tr><th>What</th><th>Why it stopped</th><th>When</th><th /></tr></thead><tbody>
          {jobs.data.map((j) => (
            <tr key={j.id}>
              <td>{JOB_KIND[j.kind] ?? j.kind}<br /><span className="muted">{j.attempts} attempts</span></td>
              <td><code>{j.lastError ?? 'stopped its worker'}</code></td>
              <td>{new Date(j.failedAt).toLocaleString()}</td>
              <td><button type="button" disabled={act.busy} onClick={() => act.run(async () => { await api(`/jobs/${j.id}/retry`, { method: 'POST' }); jobs.reload(); queue.reload(); }, 'Running it again')}>Run again</button></td>
            </tr>
          ))}
        </tbody></table></div>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

import { useState } from 'react';
import { api, post } from '../api';
import { Card, Empty, ErrorText, Loading, Page, Pre, useAction, useLive, useLoad, When } from '../components';
import { useMe } from '../context';
import { Link } from '../router';
import type { Team } from '../teams';
import { ReverseCall } from '../Undo';
import { Icon, Notice } from '../ui';
import { AgentStopBanner } from '../AutoStops';

/**
 * AI agents (MCP tokens) as identities: each acts for one person, may use only the tools that
 * person picked (directly, or "ask me first" for changes), until it expires. Its calls are listed
 * here, and calls that wait for the person are confirmed or rejected here. Admins see every agent
 * and can revoke any.
 */

export type Grant = 'run' | 'ask';
export interface Scopes { tools: Record<string, Grant>; drafting: boolean }
interface Agent {
  id: string; name: string; owner: { id: string; handle: string }; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null;
  scopes: Scopes | null; state: 'active' | 'expired' | 'revoked'; oauthApp: string | null; calls: { total: number; last7Days: number; waiting: number };
  /** Set while it is stopped automatically. */
  autoStop: { id: string; trigger: string; triggerName: string; summary: string; trippedAt: string } | null;
}
interface Call { id: string; agent: { id: string; name: string }; tool: string; title: string | null; args?: unknown; status: string; error: string | null; runId: string | null; undo: string | null; createdAt: string }
export interface Tool { name: string; key: string; title: string; changesData: boolean; kind: 'flow' | 'action' }
interface Offered { id: string; key: string; name: string; title: string; changesData: boolean; module: { name: string; version: string; title: string }; action: string; teamId: string; status: 'active' | 'changed'; changedReason: string | null }
interface ModuleSetting { id: string; type: 'host' | 'text' | 'certificate'; label: string; help?: string; example?: string; pattern?: string; default?: string }
interface ModuleItem { id: string; name: string; version: string; status: string; origin: string; manifest: { title: string; actions: { name: string; title: string; effect: 'read' | 'write' }[]; settings?: ModuleSetting[] } }

const mcpUrl = () => new URL('/mcp', location.origin).href;
const STATE_TONE = { active: 'tone-ok', expired: 'tone-warn', revoked: '' } as const;
const CALL_TEXT: Record<string, string> = {
  done: 'Done', failed: 'Failed', denied: 'Not allowed', awaiting_confirmation: 'Waits for you', rejected: 'Rejected', expired: 'Lapsed', deciding: 'Starting',
};
const toolLabel = (c: { tool: string; title: string | null }) => c.title ?? c.tool.replace(/^flow:/, 'Flow ').replace(/^action:/, '');

export function Agents() {
  const { me } = useMe();
  const [all, setAll] = useState(false);
  const agents = useLoad(() => api<Agent[]>(`/agents${all ? '?all=1' : ''}`), [all]);
  const tools = useLoad(() => api<Tool[]>('/me/mcp-tools'));
  const waiting = useLive(() => api<Call[]>('/agent-calls'), 15000);
  const [issued, setIssued] = useState<string | null>(null);
  const reload = () => (agents.reload(), waiting.reload());
  return (
    <Page
      title="AI agents"
      eyebrow="WORKSPACE / AGENTS"
      description="Each AI assistant you connect (Claude, Cursor and others, through MCP) is an agent acting for you. It uses only the tools you pick, until it expires, and every call it makes is listed here."
      actions={me.role === 'admin' ? <label className="row"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Every agent in the organization</label> : undefined}
    >
      {agents.data?.filter((a) => a.autoStop).map((a) => <AgentStopBanner key={a.id} name={a.name} stop={a.autoStop!} />)}
      <Waiting calls={waiting.data} reload={reload} />
      {issued ? <Connect token={issued} onDone={() => setIssued(null)} /> : null}
      <Card title={<><Icon name="sparkles" />Agents</>}>
        <ErrorText>{agents.error}</ErrorText>
        {agents.data ? agents.data.length ? (
          <ul className="list" aria-label="Agents">
            {agents.data.map((a) => <AgentRow key={a.id} agent={a} mine={a.owner.id === me.id} tools={tools.data ?? []} reload={reload} />)}
          </ul>
        ) : <Empty>No agents yet. Make one below to connect an AI assistant.</Empty> : <Loading />}
      </Card>
      <NewAgent tools={tools.data} onMade={(t) => (setIssued(t), agents.reload())} />
      {me.role === 'admin' ? <OfferedActions onChange={tools.reload} /> : null}
    </Page>
  );
}

/** Calls that change data and wait for the person. */
function Waiting({ calls, reload }: { calls: Call[] | null; reload: () => void }) {
  const act = useAction();
  if (!calls?.length) return null;
  const decide = (c: Call, decision: 'confirmed' | 'rejected') =>
    act.run(async () => (await post(`/agent-calls/${c.id}/decision`, { decision }), reload()), decision === 'confirmed' ? 'Confirmed: it runs now' : 'Rejected');
  return (
    <Card title={<><Icon name="shield" />Waiting for you</>} actions={<span className="badge tone-warn">{calls.length}</span>}>
      <p className="muted">Your agents asked to make these changes. Nothing happens until you confirm; a call lapses after a day.</p>
      <ul className="list" aria-label="Agent calls waiting for you">
        {calls.map((c) => (
          <li key={c.id} className="stack">
            <div><strong>{c.agent.name}</strong> wants to run <strong>{toolLabel(c)}</strong> <span className="muted"><When at={c.createdAt} /></span></div>
            {c.args !== undefined ? <Pre>{JSON.stringify(c.args, null, 2)}</Pre> : null}
            <div className="row">
              <button className="primary" disabled={act.busy} onClick={() => decide(c, 'confirmed')}>Confirm</button>
              <button className="danger" disabled={act.busy} onClick={() => decide(c, 'rejected')}>Reject</button>
            </div>
          </li>
        ))}
      </ul>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

function AgentRow({ agent: a, mine, tools, reload }: { agent: Agent; mine: boolean; tools: Tool[]; reload: () => void }) {
  const act = useAction();
  const [open, setOpen] = useState<'calls' | 'edit' | null>(null);
  const given = a.scopes ? Object.keys(a.scopes.tools).length : null;
  return (
    <li className="stack">
      <div className="row">
        <strong>{a.name}</strong>
        <span className={`badge ${STATE_TONE[a.state]}`}>{a.state === 'active' ? 'Active' : a.state === 'expired' ? 'Expired' : 'Revoked'}</span>
        {a.oauthApp ? <span className="badge tone-info" title="Connected by signing in from the app">Signed in from {a.oauthApp}</span> : null}
        {mine ? null : <span className="muted">for {a.owner.handle}</span>}
        <span className="muted">
          {a.scopes ? `${given} tool${given === 1 ? '' : 's'}${a.scopes.drafting ? ', drafts Flows' : ''}` : 'Made before agent scopes: everything you can use'}
          {' · '}{a.lastUsedAt ? <>used <When at={a.lastUsedAt} /></> : 'not used yet'}
          {a.expiresAt && a.state === 'active' ? <> · expires <When at={a.expiresAt} /></> : null}
          {' · '}{a.calls.last7Days} calls this week
        </span>
        {a.calls.waiting ? <span className="badge tone-warn">{a.calls.waiting} waiting</span> : null}
        {a.autoStop ? <span className="badge tone-warn" title={a.autoStop.summary}>Stopped automatically</span> : null}
      </div>
      <div className="row">
        <button className="ghost" onClick={() => setOpen(open === 'calls' ? null : 'calls')}>{open === 'calls' ? 'Hide calls' : 'Calls'}</button>
        {mine && a.state !== 'revoked' ? <button className="ghost" onClick={() => setOpen(open === 'edit' ? null : 'edit')}>{a.scopes ? 'Change tools' : 'Restrict'}</button> : null}
        {a.state !== 'revoked' ? (
          <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await api(`/agents/${a.id}`, { method: 'DELETE' }), reload()), 'Agent revoked')}>Revoke</button>
        ) : null}
      </div>
      <ErrorText>{act.error}</ErrorText>
      {open === 'calls' ? <Calls agentId={a.id} mine={mine} /> : null}
      {open === 'edit' ? <EditAgent agent={a} tools={tools} onSaved={() => (setOpen(null), reload())} /> : null}
    </li>
  );
}

function Calls({ agentId, mine }: { agentId: string; mine: boolean }) {
  const calls = useLoad(() => api<Call[]>(`/agents/${agentId}/calls`), [agentId]);
  if (!calls.data) return <Loading />;
  if (!calls.data.length) return <Empty>No calls yet.</Empty>;
  return (
    <table aria-label="Agent calls">
      <thead><tr><th>When</th><th>Tool</th><th>Outcome</th></tr></thead>
      <tbody>
        {calls.data.map((c) => (
          <tr key={c.id}>
            <td><When at={c.createdAt} /></td>
            <td>{toolLabel(c)}</td>
            <td>{CALL_TEXT[c.status] ?? c.status}{c.error ? <span className="muted"> ({c.error})</span> : null}{c.runId ? <> · <Link to={`/runs/${c.runId}`}>run</Link></> : null}{mine ? <ReverseCall callId={c.id} undo={c.undo} onDone={calls.reload} /> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The checklist of tools: each off, "use directly" or "ask me first". */
export function ToolPicker({ tools, scopes, onChange }: { tools: Tool[]; scopes: Scopes; onChange: (s: Scopes) => void }) {
  const set = (key: string, grant: Grant | '') => {
    const next = { ...scopes.tools };
    if (grant) next[key] = grant;
    else delete next[key];
    onChange({ ...scopes, tools: next });
  };
  return (
    <div className="stack">
      {tools.length ? (
        <ul className="list" aria-label="Tools this agent may use">
          {tools.map((t) => (
            <li key={t.key}>
              <span>{t.kind === 'action' ? <span className="badge tone-info">App action</span> : null} {t.title} {t.changesData ? <span className="badge tone-warn">Changes data</span> : <span className="badge">Reads only</span>}</span>
              <select aria-label={`Access to ${t.title}`} value={scopes.tools[t.key] ?? ''} onChange={(e) => set(t.key, e.target.value as Grant | '')}>
                <option value="">Not allowed</option>
                <option value="run">Use directly</option>
                {t.changesData ? <option value="ask">Ask me first</option> : null}
              </select>
            </li>
          ))}
        </ul>
      ) : <Empty>No Flows are offered to AI assistants yet. A Flow's owner turns this on on the Flow's page.</Empty>}
      <label className="row">
        <input type="checkbox" checked={scopes.drafting} onChange={(e) => onChange({ ...scopes, drafting: e.target.checked })} />
        May save its work as draft Flows and modules (they wait for approval like any draft)
      </label>
    </div>
  );
}

function EditAgent({ agent, tools, onSaved }: { agent: Agent; tools: Tool[]; onSaved: () => void }) {
  const act = useAction();
  const [scopes, setScopes] = useState<Scopes>(agent.scopes ?? { tools: {}, drafting: false });
  const [days, setDays] = useState('');
  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => (await api(`/agents/${agent.id}`, { method: 'PUT', body: { scopes, ...(days ? { expiresInDays: Number(days) } : {}) } }), onSaved()), 'Agent updated');
      }}
    >
      {agent.scopes ? null : <Notice>This agent was made before agent scopes and can use everything you can. Once you save, it can use only what you pick here.</Notice>}
      <ToolPicker tools={tools} scopes={scopes} onChange={setScopes} />
      <div className="field">
        <label htmlFor={`days-${agent.id}`}>Extend: works for another (days)</label>
        <input id={`days-${agent.id}`} type="number" min={1} max={365} placeholder="Keep the current expiry" value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
      <div><button type="submit" className="primary" disabled={act.busy}>Save</button></div>
      <ErrorText>{act.error}</ErrorText>
    </form>
  );
}

function NewAgent({ tools, onMade }: { tools: Tool[] | null; onMade: (token: string) => void }) {
  const act = useAction();
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [scopes, setScopes] = useState<Scopes>({ tools: {}, drafting: false });
  return (
    <Card title={<><Icon name="plus" />Connect an AI assistant</>}>
      <p className="muted">It acts as you, with your own access, and uses only the tools you pick. It cannot approve anything, change approved Flows or see your keys. Sign-offs and forms still wait for a person.</p>
      <p className="muted">Claude, ChatGPT and Copilot Studio can instead connect by signing in: add <code>{mcpUrl()}</code> as a connector there and pick its tools on the page Dittoly shows. An admin must allow the app first.</p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            const r = await post<{ token: string }>('/agents', { name, scopes, expiresInDays: Number(days) });
            setName('');
            setScopes({ tools: {}, drafting: false });
            onMade(r.token);
          }, 'Agent made');
        }}
      >
        <div className="field"><label htmlFor="agent-name">Name</label><input id="agent-name" required maxLength={80} placeholder="e.g. Claude Code on my laptop" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="agent-days">Works for (days)</label><input id="agent-days" type="number" min={1} max={365} required value={days} onChange={(e) => setDays(e.target.value)} /></div>
        {tools ? <ToolPicker tools={tools} scopes={scopes} onChange={setScopes} /> : <Loading />}
        <div><button type="submit" className="primary" disabled={act.busy || !name.trim()}>Make agent</button></div>
        <ErrorText>{act.error}</ErrorText>
      </form>
    </Card>
  );
}

function Connect({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <Card title={<><Icon name="key" />Your new agent's token</>} actions={<button className="ghost" onClick={onDone}>Done</button>}>
      <Notice>Copy this token now; it is not shown again: <code>{token}</code></Notice>
      <p className="muted">Server address (Streamable HTTP): <code>{mcpUrl()}</code>, with the header <code>Authorization: Bearer &lt;token&gt;</code>.</p>
      <p className="muted">Claude Code:</p>
      <Pre>{`claude mcp add --transport http dittoly ${mcpUrl()} --header "Authorization: Bearer ${token}"`}</Pre>
      <p className="muted">Other assistants that read an MCP JSON file:</p>
      <Pre>{JSON.stringify({ mcpServers: { dittoly: { type: 'http', url: mcpUrl(), headers: { Authorization: `Bearer ${token}` } } } }, null, 2)}</Pre>
    </Card>
  );
}

const CHANGED_TEXT: Record<string, string> = {
  mcp_tool_changed: "The MCP server changed this tool's name, description or schemas after it was approved.",
  mcp_tool_missing: 'The MCP server no longer has this tool.',
  pin_mismatch: 'What is stored no longer matches the module version that was approved.',
  module_not_approved: 'The module version is no longer approved.',
};

/** Admins: single actions of approved modules offered to agents as tools, each pinned to what was approved. */
function OfferedActions({ onChange }: { onChange: () => void }) {
  const offered = useLoad(() => api<Offered[]>('/gateway-tools'));
  const modules = useLoad(() => api<ModuleItem[]>('/modules'));
  const teams = useLoad(() => api<Team[]>('/teams'));
  const act = useAction();
  const [moduleId, setModuleId] = useState('');
  const [action, setAction] = useState('');
  const [teamId, setTeamId] = useState('');
  // A module keeps no configuration: whoever offers it says here what it works with, as a Flow would.
  const [settings, setSettings] = useState<Record<string, string>>({});
  const approved = (modules.data ?? []).filter((m) => m.status === 'approved');
  const chosen = approved.find((m) => m.id === moduleId);
  const declared = chosen?.manifest.settings ?? [];
  const pickModule = (id: string) => {
    setModuleId(id);
    setAction('');
    const m = approved.find((x) => x.id === id);
    setSettings(Object.fromEntries((m?.manifest.settings ?? []).map((st) => [st.id, st.default ?? ''])));
  };
  const told = declared.every((st) => st.type !== 'host' || settings[st.id]?.trim());
  const team = teamId || teams.data?.[0]?.id || '';
  const teamName = (id: string) => teams.data?.find((t) => t.id === id)?.name ?? 'a team';
  const reload = () => (offered.reload(), onChange());
  return (
    <Card title={<><Icon name="layers" />App actions offered to agents (admins)</>}>
      <p className="muted">
        Offer single actions of approved modules, including modules imported from MCP servers, as tools people can give their agents. Each is pinned to the module version and to the name,
        description and schemas you approved; if any of that changes, it is blocked until you offer it again. Calls run as the agent's person, with their own access, through the broker.
      </p>
      <ErrorText>{offered.error}</ErrorText>
      {offered.data?.length ? (
        <ul className="list" aria-label="Offered app actions">
          {offered.data.map((t) => (
            <li key={t.id} className="stack">
              <div className="row">
                <strong>{t.title}</strong>
                <code>{t.name}</code>
                <span className="muted">{t.module.name}@{t.module.version} · for {teamName(t.teamId)}</span>
                {t.changesData ? <span className="badge tone-warn">Changes data</span> : <span className="badge">Reads only</span>}
                {t.status === 'changed' ? <span className="badge tone-bad">Blocked</span> : <span className="badge tone-ok">Offered</span>}
              </div>
              {t.status === 'changed' ? <p className="muted">{CHANGED_TEXT[t.changedReason ?? ''] ?? t.changedReason} Check it (for an MCP server, import it again and approve the new version), then offer it again.</p> : null}
              <div><button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await api(`/gateway-tools/${t.id}`, { method: 'DELETE' }), reload()), 'No longer offered')}>Stop offering</button></div>
            </li>
          ))}
        </ul>
      ) : offered.data ? <Empty>No app actions offered yet.</Empty> : <Loading />}
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const values = Object.fromEntries(Object.entries(settings).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
          act.run(async () => (await post('/gateway-tools', { moduleVersionId: moduleId, action, teamId: team, settings: values }), setAction(''), reload()), 'Offered to agents');
        }}
      >
        <div className="field">
          <label htmlFor="gw-module">Approved module</label>
          <select id="gw-module" value={moduleId} onChange={(e) => pickModule(e.target.value)} required>
            <option value="">Choose…</option>
            {approved.map((m) => <option key={m.id} value={m.id}>{m.manifest.title} ({m.name}@{m.version}{m.origin === 'mcp' ? ', MCP server' : ''})</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="gw-action">Action</label>
          <select id="gw-action" value={action} onChange={(e) => setAction(e.target.value)} required disabled={!chosen}>
            <option value="">Choose…</option>
            {chosen?.manifest.actions.map((a) => <option key={a.name} value={a.name}>{a.title}{a.effect === 'write' ? ' (changes data)' : ''}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="gw-team">For the members of</label>
          <select id="gw-team" value={team} onChange={(e) => setTeamId(e.target.value)} required>
            {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="muted">Their shared accounts apply.</span>
        </div>
        {declared.map((st) => (
          <div className="field" key={st.id}>
            <label htmlFor={`gw-set-${st.id}`}>{st.label}</label>
            <input
              id={`gw-set-${st.id}`}
              value={settings[st.id] ?? ''}
              placeholder={st.example ?? st.default ?? ''}
              required={st.type === 'host'}
              onChange={(e) => setSettings({ ...settings, [st.id]: e.target.value })}
            />
            <span className="muted">{st.help ?? (st.type === 'host' ? `A host matching ${st.pattern}.` : 'What this action works with.')}</span>
          </div>
        ))}
        <div><button type="submit" className="primary" disabled={act.busy || !moduleId || !action || !team || !told}>Offer to agents</button></div>
        <ErrorText>{act.error}</ErrorText>
      </form>
    </Card>
  );
}

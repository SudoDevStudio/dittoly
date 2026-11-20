import { useState } from 'react';
import type { Runnable } from './RunHub';
import { teamQuery, useTeams } from '../teams';
import { api, post } from '../api';
import { Card, ChatBox, Empty, ErrorText, Loading, Status, useAction, useLive, useLoad, When } from '../components';
import { useMe } from '../context';
import { Link } from '../router';
import { Icon } from '../ui';
import { GetStarted } from '../GetStarted';
import { HomeChat } from '../HomeChat';

interface HomeView { widgets: { id: 'approvals' | 'delegations' | 'notifications' | 'recent_runs' | 'my_flows'; visible: boolean }[]; recentRunsLimit: number }
interface Approval { kind: string; id: string; title: string; flowId?: string; appId?: string; runId?: string; createdAt: string; forMember?: string; outsideTeam?: boolean }
interface Delegation { id: string; requester_id: string; delegate_id: string; action: string; status: string; expires_at: string }
interface Notification { id: number; kind: string; run_id: string | null; delegation_id: string | null; plan_id: string | null; flow_id: string | null; created_at: string; /** How its run ended or stands now (no step names). */ outcome?: string | null }
interface RunItem { id: string; flowName: string; version: number; status: string; waitReason: string | null; createdAt: string }
interface FlowItem { id: string; name: string; createdBy: string; approvedVersionId: string | null; latest: { version: number; status: string } }
const NOTE: Record<string, string> = {
  run_paused: 'A run paused and needs you', run_failed: 'A run failed', run_succeeded: 'A run finished', approval_needed: 'Something needs your approval', input_needed: 'A run is waiting for your input',
  delegation_requested: 'A teammate asked you to run an action', delegation_decided: 'Your delegation request was answered', delegation_reminder: 'A teammate is waiting on you',
  delegation_cancelled: 'A delegation was withdrawn', delegation_delegate_offboarded: 'The teammate you asked left; your request was cancelled', delegation_expired: 'A delegation expired', delegation_escalated: 'A teammate’s delegation expired', module_review_needed: 'A module is waiting for review', schedule_failed: 'A schedule could not start its Flow', followup_failed: 'A follow-up Flow could not start',
  plan_needs_answers: 'Your plan has questions for you', plan_needs_attention: 'Something in your plan needs attention', plan_ready: 'Your plan is drafted', plan_failed: 'Your plan could not be read',
  breakglass_used: 'Break-glass access was used', access_review_due: 'Access is due for review', access_removed: 'An unreviewed credential was removed', module_drift: 'A module may need a fix: its app changed', ai_budget_warning: "Most of this month's AI budget is used", watch_failed: 'A watch could not check for new items', audit_anchor_failed: 'The audit hash could not be sent', audit_stream_failed: 'Audit events could not be sent to a SIEM', flow_fix_proposed: 'A fix for one of your Flows waits for approval', module_fix_failed: 'A module fix could not be drafted automatically',
  flow_approval_needed: 'A new Flow version needs your approval', approval_reminder: 'Reminder: an approval is still waiting', approval_escalated: 'An approval has waited too long', standin_assigned: 'A teammate asked you to approve for them while away',
  agent_confirmation_needed: 'An AI agent waits for you to confirm a change', gateway_tool_blocked: 'An app tool offered to AI agents changed and is blocked', reversal_needs_approval: 'Someone asked to reverse changes; sign-off needed', reversal_finished: 'A reversal you asked for has finished',
  member_offboarded: 'Someone was offboarded: their Flows and schedules need a new owner',
  cost_cap_reached: 'A run reached its AI cost cap and waits',
  pinned_model_unavailable: "A Flow's AI model is gone: it used the organization's model instead",
  model_change_checked: 'A Flow was checked with the new AI model and waits for you',
  autostop_tripped: 'A Flow or AI agent was stopped automatically',
  autostop_resumed: 'An automatically stopped Flow or AI agent was resumed',
};
function approvalLink(a: Approval) { return a.kind === 'flow_version' ? `/flows/${a.flowId}` : a.kind === 'app_version' ? `/team-apps/${a.appId}` : a.kind === 'module' ? `/modules/${a.id}` : a.kind === 'auto_stop' ? '/auto-stops' : a.kind === 'reversal' ? (a.runId ? `/runs/${a.runId}` : `/reversals/${a.id}`) : `/runs/${a.runId}`; }

export function Home() {
  const { me, mode } = useMe();
  const view = useLoad(() => api<HomeView>('/views/home'));
  const approvals = useLive(() => api<Approval[]>('/approvals'), 15000);
  const delegations = useLive(() => api<Delegation[]>('/delegations'), 15000);
  const notes = useLive(() => api<Notification[]>('/notifications'), 15000);
  const runs = useLive(() => api<RunItem[]>(`/runs?limit=${view.data?.recentRunsLimit ?? 10}`), 15000, [view.data?.recentRunsLimit]);
  const { current: team } = useTeams();
  const flows = useLoad(() => api<FlowItem[]>(`/flows${teamQuery(team)}`), [team]);
  const vault = useLoad(() => api<{ service: string }[]>('/me/credentials'));
  const runnable = useLoad(() => api<Runnable[]>(`/runnable${teamQuery(team)}`), [team]);
  const chat = useAction();
  const [runFilter, setRunFilter] = useState('all');
  const [layoutNote, setLayoutNote] = useState<string | null>(null);
  if (view.error) return <ErrorText>{view.error}</ErrorText>;
  if (!view.data) return <Loading />;
  const incoming = delegations.data?.filter(d => d.delegate_id === me.id && d.status === 'pending') ?? [];
  const myFlows = flows.data?.filter(f => f.createdBy === me.id) ?? [];
  const needsAttention = runs.data?.filter(r => ['paused', 'waiting', 'failed'].includes(r.status)) ?? [];
  const visibleRuns = runs.data?.filter(r => runFilter === 'all' || (runFilter === 'attention' ? ['paused', 'waiting', 'failed'].includes(r.status) : r.status === 'succeeded')) ?? [];
  const preset = (id: HomeView['widgets'][number]['id']) => chat.run(async () => {
    const widgets = [...view.data!.widgets].sort((a, b) => Number(b.id === id) - Number(a.id === id)).map(w => w.id === id ? { ...w, visible: true } : w);
    view.setData(await api<HomeView>('/views/home', { method: 'PUT', body: { ...view.data, widgets } }));
  });
  const widgets: Record<string, React.ReactNode> = {
    approvals: <Card title={<><span className="status-dot"/>Pending Signoffs & Approvals</>} key="approvals" actions={<span className="badge tone-warn">{approvals.data?.length ?? 0} required</span>}>
      <ErrorText>{approvals.error}</ErrorText>
      {approvals.loading && !approvals.data ? <Loading /> : approvals.data?.length ? approvals.data.map(a => <article className="request-card" key={`${a.kind}:${a.id}`}><div className="request-meta"><span>{a.kind.replace(/_/g, ' ').toUpperCase()}</span><span>Requested <When at={a.createdAt}/></span></div><h3>{a.title}</h3>{a.forMember ? <p><span className="badge tone-info">For {a.forMember}</span> <span className="muted">You stand in for them; your approval is recorded as given for them.</span></p> : a.outsideTeam ? <p><span className="badge tone-warn">Outside your team</span> <span className="muted">The team approves this; as an org admin you can step in, and that is recorded.</span></p> : null}{a.kind === 'input' ? <><p className="muted">Your run is waiting for you to fill in a form.</p><Link className="button primary" to={approvalLink(a)}><Icon name="flow" size={16}/>Fill in</Link></> : <><p className="muted">Review the exact {a.kind === 'module' ? 'module manifest and sandbox report' : a.kind === 'gate' ? 'run and approval step' : a.kind === 'reversal' ? 'changes to reverse and the reason' : a.kind === 'cost_cap' ? 'AI spend of the run and its cap' : a.kind === 'auto_stop' ? 'evidence of the automatic stop, then resume the Flow and decide whether this run goes on' : 'Flow version'} before making your decision.</p><Link className="button primary" to={approvalLink(a)}><Icon name="shield" size={16}/>{a.kind === 'auto_stop' ? 'Open Automatic stops' : 'Review & Authorize'}</Link>{a.kind === 'auto_stop' && a.runId ? <> <Link className="button" to={`/runs/${a.runId}`}>Open the run</Link></> : null}</>}</article>) : <Empty>All caught up. No approvals waiting for you.</Empty>}
    </Card>,
    delegations: <Card title={<><Icon name="users"/>Teammate Requests</>} key="delegations" actions={<span className="badge tone-info">{incoming.length} pending</span>}>
      <ErrorText>{delegations.error}</ErrorText>
      {delegations.loading && !delegations.data ? <Loading /> : incoming.length ? incoming.map(d => <article className="request-card" key={d.id}><div className="request-meta"><span>PER-ACTION DELEGATION</span><span>Expires <When at={d.expires_at}/></span></div><h3>Run “{d.action}” with your account</h3><p className="muted">Your teammate is requesting one exact action. Your credential stays private.</p><Link to={`/delegations/${d.id}`} className="button primary"><Icon name="key" size={16}/>Review Request</Link></article>) : <Empty>No open requests from teammates.</Empty>}
    </Card>,
    recent_runs: <Card title="Recent runs" key="recent_runs" actions={<div className="tabs">{[['all', 'All runs'], ['attention', 'Attention'], ['succeeded', 'Succeeded']].map(([v, label]) => <button key={v} className={runFilter === v ? 'selected' : ''} aria-pressed={runFilter === v} onClick={() => setRunFilter(v!)}>{label}</button>)}</div>}>
      <ErrorText>{runs.error}</ErrorText>
      {runs.loading && !runs.data ? <Loading /> : visibleRuns.length ? <div className="table-wrap"><table><thead><tr><th>Flow / Execution</th><th>Status</th><th>Started</th></tr></thead><tbody>{visibleRuns.map(r => <tr key={r.id}><td><Link to={`/runs/${r.id}`}>{r.flowName}</Link><div className="muted">v{r.version} · {r.id.slice(0, 8)}</div></td><td><Status value={r.status}/></td><td><When at={r.createdAt}/></td></tr>)}</tbody></table></div> : <Empty>{runs.data?.length ? 'No runs match this filter.' : 'Your executions will appear here. Start a run from an approved Flow.'}</Empty>}
      <div className="table-foot"><span>Showing {visibleRuns.length} recent runs</span><Link to="/runs">All runs →</Link></div>
    </Card>,
    my_flows: <Card title="My Flows" key="my_flows" actions={<span className="badge tone-info">{myFlows.length} total</span>}>
      <ErrorText>{flows.error}</ErrorText>
      {flows.loading && !flows.data ? <Loading /> : myFlows.length ? <ul className="list">{myFlows.map(f => <li key={f.id}><Icon name="flow"/><Link to={`/flows/${f.id}`}>{f.name}</Link><Status value={f.latest.status}/><span className="muted">v{f.latest.version}</span></li>)}</ul> : <Empty>Create your first Flow to connect your apps.</Empty>}
      <Link to="/flows" className="card-link">All Flows <Icon name="arrow" size={16}/></Link>
    </Card>,
    notifications: <Card title={<><Icon name="bell"/>Activity & Notifications</>} key="notifications">
      <ErrorText>{notes.error}</ErrorText>
      {notes.loading && !notes.data ? <Loading /> : notes.data?.length ? <ul className="list">{notes.data.slice(0, 8).map(n => <li key={n.id}>{n.run_id ? <Link to={`/runs/${n.run_id}`}>{NOTE[n.kind] ?? n.kind.replace(/_/g, ' ')}</Link> : n.delegation_id ? <Link to={`/delegations/${n.delegation_id}`}>{NOTE[n.kind] ?? n.kind.replace(/_/g, ' ')}</Link> : n.plan_id ? <Link to={`/plans/${n.plan_id}`}>{NOTE[n.kind] ?? n.kind.replace(/_/g, ' ')}</Link> : n.flow_id ? <Link to={`/flows/${n.flow_id}`}>{NOTE[n.kind] ?? n.kind.replace(/_/g, ' ')}</Link> : n.kind === 'agent_confirmation_needed' || n.kind === 'gateway_tool_blocked' ? <Link to="/agents">{NOTE[n.kind]}</Link> : n.kind === 'member_offboarded' ? <Link to="/admin#provisioning">{NOTE[n.kind]}</Link> : <span>{NOTE[n.kind] ?? n.kind.replace(/_/g, ' ')}</span>}{n.outcome ? <span className="muted"> {n.outcome}</span> : null}<span className="muted"><When at={n.created_at}/></span></li>)}</ul> : <Empty>Nothing new. Your workspace is quiet.</Empty>}
    </Card>,
  };
  const enabled = view.data.widgets.filter(w => w.visible);
  return <section className="page dashboard">
    {/* The chat comes first: say what to automate, see the plan, build it in one click (HomeChat.tsx). */}
    <HomeChat />
    <nav className="home-strip" aria-label="Needs you">
      <a href="#your-work" className={`home-strip-item ${approvals.data?.length || incoming.length ? 'warning' : ''}`}><Icon name="shield" size={15}/><strong>{approvals.data && delegations.data ? approvals.data.length + incoming.length : '—'}</strong> awaiting your decision</a>
      <Link to="/runs" className={`home-strip-item ${needsAttention.length ? 'warning' : ''}`}><Icon name="clock" size={15}/><strong>{runs.data ? needsAttention.length : '—'}</strong> runs need attention</Link>
      <Link to="/run" className="home-strip-item"><Icon name="flow" size={15}/><strong>{flows.data ? flows.data.filter(f => f.approvedVersionId).length : '—'}</strong> Flows ready to run</Link>
      <Link to="/create" className="home-strip-item"><Icon name="plus" size={15}/>Create</Link>
      <span className="badge tone-ok"><Icon name="shield" size={12}/>{mode === 'local' ? 'Local workspace' : 'Organization workspace'}</span>
    </nav>
    <h2 className="home-section" id="your-work">Your work</h2>
    <div className="dashboard-grid"><div className="dashboard-main"><GetStarted/>{enabled.filter(w => w.id !== 'my_flows').map(w => widgets[w.id])}</div><aside className="dashboard-side">
      <Card title={<><Icon name="sparkles"/>Arrange this page</>} actions={<span className="badge tone-info">Only for you</span>}><p className="muted">Say how you want this page laid out; only your view changes.</p><ChatBox placeholder='e.g. “Show my runs first”' button="Apply layout" busy={chat.busy} onSubmit={text => chat.run(async () => { const out = await post<{ config: HomeView; reply: string; notLayout?: boolean }>('/views/home/chat', { request: text }); view.setData(out.config); setLayoutNote(out.notLayout ? out.reply : null); })}/>{layoutNote ? <p className="notice" role="status">{layoutNote} <a href="#home-chat">Use the chat at the top</a></p> : null}<ErrorText>{chat.error}</ErrorText><div className="eyebrow">QUICK PRESETS</div><div className="suggestions"><button disabled={chat.busy} onClick={() => preset('recent_runs')}><Icon name="bolt" size={12}/>Runs first</button><button disabled={chat.busy} onClick={() => preset('delegations')}><Icon name="users" size={12}/>Requests first</button><button disabled={chat.busy} onClick={() => chat.run(async () => view.setData(await api<HomeView>('/views/home', { method: 'DELETE' })))}><Icon name="refresh" size={12}/>Reset default</button></div></Card>
      <Card title={<><Icon name="arrow"/>Ready to run</>} actions={<Link to="/run">All</Link>}>{runnable.data?.length ? <ul className="list">{[...runnable.data].sort((a, b) => Number(b.ready) - Number(a.ready)).slice(0, 4).map(r => <li key={r.versionId}><Link to={`/run/${r.versionId}`}>{r.name}</Link>{r.ready ? <span className="badge tone-ok">Ready</span> : <span className="badge tone-warn">Needs setup</span>}</li>)}</ul> : runnable.loading ? <Loading/> : <Empty>No approved Flows to run yet.</Empty>}</Card>
      {enabled.filter(w => w.id === 'my_flows').map(w => widgets[w.id])}
      <Card title={<><Icon name="key"/>Your credentials</>}><ErrorText>{vault.error}</ErrorText>{vault.data?.length ? <ul className="list">{vault.data.map(c => <li key={c.service}><span className="status-dot"/><code>{c.service}</code><span className="badge tone-ok">Stored</span></li>)}</ul> : vault.loading ? <Loading/> : <Empty>No credentials stored yet.</Empty>}<p className="muted">Encrypted on the server. Used only for actions you execute. Sharing a Flow keeps your credentials private.</p><Link to="/credentials" className="card-link">Manage your vault <Icon name="arrow" size={16}/></Link></Card>
    </aside></div>
  </section>;
}

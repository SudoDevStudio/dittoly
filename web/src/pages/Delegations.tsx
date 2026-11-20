import { useState } from 'react';
import { api, post } from '../api';
import { Card, Empty, ErrorText, Loading, Page, Pre, Status, useAction, useLive, useLoad, When } from '../components';
import { useMe } from '../context';
import { Link, navigate } from '../router';
import { Avatar, Icon, Metric, Notice } from '../ui';

interface Item { id: string; run_id: string; step_id: string; requester_id: string; delegate_id: string; action: string; status: string; created_at: string; expires_at: string }
interface Detail {
  id: string;
  status: string;
  runId: string;
  stepId: string;
  requesterId: string;
  delegateId: string;
  module: string;
  action: { name: string; title?: string; effect?: string; description?: string };
  hosts: string[];
  expiresAt: string;
  inputs?: unknown[];
}
interface Person { id: string; handle: string; displayName: string | null }

export function Delegations() {
  const { me } = useMe();
  const list = useLive(() => api<Item[]>('/delegations'), 15000);
  const people = useLoad(() => api<Person[]>('/directory'));
  const [tab, setTab] = useState('pending');
  const name = (id: string) => people.data?.find(p => p.id === id)?.displayName ?? people.data?.find(p => p.id === id)?.handle ?? id;
  const rows = list.data ?? [];
  const pending = rows.filter(d => d.delegate_id === me.id && d.status === 'pending');
  const sent = rows.filter(d => d.requester_id === me.id);
  const active = rows.filter(d => ['approved', 'running'].includes(d.status));
  const shown = tab === 'pending' ? pending : tab === 'sent' ? sent : tab === 'active' ? active : rows;
  return <Page title="Delegations" eyebrow="CONTROL PLANE / SCOPED ACCESS" description="Ask a teammate to run one exact action with their own account. Both identities are recorded, and raw credentials stay private." actions={<Link to="/runs" className="button primary"><Icon name="plus" size={16}/>Request from a Run</Link>}>
    <div className="metrics"><Metric label="Pending your approval" value={list.data ? pending.length : '—'} detail="Requests assigned to you" icon="shield" tone={pending.length ? 'warning' : ''}/><Metric label="You requested" value={list.data ? sent.length : '—'} detail="Actions requested from teammates" icon="users"/><Metric label="Approved or running" value={list.data ? active.length : '—'} detail="Authorized single actions" icon="key"/><Metric label="Delegation history" value={list.data ? rows.length : '—'} detail="Requests visible to you" icon="clock"/></div>
    <div className="toolbar"><div className="tabs">{[['pending', `Pending for you (${pending.length})`], ['active', `Approved / running (${active.length})`], ['sent', `You requested (${sent.length})`], ['history', 'All requests']].map(([v, label]) => <button key={v} className={tab === v ? 'selected' : ''} aria-pressed={tab === v} onClick={() => setTab(v!)}>{label}</button>)}</div></div>
    <ErrorText>{list.error ?? people.error}</ErrorText>
    {!list.data ? <Loading/> : shown.length ? shown.map(d => <article className="card" key={d.id}>
      <div className="credential-head"><Avatar name={name(d.requester_id)}/><div><strong>{name(d.requester_id)}</strong><div className="muted">requests an action from {d.delegate_id === me.id ? 'you' : name(d.delegate_id)}</div></div><span className="spacer"/><Status value={d.status}/></div>
      <div className="request-card"><div className="request-meta"><span>TARGET ACTION</span><span>REQUEST {d.id.slice(0, 8)}</span></div><h3>{d.action}</h3><div className="request-meta"><span>Requested <When at={d.created_at}/></span><span>Expires <When at={d.expires_at}/></span></div></div>
      <div className="row"><p className="muted">Review the exact inputs and permitted hosts before authorizing this action.</p><span className="spacer"/><Link to={`/delegations/${d.id}`} className={d.delegate_id === me.id && d.status === 'pending' ? 'button primary' : 'button'}><Icon name="shield" size={16}/>{d.delegate_id === me.id && d.status === 'pending' ? 'Review & Authorize' : 'Inspect Request'}</Link></div>
    </article>) : <Card><Empty>{tab === 'pending' ? 'All caught up. No teammate requests waiting for you.' : 'No requests in this view.'}</Empty></Card>}
    <Notice><strong>One action. Two accountable identities.</strong> Delegation authorizes the exact requested step. To request access, open a paused run and choose a teammate for the failed action.</Notice>
  </Page>;
}

export function DelegationDetail({ id }: { id: string }) {
  const { me } = useMe();
  const d = useLoad(() => api<Detail>(`/delegations/${id}`), [id]);
  const people = useLoad(() => api<Person[]>('/directory'));
  const act = useAction();
  const [other, setOther] = useState('');
  if (d.error) return <ErrorText>{d.error}</ErrorText>;
  if (!d.data) return <Loading />;
  const x = d.data;
  const name = (pid: string) => people.data?.find((p) => p.id === pid)?.handle ?? pid;
  const iAmDelegate = x.delegateId === me.id;
  const iAmRequester = x.requesterId === me.id;

  return (
    <Page title={`Run “${x.action.title ?? x.action.name}” for ${name(x.requesterId)}`} eyebrow="TEAMMATE DELEGATIONS / REQUEST REVIEW" actions={<Status value={x.status} />}>
      <Card title="What you are asked to do">
        <p>
          <strong>{x.module}</strong> · {x.action.name}
          {x.action.effect === 'write' ? <span className="badge tone-warn" style={{ marginLeft: 8 }}>changes data</span> : <span className="badge tone-muted" style={{ marginLeft: 8 }}>reads data</span>}
        </p>
        {x.action.description ? <p className="muted">{x.action.description}</p> : null}
        <p className="muted">
          It connects only to {x.hosts.join(', ')}, using <strong>your own</strong> account. This exact request cannot be changed after you approve it.
        </p>
        {x.inputs ? (
          <>
            <h2>Exact inputs</h2>
            <Pre>{JSON.stringify(x.inputs.length === 1 ? x.inputs[0] : x.inputs, null, 2)}</Pre>
          </>
        ) : null}
        <p className="muted">
          Requested by {name(x.requesterId)} · expires <When at={x.expiresAt} />
        </p>
        {iAmDelegate && x.status === 'pending' ? (
          <div className="row">
            <button className="primary" disabled={act.busy} onClick={() => act.run(async () => (await post(`/delegations/${id}/decision`, { decision: 'approved' }), d.reload()), 'Accepted')}>
              Approve and run with my account
            </button>
            <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await post(`/delegations/${id}/decision`, { decision: 'rejected' }), d.reload()), 'Declined')}>
              Decline
            </button>
          </div>
        ) : null}
        {iAmRequester && x.status === 'pending' ? (
          <div className="row">
            <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Reassign to" style={{ maxWidth: 220 }}>
              <option value="">Reassign to…</option>
              {people.data
                ?.filter((p) => p.id !== me.id && p.id !== x.delegateId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName ?? p.handle}
                  </option>
                ))}
            </select>
            <button disabled={!other || act.busy} onClick={() => act.run(async () => navigate(`/delegations/${(await post<{ delegationId: string }>(`/delegations/${id}/reassign`, { delegateId: other })).delegationId}`))}>
              Reassign
            </button>
            <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await post(`/delegations/${id}/cancel`), d.reload()), 'Delegation withdrawn')}>
              Withdraw
            </button>
          </div>
        ) : null}
        <ErrorText>{act.error}</ErrorText>
        {iAmRequester ? <Link to={`/runs/${x.runId}`}>Open the run</Link> : null}
      </Card>
    </Page>
  );
}

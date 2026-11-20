import { useState } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, useAction, useLoad, When } from './components';
import { useMe } from './context';
import { Icon } from './ui';

/**
 * "While I'm away, Sam approves for me": between two dates the stand-in may approve whatever
 * the member could, and gets the member's approval notifications. Admins can set one for anyone.
 */

interface Standin { id: string; memberId: string; member: string; standinId: string; standin: string; startsAt: string; endsAt: string; note: string | null; active: boolean }
interface Approver { id: string; handle: string; displayName: string | null; role: string }

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export function StandinsCard() {
  const { me, mode } = useMe();
  const list = useLoad(() => api<Standin[]>('/standins'));
  const approvers = useLoad(() => api<Approver[]>('/approvers'));
  const act = useAction();
  const [who, setWho] = useState('');
  const [standin, setStandin] = useState('');
  const [from, setFrom] = useState(day(0));
  const [to, setTo] = useState(day(7));
  const [note, setNote] = useState('');
  // A local install has one person: nobody to stand in.
  if (mode === 'local' || (me.role !== 'admin' && me.role !== 'approver')) return null;
  const away = who || me.id;
  const name = (a: Approver) => a.displayName ?? a.handle;
  // From the start of the first day to the end of the last one, in the browser's time zone.
  const range = () => ({ startsAt: new Date(`${from}T00:00`).toISOString(), endsAt: new Date(`${to}T23:59:59`).toISOString() });
  return (
    <Card title={<><Icon name="users" />When I'm away</>}>
      <p className="muted">Pick someone to approve for you between two dates. They can approve whatever you could, including your teams' Flows and sign-offs, and they get your approval notifications. Each approval records that it was given for you. They still cannot approve their own work.</p>
      {list.data?.length ? (
        <ul className="list" aria-label="Stand-ins">
          {list.data.map((s) => (
            <li key={s.id}>
              <span><strong>{s.standin}</strong> approves for <strong>{s.memberId === me.id ? 'you' : s.member}</strong></span>
              <span className="muted"><When at={s.startsAt} /> – <When at={s.endsAt} />{s.note ? ` · ${s.note}` : ''}</span>
              {s.active ? <span className="badge tone-ok">Now</span> : null}
              {s.memberId === me.id || me.role === 'admin' ? (
                <button className="ghost" disabled={act.busy} onClick={() => act.run(async () => (await api(`/standins/${s.id}`, { method: 'DELETE' }), list.reload()), 'Stand-in removed')}>Remove</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : list.data ? <Empty>Nobody stands in for you.</Empty> : null}
      {me.role === 'admin' ? (
        <div className="field">
          <label htmlFor="standin-who">Who is away</label>
          <select id="standin-who" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Me</option>
            {approvers.data?.filter((a) => a.id !== me.id).map((a) => <option key={a.id} value={a.id}>{name(a)}</option>)}
          </select>
        </div>
      ) : null}
      <div className="row">
        <div className="field">
          <label htmlFor="standin-who-approves">Who approves instead</label>
          <select id="standin-who-approves" value={standin} onChange={(e) => setStandin(e.target.value)}>
            <option value="">Choose an approver</option>
            {approvers.data?.filter((a) => a.id !== away).map((a) => <option key={a.id} value={a.id}>{name(a)}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="standin-from">From</label><input id="standin-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label htmlFor="standin-to">Until (including)</label><input id="standin-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <div className="field"><label htmlFor="standin-note">Note (optional)</label><input id="standin-note" placeholder="e.g. Holiday" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <button
        className="primary"
        disabled={act.busy || !standin}
        onClick={() => act.run(async () => {
          await post('/standins', { standinId: standin, ...range(), ...(who ? { memberId: who } : {}), ...(note ? { note } : {}) });
          setStandin('');
          setNote('');
          list.reload();
        }, 'Stand-in set')}
      >Set stand-in</button>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

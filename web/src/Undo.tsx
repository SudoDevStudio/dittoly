import { useState } from 'react';
import { api, post } from './api';
import { Card, ErrorText, Loading, Page, useAction, useLoad, When } from './components';
import { useMe } from './context';
import { Link } from './router';
import { Icon, Notice } from './ui';

/**
 * Undo: writes whose module declares how to reverse them can be reversed for a while (the
 * organization's undo window). The person it ran as asks, with a reason; an approver signs off;
 * then each write is reversed, newest first, with that person's own access.
 */

interface Write { id: string; runId: string | null; stepId: string | null; item: number; agentCallId: string | null; action: string; undoAction: string; status: string; error: string | null; createdAt: string; expiresAt: string }
interface Reversal {
  id: string; runId: string | null; agentCallId: string | null; requestedBy: string | null; requester: string | null; decider: string | null; reason: string;
  status: 'pending' | 'rejected' | 'running' | 'done' | 'partly_failed'; decidedAt: string | null; finishedAt: string | null; createdAt: string; writes: Write[];
}
interface RunUndo { writes: Write[]; reversals: Reversal[]; windowDays: number }

const WRITE_TEXT: Record<string, string> = { ready: 'Can be reversed', reversing: 'Reversing', reversed: 'Reversed', failed: 'Reversal failed', expired: 'No longer reversible' };
const REVERSAL_TEXT: Record<string, string> = { pending: 'Waiting for sign-off', rejected: 'Rejected', running: 'Reversing', done: 'Reversed', partly_failed: 'Partly reversed' };
const writeLabel = (w: Write, stepTitle?: (id: string) => string) =>
  `${w.stepId ? (stepTitle?.(w.stepId) ?? w.stepId) : 'Agent call'}${w.item ? ` (item ${w.item + 1})` : ''}: ${w.action} → ${w.undoAction}`;

/** On a run: what it changed that can be reversed, asking to reverse, and its reversals. */
export function RunUndoCard({ runId, mine, stepTitle }: { runId: string; mine: boolean; stepTitle: (id: string) => string }) {
  const { me } = useMe();
  const data = useLoad(() => api<RunUndo>(`/runs/${runId}/undo`), [runId]);
  if (!data.data) return data.error ? <ErrorText>{data.error}</ErrorText> : null;
  const { writes, reversals, windowDays } = data.data;
  if (!writes.length && !reversals.length) return null;
  // Writes a request already covers (waiting for sign-off or being reversed) cannot be asked for again.
  const asked = new Set(reversals.filter((r) => r.status === 'pending' || r.status === 'running').flatMap((r) => r.writes.map((w) => w.id)));
  const ready = writes.filter((w) => w.status === 'ready' && !asked.has(w.id));
  return (
    <Card title={<><Icon name="refresh" />Undo</>} actions={ready.length ? <span className="badge tone-info">{ready.length} can be reversed</span> : null}>
      <p className="muted">
        Changes whose module says how to reverse them can be reversed for {windowDays} days. Changes not listed here cannot be reversed by Dittoly.
      </p>
      <ul className="list" aria-label="Changes this run made">
        {writes.map((w) => (
          <li key={w.id}>
            <span>{writeLabel(w, stepTitle)}</span>
            <span className={`badge ${w.status === 'ready' ? 'tone-ok' : w.status === 'failed' ? 'tone-bad' : ''}`}>{WRITE_TEXT[w.status] ?? w.status}</span>
            {w.status === 'ready' ? <span className="muted">until <When at={w.expiresAt} /></span> : null}
            {w.error ? <span className="muted">({w.error})</span> : null}
          </li>
        ))}
      </ul>
      {reversals.map((r) => <ReversalCard key={r.id} reversal={r} reload={data.reload} stepTitle={stepTitle} />)}
      {ready.length && (mine || me.role === 'admin') ? <AskToReverse body={{ runId }} writes={ready} stepTitle={stepTitle} onDone={data.reload} /> : null}
    </Card>
  );
}

function AskToReverse({ body, writes, stepTitle, onDone }: { body: { runId?: string; agentCallId?: string }; writes: Write[]; stepTitle?: (id: string) => string; onDone: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(writes.map((w) => w.id)));
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => (await post('/reversals', { ...body, reason, ...(picked.size < writes.length ? { undoIds: [...picked] } : {}) }), setReason(''), onDone()), 'Asked an approver to sign off');
      }}
    >
      {writes.length > 1 ? (
        <fieldset>
          <legend>Reverse</legend>
          {writes.map((w) => (
            <label key={w.id} className="row"><input type="checkbox" checked={picked.has(w.id)} onChange={() => toggle(w.id)} />{writeLabel(w, stepTitle)}</label>
          ))}
        </fieldset>
      ) : null}
      <div className="field">
        <label htmlFor={`reason-${body.runId ?? body.agentCallId}`}>Why reverse it?</label>
        <textarea id={`reason-${body.runId ?? body.agentCallId}`} rows={2} minLength={10} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Posted the announcement a day early" />
        <span className="muted">An approver signs off first. It is reversed with your own access, newest change first.</span>
      </div>
      <div><button type="submit" className="danger" disabled={act.busy || !picked.size || reason.trim().length < 10}>Ask to reverse</button></div>
      <ErrorText>{act.error}</ErrorText>
    </form>
  );
}

export function ReversalCard({ reversal: r, reload, stepTitle }: { reversal: Reversal; reload: () => void; stepTitle?: (id: string) => string }) {
  const { me, mode } = useMe();
  const act = useAction();
  const canDecide = r.status === 'pending' && (me.role === 'admin' || me.role === 'approver') && (mode === 'local' || r.requestedBy !== me.id);
  const decide = (decision: 'approved' | 'rejected') => act.run(async () => (await post(`/reversals/${r.id}/decision`, { decision }), reload()), decision === 'approved' ? 'Signed off: reversing now' : 'Reversal rejected');
  return (
    <div className="stack reversal" aria-label="Reversal">
      <div className="row">
        <strong>Reversal</strong>
        <span className={`badge ${r.status === 'done' ? 'tone-ok' : r.status === 'pending' ? 'tone-warn' : r.status === 'partly_failed' ? 'tone-bad' : ''}`}>{REVERSAL_TEXT[r.status]}</span>
        <span className="muted">asked by {r.requester ?? 'someone'} <When at={r.createdAt} />{r.decider ? <> · {r.status === 'rejected' ? 'rejected' : 'signed off'} by {r.decider}</> : null}</span>
      </div>
      <p>“{r.reason}”</p>
      <ul className="list">
        {r.writes.map((w) => <li key={w.id}><span>{writeLabel(w, stepTitle)}</span><span className="muted">{WRITE_TEXT[w.status] ?? w.status}{w.error ? ` (${w.error})` : ''}</span></li>)}
      </ul>
      {canDecide ? (
        <div className="row">
          <button className="primary" disabled={act.busy} onClick={() => decide('approved')}>Sign off and reverse</button>
          <button className="danger" disabled={act.busy} onClick={() => decide('rejected')}>Reject</button>
        </div>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}

/** A reversal on its own page (the approvers' inbox links here for agent calls). */
export function ReversalPage({ id }: { id: string }) {
  const r = useLoad(() => api<Reversal>(`/reversals/${id}`), [id]);
  return (
    <Page title="Reverse changes" eyebrow="EXECUTION PORTAL / UNDO" description="Changes someone asked to reverse. An approver signs off; then each is reversed with the original person's own access.">
      <Card>
        <ErrorText>{r.error}</ErrorText>
        {r.data ? (
          <>
            {r.data.runId ? <p><Link to={`/runs/${r.data.runId}`}>Open the run</Link></p> : <p className="muted">Changes an AI agent made through an app action.</p>}
            <ReversalCard reversal={r.data} reload={r.reload} />
          </>
        ) : r.error ? null : <Loading />}
      </Card>
    </Page>
  );
}

/** On the Agents page: reverse a call an agent made, or show where its reversal stands. */
export function ReverseCall({ callId, undo, onDone }: { callId: string; undo: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  if (!undo) return null;
  if (undo !== 'ready') return <span className="muted"> · {WRITE_TEXT[undo] ?? undo}</span>;
  return open ? (
    <AskToReverse body={{ agentCallId: callId }} writes={[{ id: callId } as Write]} onDone={() => (setOpen(false), onDone())} />
  ) : (
    <> · <button className="ghost" onClick={() => setOpen(true)}>Reverse</button></>
  );
}

/** Admins: how long changes can be reversed. */
export function UndoWindowCard() {
  const current = useLoad(() => api<{ days: number }>('/undo-window'));
  const act = useAction();
  const [days, setDays] = useState<string | null>(null);
  if (!current.data) return current.error ? <ErrorText>{current.error}</ErrorText> : <Loading />;
  const value = days ?? String(current.data.days);
  return (
    <Card title={<><Icon name="refresh" />Undo window</>}>
      <p className="muted">How long Dittoly keeps what it needs to reverse a change (for example the id of a created issue), encrypted. After that the change can no longer be reversed and that data is dropped.</p>
      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => (await api('/undo-window', { method: 'PUT', body: { days: Number(value) } }), setDays(null), current.reload()), 'Undo window saved');
      }}>
        <div className="field"><label htmlFor="undo-days">Days (1 to 90)</label><input id="undo-days" type="number" min={1} max={90} value={value} onChange={(e) => setDays(e.target.value)} /></div>
        <button type="submit" className="primary" disabled={act.busy || days === null}>Save</button>
      </form>
      <Notice>Reversing still needs an approver's sign-off, and only works for changes whose module declares how to reverse them.</Notice>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}


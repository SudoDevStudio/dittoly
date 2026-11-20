import { api } from './api';
import { ErrorText, useAction, useLoad } from './components';
import { Link } from './router';
import { Icon } from './ui';

interface Step { id: string; title: string; detail: string; done: boolean; optional: boolean; link: string | null }
export interface Onboarding { steps: Step[]; complete: boolean; hidden: boolean }

/** The "Get started" checklist on the home page; each step ticks itself off when it really happened. */
export function GetStarted() {
  const state = useLoad(() => api<Onboarding>('/onboarding'));
  const act = useAction();
  const setHidden = (hidden: boolean) => act.run(async () => state.setData(await api<Onboarding>('/onboarding', { method: 'PUT', body: { hidden } })));
  const o = state.data;
  if (!o) return null;
  if (o.hidden) {
    return o.complete ? null : <button className="ghost get-started-reopen" disabled={act.busy} onClick={() => setHidden(false)}><Icon name="check" size={14}/>Show “Get started”</button>;
  }
  const required = o.steps.filter(s => !s.optional);
  const done = required.filter(s => s.done).length;
  const next = o.steps.find(s => !s.done && !s.optional) ?? o.steps.find(s => !s.done);
  return <section className="card get-started" aria-labelledby="get-started-title">
    <div className="card-head">
      <h2 id="get-started-title"><Icon name="check"/>{o.complete ? 'You’re set up' : 'Get started'}</h2>
      <div className="row">
        <span className="badge tone-info" aria-label={`${done} of ${required.length} steps done`}>{done} / {required.length}</span>
        <button className="ghost" disabled={act.busy} onClick={() => setHidden(true)}>Hide</button>
      </div>
    </div>
    <div className="get-started-bar" role="progressbar" aria-label="Get started progress" aria-valuemin={0} aria-valuemax={required.length} aria-valuenow={done}><span style={{ width: `${(done / Math.max(1, required.length)) * 100}%` }}/></div>
    <ol className="get-started-steps">
      {o.steps.map((s, i) => <li key={s.id} className={s.done ? 'done' : s === next && !o.complete ? 'next' : ''}>
        <span className="get-started-mark" aria-hidden="true">{s.done ? <Icon name="check" size={14}/> : i + 1}</span>
        <div>
          <div className="get-started-title">{s.title}{s.optional ? <span className="muted"> · optional</span> : null}{s.done ? <span className="sr-only"> (done)</span> : null}</div>
          {s.done ? null : <p className="muted">{s.detail}</p>}
        </div>
        {!s.done && s.link ? <Link className={`button ${s === next && !o.complete ? 'primary' : ''}`} to={s.link}>{s === next && !o.complete ? 'Start' : 'Open'}<Icon name="arrow" size={14}/></Link> : null}
      </li>)}
    </ol>
    {o.complete ? <p className="muted">Everything needed is done. What is left is optional; hide this card when you like.</p> : null}
    <p className="muted get-started-foot"><a href="https://github.com/SudoDevStudio/dittoly/blob/main/docs/getting-started.md" target="_blank" rel="noreferrer">The full guide, step by step</a></p>
    <ErrorText>{state.error ?? act.error}</ErrorText>
  </section>;
}

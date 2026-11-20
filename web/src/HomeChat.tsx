import { useEffect, useRef, useState } from 'react';
import { api, MESSAGES, post } from './api';
import { ErrorText, useAction, useLive, useLoad, When } from './components';
import { useMe } from './context';
import { Link } from './router';
import { useTeams } from './teams';
import { Icon } from './ui';
import { useDictation } from './speech';

/**
 * The home page's chat: say what to automate, the AI answers and shows its whole plan (apps, modules it reuses or
 * builds, the Flow's steps, what it assumed), you correct it in plain words, then one click drafts everything.
 * Approvals stay as they are; in local mode the single member approves each item from here.
 */

interface Message { role: 'user' | 'assistant'; text: string }
interface Question { id: string; question: string; options: string[] }
interface ChatPlan {
  title: string;
  summary: string;
  questions: Question[];
  modules: { key: string; title: string; request: string; extends?: string }[];
  flows: { key: string; title: string; request: string; needs: string[] }[];
  reuse: { key: string; flow: string; version: number; title: string; why: string }[];
  superFlow: { title: string; request: string; uses: string[] } | null;
}
interface PlanItem { id: string; kind: 'module' | 'flow' | 'existing' | 'superflow'; title: string; status: string; error: string | null; moduleVersionId: string | null; flowId: string | null; flowVersionId: string | null }
interface BuiltPlan { id: string; status: string; items: PlanItem[] }

const SUGGESTIONS = [
  'When someone fills our contact form, add them to the CRM and tell #sales',
  'When a new hire is added, open their laptop ticket after their manager approves',
  'Every morning, post the open pull requests that wait for review to #dev in Slack',
];
const WORKING = new Set(['reading', 'drafting', 'waiting']);
const ITEM: Record<string, string> = {
  queued: 'Queued', drafting: 'Drafting…', in_review: 'Waits for an admin to approve', approved: 'Approved', rejected: 'Rejected',
  needs_attention: 'Needs a fix before review', waiting: 'Drafted once what it needs is approved', drafted: 'Waits for an approver',
  blocked: 'Blocked', needs_answers: 'Has questions', failed: 'Drafting failed', cancelled: 'Cancelled',
};

const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

interface RecentChat { id: string; title: string; createdBy: string; mine: boolean; planId: string | null; updatedAt: string; expiresAt: string }
interface StoredChat { id: string; messages: unknown; plan: unknown; planId: string | null }
/** "30 days": how long a chat is kept after its last message, from the newest chat's expiry. */
function recentDays(chats: RecentChat[]): string {
  const c = chats[0];
  if (!c) return '';
  const days = Math.round((Date.parse(c.expiresAt) - Date.parse(c.updatedAt)) / 86_400_000);
  return `${days} DAY${days === 1 ? '' : 'S'}`;
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The plan as the page needs it, whatever came back (missing lists are empty), so an odd answer cannot break the page. */
function asPlan(p: unknown): ChatPlan | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const sf = o.superFlow && typeof o.superFlow === 'object' ? (o.superFlow as Record<string, unknown>) : null;
  return {
    title: str(o.title),
    summary: str(o.summary),
    questions: list<Question>(o.questions).map((q) => ({ id: str(q?.id), question: str(q?.question), options: list<string>(q?.options).filter((x) => typeof x === 'string') })),
    modules: list<ChatPlan['modules'][number]>(o.modules).map((m) => ({ key: str(m?.key), title: str(m?.title), request: str(m?.request), ...(str(m?.extends) ? { extends: str(m?.extends) } : {}) })),
    flows: list<ChatPlan['flows'][number]>(o.flows).map((f) => ({ key: str(f?.key), title: str(f?.title), request: str(f?.request), needs: list<string>(f?.needs) })),
    reuse: list<ChatPlan['reuse'][number]>(o.reuse).map((r) => ({ key: str(r?.key), flow: str(r?.flow), version: Number(r?.version) || 0, title: str(r?.title), why: str(r?.why) })),
    superFlow: sf ? { title: str(sf.title), request: str(sf.request), uses: list<string>(sf.uses) } : null,
  };
}

/** "What will happen. Assuming: a; b; c" → the sentence and the list. */
function splitSummary(summary: string): { what: string; assumed: string[] } {
  const i = summary.search(/\bAssuming:/);
  if (i === -1) return { what: summary, assumed: [] };
  return { what: summary.slice(0, i).trim(), assumed: summary.slice(i + 'Assuming:'.length).split(/;\s*/).map((s) => s.trim().replace(/\.$/, '')).filter(Boolean) };
}

export function HomeChat() {
  const { me } = useMe();
  const { current: team } = useTeams();
  const act = useAction();
  const [messages, setMessages] = useState<Message[]>([]);
  const [plan, setPlan] = useState<ChatPlan | null>(null);
  // Sent here with a request to plan (?ask=…, e.g. "Plan it as a Super Flow" on the Flows page): it waits in the box.
  const [text, setText] = useState(() => {
    const url = new URL(location.href);
    const ask = url.searchParams.get('ask');
    if (ask) {
      url.searchParams.delete('ask');
      history.replaceState(history.state, '', url);
    }
    return ask?.slice(0, 4000) ?? '';
  });
  const [built, setBuilt] = useState<string | null>(null);
  // The chat is kept (for its owner and team, until it expires): its id is in the address, so it can be opened again.
  const [chatId, setChatId] = useState<string | null>(() => new URLSearchParams(location.search).get('chat'));
  const recent = useLoad(() => api<RecentChat[]>(`/chats${team ? `?teamId=${team}` : ''}`), [team, chatId]);
  const remember = (id: string | null) => {
    setChatId(id);
    const url = new URL(location.href);
    if (id) url.searchParams.set('chat', id);
    else url.searchParams.delete('chat');
    history.replaceState(history.state, '', url);
  };
  const open = (id: string) =>
    void act.run(async () => {
      const c = await api<StoredChat>(`/chats/${id}`);
      setMessages(list<Message>(c.messages));
      setPlan(asPlan(c.plan));
      setBuilt(c.planId);
      remember(c.id);
    });
  // Opened from a link (?chat=…): load it once.
  useEffect(() => {
    if (chatId && !messages.length) open(chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const startNew = () => {
    setMessages([]);
    setPlan(null);
    setBuilt(null);
    remember(null);
  };
  const end = useRef<HTMLDivElement>(null);
  // In braces: newer browsers return a Promise from scrollIntoView, and an effect must return nothing or a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [messages.length]);
  // A real AI can take a minute to plan: say how long it has been, and let the person stop waiting.
  const pending = useRef<AbortController | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  const waited = since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));

  const dictation = useDictation(text, setText);
  const send = (said: string) => {
    dictation.stop();
    const t = said.trim();
    if (!t || act.busy) return;
    const next: Message[] = [...messages, { role: 'user', text: t }];
    setMessages(next);
    setText('');
    const ctrl = new AbortController();
    pending.current = ctrl;
    setSince(Date.now());
    setNow(Date.now());
    void act.run(async () => {
      try {
        const r = await post<{ chatId: string; reply: string; plan: ChatPlan | null }>('/chat/plan', { message: t, ...(chatId ? { chatId } : {}), ...(team ? { teamId: team } : {}) }, { signal: ctrl.signal });
        if (typeof r?.chatId === 'string') remember(r.chatId);
        setMessages([...next, { role: 'assistant', text: typeof r?.reply === 'string' && r.reply ? r.reply : 'Here is my plan.' }]);
        setPlan(asPlan(r?.plan));
      } catch (err) {
        setMessages(messages);
        setText(t);
        // Stopped by the person: nothing to report.
        if (ctrl.signal.aborted) return;
        throw err;
      } finally {
        pending.current = null;
        setSince(null);
      }
    });
  };
  const build = () =>
    plan &&
    chatId &&
    void act.run(async () => {
      const r = await post<{ id: string }>('/plans/from-chat', { chatId });
      setBuilt(r.id);
    }, 'Building: drafts appear below as they are ready');

  const started = messages.length > 0;
  // "No AI" is not an error the person made: it is a setting nobody has filled in yet.
  const noAi = act.error === MESSAGES.ai_provider_not_configured || /No AI is set up yet/.test(act.error ?? '');
  return (
    <section id="home-chat" className={`home-chat ${started ? 'started' : ''}`} aria-label="Chat">
      {!started ? (
        <div className="home-chat-hero">
          <h1>What do you want to automate{me.handle ? `, ${me.handle}` : ''}?</h1>
          <p className="muted">Say it in your own words. The AI shows its plan first; you correct it, then build it in one click. Nothing runs until it is approved.</p>
        </div>
      ) : (
        <ol className="home-chat-log" aria-label="Conversation">
          {messages.map((m, i) => (
            <li key={i} className={`bubble ${m.role}`}>
              {m.role === 'assistant' ? <Icon name="sparkles" size={16} /> : null}
              <span>{m.text}</span>
            </li>
          ))}
          {since !== null ? (
            <li className="bubble assistant thinking" aria-live="polite">
              <Icon name="sparkles" size={16} />
              <span>
                Planning…{waited >= 5 ? ` ${waited}s` : ''}
                {waited >= 20 ? ' (the AI is still working; a plan with several apps can take a minute or two)' : ''}
              </span>
              <button type="button" className="ghost small" onClick={() => pending.current?.abort()}>Stop</button>
            </li>
          ) : null}
          <div ref={end} />
        </ol>
      )}

      {plan && !built ? <PlanCard plan={plan} busy={act.busy} onAnswer={send} onBuild={build} /> : null}
      {built ? <BuildProgress planId={built} canApprove={me.role === 'admin' || me.role === 'approver'} /> : null}

      {!built ? (
        <>
        <form
          className="home-chat-box"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <textarea
            value={text}
            rows={started ? 2 : 3}
            aria-label={started ? 'Correct the plan or ask something' : 'What do you want to automate?'}
            placeholder={started ? 'Change something, e.g. "post it to #release instead" or "only on weekdays"' : 'e.g. when a new customer signs up, add them to the CRM and welcome them by email'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          {dictation.available ? (
            <button
              type="button"
              className={`ghost mic ${dictation.listening ? 'listening' : ''}`}
              aria-pressed={dictation.listening}
              aria-label={dictation.listening ? 'Stop listening' : 'Speak instead of typing'}
              title={dictation.listening ? 'Stop listening' : 'Speak instead of typing'}
              disabled={act.busy}
              onClick={dictation.toggle}
            >
              <Icon name="mic" size={18} />
            </button>
          ) : null}
          <button type="submit" className="primary" disabled={act.busy || !text.trim()} aria-label="Send"><Icon name="arrow" size={18} /></button>
        </form>
        {dictation.listening ? <p className="muted small" aria-live="polite">Listening… speak, then check the text and send it.</p> : null}
        {dictation.problem ? <p className="muted small" role="status">{dictation.problem}</p> : null}
        </>
      ) : (
        <div className="row"><button type="button" className="ghost" onClick={startNew}>Start something new</button></div>
      )}
      {started && !built ? <div className="row"><button type="button" className="ghost small" onClick={startNew}>New chat</button></div> : null}
      {!started ? (
        <div className="suggestions" aria-label="Examples">
          {SUGGESTIONS.map((s) => <button key={s} type="button" disabled={act.busy} onClick={() => send(s)}>{s}</button>)}
        </div>
      ) : null}
      {!started && recent.data?.length ? (
        <nav className="recent-chats" aria-label="Recent chats">
          <div className="eyebrow" data-eyebrow>RECENT CHATS (KEPT {recentDays(recent.data)})</div>
          <ul>
            {recent.data.slice(0, 8).map((c) => (
              <li key={c.id}>
                <button type="button" className="link" onClick={() => open(c.id)}>{c.title}</button>
                <span className="muted small">
                  {c.mine ? '' : `${c.createdBy} · `}<When at={c.updatedAt} />{c.planId ? ' · built' : ''}
                </span>
                {c.mine ? (
                  <button type="button" className="ghost small" aria-label={`Delete chat ${c.title}`} onClick={() => void act.run(async () => { await api(`/chats/${c.id}`, { method: 'DELETE' }); recent.reload(); }, 'Chat deleted')}>×</button>
                ) : null}
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {noAi ? <NoAiYet /> : <ErrorText>{act.error}</ErrorText>}
    </section>
  );
}

/**
 * The first wall a new workspace hits: the page invites you to describe an automation, and nothing can read it.
 * So it says what to set, where, and what works in the meantime, instead of one red line.
 */
function NoAiYet() {
  return (
    <div className="notice no-ai" role="note">
      <p><strong>No AI is set up yet</strong>, so a description cannot be turned into a plan.</p>
      <p className="muted">
        Set these where Dittoly runs (in its <code>.env</code>, one per line), then start it again:
      </p>
      <pre className="pre">{`DITTOLY_AI_PROVIDER=anthropic   # or openai, ollama, claude-cli, codex-cli\nANTHROPIC_API_KEY=…             # OPENAI_API_KEY, or for ollama: DITTOLY_AI_MODEL=<a model you pulled>`}</pre>
      <p className="muted">
        With <code>ollama</code> the model runs on your own machine and nothing leaves it. An admin can also switch
        the model later on the <Link to="/admin">Admin page</Link>.
      </p>
      <p className="muted">
        Meanwhile you can still do everything by hand: <Link to="/marketplace">approve a module from the marketplace</Link>,
        then <Link to="/flows">build a Flow</Link> step by step and run it.
      </p>
    </div>
  );
}

function PlanCard({ plan, busy, onAnswer, onBuild }: { plan: ChatPlan; busy: boolean; onAnswer: (text: string) => void; onBuild: () => void }) {
  // The AI asks everything it needs at once, so the answers go back at once too: pick them all, then send.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const chosen = plan.questions.filter((q) => picked[q.id]);
  const sendAnswers = () => {
    const text = chosen.map((q) => `${q.question} ${picked[q.id]}`).join('\n');
    setPicked({});
    onAnswer(text);
  };
  const { what, assumed } = splitSummary(plan.summary);
  const nothing = !plan.modules.length && !plan.flows.length && !plan.superFlow;
  return (
    <article className="plan-card" aria-label="The plan">
      <header><Icon name="flow" size={18} /><strong>{plan.title || 'The plan'}</strong></header>
      {what ? <p>{what}</p> : null}
      {assumed.length ? (
        <>
          <div className="eyebrow" data-eyebrow>ASSUMED (SAY IF ANY IS WRONG)</div>
          <ul className="plan-assumed">{assumed.map((a) => <li key={a}>{a}</li>)}</ul>
        </>
      ) : null}
      {plan.reuse.length ? (
        <>
          <div className="eyebrow" data-eyebrow>ALREADY THERE</div>
          <ul className="plan-parts">{plan.reuse.map((r) => <li key={r.key}><Icon name="check" size={15} /><span><strong>{r.title}</strong> <span className="muted">{r.why}</span></span></li>)}</ul>
        </>
      ) : null}
      {plan.modules.length ? (
        <>
          <div className="eyebrow" data-eyebrow>NEW CONNECTIONS TO BUILD</div>
          <ul className="plan-parts">{plan.modules.map((m) => <li key={m.key}><Icon name="layers" size={15} /><details><summary><strong>{m.title}</strong>{m.extends ? <span className="badge tone-info">adds to {m.extends}</span> : null}</summary><p className="muted">{m.request}</p></details></li>)}</ul>
        </>
      ) : null}
      {plan.flows.length ? (
        <>
          <div className="eyebrow" data-eyebrow>{plan.flows.length === 1 ? 'THE FLOW' : 'THE FLOWS'}</div>
          <ul className="plan-parts">{plan.flows.map((f) => <li key={f.key}><Icon name="flow" size={15} /><span><strong>{f.title}</strong><span className="pre-wrap muted">{f.request}</span></span></li>)}</ul>
        </>
      ) : null}
      {plan.superFlow ? (
        <>
          <div className="eyebrow" data-eyebrow>CONNECTED AS ONE SUPER FLOW</div>
          <p><strong>{plan.superFlow.title}</strong> <span className="muted">{plan.superFlow.request}</span></p>
        </>
      ) : null}
      {plan.questions.length ? (
        <div className="plan-questions">
          <div className="eyebrow" data-eyebrow>{plan.questions.length === 1 ? 'ONE THING TO DECIDE' : `${plan.questions.length} THINGS TO DECIDE`}</div>
          {plan.questions.map((q, i) => (
            <div key={q.id} className="plan-question">
              <p><strong>{plan.questions.length > 1 ? `${i + 1}. ` : ''}{q.question}</strong></p>
              <div className="suggestions" role="group" aria-label={q.question}>
                {q.options.map((o) => (
                  <button
                    key={o}
                    type="button"
                    disabled={busy}
                    aria-pressed={picked[q.id] === o}
                    className={picked[q.id] === o ? 'selected' : undefined}
                    onClick={() => setPicked((p) => ({ ...p, [q.id]: p[q.id] === o ? '' : o }))}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="row">
            <button type="button" disabled={busy || !chosen.length} onClick={sendAnswers}>
              {chosen.length === plan.questions.length ? 'Send these answers' : `Send ${chosen.length} of ${plan.questions.length} answers`}
            </button>
            <span className="muted small">Or write your own answer in the box below. Anything you leave out is decided as assumed.</span>
          </div>
        </div>
      ) : null}
      <footer className="row">
        <button type="button" className="primary" disabled={busy || nothing} onClick={onBuild}><Icon name="bolt" size={16} />Build it</button>
        <span className="muted small">
          {nothing ? 'Nothing to build yet: say what should happen.' : `Drafts ${plan.modules.length ? `${plan.modules.length} connection${plan.modules.length === 1 ? '' : 's'} and ` : ''}${plan.flows.length + (plan.superFlow ? 1 : 0)} Flow${plan.flows.length + (plan.superFlow ? 1 : 0) === 1 ? '' : 's'}${plan.questions.length ? '; open questions are decided as assumed' : ''}. Each is approved before it runs.`}
        </span>
      </footer>
    </article>
  );
}

/** What the click started: each draft as it is ready, with a link, and (for admins and approvers) approve buttons. */
function BuildProgress({ planId, canApprove }: { planId: string; canApprove: boolean }) {
  const { mode } = useMe();
  const plan = useLive(() => api<BuiltPlan>(`/plans/${planId}`), 2500, [planId], (p) => !p || WORKING.has(p.status) || p.items.some((i) => ['queued', 'drafting'].includes(i.status)));
  const act = useAction();
  const p = plan.data;
  // Every part is a link: the module or Flow itself once it exists, and until then (queued, drafting, failed) the
  // part on the plan, where its progress, what it is waiting for and why it stopped are written.
  const href = (i: PlanItem) =>
    (i.kind === 'module' ? i.moduleVersionId && `/modules/${i.moduleVersionId}` : i.flowId && `/flows/${i.flowId}`) || `/plans/${planId}#item-${i.id}`;
  // In local mode the single member approves their own; on a shared server an admin or approver does, in their lists.
  const approve = (i: PlanItem) =>
    act.run(
      async () => {
        if (i.kind === 'module') await post(`/modules/${i.moduleVersionId}/decision`, { decision: 'approved' });
        else await post(`/flow-versions/${i.flowVersionId}/decision`, { decision: 'approved' });
        await plan.reload();
      },
      `${i.title} approved`,
    );
  return (
    <article className="plan-card" aria-label="Building">
      <header><Icon name="bolt" size={18} /><strong>Building</strong></header>
      {!p ? <p className="muted">Starting…</p> : (
        <ul className="plan-parts">
          {p.items.filter((i) => i.kind !== 'existing').map((i) => {
            const link = href(i);
            const onPlan = link.startsWith('/plans/');
            const mayApprove = mode === 'local' && canApprove && ((i.kind === 'module' && i.status === 'in_review' && i.moduleVersionId) || (i.kind !== 'module' && i.status === 'drafted' && i.flowVersionId));
            return (
              <li key={i.id}>
                <Icon name={i.kind === 'module' ? 'layers' : 'flow'} size={15} />
                <span>
                  <Link to={link} title={onPlan ? 'Open this part of the plan' : undefined}><strong>{i.title}</strong></Link> <span className="muted">· {ITEM[i.status] ?? i.status}</span>
                </span>
                {mayApprove ? <button type="button" disabled={act.busy} onClick={() => void approve(i)}>Approve</button> : null}
              </li>
            );
          })}
        </ul>
      )}
      <footer className="row">
        <Link to={`/plans/${planId}`}>Open the full plan</Link>
        <span className="muted small">Open a draft to read what it may access before approving it.</span>
      </footer>
      <ErrorText>{act.error}</ErrorText>
    </article>
  );
}

import { useEffect, useState } from 'react';
import { DraftModelPicker } from '../DraftModel';
import { api, post } from '../api';
import { Card, CodeView, Empty, ErrorText, Loading, Page, Status, useAction, useLive, When } from '../components';
import { Link, navigate } from '../router';
import { useTeams } from '../teams';
import { toast } from '../toast';
import { activityText, elapsed } from '../BuildPanel';
import { Icon, Notice } from '../ui';

interface PlanSummary { id: string; title: string; fileName: string; status: string; error: string | null; pages: number; createdBy: string; items: number; open: number; createdAt: string }
interface PlanItem {
  id: string; kind: 'module' | 'flow' | 'existing' | 'superflow'; key: string; title: string; request: string; needs: string[]; status: string; error: string | null;
  moduleName: string | null; moduleVersionId: string | null; flowId: string | null; flowVersionId: string | null;
  /** extends:<module>: adds to that approved module instead of a new one. */
  basedOn?: string | null;
  detail: string | null; questions: { id: string; question: string; options: string[] }[]; notes: string | null;
  /** What the AI answered, when its answer could not be read at all. */
  aiRaw?: string | null;
  /** While the AI drafts it: the step it is on and how far it has come. */
  progress?: { step: string; percent: number; since?: string | null; detail?: string | null; detailAt?: string | null } | null;
  /** While queued: drafts that go first, or when a retry after a busy AI is due. */
  queue?: { ahead: number; retryAt: string | null } | null;
}
interface Plan {
  id: string; title: string; fileName: string; status: string; error: string | null; errorDetail: string | null; aiRaw?: string | null; pages: number; pdfBytes: number; createdBy: string | null; mine: boolean;
  /** Built from a home chat (no PDF); chatId while that chat is still kept. */
  fromChat?: boolean; chatId?: string | null;
  createdAt: string; summary: string | null; questions: { id: string; question: string; options: string[] }[]; answers: Record<string, string> | null; items: PlanItem[];
}

const MAX_BYTES = 10 * 1024 * 1024;
/** Plans whose status still changes on its own (the server is working on them). */
const WORKING = new Set(['reading', 'drafting', 'waiting']);

const PLAN_STATUS: Record<string, string> = {
  reading: 'The AI is reading the plan…',
  needs_answers: 'The AI has questions before anything is built.',
  drafting: 'Drafting modules and Flows…',
  waiting: 'Waiting on reviews: Flows are drafted once the modules they need are approved.',
  done: 'Everything is drafted. The modules are approved; Flows not yet approved wait for an approver.',
  failed: 'The plan could not be turned into modules and Flows.',
  cancelled: 'Cancelled: nothing more is drafted. Try again on a module or Flow to resume it.',
};

/** Item states Cancel can stop (as the server allows). */
const CANCELLABLE = new Set(['queued', 'drafting', 'waiting', 'blocked', 'needs_answers']);
/** States of a needed item that keep a Flow blocked. */
const BLOCKING = new Set(['failed', 'rejected', 'needs_attention', 'cancelled', 'blocked']);

const ERRORS: Record<string, string> = {
  validation_failed: 'The draft failed its sandbox tests. Open it, revise it, and submit it for review.',
  module_rejected: 'An admin rejected this module. Revise it and submit it again; the plan picks up the approved version.',
  module_not_approved: 'Waits for a module of this plan that was rejected or needs fixing.',
  needs_module_failed: 'A module it needs could not be drafted. Try that module again.',
  needs_module_rejected: 'A module it needs was rejected by an admin. Revise that module and submit it again.',
  needs_module_needs_attention: 'A module it needs failed its sandbox tests. Revise that module and submit it for review.',
  needs_module_cancelled: 'A module it needs was cancelled. Try that module again to resume.',
  flow_not_approved: 'Waits for a Flow of this plan that was rejected or could not be drafted.',
  flow_rejected: 'An approver rejected this Flow. Change it and submit it again; the plan picks up the approved version.',
  plan_nothing_to_build: 'No modules or Flows could be drafted. Check what the AI understood below for missing prerequisites, then try again after resolving them.',
  ai_invalid_plan: "The AI's breakdown could not be used, even after it was told what was wrong. The details say why. Try again; a plan that describes what to automate (not how to build it) works best.",
  ai_provider_not_configured: 'No AI provider is configured on this server.',
  uploader_disabled: 'The person who uploaded the plan no longer has access.',
  no_approved_modules: 'No approved module can do what this Flow needs.',
  ai_response_not_json: "The AI's draft could not be read, even after it was asked to fix it. This usually happens with long Flows. Try again; adding details (what runs in parallel, what each step passes on) often helps.",
  ai_output_truncated: "The AI's draft was cut off: it was too long, even on the second try. Add details that narrow it down, or split the request into smaller Flows.",
  ai_response_shape: "The AI answered in the wrong shape. Try again.",
  ai_output_unparseable: "The AI's answer could not be read. Try again.",
  ai_no_structured_output: "The AI gave no usable answer. Try again.",
  invalid_flow: "The AI's draft did not pass the Flow checks, even after one round of fixes. The details say what was wrong; add what the AI got wrong and try again.",
  invalid_manifest: "The module's manifest is missing required fields or uses unsupported values after repair attempts. Check Details for the exact fields. Narrow the module to specific actions and try again.",
  ai_cli_failed: 'The AI command-line provider on the machine running Dittoly failed. Details has what it said — usually it is not signed in, out of credit, or cannot use the selected model. Fix that there, then try again.',
  unknown_module: 'The draft uses a module that is not approved. Add which module it should use and try again.',
  unknown_action: 'The draft uses an action the module does not have. Add which action it should use and try again.',
  unknown_flow: 'The draft runs a Flow version that does not exist.',
  ai_rate_limited: 'The AI provider is busy (rate limit). Try again in a minute.',
  ai_unreachable: 'The AI provider could not be reached. Try again.',
  ai_api_error: 'The AI provider returned an error. Try again.',
  ai_refused: 'The AI declined this request. Rephrase it in the notes and try again.',
  plan_unexpected_questions: 'The AI had questions it could not ask here. Add the details it needs and try again.',
  drafting_failed: 'Drafting stopped on an unexpected error. Try again.',
  flow_needs_super_flow: 'One Flow cannot do all of this. The details list the Flows to build instead; a Super Flow runs them together.',
  ai_module_config_invalid: "The AI's config for this module was still invalid after repair attempts. Check Details for what was wrong, ask for fewer actions, and try again.",
  ai_manifest_invalid: "The AI's module manifest was still incomplete after repair attempts. Check Details, ask for fewer actions at a time, and try again.",
  drafting_stopped: 'Drafting stopped: the server gave up on it after several tries (a crash or restart). Try again.',
  plan_analysis_failed: 'Reading the plan stopped on an unexpected error. Try again.',
};
const explain = (code: string | null, kind?: PlanItem['kind']) => {
  if (kind === 'module' && code === 'ai_response_not_json') return "The AI returned malformed JSON for the module manifest or tests, even after a retry. Check Details, keep the module request focused on its actions, and try again.";
  if (kind === 'module' && code === 'ai_output_truncated') return "The AI's module draft was cut off. Reduce the number of actions or the amount of code requested, then try again.";
  return code ? (ERRORS[code] ?? `Failed: ${code.replace(/_/g, ' ')}`) : null;
};

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Upload a plan as a PDF; the AI reads it and drafts modules and Flows for review. */
export function Plans() {
  const plans = useLive(() => api<PlanSummary[]>('/plans'), 5000, [], (d) => !!d?.some((p) => WORKING.has(p.status)));
  const { current: team } = useTeams();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [dragging, setDragging] = useState(false);
  const act = useAction();
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) return toast('error', 'Choose a PDF file.');
    if (f.size > MAX_BYTES) return toast('error', 'The PDF must be at most 10 MB.');
    setFile(f);
  };
  const upload = () => act.run(async () => {
    const created = await post<Plan>('/plans', { fileName: file!.name, pdfBase64: await readBase64(file!), ...(title.trim() ? { title: title.trim() } : {}), ...(team ? { teamId: team } : {}) });
    setFile(null);
    setTitle('');
    navigate(`/plans/${created.id}`);
  }, 'Plan uploaded. The AI is reading it.');
  return (
    <Page title="Plans" eyebrow="WORKSPACE / PLANS" description="Upload a plan as a PDF. The AI reads it, asks what it cannot decide, and drafts the modules and Flows. Every module and Flow still goes through review before it can run." className="plans-page">
      <div className="grid">
        <Card title={<><Icon name="plus" />Upload a plan</>}>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (file) upload(); }}>
            <label
              className={`dropzone ${dragging ? 'dragging' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0]); }}
            >
              <Icon name="download" size={24} />
              <span>{file ? <><strong>{file.name}</strong> · {(file.size / 1024).toFixed(0)} KB</> : <>Drop a PDF here or <u>choose a file</u></>}</span>
              <span className="muted">Up to 10 MB. Describe the workflow to automate using available capabilities. Platform development roadmaps belong in your code editor. Scanned pages cannot be read.</span>
              <input type="file" accept="application/pdf,.pdf" className="visually-hidden" aria-label="Plan PDF" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <div className="field">
              <label htmlFor="plan-title">Title (optional)</label>
              <input id="plan-title" value={title} maxLength={120} placeholder="Defaults to the file name" onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="row">
              <button type="submit" className="primary" disabled={!file || act.busy}>{act.busy ? 'Uploading…' : 'Upload and read'}</button>
              {file ? <button type="button" className="ghost" disabled={act.busy} onClick={() => setFile(null)}>Clear</button> : null}
            </div>
            <ErrorText>{act.error}</ErrorText>
          </form>
          <Notice>The PDF and its text are stored encrypted. Only you and admins can see your plans.</Notice>
        </Card>
        <Card title={<><Icon name="layers" />Your plans</>}>
          <ErrorText>{plans.error}</ErrorText>
          {plans.loading && !plans.data ? <Loading /> : plans.data?.length ? (
            <div className="table-wrap"><table><thead><tr><th>Plan</th><th>Status</th><th>Uploaded</th></tr></thead><tbody>
              {plans.data.map((p) => <tr key={p.id}>
                <td><Link to={`/plans/${p.id}`}>{p.title}</Link><div className="muted">{p.fileName} · {p.items ? `${p.items - p.open} of ${p.items} done` : `${p.pages} ${p.pages === 1 ? 'page' : 'pages'}`} · {p.createdBy}</div></td>
                <td><Status value={p.status} /></td>
                <td><When at={p.createdAt} /></td>
              </tr>)}
            </tbody></table></div>
          ) : <Empty>No plans yet. Upload one to get started.</Empty>}
        </Card>
      </div>
    </Page>
  );
}

export function PlanPage({ id }: { id: string }) {
  const plan = useLive(() => api<Plan>(`/plans/${id}`), 4000, [id], (d) => !d || WORKING.has(d.status));
  // Opened from a link on a part ("#item-<id>"): bring that part into view and mark it, once it is on the page.
  const loaded = !!plan.data;
  useEffect(() => {
    const anchor = location.hash.slice(1);
    if (!loaded || !anchor.startsWith('item-')) return;
    const el = document.getElementById(anchor);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('just-opened');
    const t = setTimeout(() => el.classList.remove('just-opened'), 2500);
    return () => clearTimeout(t);
  }, [loaded]);
  const act = useAction();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (plan.error) return <ErrorText>{plan.error}</ErrorText>;
  if (!plan.data) return <Loading />;
  const p = plan.data;
  const update = (next: Plan | undefined) => { if (next) plan.setData(next); };
  const answered = Object.fromEntries(
    Object.entries(answers).filter(([, v]) => v.trim()).map(([qid, v]) => [p.questions.find((q) => q.id === qid)?.question ?? qid, v.trim()]),
  );
  const modules = p.items.filter((i) => i.kind === 'module');
  const flows = p.items.filter((i) => i.kind === 'flow');
  const reused = p.items.filter((i) => i.kind === 'existing');
  const superFlow = p.items.find((i) => i.kind === 'superflow');
  const titleOf = (key: string) => p.items.find((m) => m.key === key)?.title ?? key;
  // The needed items that keep a Flow blocked, with their state.
  const blockers = (it: PlanItem) =>
    it.needs.map((k) => p.items.find((m) => m.key === k && (it.kind === 'superflow' ? m.kind === 'flow' || m.kind === 'existing' : m.kind === 'module'))).filter((m): m is PlanItem => !!m && BLOCKING.has(m.status)).map((m) => `${m.title} (${(ITEM_STATUS[m.status] ?? m.status).toLowerCase()})`);
  return (
    <Page
      title={p.title}
      eyebrow="WORKSPACE / PLANS"
      description={p.fromChat ? `From a chat · built by ${p.createdBy ?? 'unknown'}` : `${p.fileName} · ${p.pages} ${p.pages === 1 ? 'page' : 'pages'} · uploaded by ${p.createdBy ?? 'unknown'}`}
      actions={<>
        <DraftModelPicker type="plan" id={p.id} what="this plan" />
        {p.fromChat
          ? (p.chatId ? <Link className="button" to={`/?chat=${encodeURIComponent(p.chatId)}`}><Icon name="sparkles" size={16} />Back to the chat</Link> : null)
          : <a className="button" href={`/api/plans/${p.id}/pdf`}><Icon name="download" size={16} />Download PDF</a>}
        {['reading', 'needs_answers', 'drafting', 'waiting'].includes(p.status) ? (
          <button type="button" className="ghost" disabled={act.busy} onClick={() => {
            if (!confirm('Cancel this plan? Everything not yet drafted stops. Modules and Flows already drafted stay, and you can resume any item later.')) return;
            act.run(() => post<Plan>(`/plans/${p.id}/cancel`), 'Plan cancelled').then(update);
          }}>Cancel plan</button>
        ) : null}
        <button type="button" className="ghost danger" disabled={act.busy} onClick={() => {
          if (!confirm('Delete this plan and its PDF? Modules and Flows it drafted stay.')) return;
          act.run(async () => { await api(`/plans/${p.id}`, { method: 'DELETE' }); navigate('/plans'); }, 'Plan deleted');
        }}>Delete</button>
      </>}
    >
      <Card title={<><Icon name="sparkles" />Status</>} actions={<Status value={p.status} />}>
        <p>{PLAN_STATUS[p.status] ?? p.status}</p>
        <PlanProgress items={p.items} />
        {p.status === 'failed' || (p.status === 'cancelled' && p.items.length === 0) ? <>
          {p.error ? <p className="error" role="alert">{explain(p.error)}</p> : null}
          {p.errorDetail ? <details><summary>Details</summary><p className="pre-wrap">{p.errorDetail}</p></details> : null}
          <AiRaw raw={p.aiRaw} />
          <button type="button" className="primary" disabled={act.busy} onClick={() => act.run(() => post<Plan>(`/plans/${p.id}/retry`), 'Reading the plan again').then(update)}>
            <Icon name="refresh" size={16} />Try again
          </button>
        </> : null}
        {p.summary ? <><div className="eyebrow">WHAT THE AI UNDERSTOOD</div><p>{p.summary}</p></> : null}
        {p.answers && Object.keys(p.answers).length ? <><div className="eyebrow">YOUR ANSWERS</div><ul>{Object.entries(p.answers).map(([q, a]) => <li key={q}>{q} <strong>{a}</strong></li>)}</ul></> : null}
        <ErrorText>{act.error}</ErrorText>
      </Card>

      {p.status === 'needs_answers' ? (
        <Card title={<><Icon name="sparkles" />Questions before building</>}>
          {p.mine ? (
            <form className="form-grid" onSubmit={(e) => {
              e.preventDefault();
              act.run(() => post<Plan>(`/plans/${p.id}/answers`, { answers: answered }), 'Answers sent. The AI is finishing the plan.').then(update);
            }}>
              {p.questions.map((q) => (
                <div className="field" key={q.id}>
                  <label htmlFor={`pq-${q.id}`}>{q.question}</label>
                  {q.options.length ? (
                    <div className="suggestions" role="group" aria-label={q.question}>
                      {q.options.map((o) => <button type="button" key={o} aria-pressed={answers[q.id] === o} className={answers[q.id] === o ? 'selected' : undefined} onClick={() => setAnswers({ ...answers, [q.id]: o })}>{o}</button>)}
                    </div>
                  ) : null}
                  <input id={`pq-${q.id}`} placeholder={q.options.length ? 'Or write your own answer' : 'Your answer'} value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                </div>
              ))}
              <div className="row">
                <button type="submit" className="primary" disabled={act.busy}>{act.busy ? 'Sending…' : Object.keys(answered).length ? 'Build with these answers' : 'Let the AI decide'}</button>
              </div>
              <p className="muted">Never put passwords or tokens here: each person stores their own credentials in their vault.</p>
            </form>
          ) : <Empty>Waiting for {p.createdBy} to answer.</Empty>}
        </Card>
      ) : null}

      {p.items.length ? (
        <div className="grid">
          <Card title={<><Icon name="layers" />Modules</>} actions={<span className="badge tone-info">{modules.length}</span>}>
            {modules.length ? <ul className="plan-items">{modules.map((m) => <PlanItemRow key={m.id} item={m} planId={p.id} onUpdate={update} />)}</ul>
              : <Empty>The approved modules already cover this plan.</Empty>}
          </Card>
          <Card title={<><Icon name="flow" />Flows</>} actions={<span className="badge tone-info">{flows.length}</span>}>
            {flows.length ? <ul className="plan-items">{flows.map((f) => <PlanItemRow key={f.id} item={f} planId={p.id} onUpdate={update} needs={f.needs.map(titleOf)} waitingOn={blockers(f)} />)}</ul>
              : <Empty>{reused.length ? 'Approved Flows already cover this plan.' : 'No Flows in this plan.'}</Empty>}
          </Card>
        </div>
      ) : null}
      {reused.length ? (
        <Card title={<><Icon name="check" />Reusing existing Flows</>} actions={<span className="badge tone-ok">{reused.length}</span>}>
          <p className="muted">These approved Flows already do part of the plan, so nothing new is built for them.</p>
          <ul className="plan-items">{reused.map((f) => <PlanItemRow key={f.id} item={f} planId={p.id} onUpdate={update} />)}</ul>
        </Card>
      ) : null}
      {superFlow ? (
        <Card title={<><Icon name="flow" />Suggested Super Flow</>} actions={<span className="badge super">Super Flow</span>}>
          <p className="muted">The plan's Flows belong together, so they are connected into one Super Flow. It is drafted once every Flow it runs is approved, and then needs its own approval.</p>
          <ul className="plan-items"><PlanItemRow item={superFlow} planId={p.id} onUpdate={update} needs={superFlow.needs.map(titleOf)} waitingOn={blockers(superFlow)} /></ul>
        </Card>
      ) : null}
    </Page>
  );
}

/** Items past drafting count whole; one being drafted counts as far as it has come. */
const DRAFTED = new Set(['in_review', 'approved', 'needs_attention', 'drafted', 'rejected']);
/** Not built itself: its parts are. */
const NOT_BUILT = new Set(['existing', 'cancelled', 'split']);

/** The plan's drafting, as one bar: how much of what it builds is drafted. */
function PlanProgress({ items }: { items: PlanItem[] }) {
  const built = items.filter((i) => !NOT_BUILT.has(i.kind) && !NOT_BUILT.has(i.status));
  if (!built.length) return null;
  const done = built.filter((i) => DRAFTED.has(i.status)).length;
  const share = built.reduce((n, i) => n + (DRAFTED.has(i.status) ? 100 : i.status === 'drafting' ? (i.progress?.percent ?? 5) : 0), 0) / built.length;
  return <ProgressBar percent={share} label={`${done} of ${built.length} drafted · ${Math.round(share)}%`} />;
}

function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="progress-line">
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
        <div className="progress-fill" style={{ width: `${value}%` }} />
      </div>
      <span className="muted">{label}</span>
    </div>
  );
}

/** "Queued" with what it waits for. */
function queuedText(q: PlanItem['queue']): string | null {
  if (!q) return null;
  if (q.retryAt) {
    const mins = Math.max(1, Math.round((new Date(q.retryAt).getTime() - Date.now()) / 60_000));
    return `The AI service was busy; trying again in about ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`;
  }
  return q.ahead === 0 ? 'Starts in a moment.' : `${q.ahead} ${q.ahead === 1 ? 'draft goes' : 'drafts go'} first (drafts run a few at a time).`;
}

const ITEM_STATUS: Record<string, string> = {
  queued: 'Queued for drafting',
  drafting: 'The AI is drafting it…',
  in_review: 'Drafted and sent to an admin for review',
  approved: 'Approved',
  rejected: 'Rejected by an admin',
  needs_attention: 'Drafted, but needs fixing before review',
  waiting: 'Drafted once what it needs is approved',
  drafted: 'Drafted; waiting for an approver',
  blocked: 'Blocked',
  needs_answers: 'The AI needs a few answers before it drafts this',
  failed: 'Drafting failed',
  cancelled: 'Cancelled',
  split: 'One Flow could not do all of it: built as the Flows below, run together by a Super Flow',
};

function PlanItemRow({ item, planId, onUpdate, needs, waitingOn }: { item: PlanItem; planId: string; onUpdate: (p: Plan | undefined) => void; needs?: string[]; waitingOn?: string[] }) {
  const act = useAction();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  // The API documentation to build from, when the AI asked for it or the person has better docs.
  const [docs, setDocs] = useState('');
  const link = item.moduleVersionId ? `/modules/${item.moduleVersionId}` : item.flowId ? `/flows/${item.flowId}` : null;
  const status = item.kind === 'existing' ? 'Approved Flow, used as it is' : item.kind !== 'module' && item.status === 'approved' ? 'Approved' : (ITEM_STATUS[item.status] ?? item.status);
  const asking = item.status === 'needs_answers' && item.questions.length > 0;
  const canRetry = item.status === 'failed' || item.status === 'needs_answers' || item.status === 'cancelled';
  const cancel = () => act.run(() => post<Plan>(`/plans/${planId}/items/${item.id}/cancel`), 'Cancelled').then(onUpdate);
  const removeNotes = () => act.run(() => api<Plan>(`/plans/${planId}/items/${item.id}/notes`, { method: 'DELETE' }), 'Details removed').then(onUpdate);
  // Answers keyed by the question as asked, so they read on their own later.
  // The documentation the AI asked for is kept under its id, so the builder reads it as the API source.
  const given = Object.fromEntries(item.questions.filter((q) => answers[q.id]?.trim()).map((q) => [q.id === 'api_docs' ? 'api_docs' : q.question, answers[q.id]!.trim()]));
  const draftAgain = () =>
    act
      .run(() => {
        const all = { ...given, ...(docs.trim() ? { api_docs: docs.trim() } : {}) };
        return post<Plan>(`/plans/${planId}/items/${item.id}/retry`, { ...(Object.keys(all).length ? { answers: all } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      }, 'Drafting again')
      .then((p) => {
        if (p) {
          setAnswers({});
          setNotes('');
          setDocs('');
        }
        onUpdate(p);
      });
  return (
    <li className="plan-item" id={`item-${item.id}`}>
      <div className="row between">
        <strong>{link ? <Link to={link}>{item.title}</Link> : item.title}</strong>
        <div className="row">
          {item.kind !== 'existing' && CANCELLABLE.has(item.status) ? <button type="button" className="ghost" disabled={act.busy} onClick={cancel}>Cancel</button> : null}
          <Status value={item.status} />
        </div>
      </div>
      <p className="muted">{status}{item.moduleName ? <> · <code>{item.moduleName}</code></> : null}{basedOnText(item.basedOn) ? <> · {basedOnText(item.basedOn)}</> : null}</p>
      {item.status === 'drafting' && item.progress ? (
        <>
          <ProgressBar percent={item.progress.percent} label={`${item.progress.step[0]!.toUpperCase()}${item.progress.step.slice(1)} · ${item.progress.percent}%${item.progress.since ? ` · for ${elapsed(item.progress.since, Date.now())}` : ''}`} />
          <p className="muted small">› {activityText(item.progress, Date.now())}</p>
        </>
      ) : null}
      {item.status === 'queued' && queuedText(item.queue) ? <p className="muted">{queuedText(item.queue)}</p> : null}
      {needs?.length ? <p className="muted">Needs: {needs.join(', ')}</p> : null}
      {item.error ? <p className="error" role="alert">{explain(item.error, item.kind)}</p> : null}
      {item.status === 'blocked' && waitingOn?.length ? <p className="muted">Waiting on: {waitingOn.join(', ')}</p> : null}
      {item.detail ? <details><summary>Details</summary><p className="pre-wrap">{item.detail}</p></details> : null}
      <AiRaw raw={item.aiRaw} />
      <details><summary>{item.kind === 'existing' ? 'Why it fits' : 'What the AI asked for'}</summary><p className="pre-wrap">{item.request}</p>{item.notes ? <><div className="row between"><strong>Details you added</strong><span className="row"><button type="button" className="ghost small" disabled={act.busy} onClick={() => setNotes(item.notes ?? '')}>Edit</button><button type="button" className="ghost small" disabled={act.busy} onClick={() => void removeNotes()}>Remove</button></span></div><p className="pre-wrap">{item.notes}</p></> : null}</details>
      {canRetry ? (
        <div className="stack">
          {asking ? (
            <>
              <strong>The AI needs to know</strong>
              {item.questions.map((q) => (
                <label key={q.id} className="field">
                  <span>{q.question}</span>
                  {q.options.length ? (
                    <select value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}>
                      <option value="">Choose…</option>
                      {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                  )}
                </label>
              ))}
            </>
          ) : null}
          {item.kind === 'module' && !item.questions.some((q) => q.id === 'api_docs') ? (
            <label className="field">
              <span>API documentation to build from (optional): a link, or paste it</span>
              <textarea rows={2} maxLength={200000} value={docs} onChange={(e) => setDocs(e.target.value)} placeholder="https://developer.example.com/api/reference" />
            </label>
          ) : null}
          <label className="field">
            <span>{asking ? 'Anything else the AI should know (optional)' : 'Add details for the AI (optional)'}</span>
            <textarea rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={item.kind === 'module' ? 'E.g. the app to connect to, the exact actions, and the input/output fields. Describe a complete module, with no platform changes or placeholder actions.' : 'E.g. which module and action to use, which fields each step passes on, what runs at the same time.'} />
          </label>
          <div>
            <button type="button" className={asking ? 'primary' : 'ghost'} disabled={act.busy || (asking && item.questions.some((q) => !answers[q.id]?.trim()) && !notes.trim())} onClick={draftAgain}>
              <Icon name="refresh" size={14} />{asking ? 'Answer and draft' : item.status === 'cancelled' ? 'Resume' : 'Try again'}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** What a plan item builds on, in words: the next version of an approved module. */
export function basedOnText(basedOn: string | null | undefined): string | null {
  const ext = basedOn?.match(/^extends:(.+)$/);
  if (ext) return `adds to ${ext[1]} (its next version)`;
  const clone = basedOn?.match(/^clones:(.+)$/);
  if (clone) return `a new module made from a copy of ${clone[1]} (which stays as it is)`;
  if (basedOn?.startsWith('from:')) return 'a new Flow made from a copy of an approved Flow (which stays as it is)';
  return null;
}

/**
 * What the AI actually answered, when its answer could not be read. Without it an unreadable answer is a dead end:
 * this is the only way to see whether it was cut off, wrapped in prose, or simply the wrong shape.
 */
function AiRaw({ raw }: { raw?: string | null }) {
  if (!raw) return null;
  return (
    <details className="ai-raw">
      <summary>What the AI answered</summary>
      <p className="muted">The answer as it came back, so you can see where it broke. Long answers are shortened in the middle.</p>
      <CodeView code={raw} label="the AI's answer" />
    </details>
  );
}

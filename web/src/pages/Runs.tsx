import { useEffect, useRef, useState } from 'react';
import { OPEN_LIVE } from '../BuildPanel';
import { Linkified, ModuleLink } from '../ModuleLink';
import { SaveRunAsTest } from '../FlowTests';
import { RunUndoCard } from '../Undo';
import { api, post } from '../api';
import { LiveBrowser } from '../LiveBrowser';
import { Card, ChatBox, Empty, ErrorText, Loading, Page, Pre, Status, useAction, useLive, useLoad, When } from '../components';
import { useMe } from '../context';
import { Link, navigate } from '../router';
import { FlowGraph, Icon, Metric, SearchField } from '../ui';
import { stepsUsing, useRemoveStep } from '../remove-step';
import { OutputView } from '../OutputView';
import { FixEvidence, isFixOutput } from '../FixEvidence';
import { InputStepForm, type Field } from '../RunForm';
import { CostCapPanel } from '../Costs';
import { RunStopPanel } from '../AutoStops';

interface RunItem { id: string; flowName: string; version: number; status: string; waitReason: string | null; createdAt: string; finishedAt: string | null }
interface Step {
  id: string;
  type: string;
  title: string | null;
  module: string | null;
  action: string | null;
  status: string;
  attempts: number;
  errorType: string | null;
  executedBy: string | null;
  output?: unknown;
  /** A waiting input step, for the run's own member. */
  input?: { intro: string | null; fields: Field[] };
  /** A flow step's child runs (a Super Flow). */
  children?: { key: string; runId: string; status: string; flowName: string; version: number }[];
  /** A decided sign-off: who decided, and for whom when a stand-in did; by is null when an evidence gate released it. */
  decision?: { decision: string; at: string; by: string | null; for: string | null; outsideTeam: boolean; automatic?: { fixStep: string; confidence: number | null; level: string | null } | null };
  /** Waiting for a sign-off because text an AI wrote could steer it: exactly what it will do, and the hash a decision covers. */
  signOff?: { values: unknown; sha256: string };
  /** A failed fix or app step: what it printed before it failed (install, build, tests), secrets redacted. */
  log?: string;
  /** A refused step: what the check that refused it said, field by field. */
  detail?: string;
  /** A person got past this failed step (skipped it or typed in its result), or asked an approver to. */
  resolution?: { kind: 'skip' | 'result'; status: 'pending' | 'applied' | 'rejected'; requestedBy: string | null; decidedBy: string | null; at: string };
  /** A typed-in result waiting for an approver. */
  proposed?: unknown;
}
interface Run {
  id: string;
  flowId: string;
  flowName: string;
  version: number;
  runAs: string;
  status: string;
  waitReason: string | null;
  manualRetriesUsed: number;
  createdAt: string;
  finishedAt: string | null;
  /** When a finished run's inputs and outputs are deleted; null when none are kept. */
  dataExpiresAt: string | null;
  /** Only for the member who ran it. */
  inputs?: Record<string, unknown>;
  steps: Step[];
  /** Set when a Super Flow started this run. */
  parent: { runId: string; flowName: string } | null;
  dry?: boolean;
  /** The model it was started with; null: its Flow's. */
  aiModel?: string | null;
  breakglass?: boolean;
  /** What its AI steps spent so far. */
  aiSpend?: { tokens: number; amount: number; currency: string | null };
  /** Set while it waits at its AI cost cap. */
  costCap?: { stepId: string | null; scope: 'run' | 'step' | null; reason: string; spent: { tokens: number; amount: number; currency: string | null } | null; cap: { tokens?: number; amount?: number } | null } | null;
  /** Automatic stops of its Flow that paused it. */
  autoStops?: { triggerName: string; summary: string; thisRun: string | null; reason: string | null; resumedBy: string | null }[];
  /** How it ended or where it stands (src/engine/outcome.ts). */
  outcome?: Outcome;
  /** A paused run: what stopped it and how to get it going (src/engine/next-steps.ts). */
  nextSteps?: NextSteps | null;
  /** What the run did, line by line, the latest last (its member and approvers). */
  commentary?: CommentLine[];
}
interface CommentLine { id: number; stepId: string | null; at: string; text: string }

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** What the run is doing now, line by line ("Now on step …", "Calling GET … → 200"), the latest at the bottom. */
function Commentary({ lines, live }: { lines: CommentLine[]; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <Card title={live ? 'Live' : 'What the run did'} actions={live ? <span className="badge tone-info">running</span> : null}>
      <div ref={box} className="run-commentary" role="log" aria-live="polite" aria-label="Run commentary">
        {lines.map((l) => (
          <div key={l.id} className={`build-line ${/failed|→ [45]\d\d/.test(l.text) ? 'build-tone-bad' : / done$|finished$/.test(l.text) ? 'build-tone-ok' : ''}`}>
            <span className="build-at">{clock(l.at)}</span> <span className="build-prompt">›</span> <Linkified text={l.text} />
          </div>
        ))}
      </div>
    </Card>
  );
}
interface NextSteps {
  stepId: string;
  stepTitle: string;
  errorType: string;
  what: string;
  why: string;
  fixes: { kind: 'link' | 'retry' | 'restart' | 'skip' | 'result' | 'continue' | 'ai_fix'; label: string; href?: string; detail?: string; moduleVersionId?: string; feedback?: string }[];
  calls?: string[];
  /** What a failed fix or app step printed before it stopped. */
  log?: string;
  /** What the check that refused the step said, field by field. */
  detail?: string;
  result?: { example: unknown; fields: string[] };
}

/**
 * What a failed fix or app step printed: the install, build and test output as it came, secrets already removed.
 * Without it "installing the project failed" is all anybody ever sees, and nobody can tell npm from Docker.
 */
function StepLog({ text, open = false }: { text: string; open?: boolean }) {
  return (
    <details className="step-log" open={open}>
      <summary>What it printed</summary>
      <pre className="step-log-text">{text}</pre>
      <p className="muted">The last {Math.min(text.length, 4000).toLocaleString()} characters, secrets removed. It goes when the run's data does.</p>
    </details>
  );
}

/** What stopped a paused run, why, and each way to get it going: fix it where it is set, then retry; or get past the step. */
function NextStepsCard({ n, runId, busy, onRetry, onDone }: { n: NextSteps; runId: string; busy: boolean; onRetry: () => void; onDone: () => void }) {
  const act = useAction();
  const [typing, setTyping] = useState(false);
  // A draft in the shape later steps expect, to edit: nobody has to guess the fields.
  const draft = n.result ? JSON.stringify(n.result.example, null, 2) : '{}';
  const [text, setText] = useState(draft);
  const resolve = (body: unknown, message: string) => act.run(async () => (await post(`/runs/${runId}/steps/${n.stepId}/resolve`, body), onDone()), message);
  const given = (): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('The result is not valid JSON: check the quotes, commas and brackets (use straight "quotes").');
    }
  };
  return (
    <section className="next-steps" id="what-to-do" aria-label="What to do">
      <h3><Icon name="info" size={16} />Stopped at <a href={`#step-${n.stepId}`}>{n.stepTitle}</a></h3>
      <p><strong>{n.what}</strong></p>
      <p className="muted">{n.why}</p>
      {n.calls?.length ? (
        <div className="next-steps-calls">
          <span className="muted">What it called before it stopped:</span>
          <ul>{n.calls.map((c, i) => <li key={i}><code>{c}</code></li>)}</ul>
        </div>
      ) : null}
      {n.detail ? <p className="next-steps-detail"><Icon name="info" size={13} /> {n.detail}</p> : null}
      {n.log ? <StepLog text={n.log} open /> : null}
      {n.fixes.length ? (
        <ol className="next-steps-list">
          {n.fixes.map((f) => (
            <li key={f.label}>
              {f.kind === 'retry' ? (
                <button type="button" className="primary" disabled={busy} onClick={onRetry}>{f.label}</button>
              ) : f.kind === 'continue' ? (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || act.busy}
                  onClick={() =>
                    void act.run(async () => {
                      const r = await post<{ runId: string; moved: boolean }>(`/runs/${runId}/continue`);
                      if (r.moved) onDone();
                      else navigate(`/runs/${r.runId}`);
                    }, 'Going on with the newest version')
                  }
                >
                  {f.label}
                </button>
              ) : f.kind === 'ai_fix' ? (
                <>
                <button
                  type="button"
                  disabled={busy || act.busy}
                  onClick={() =>
                    void act.run(async () => {
                      const fixed = await post<{ id: string }>(`/modules/${f.moduleVersionId}/revise`, { feedback: f.feedback, forRun: runId });
                      navigate(`/modules/${fixed.id}`);
                    }, 'Fixed version drafted: review it')
                  }
                >
                  {act.busy ? 'The AI is fixing it… (a few minutes)' : f.label}
                </button>
                {act.busy ? (
                  <button type="button" className="link-button" onClick={() => window.dispatchEvent(new Event(OPEN_LIVE))}>
                    Watch it in Live →
                  </button>
                ) : null}
                </>
              ) : f.kind === 'skip' ? (
                <button type="button" disabled={busy || act.busy} onClick={() => void resolve({ kind: 'skip' }, f.label.startsWith('Ask') ? 'Asked an approver' : 'Step skipped')}>{f.label}</button>
              ) : f.kind === 'result' ? (
                <button type="button" disabled={busy || act.busy} aria-expanded={typing} onClick={() => setTyping((t) => !t)}>{f.label}</button>
              ) : (
                <Link to={f.href ?? '#'} className={`button ${f.kind === 'restart' ? 'primary' : ''}`}>{f.label}</Link>
              )}
              {f.detail ? <span className="muted"> {f.detail}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {typing ? (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => (await post(`/runs/${runId}/steps/${n.stepId}/resolve`, { kind: 'result', output: given() }), onDone()), 'Result given');
          }}
        >
          <label htmlFor="given-result">What the step would have returned: change this draft, then continue</label>
          {n.result?.fields.length ? <p className="muted small">Its fields: {n.result.fields.join(', ')}.</p> : null}
          <textarea id="given-result" rows={Math.min(16, Math.max(6, text.split('\n').length + 1))} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoCorrect="off" autoCapitalize="off" />
          <div className="row">
            <button className="primary" disabled={act.busy}>Continue with this result</button>
            {text !== draft ? <button type="button" className="ghost" onClick={() => setText(draft)}>Reset the draft</button> : null}
          </div>
        </form>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </section>
  );
}

/** A member asked to get past a failed step that changes data: an approver sees what and decides. */
function ResolutionRequest({ runId, step, canDecide, onDone }: { runId: string; step: Step; canDecide: boolean; onDone: () => void }) {
  const act = useAction();
  const r = step.resolution!;
  const decide = (decision: 'approved' | 'rejected') => act.run(async () => (await post(`/runs/${runId}/steps/${step.id}/resolution`, { decision }), onDone()), decision === 'approved' ? 'Approved: the run goes on' : 'Rejected: the run stays paused');
  return (
    <section className="next-steps" aria-label="Approval to get past a step">
      <h3><Icon name="info" size={16} />{r.requestedBy} asks to {r.kind === 'skip' ? 'skip' : 'continue with a result they typed in for'} “{step.title ?? step.id}”</h3>
      <p className="muted">The step failed ({(step.errorType ?? '').replace(/_/g, ' ')}) and it changes data, so an approver agrees first.</p>
      {r.kind === 'result' && step.proposed !== undefined ? <OutputView value={step.proposed} path="proposed" /> : null}
      {canDecide ? (
        <div className="row">
          <button className="primary" disabled={act.busy} onClick={() => void decide('approved')}>Approve</button>
          <button className="danger" disabled={act.busy} onClick={() => void decide('rejected')}>Reject</button>
        </div>
      ) : <p className="muted">Waiting for an approver.</p>}
      <ErrorText>{act.error}</ErrorText>
    </section>
  );
}
interface Outcome {
  state: 'running' | 'waiting' | 'succeeded' | 'stopped' | 'paused' | 'cancelled';
  tone: 'ok' | 'info' | 'warn' | 'bad';
  headline: string;
  reason: string | null;
  step: { id: string; title: string; status: string; errorType: string | null } | null;
  link: { url: string; stepId: string } | null;
  /** Where to go to get it going again, inside the portal. */
  action: { label: string; href: string } | null;
  ran: number;
  skipped: string[];
  notRun: string[];
}

/** The run's result at a glance: what it ended with, why, the step to look at, and what it did not do. */
function OutcomePanel({ outcome: o }: { outcome: Outcome }) {
  const tone = { ok: 'tone-ok', info: 'tone-info', warn: 'tone-warn', bad: 'tone-danger' }[o.tone];
  return (
    <Card title={<><Icon name="check" />Result</>}>
      <p className={`outcome-headline ${tone}`} role="status"><strong>{o.headline}</strong></p>
      {o.reason ? <p>{o.reason}</p> : null}
      {o.action ? (
        <p>{o.action.href.startsWith('#') ? <a href={o.action.href}>{o.action.label}</a> : <Link to={o.action.href}>{o.action.label}</Link>}</p>
      ) : null}
      {o.step ? (
        <p className="muted">
          Step to look at: <a href={`#step-${o.step.id}`}>{o.step.title}</a>
          {o.step.errorType ? <> · <code>{o.step.errorType}</code></> : null}
        </p>
      ) : null}
      {o.link ? (
        <p>
          <a href={o.link.url} target="_blank" rel="noreferrer noopener">{o.link.url}</a> <span className="muted">(from {o.link.stepId})</span>
        </p>
      ) : null}
      <p className="muted">{o.ran} step{o.ran === 1 ? '' : 's'} ran.</p>
      {o.skipped.length ? (
        <details>
          <summary>Skipped by their conditions: {o.skipped.length}</summary>
          <ul className="list">{o.skipped.map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      ) : null}
      {o.notRun.length ? (
        <details>
          <summary>Not reached: {o.notRun.length}</summary>
          <ul className="list">{o.notRun.map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      ) : null}
    </Card>
  );
}
interface RunView { hideModules: string[]; hideStatuses: string[]; showOutputs: boolean; compact: boolean }
interface Person { id: string; handle: string; displayName: string | null }

export function Runs() {
  const runs = useLive(() => api<RunItem[]>('/runs?limit=100'), 15000);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const rows = runs.data ?? [];
  const attention = rows.filter(r => ['paused', 'waiting'].includes(r.status));
  const filtered = rows.filter(r => (filter === 'all' || (filter === 'attention' ? ['paused', 'waiting'].includes(r.status) : r.status === filter)) && `${r.flowName} ${r.id}`.toLowerCase().includes(q.toLowerCase()));
  const durations = rows.filter(r => r.finishedAt).map(r => new Date(r.finishedAt!).getTime() - new Date(r.createdAt).getTime());
  const mean = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const exportRuns = () => {
    const cell = (v: string) => '"' + v.replace(/"/g, '""').replace(/^[=+@-]/, "'$&") + '"';
    const csv = [['Run ID', 'Flow', 'Version', 'Status', 'Started', 'Finished'], ...filtered.map(r => [r.id, r.flowName, String(r.version), r.status, r.createdAt, r.finishedAt ?? ''])].map(row => row.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'dittoly-runs.csv'; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <Page title="Runs" eyebrow="CONTROL PLANE / EXECUTION PORTAL" description="Track your versioned executions, inspect step outcomes, and resolve approval gates as runs progress." className="runs-page" actions={<><button onClick={exportRuns} disabled={!filtered.length}><Icon name="download" size={16}/>Export CSV</button><Link to="/flows" className="button primary"><Icon name="bolt" size={16}/>Execute Flow</Link></>}>
      <div className="metrics"><Metric label="Recent runs" value={runs.data ? rows.length : '—'} detail="Latest 100 executions" icon="bolt"/><Metric label="Awaiting action" value={runs.data ? attention.length : '—'} detail="Paused or waiting for approval" icon="lock" tone={attention.length ? 'warning' : ''}/><Metric label="Mean run duration" value={mean === null ? '—' : `${(mean / 1000).toFixed(1)}s`} detail="Completed runs in this list" icon="clock"/><Metric label="Succeeded" value={runs.data ? rows.filter(r => r.status === 'succeeded').length : '—'} detail="Successfully completed executions" icon="check"/></div>
      {attention[0] ? <div className="request-card"><div className="request-meta"><span>EXECUTION NEEDS ATTENTION</span><Status value={attention[0].status}/></div><h3>{attention[0].flowName} · v{attention[0].version}</h3><p className="muted">{attention[0].waitReason?.replace(/_/g, ' ') ?? 'Inspect this run to see what is needed.'}</p><Link className="button primary" to={`/runs/${attention[0].id}`}><Icon name="shield" size={16}/>Inspect & Resolve</Link></div> : null}
      <div className="toolbar"><div className="tabs">{[['all', 'All runs'], ['attention', 'Needs attention'], ['succeeded', 'Succeeded'], ['running', 'Running'], ['failed', 'Failed']].map(([v, label]) => <button key={v} className={filter === v ? 'selected' : ''} aria-pressed={filter === v} onClick={() => setFilter(v!)}>{label}</button>)}</div><button className="ghost icon-button" aria-label="Refresh runs" onClick={runs.reload}><Icon name="refresh" size={17}/></button><SearchField value={q} onChange={setQ} placeholder="Filter by Flow name or run ID…"/></div>
      <Card>
        {runs.error ? <ErrorText>{runs.error}</ErrorText> : null}
        {!runs.data ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <Empty>{rows.length ? "No runs match your filters." : "No runs yet. Start one from an approved Flow."}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Flow</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/runs/${r.id}`}>
                        {r.flowName} v{r.version}
                      </Link>
                    </td>
                    <td>
                      <Status value={r.status} /> {r.waitReason ? <span className="muted">{r.waitReason.replace(/_/g, ' ')}</span> : null}
                    </td>
                    <td>
                      <When at={r.createdAt} />
                    </td>
                    <td>
                      <When at={r.finishedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-foot"><span>Showing {filtered.length} of {rows.length} executions</span><span className="row"><span className="status-dot"/>Updates every 15 seconds</span></div>
      </Card>
    </Page>
  );
}

const ERRORS: Record<string, string> = {
  team_credential_missing: "This step uses your team's shared account, which a team admin has not stored yet (Teams page).",
  missing_credential: 'You have no credential for this app. Ask a teammate to run this step, or add yours under My credentials.',
  ai_key_missing: 'This AI step uses your own AI key, none is stored, and no organization AI is set up to fall back to. Add a personal credential named "anthropic" or "openai" under My credentials (the name must match), or ask an admin to set up the organization\'s AI.',
  ai_key_missing_openai: 'This AI step uses your own OpenAI key, and none is stored. Add a personal credential named "openai" under My credentials (the name must match), or ask an admin to set up the organization\'s AI to fall back to.',
  ai_key_missing_anthropic: 'This AI step uses your own Anthropic key, and none is stored. Add a personal credential named "anthropic" under My credentials (the name must match), or ask an admin to set up the organization\'s AI to fall back to.',
  auto_stopped: 'Its Flow was stopped automatically. It waits here until an approver of its team or an admin resumes the Flow, and says whether this run goes on.',
  install_failed: 'Installing the project failed. What it printed is under “What it printed” on the step.',
  build_failed: 'Building the project failed. What it printed is under “What it printed” on the step.',
  pinned_version_retired: "Started from an App pinned to a Flow version a newer one replaced: it still reads, but its steps that change data no longer run. The App's author can move its pin to the current version.",
  egress_not_allowed: "This step declares an outside service its team's allowed destinations no longer include. An admin can allow it again (Admin or Teams page), or the Flow can drop it.",
  clone_failed: 'The repository could not be cloned at that branch.',
  clone_branch_not_found: "The branch to clone does not exist. Check the fix or app step's \"ref\" (main or master?).",
  clone_repo_not_found: "The repository does not exist, or your token cannot see it. Check the step's repository URL, and that your token can read that repository (for a private one on GitHub: the repo scope, or the repository chosen for a fine-grained token).",
  clone_repo_not_found_no_token: 'The repository is private or does not exist, and the step clones it without a token. Check its URL, or give the step a credential.',
  clone_access_denied: 'The git host refused your token: it may have expired or lack read access to this repository. Replace it under My credentials.',
  clone_unreachable: 'The git host could not be reached from this server. Check the repository URL and the network.',
  uncertain_outcome: 'This step may or may not have changed data before it failed. Check the app before retrying.',
  delegation_rejected: 'Your teammate declined. You can ask someone else.',
  delegation_expired: 'Your teammate did not answer in time. You can ask someone else.',
  delegation_cancelled: 'You withdrew the request.',
  approval_rejected: 'An approver rejected this step.',
  awaiting_sign_off:
    "Waiting for a sign-off: text an AI wrote earlier in this run decides what this step does, and that text could carry someone's instructions (from a ticket, page or email it read). Check the earlier results, then approve or reject.",
  sign_off_rejected: 'An approver rejected this step after checking what the AI wrote, so it did not run.',
  mcp_tool_changed: 'The remote tool changed since it was approved. An admin must approve the new version.',
};

interface LiveSummary {
  id: string;
  kind: 'step' | 'page';
  stepId: string | null;
  help: string | null;
}

/** Browser steps of this run, live, while they run (only the run's member sees them). */
function LivePanel({ runId }: { runId: string }) {
  const sessions = useLive(() => api<LiveSummary[]>(`/live?run=${runId}`), 1500, [runId]);
  if (!sessions.data?.length) return null;
  return (
    <>
      {sessions.data.map((s) => (
        <Card key={s.id} title={`Live browser · ${s.stepId}`} actions={s.help ? <span className="badge tone-warn">waiting for you</span> : <span className="badge tone-info">running</span>}>
          <LiveBrowser id={s.id} kind="step" />
        </Card>
      ))}
    </>
  );
}

const STEP_KIND: Record<string, string> = { ai: 'AI', browse: 'AI-guided browser check', report: 'report', input: 'asks you', approval: 'approval', delay: 'wait', fix: 'fix and verify', app: 'build and run' };

export function RunPage({ id }: { id: string }) {
  const { me, mode } = useMe();
  // Live while the run is in progress: statuses update without a refresh.
  const run = useLive(() => api<Run>(`/runs/${id}`), 2000, [id], (r) => !r || ['running', 'waiting'].includes(r.status));
  const view = useLoad(() => api<RunView>('/views/run'));
  const people = useLoad(() => api<Person[]>('/directory'));
  // Removing a step from the Flow, from its graph here: a new version to approve, then the run can go on with it.
  const removeStep = useRemoveStep(run.data?.flowId ?? '', () => run.reload());
  const act = useAction();
  const [delegateTo, setDelegateTo] = useState('');
  // A request to the layout box that is about the Flow, not the screen: where to do it instead.
  const [viewNote, setViewNote] = useState<string | null>(null);

  if (run.error) return <ErrorText>{run.error}</ErrorText>;
  if (!run.data || !view.data) return <Loading />;
  const r = run.data;
  const v = view.data;
  const mine = r.runAs === me.id;
  const name = (pid: string | null) => people.data?.find((p) => p.id === pid)?.handle ?? pid ?? '';
  const canGate = (me.role === 'admin' || me.role === 'approver') && (mode === 'local' || !mine);
  const visible = r.steps.filter((s) => !(s.module && v.hideModules.includes(s.module)) && !v.hideStatuses.includes(s.status));
  const hidden = r.steps.length - visible.length;
  const refresh = () => run.reload();

  return (
    <Page
      eyebrow={r.steps.some((s) => s.type === 'flow') ? 'EXECUTION PORTAL / SUPER FLOW RUN' : 'EXECUTION PORTAL / RUN DETAIL'}
      title={`${r.flowName} v${r.version}`}
      description={r.parent ? `Started by the Super Flow “${r.parent.flowName}”.` : undefined}
      actions={
        <>
          {r.parent ? <Link to={`/runs/${r.parent.runId}`} className="button"><Icon name="arrow" size={15} />Super Flow run</Link> : null}
          {r.dry ? <span className="badge tone-info" title="Reads ran for real; sign-offs and changes were skipped">Dry run</span> : null}
          {r.breakglass ? <span className="badge tone-warn">Break-glass</span> : null}
          <Status value={r.status} />
          <button onClick={refresh}>Refresh</button>
        </>
      }
    >
      <div className="run-layout">
      <div className="run-main">
      <Card>
        <div className="row">
          <span>
            Run as <strong>{name(r.runAs)}</strong>
          </span>
          <span className="muted">
            started <When at={r.createdAt} />
          </span>
          {r.waitReason ? <span className="muted">· {r.waitReason.replace(/_/g, ' ')}</span> : null}
          <Link to={`/flows/${r.flowId}`}>Open Flow</Link>
          <a href={`/api/runs/${id}/evidence?format=html`} download title="The run's record for an audit: approvals, module hashes, AI used, every step and sign-off, and its audit chain">Evidence pack (HTML)</a>
          <a href={`/api/runs/${id}/evidence?format=download`} download>(JSON)</a>
        </div>
        {r.status === 'paused' && r.nextSteps ? (
          <NextStepsCard n={r.nextSteps} runId={id} busy={act.busy} onDone={refresh} onRetry={() => act.run(async () => (await post(`/runs/${id}/retry`), refresh()), 'Retrying the run')} />
        ) : r.status === 'paused' && mine ? (
          <div className="row">
            <button className="primary" disabled={act.busy} onClick={() => act.run(async () => (await post(`/runs/${id}/retry`), refresh()), 'Retrying the run')}>
              Retry
            </button>
            <span className="muted">Manual retries used: {r.manualRetriesUsed}</span>
          </div>
        ) : null}
        {r.status === 'waiting' && r.waitReason === 'step_resolution'
          ? r.steps.filter((s) => s.resolution?.status === 'pending').map((s) => <ResolutionRequest key={s.id} runId={id} step={s} canDecide={canGate} onDone={refresh} />)
          : null}
        {(r.status === 'succeeded' || r.status === 'failed') && mine && !r.dry ? <div><SaveRunAsTest runId={id} flowName={r.flowName ?? 'Flow'} /></div> : null}
        {r.autoStops?.length ? <RunStopPanel stops={r.autoStops} /> : null}
        {r.costCap ? <CostCapPanel runId={id} cap={r.costCap} canDecide={mine || me.role === 'admin' || me.role === 'approver'} onDone={refresh} /> : null}
        {r.aiModel ? <p className="muted">Started with the AI model <code>{r.aiModel}</code>.</p> : null}
        {r.aiSpend?.tokens ? <p className="muted">AI used so far: {r.aiSpend.tokens.toLocaleString()} tokens{r.aiSpend.currency ? ` (about ${r.aiSpend.amount} ${r.aiSpend.currency})` : ''}.</p> : null}
        {['running', 'waiting', 'paused'].includes(r.status) && (mine || me.role === 'admin' || (r.costCap && me.role === 'approver')) ? (
          <div>
            <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await post(`/runs/${id}/cancel`), refresh()), 'Run cancelled')}>
              Cancel run
            </button>
          </div>
        ) : null}
        <ErrorText>{act.error}</ErrorText>
      </Card>
      {['succeeded', 'failed', 'cancelled'].includes(r.status) && !r.dry ? (
        <RunUndoCard runId={id} mine={mine} stepTitle={(sid) => r.steps.find((s) => s.id === sid)?.title ?? sid} />
      ) : null}

      <FlowGraph steps={visible} remove={mine && r.status !== 'running' ? { onRemove: removeStep.remove, busyId: removeStep.busyId, busy: removeStep.busy, usedBy: (sid) => stepsUsing(visible as never, sid) } : undefined}/>
      <ErrorText>{removeStep.error}</ErrorText>
      {r.inputs && Object.keys(r.inputs).length ? (
        <Card title="Inputs">
          <OutputView value={r.inputs} path="inputs" />
        </Card>
      ) : null}
      {mine && ['running', 'waiting'].includes(r.status) ? <LivePanel runId={id} /> : null}
      {r.commentary?.length ? <Commentary lines={r.commentary} live={['running', 'waiting'].includes(r.status)} /> : null}
      <Card title="Execution Steps" actions={hidden ? <span className="muted">{hidden} hidden by your view</span> : null}>
        <ol className={`steps ${v.compact ? 'compact' : ''}`}>
          {visible.map((s) => (
            <li key={s.id} id={`step-${s.id}`}>
              <div className="step-head">
                <Status value={s.status} />
                <strong>{s.title ?? s.id}</strong>
                {s.module ? (
                  <span className="muted">
                    <ModuleLink refText={s.module} /> · {s.action}
                  </span>
                ) : (
                  <span className="muted">{STEP_KIND[s.type] ?? s.type}</span>
                )}
                {s.attempts > 1 ? <span className="muted">· {s.attempts} attempts</span> : null}
                {s.executedBy && s.executedBy !== r.runAs ? <span className="muted">· run by {name(s.executedBy)} (delegated)</span> : null}
              </div>
              {s.status === 'running' && r.commentary?.some((l) => l.stepId === s.id) ? (
                <ul className="step-now" aria-label={`What step ${s.title ?? s.id} is doing now`}>
                  {(r.commentary ?? []).filter((l) => l.stepId === s.id).slice(-4).map((l) => <li key={l.id}>› <Linkified text={l.text} /></li>)}
                </ul>
              ) : null}
              {s.resolution && s.resolution.status === 'applied' ? (
                <p className="muted">
                  {s.resolution.kind === 'skip' ? 'Skipped' : 'Result typed in'} by {s.resolution.requestedBy} after it failed
                  {s.resolution.decidedBy && s.resolution.decidedBy !== s.resolution.requestedBy ? `, approved by ${s.resolution.decidedBy}` : ''}. <When at={s.resolution.at} />
                </p>
              ) : null}
              {s.decision?.automatic ? (
                <p className="muted">
                  Released automatically by its evidence gate: Dittoly verified the fix of step <strong>{s.decision.automatic.fixStep}</strong>
                  {s.decision.automatic.confidence !== null ? ` (confidence ${s.decision.automatic.confidence}, ${s.decision.automatic.level})` : ''}, no person decided. <When at={s.decision.at} />
                </p>
              ) : s.decision ? (
                <p className="muted">
                  {s.decision.decision === 'approved' ? 'Approved' : 'Rejected'} by <strong>{s.decision.by}</strong>
                  {s.decision.for ? <> for <strong>{s.decision.for}</strong> (standing in)</> : null}
                  {s.decision.outsideTeam ? ' (org admin outside the team)' : ''} <When at={s.decision.at} />
                </p>
              ) : null}
              {s.errorType ? (
                <p className="error">
                  {ERRORS[s.errorType] ?? s.errorType.replace(/_/g, ' ')}
                  {s.detail ? <><br /><span className="error-detail">{s.detail}</span></> : null}
                </p>
              ) : null}
              {s.input ? <InputStepForm runId={id} stepId={s.id} view={s.input} onDone={refresh} /> : null}
              {s.signOff && s.status === 'waiting' ? (
                <div>
                  <p className="muted">Text an AI wrote could steer this step. Approving lets it run with exactly these values; if they change, it asks again.</p>
                  <pre className="pre">{JSON.stringify(s.signOff.values, null, 2)}</pre>
                </div>
              ) : null}
              {(s.type === 'approval' || s.errorType === 'awaiting_sign_off') && s.status === 'waiting' && canGate ? (
                <div className="row">
                  <button className="primary" onClick={() => act.run(async () => (await post(`/runs/${id}/steps/${s.id}/gate`, { decision: 'approved', ...(s.signOff ? { valuesSha256: s.signOff.sha256 } : {}) }), refresh()), 'Approved, the run continues')}>
                    Approve
                  </button>
                  <button className="danger" onClick={() => act.run(async () => (await post(`/runs/${id}/steps/${s.id}/gate`, { decision: 'rejected', ...(s.signOff ? { valuesSha256: s.signOff.sha256 } : {}) }), refresh()), 'Rejected, the run stops')}>
                    Reject
                  </button>
                </div>
              ) : null}
              {/* Only with teammates to ask: alone (a local install), the choice would be empty. */}
              {s.status === 'failed' && s.type === 'action' && mine && r.status === 'paused' && people.data?.some((p) => p.id !== me.id) ? (
                <div className="row">
                  <label htmlFor={`d-${s.id}`}>Ask a teammate to run this step:</label>
                  <select id={`d-${s.id}`} value={delegateTo} onChange={(e) => setDelegateTo(e.target.value)} style={{ maxWidth: 220 }}>
                    <option value="">Choose…</option>
                    {people.data
                      ?.filter((p) => p.id !== me.id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName ?? p.handle}
                        </option>
                      ))}
                  </select>
                  <button disabled={!delegateTo || act.busy} onClick={() => act.run(async () => (await post(`/runs/${id}/steps/${s.id}/delegate`, { delegateId: delegateTo }), refresh()), 'Teammate asked to run this step')}>
                    Send request
                  </button>
                </div>
              ) : null}
              {s.children?.length ? (
                <ul className="list child-runs">
                  {s.children.map((c) => (
                    <li key={c.key}>
                      <Icon name="flow" size={15} />
                      <Link to={`/runs/${c.runId}`}>{c.flowName} v{c.version}</Link>
                      <Status value={c.status} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {s.log ? <StepLog text={s.log} /> : null}
              {s.type === 'fix' && isFixOutput(s.output) ? <FixEvidence output={s.output} /> : null}
              {v.showOutputs && s.output !== undefined ? (
                <details open={s.type === 'action' && s.status === 'succeeded'}>
                  <summary>Output</summary>
                  <OutputView value={s.output} path={`steps.${s.id}.output`} />
                </details>
              ) : null}
            </li>
          ))}
        </ol>
        {r.finishedAt ? (
          <p className="muted">
            {r.dataExpiresAt ? (
              <>
                Inputs and outputs are kept, encrypted, until <When at={r.dataExpiresAt} /> and only you (and a teammate, for a step they ran) can see them; then they are deleted. Statuses stay.
              </>
            ) : (
              'This run’s inputs and outputs have been deleted; statuses stay.'
            )}
          </p>
        ) : null}
      </Card>

      <Card title="Change how runs look">
        <p className="muted">For example “hide merge requests”, “hide skipped steps” or “compact”. This only changes what you see.</p>
        <ChatBox
          placeholder="How should run pages look?"
          button="Apply"
          busy={act.busy}
          onSubmit={(text) =>
            act.run(async () => {
              const out = await post<{ config: RunView; reply: string; notLayout?: boolean }>('/views/run/chat', { request: text });
              view.setData(out.config);
              setViewNote(out.notLayout ? out.reply : null);
            })
          }
        />
        {viewNote ? (
          <p className="notice" role="status">
            {viewNote} <Link to="/">Open the home chat</Link> · <Link to={`/flows/${r.flowId}`}>Open this Flow</Link>
            {r.status === 'paused' ? <> · <a href="#what-to-do">See “What to do” above</a></> : null}
          </p>
        ) : null}
        <div className="row">
          {v.hideModules.length || v.hideStatuses.length || v.compact || !v.showOutputs ? (
            <button onClick={() => act.run(async () => view.setData(await api<RunView>('/views/run', { method: 'DELETE' })))}>Reset view</button>
          ) : null}
        </div>
      </Card>
      </div>
      {r.outcome ? <aside className="run-side" aria-label="Result"><OutcomePanel outcome={r.outcome} /></aside> : null}
      </div>
    </Page>
  );
}

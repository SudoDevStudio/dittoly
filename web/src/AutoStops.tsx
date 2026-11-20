import { useState } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, Loading, Page, useAction, useLoad, When } from './components';
import { useMe } from './context';
import { Link } from './router';
import { Icon, Notice } from './ui';

/**
 * Automatic stops: a Flow or AI agent stopped because a control kept failing (blocked calls, a
 * spend spike, a failure spike, rejected sign-offs). Approvers and admins see what tripped it and
 * resume it with a reason, deciding for each paused run whether it goes on or is cancelled.
 */

interface StopEvent { id: string; kind: string; detail: string | null; runId: string | null; amount: number; at: string }
export interface Stop {
  id: string;
  subjectType: 'flow' | 'agent';
  subjectId: string;
  name: string;
  owner: string | null;
  trigger: string;
  triggerName: string;
  evidence: { summary: string; events: StopEvent[]; module?: string };
  trippedAt: string;
  resumedAt: string | null;
  resumedBy: string | null;
  reason: string | null;
  runDecisions: Record<string, string> | null;
  pausedRuns: { id: string; runAs: string; createdAt: string; stepId: string | null }[];
  canResume: boolean;
}

const KIND: Record<string, string> = {
  violation: 'Call refused by the broker',
  scope_denied: 'Tool outside its scopes',
  ai_tokens: 'AI tokens',
  cost_cap: 'Run reached its cost cap',
  run_failed: 'Run failed',
  drift_error: 'Drift error',
  sign_off_rejected: 'Sign-off on AI-written text rejected',
};

function Evidence({ s }: { s: Stop }) {
  return (
    <details>
      <summary>The events that crossed the threshold ({s.evidence.events.length})</summary>
      <table>
        <thead><tr><th>When</th><th>What</th><th>Detail</th><th>Run</th></tr></thead>
        <tbody>
          {s.evidence.events.map((e) => (
            <tr key={e.id}>
              <td><When at={e.at} /></td>
              <td>{KIND[e.kind] ?? e.kind}</td>
              <td>{e.kind === 'ai_tokens' ? `${e.amount.toLocaleString()} tokens` : <code>{e.detail ?? '–'}</code>}</td>
              <td>{e.runId ? <Link to={`/runs/${e.runId}`}>Open run</Link> : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function StopCard({ s, onDone }: { s: Stop; onDone: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const [runs, setRuns] = useState<Record<string, 'continue' | 'cancel'>>({});
  const link = s.subjectType === 'flow' ? <Link to={`/flows/${s.subjectId}`}>{s.name}</Link> : <Link to="/agents">{s.name}</Link>;
  // A run that waits on this stop links straight to this card (src/engine/outcome.ts).
  return (
    <Card id={`stop-${s.id}`} title={<>{s.subjectType === 'flow' ? 'Flow' : 'AI agent'} {link}</>} actions={<span className="badge tone-warn">{s.triggerName}</span>}>
      <p>
        <strong>{s.evidence.summary}.</strong>
        <span className="muted"> Stopped <When at={s.trippedAt} />{s.owner ? ` · ${s.subjectType === 'flow' ? 'team' : 'acts for'} ${s.owner}` : ''}</span>
      </p>
      <p className="muted">
        {s.subjectType === 'flow'
          ? 'New runs are refused (by hand, schedules, webhooks, Flow URLs, watches, follow-ups, AI agents and Super Flows). Runs under way wait before their next step.'
          : 'Its tool calls are refused; it can still list its tools. Its token stays, and calls waiting for its person stay waiting.'}
      </p>
      <Evidence s={s} />
      {s.pausedRuns.length ? (
        <table>
          <thead><tr><th>Paused run</th><th>Run as</th><th>Started</th><th>Waits before</th><th>When resumed</th></tr></thead>
          <tbody>
            {s.pausedRuns.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/runs/${r.id}`}>{r.id.slice(0, 8)}</Link></td>
                <td>{r.runAs}</td>
                <td><When at={r.createdAt} /></td>
                <td><code>{r.stepId ?? '–'}</code></td>
                <td>
                  <select aria-label={`What happens to run ${r.id.slice(0, 8)}`} value={runs[r.id] ?? 'continue'} disabled={!s.canResume} onChange={(e) => setRuns({ ...runs, [r.id]: e.target.value as 'continue' | 'cancel' })}>
                    <option value="continue">Continue</option>
                    <option value="cancel">Cancel</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {s.canResume ? (
        <div className="row">
          <input aria-label="Why it is safe to resume" placeholder="Why it is safe to resume (10 characters or more)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="primary" disabled={act.busy || reason.trim().length < 10} onClick={() => act.run(async () => (await post(`/auto-stops/${s.id}/resume`, { reason: reason.trim(), runs }), onDone()), `${s.name} resumed`)}>
            <Icon name="check" size={15} />Resume
          </button>
        </div>
      ) : (
        <p className="muted">{s.subjectType === 'flow' ? 'An approver of its team or an admin can resume it.' : 'Its person or an admin can resume it.'}</p>
      )}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

export function AutoStopsPage() {
  const { me } = useMe();
  const stops = useLoad(() => api<Stop[]>('/auto-stops'));
  if (stops.error) return <ErrorText>{stops.error}</ErrorText>;
  if (!stops.data) return <Loading />;
  const open = stops.data.filter((s) => !s.resumedAt);
  const past = stops.data.filter((s) => s.resumedAt);
  return (
    <Page
      title="Automatic stops"
      eyebrow="GOVERNANCE / CONTROLS"
      description="A Flow or AI agent stops by itself when a control keeps failing: calls the broker refused, AI spend far above its usual hour, many failed runs, or sign-offs on AI-written text rejected again and again. It stays stopped until someone looks and resumes it with a reason."
      actions={me.role === 'admin' ? <Link to="/admin" className="button"><Icon name="shield" size={16} />Thresholds</Link> : undefined}
    >
      {open.length ? open.map((s) => <StopCard key={s.id} s={s} onDone={stops.reload} />) : <Empty>Nothing is stopped.</Empty>}
      {past.length ? (
        <Card title="Resumed in the last 30 days">
          <table>
            <thead><tr><th>Stopped</th><th>What</th><th>Trigger</th><th>Resumed</th><th>By</th><th>Reason</th><th>Runs</th></tr></thead>
            <tbody>
              {past.map((s) => {
                const d = Object.values(s.runDecisions ?? {});
                return (
                  <tr key={s.id}>
                    <td><When at={s.trippedAt} /></td>
                    <td>{s.subjectType === 'flow' ? 'Flow' : 'Agent'} {s.name}</td>
                    <td title={s.evidence.summary}>{s.triggerName}</td>
                    <td><When at={s.resumedAt} /></td>
                    <td>{s.resumedBy}</td>
                    <td>{s.reason}</td>
                    <td>{d.length ? `${d.filter((x) => x === 'continued').length} continued, ${d.filter((x) => x === 'cancelled').length} cancelled` : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ) : null}
    </Page>
  );
}

/** On the Flow page while it is stopped. */
export function FlowStopBanner({ flowId }: { flowId: string }) {
  const stop = useLoad(() => api<{ stop: Stop | null }>(`/flows/${flowId}/auto-stop`), [flowId]);
  const s = stop.data?.stop;
  if (!s) return null;
  return (
    <Notice icon="shield">
      <strong>Stopped automatically: {s.triggerName}.</strong> {s.evidence.summary}. New runs are refused and runs under way wait before their next step
      {s.pausedRuns.length ? ` (${s.pausedRuns.length} waiting)` : ''}. <Link to="/auto-stops">{s.canResume ? 'Review and resume' : 'See why'}</Link>
    </Notice>
  );
}

/** On the Agents page for each stopped agent. */
export function AgentStopBanner({ name, stop }: { name: string; stop: { triggerName: string; summary: string; trippedAt: string } }) {
  return (
    <Notice icon="shield">
      <strong>{name} was stopped automatically: {stop.triggerName}.</strong> {stop.summary}. Its tool calls are refused until its person or an admin resumes it; its token stays. <Link to="/auto-stops">Review and resume</Link>
    </Notice>
  );
}

/** On a run's page while it waits because its Flow was stopped. */
export function RunStopPanel({ stops }: { stops: { triggerName: string; summary: string; thisRun: string | null; reason: string | null; resumedBy: string | null }[] }) {
  const waiting = stops.find((s) => s.thisRun === 'waiting');
  const past = stops.filter((s) => s.thisRun !== 'waiting');
  return (
    <div className="assistant-note" role="note" aria-label="Automatic stop">
      {waiting ? (
        <p><Icon name="shield" size={14} /> <strong>Paused by an automatic stop: {waiting.triggerName}.</strong> {waiting.summary}. It waits before its next step until an approver of its team or an admin resumes the Flow and decides whether this run continues. <Link to="/auto-stops">Automatic stops</Link></p>
      ) : null}
      {past.map((s, i) => (
        <p key={i} className="muted">Paused by an automatic stop ({s.triggerName}); {s.resumedBy} resumed the Flow: “{s.reason}”. This run {s.thisRun}.</p>
      ))}
    </div>
  );
}

type Settings = {
  blockedCalls: { enabled: boolean; count: number; minutes: number };
  spendSpike: { enabled: boolean; multiplier: number; floorTokens: number; costCapHits: number };
  failureSpike: { enabled: boolean; count: number; minutes: number; percent: number; driftErrors: number };
  rejectedSignOffs: { enabled: boolean; count: number; minutes: number };
};

const FIELDS: { key: keyof Settings; title: string; help: string; numbers: [string, string][] }[] = [
  { key: 'blockedCalls', title: 'Blocked calls', help: 'Calls the broker refused (undeclared host, a credential on the wrong host, a write in a read action), or an agent calling tools outside its scopes.', numbers: [['count', 'Calls'], ['minutes', 'Within minutes']] },
  { key: 'spendSpike', title: 'Spend spike', help: 'AI tokens of a Flow or agent in one hour, against its usual hour over the last 7 days (never below the floor, never without a usual hour yet); or runs of one Flow reaching their cost cap.', numbers: [['multiplier', 'Times the usual hour'], ['floorTokens', 'At least tokens'], ['costCapHits', 'Cost caps reached in an hour']] },
  { key: 'failureSpike', title: 'Failure spike', help: 'Failed runs of a Flow that are also a large share of its runs then; or drift errors piling up for a module it uses.', numbers: [['count', 'Failed runs'], ['minutes', 'Within minutes'], ['percent', 'And at least % of its runs'], ['driftErrors', 'Or drift errors of a module']] },
  { key: 'rejectedSignOffs', title: 'Rejected sign-offs', help: 'Sign-offs on what the AI wrote, rejected again and again: a sign the AI is being steered.', numbers: [['count', 'Rejections'], ['minutes', 'Within minutes']] },
];

/** Admins: the thresholds, and turning a trigger off. */
export function AutoStopSettingsCard() {
  const current = useLoad(() => api<{ settings: Settings; defaults: Settings }>('/auto-stops/settings'));
  const act = useAction();
  const [draft, setDraft] = useState<Settings | null>(null);
  if (!current.data) return <Card title="Automatic stops"><Loading /></Card>;
  const s = draft ?? current.data.settings;
  const set = <K extends keyof Settings>(k: K, field: string, value: number | boolean) => setDraft({ ...s, [k]: { ...s[k], [field]: value } });
  const save = (value: Settings) => act.run(async () => (await api('/auto-stops/settings', { method: 'PUT', body: value }), setDraft(null), current.reload()), 'Automatic stop settings saved');
  return (
    <Card title="Automatic stops" actions={<Link to="/auto-stops">Stopped now</Link>}>
      <p className="muted">When a control keeps failing, the Flow or agent stops until an approver of its team, its person or an admin resumes it with a reason. These apply to the whole organization; a Flow may set its own counts in its definition (<code>autoStop</code>). Dry runs never count, and break-glass does not get past a stop.</p>
      {FIELDS.map((f) => (
        <fieldset key={f.key}>
          <legend>
            <label><input type="checkbox" checked={s[f.key].enabled} onChange={(e) => set(f.key, 'enabled', e.target.checked)} /> {f.title}</label>
          </legend>
          <p className="muted">{f.help}</p>
          <div className="row">
            {f.numbers.map(([field, label]) => (
              <label key={field}>
                {label}{' '}
                <input type="number" min={1} step={field === 'multiplier' ? 0.5 : 1} disabled={!s[f.key].enabled} value={(s[f.key] as Record<string, number | boolean>)[field] as number} onChange={(e) => set(f.key, field, Number(e.target.value))} />
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="row">
        <button className="primary" disabled={act.busy || !draft} onClick={() => save(s)}>Save automatic stop settings</button>
        <button disabled={act.busy} onClick={() => save(current.data!.defaults)}>Back to the defaults</button>
      </div>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

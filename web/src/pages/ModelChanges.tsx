import { useState } from 'react';
import { api, post } from '../api';
import { Card, Empty, ErrorText, Loading, Page, Status, useAction, useLoad, When } from '../components';
import { Link } from '../router';
import { Icon } from '../ui';

/**
 * Model changes, for approvers: when the organization moves to a new AI model, approved Flows
 * follow it at once (unless locked) and each with AI steps is checked with the new one. Here an
 * approver accepts it (one click when the check passed, with a reason otherwise) or locks the
 * Flow to its old model.
 */

interface StepSummary { stepId: string; type: 'ai' | 'browse' | 'fix'; status: string; samples: number; calls: number; failedCalls: number; errors: Record<string, number>; agreement: number | null; consistency: number | null }
interface Diff { path: string; similarity: number; expected?: unknown; got?: unknown }
interface Waiting {
  checkId: string;
  flowId: string;
  flowName: string;
  versionId: string;
  version: number;
  team: string | null;
  fromModel: string;
  toModel: string;
  status: string;
  summary: { steps: StepSummary[]; note?: string } | null;
  details: { stepId: string; samples: { source: 'test' | 'run'; name: string; agreement: number | null; consistency: number | null; errors: string[]; diffs: Diff[] }[] }[];
  tokens: { input: number; output: number };
  cost: { amount: number; currency: string } | null;
  finishedAt: string | null;
}
interface Unavailable { flowId: string; flowName: string; versionId: string; version: number; model: string | null; lastFailedAt: string; checking: boolean }
interface Changes { currentModel: string | null; waiting: Waiting[]; unavailable: Unavailable[] }

const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);

function CheckCard({ c, onDone }: { c: Waiting; onDone: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const finished = c.status !== 'queued' && c.status !== 'running';
  const decide = (decision: 'accept' | 'keep', withReason = false) =>
    act.run(async () => (await post(`/model-changes/${c.checkId}/decision`, { decision, ...(withReason && reason.trim() ? { reason: reason.trim() } : {}) }), onDone()), decision === 'accept' ? `${c.flowName} accepted on ${c.toModel}` : `${c.flowName} locked to ${c.fromModel}`);
  return (
    <Card title={<><Link to={`/flows/${c.flowId}`}>{c.flowName}</Link> v{c.version}</>} actions={<Status value={c.status} />}>
      <p>
        <code>{c.fromModel}</code> → <code>{c.toModel}</code>{c.team ? <span className="muted"> · {c.team}</span> : null}
        {c.finishedAt ? <span className="muted"> · checked <When at={c.finishedAt} /></span> : null}
      </p>
      {c.summary?.note ? <p className="muted">{c.summary.note}</p> : null}
      <p className="muted">
        Cost of the check: {(c.tokens.input + c.tokens.output).toLocaleString()} tokens{c.cost ? ` (about ${c.cost.amount} ${c.cost.currency})` : ''}, counted against the Flow's team.
      </p>
      {c.summary?.steps.length ? (
        <table>
          <thead><tr><th>Step</th><th>Result</th><th>Inputs</th><th>Same as recorded</th><th>Consistent across repeats</th><th>Errors</th></tr></thead>
          <tbody>
            {c.summary.steps.map((s) => (
              <tr key={s.stepId}>
                <td><code>{s.stepId}</code></td>
                <td>{s.status === 'not_checked' ? 'not checked (browse steps need live pages)' : s.status.replace(/_/g, ' ')}</td>
                <td>{s.samples}</td>
                <td>{pct(s.agreement)}</td>
                <td>{pct(s.consistency)}</td>
                <td>{Object.entries(s.errors).map(([k, n]) => `${k.replace(/_/g, ' ')} ×${n}`).join(', ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {c.details.some((d) => d.samples.some((s) => s.diffs.length)) ? (
        <details>
          <summary>Differences per step</summary>
          {c.details.map((d) => (
            <div key={d.stepId}>
              <h3><code>{d.stepId}</code></h3>
              <ul className="list">
                {d.samples.map((s, i) => (
                  <li key={i}>
                    <span>{s.source === 'test' ? `Test "${s.name}"` : `A ${s.name}`}: same {pct(s.agreement)}, consistent {pct(s.consistency)}</span>
                    {s.diffs.map((f) => (
                      <div key={f.path} className="muted">
                        <code>{f.path}</code> ({pct(f.similarity)}){f.expected !== undefined ? <>: recorded “{String(f.expected)}”, new “{String(f.got)}”</> : ' (values of runs are not shown)'}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      ) : null}
      {finished ? (
        <div className="row">
          {c.status === 'passed' ? (
            <button className="primary" disabled={act.busy} onClick={() => decide('accept')}><Icon name="shield" size={15} />Accept {c.toModel}</button>
          ) : (
            <>
              <input aria-label="Why accept anyway" placeholder="Why accept despite the differences (10 characters or more)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="primary" disabled={act.busy || reason.trim().length < 10} onClick={() => decide('accept', true)}>Accept anyway</button>
            </>
          )}
          <button disabled={act.busy} onClick={() => decide('keep')}>Lock to {c.fromModel}</button>
          {c.status === 'skipped_budget' || c.status === 'no_inputs' ? (
            <button disabled={act.busy} onClick={() => act.run(async () => (await post(`/flow-versions/${c.versionId}/model-check`), onDone()), 'Check started')}>Check again</button>
          ) : null}
        </div>
      ) : <p className="muted">The check is running in the background.</p>}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

export function ModelChangesPage() {
  const changes = useLoad(() => api<Changes>('/model-changes'));
  const act = useAction();
  if (changes.error) return <ErrorText>{changes.error}</ErrorText>;
  if (!changes.data) return <Loading />;
  const d = changes.data;
  return (
    <Page
      title="Model changes"
      eyebrow="GOVERNANCE / AI MODELS"
      description={`The organization's AI model is ${d.currentModel ?? 'not set'}. Approved Flows follow it at once (unless locked to a model); each is checked with the new model in the background. Accept the result, or lock a Flow to its old model.`}
    >
      {d.unavailable.length ? (
        <Card title="Pinned model no longer available">
          <ul className="list">
            {d.unavailable.map((u) => (
              <li key={u.versionId}>
                <Link to={`/flows/${u.flowId}`}>{u.flowName}</Link> v{u.version} <code>{u.model ?? '?'}</code>
                <span className="muted"> · AI step failed <When at={u.lastFailedAt} /></span>
                {u.checking ? <span className="muted"> · check below</span> : (
                  <button disabled={act.busy} onClick={() => act.run(async () => (await post(`/flow-versions/${u.versionId}/model-check`), changes.reload()), 'Check started')}>Check with {d.currentModel}</button>
                )}
              </li>
            ))}
          </ul>
          <ErrorText>{act.error}</ErrorText>
        </Card>
      ) : null}
      {d.waiting.length ? d.waiting.map((c) => <CheckCard key={c.checkId} c={c} onDone={changes.reload} />) : <Empty>No model check is waiting for a decision.</Empty>}
    </Page>
  );
}

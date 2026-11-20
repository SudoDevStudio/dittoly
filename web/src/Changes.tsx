import { api } from './api';
import { Card, Empty, ErrorText, Loading, Page, Status, useLoad, When } from './components';
import { useMe } from './context';
import { Link } from './router';
import { CodeDiff } from './ModuleSafety';
import { Icon } from './ui';

/**
 * Change records: each self-fix as one governed change, with its evidence (the drift, the AI
 * request), what changed, the tests, the Flow versions proposed and every decision. For admins
 * and approvers; linked from the module and Flow review pages.
 */

interface ChangeSummary {
  id: string;
  module: string;
  fromVersion: string;
  toVersion: string | null;
  status: string;
  widensAccess: boolean;
  widening: string[];
  approvalsNeeded: number;
  author: string;
  requestedBy: string | null;
  requestedHow: 'automatic' | 'by_hand';
  createdAt: string;
  moduleApprovalsGiven?: number;
}

interface TestCount { total: number; passed: number; failing: string[] }

interface Change extends ChangeSummary {
  drift: { detectedAt: string; summary: { calls: number; failures: number; errors: Record<string, number>; actions: string[] } };
  ai: { provider: string | null; model: string | null; inputTokens: number; outputTokens: number; cost: { amount: number; currency: string } | null };
  moduleVersion: { fromVersionId: string | null; versionId: string | null; status: string | null; approvals: { required: number; given: { handle: string; at: string }[] } };
  diff: { changes: string[]; code: { added: number; removed: number }; codeLines: { op: ' ' | '+' | '-'; text: string }[] };
  tests: { module: TestCount; recorded: TestCount; flows: { flowId: string; name: string; total: number; passed: number }[] };
  flows: { flowId: string; name: string; versionId?: string; status: string; reason?: string; versionStatus: string | null; version: number | null }[];
  decisions: { part: string; subjectId: string; decision: string; final: boolean; by: string | null; at: string }[];
}

const requester = (c: ChangeSummary) =>
  c.requestedHow === 'by_hand' ? `asked for by ${c.requestedBy ?? 'someone no longer here'}` : c.requestedBy ? `self-fixing turned on by ${c.requestedBy}` : 'self-fixing on by default';

export function WidensAccess({ widening }: { widening: string[] }) {
  return (
    <p role="alert" className="badge tone-bad" style={{ display: 'block', whiteSpace: 'normal' }}>
      <Icon name="shield" size={15} /> Widens access: {widening.join('; ')}. Needs several different admins, like a new module.
    </p>
  );
}

export function ChangesPage() {
  const list = useLoad(() => api<ChangeSummary[]>('/changes'));
  return (
    <Page title="Changes" eyebrow="GOVERNANCE / CHANGE RECORDS" description="Every fix Dittoly drafted for a module whose app changed, as one change: what started it, what the AI produced, the tests and who decided each part. Nothing is applied until people approve it, and whoever asked for a fix never approves it.">
      {list.error ? <ErrorText>{list.error}</ErrorText> : !list.data ? <Loading /> : !list.data.length ? <Empty>No changes yet.</Empty> : (
        <Card>
          <table aria-label="Changes">
            <thead><tr><th>Module</th><th>Status</th><th>Asked for</th><th>Drafted</th></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/changes/${c.id}`}>{c.module} {c.fromVersion} → {c.toVersion ?? '?'}</Link>
                    {c.widensAccess ? <> <span className="badge tone-bad">widens access</span></> : null}
                  </td>
                  <td><Status value={c.status} /></td>
                  <td className="muted">{requester(c)}</td>
                  <td><When at={c.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}

const tests = (t: TestCount, what: string) =>
  t.total ? `${t.passed} of ${t.total} ${what} passed${t.failing.length ? ` (failing: ${t.failing.join(', ')})` : ''}` : `no ${what}`;

export function ChangePage({ id }: { id: string }) {
  const r = useLoad(() => api<Change>(`/changes/${id}`), [id]);
  if (r.error) return <ErrorText>{r.error}</ErrorText>;
  if (!r.data) return <Loading />;
  const c = r.data;
  const errors = Object.entries(c.drift.summary.errors).map(([e, n]) => `${e} ×${n}`).join(', ');
  return (
    <Page title={`${c.module} ${c.fromVersion} → ${c.toVersion ?? '?'}`} eyebrow="GOVERNANCE / CHANGE RECORD" actions={<Status value={c.status} />}>
      {c.widensAccess ? <WidensAccess widening={c.widening} /> : null}
      <Card title="Who">
        <p>Drafted by <strong>{c.author}</strong>, {requester(c)}. {c.requestedBy ? `${c.requestedBy} cannot approve any part of it.` : ''}</p>
      </Card>
      <Card title="Why: the app seems to have changed">
        <p>In the day before <When at={c.drift.detectedAt} />, {c.drift.summary.failures} of {c.drift.summary.calls} calls failed ({errors}), in {c.drift.summary.actions.join(', ') || 'several actions'}.</p>
      </Card>
      <Card title="The AI request">
        <p>
          {c.ai.provider ?? 'unknown provider'}{c.ai.model ? ` / ${c.ai.model}` : ''}: {c.ai.inputTokens.toLocaleString()} tokens in (the prompt), {c.ai.outputTokens.toLocaleString()} out
          {c.ai.cost ? `, about ${c.ai.cost.amount.toFixed(4)} ${c.ai.cost.currency}` : ' (no price set for this model)'}. Only what failed was sent, never any data.
        </p>
      </Card>
      <Card title={<><Icon name="layers" />What changed</>} actions={<span className="muted">+{c.diff.code.added} −{c.diff.code.removed} lines</span>}>
        {c.diff.changes.length ? <ul className="list">{c.diff.changes.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="muted">Same hosts, credentials and actions.</p>}
        {c.diff.codeLines.length ? <details><summary>Code changes</summary><CodeDiff lines={c.diff.codeLines} /></details> : null}
        {c.moduleVersion.versionId ? <p><Link to={`/modules/${c.moduleVersion.versionId}`}>Open the module review</Link></p> : null}
      </Card>
      <Card title="Tests">
        <ul className="list">
          <li>{tests(c.tests.module, 'sandbox tests')}</li>
          <li>{tests(c.tests.recorded, 'tests recorded against the real app')}</li>
          {c.tests.flows.map((f) => <li key={f.flowId}>Flow “{f.name}”: {f.passed} of {f.total} tests passed with the fix</li>)}
        </ul>
      </Card>
      <Card title="Parts to approve">
        <ul className="list">
          <li>
            Module {c.moduleVersion.status ? <Status value={c.moduleVersion.status} /> : null} approvals {c.moduleVersion.approvals.given.length} of {c.moduleVersion.approvals.required}
            {c.moduleVersion.approvals.given.length ? <span className="muted"> ({c.moduleVersion.approvals.given.map((g) => g.handle).join(', ')})</span> : null}
          </li>
          {c.flows.map((f) => (
            <li key={f.flowId}>
              Flow “{f.name}”{' '}
              {f.versionId ? <><Link to={`/flows/${f.flowId}`}>v{f.version}</Link> {f.versionStatus ? <Status value={f.versionStatus} /> : null}</> : <><span className="badge tone-warn">needs a person</span> <span className="muted">{f.reason}</span></>}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Decisions">
        {c.decisions.length ? (
          <table aria-label="Decisions">
            <thead><tr><th>Part</th><th>Decision</th><th>By</th><th>When</th></tr></thead>
            <tbody>
              {c.decisions.map((d, i) => (
                <tr key={i}>
                  <td>{d.part === 'module' ? 'module' : `Flow “${c.flows.find((f) => f.versionId === d.subjectId)?.name ?? d.subjectId}”`}</td>
                  <td><Status value={d.decision} />{d.final ? null : <span className="muted"> one of several approvals</span>}</td>
                  <td>{d.by ?? '—'}</td>
                  <td><When at={d.at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>Nobody has decided yet.</Empty>}
      </Card>
    </Page>
  );
}

/** On a module or Flow review page: the change it is part of, with the "widens access" flag. */
export function ChangeLinkCard({ moduleVersionId, flowVersionId }: { moduleVersionId?: string; flowVersionId?: string }) {
  const { me } = useMe();
  const may = me.role === 'admin' || me.role === 'approver';
  const q = moduleVersionId ? `moduleVersion=${moduleVersionId}` : `flowVersion=${flowVersionId}`;
  const r = useLoad(() => (may ? api<ChangeSummary[]>(`/changes/for?${q}`) : Promise.resolve([])), [q, may]);
  if (!r.data?.length) return null;
  const c = r.data[0]!;
  return (
    <Card title={<><Icon name="refresh" />Part of a self-fix change</>} actions={<Status value={c.status} />}>
      {c.widensAccess ? <WidensAccess widening={c.widening} /> : null}
      <p>
        Dittoly drafted this because {c.module}’s app seems to have changed; {requester(c)}.
        {moduleVersionId && c.approvalsNeeded > 1 ? ` Approvals: ${c.moduleApprovalsGiven ?? 0} of ${c.approvalsNeeded} different admins.` : ''}
      </p>
      <Link to={`/changes/${c.id}`}>Open the change record: evidence, tests and decisions</Link>
    </Card>
  );
}

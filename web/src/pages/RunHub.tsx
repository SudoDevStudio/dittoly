import { useState } from 'react';
import { api, post } from '../api';
import { Card, Empty, ErrorText, Loading, Page, useAction, useLoad } from '../components';
import { Link, navigate } from '../router';
import { RunFormFields, runFormProblems, type FlowDefinitionView } from '../RunForm';
import { Icon, SearchField } from '../ui';
import { RunModelSelect } from '../Costs';
import { teamQuery, useTeams } from '../teams';
import { readSort, sortRunnable, writeSort, type Dir, type SortBy } from '../run-sort';

export interface Runnable {
  flowId: string;
  team: { id: string; name: string };
  versionId: string;
  name: string;
  version: number;
  description: string | null;
  /** When this version was approved: when it was added to what you can run. */
  approvedAt: string | null;
  inputs: number;
  asksDuringRun: boolean;
  ready: boolean;
  missing: { service: string; label: string }[];
  teamMissing: { service: string; label: string }[];
  blocked: string | null;
}

/** One row of the list: a Flow the member can run, saying whether they are ready. */
export function RunnableCard({ r }: { r: Runnable }) {
  return (
    <li className="runnable-card runnable-row">
      <span className="brand-mark" aria-hidden="true">
        <Icon name="bolt" />
      </span>
      <div className="runnable-main">
        <div className="runnable-title">
          <h3>{r.name}</h3>
          {r.ready ? <span className="badge tone-ok">Ready</span> : <span className="badge tone-warn">{r.blocked ? 'Unavailable' : 'Needs setup'}</span>}
        </div>
        <span className="runnable-meta muted">
          v{r.version} · {r.team.name} · {r.inputs ? `${r.inputs} ${r.inputs === 1 ? 'input' : 'inputs'}` : 'No inputs'}
          {r.asksDuringRun ? ' · asks you during the run' : ''}
          {r.approvedAt ? ` · added ${new Date(r.approvedAt).toLocaleDateString()}` : ''}
        </span>
        {r.description ? <p className="runnable-desc muted" title={r.description}>{r.description}</p> : null}
        {r.missing.length ? (
          <p className="runnable-missing">
            Needs your own {r.missing.map((m) => m.label).join(', ')}. <Link to="/credentials">Add in your vault</Link>
          </p>
        ) : null}
        {r.teamMissing.length ? (
          <p className="runnable-missing">
            Your team has not stored its shared {r.teamMissing.map((m) => m.label).join(', ')} yet. <Link to="/teams">Teams</Link>
          </p>
        ) : null}
        {r.blocked ? <p className="muted">A module it uses is no longer approved.</p> : null}
      </div>
      <div className="runnable-actions">
        <Link className={`button ${r.ready ? 'primary' : ''}`} to={`/run/${r.versionId}`}>
          <Icon name="arrow" size={16} />
          Open
        </Link>
        <Link to={`/flows/${r.flowId}`}>Details</Link>
      </div>
    </li>
  );
}

/** Everything the member can run, as a list: searchable and sortable. */
export function RunHub() {
  const { current: team } = useTeams();
  const list = useLoad(() => api<Runnable[]>(`/runnable${teamQuery(team)}`), [team]);
  const [q, setQ] = useState('');
  const [sort, setSortState] = useState(readSort);
  const setSort = (next: { by: SortBy; dir: Dir }) => {
    setSortState(next);
    writeSort(next);
  };
  const matching = list.data?.filter((r) => `${r.name} ${r.description ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const shown = matching ? sortRunnable(matching, sort.by, sort.dir) : undefined;
  return (
    <Page title="Run a Flow" eyebrow="WORKSPACE / RUN" description="Every approved Flow you may run. Each runs as you, with your own access." className="run-hub">
      <div className="toolbar">
        <SearchField value={q} onChange={setQ} placeholder="Find a Flow…" />
        <select aria-label="Sort by" value={sort.by} onChange={(e) => setSort({ by: e.target.value as SortBy, dir: e.target.value === 'name' ? 'asc' : 'desc' })}>
          <option value="added">Recently added</option>
          <option value="name">Name</option>
        </select>
        <select aria-label="Order" value={sort.dir} onChange={(e) => setSort({ ...sort, dir: e.target.value as Dir })}>
          {sort.by === 'name' ? (
            <>
              <option value="asc">A to Z (ASC)</option>
              <option value="desc">Z to A (DESC)</option>
            </>
          ) : (
            <>
              <option value="desc">Newest first (DESC)</option>
              <option value="asc">Oldest first (ASC)</option>
            </>
          )}
        </select>
      </div>
      <ErrorText>{list.error}</ErrorText>
      {!list.data ? (
        <Loading />
      ) : shown?.length === 0 ? (
        <Empty>{list.data.length ? 'No Flow matches.' : 'No approved Flows yet. Create one in Flows · AI Studio and have it approved.'}</Empty>
      ) : (
        <ul className="runnable-list">
          {shown!.map((r) => (
            <RunnableCard key={r.versionId} r={r} />
          ))}
        </ul>
      )}
    </Page>
  );
}

interface Review {
  id: string;
  flowId: string;
  version: number;
  status: string;
  summary: string;
  definition: FlowDefinitionView;
  /** Set when it has organization AI steps: the model they use. */
  aiModel?: string | null;
  modelLocked?: boolean;
}

/** The run view of one approved Flow version: its form, and Run. */
export function RunFlow({ versionId }: { versionId: string }) {
  const review = useLoad(() => api<Review>(`/flow-versions/${versionId}/review`), [versionId]);
  const runnable = useLoad(() => api<Runnable[]>('/runnable'));
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [tried, setTried] = useState(false);
  const [model, setModel] = useState('');
  const act = useAction();
  const r = review.data;
  const me = runnable.data?.find((x) => x.versionId === versionId);
  if (review.error) return <ErrorText>{review.error}</ErrorText>;
  if (!r) return <Loading />;
  const name = me?.name ?? 'Flow';
  return (
    <Page title={name} eyebrow={`RUN / v${r.version}`} description={r.definition.description ?? undefined} className="run-flow">
      {r.status !== 'approved' ? <p className="error">This version is not approved, so it cannot run.</p> : null}
      {me && !me.ready && me.missing.length ? (
        <p className="runnable-missing">
          Needs your own {me.missing.map((m) => m.label).join(', ')} first. <Link to="/credentials">Add in your vault</Link>
        </p>
      ) : null}
      <div className="run-layout">
        <Card title="Run it">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (Object.keys(runFormProblems(r.definition, values)).length) return;
              act.run(async () => {
                const { runId } = await post<{ runId: string }>(`/flow-versions/${versionId}/runs`, { inputs: values, ...(model ? { model } : {}) });
                navigate(`/runs/${runId}`);
              });
            }}
          >
            <RunFormFields versionId={versionId} definition={r.definition} values={values} onChange={setValues} showProblems={tried} />
            <RunModelSelect value={model} onChange={setModel} show={Boolean(r.aiModel) && !r.modelLocked} />
            <button type="submit" className="primary" disabled={act.busy || r.status !== 'approved'}>
              {act.busy ? 'Starting…' : 'Run now'}
            </button>
            <ErrorText>{act.error}</ErrorText>
          </form>
        </Card>
        <Card title="What it does">
          <p className="summary">{r.summary}</p>
          <Link to={`/flows/${r.flowId}`}>Flow details, schedules and versions</Link>
        </Card>
      </div>
    </Page>
  );
}

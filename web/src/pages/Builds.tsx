import { useEffect, useState } from 'react';
import { api } from '../api';
import { activityText, elapsed } from '../BuildPanel';
import { Card, Empty, ErrorText, Loading, Page, useLive } from '../components';
import { useMe } from '../context';
import { Link } from '../router';

/**
 * Building: every module, Flow and Super Flow the AI is building now, whatever started it (a plan, the chat, a
 * revision, an AI fix from a run, a self-fix), with its step, how far it is and what the AI is doing. Admins and
 * approvers can switch to everyone's builds.
 */
interface Build {
  id: string;
  kind: 'module' | 'flow' | 'superflow';
  source: 'plan' | 'chat' | 'revise' | 'extend' | 'run_fix' | 'self_fix';
  title: string;
  by: string | null;
  status: string;
  link: string | null;
  planTitle: string | null;
  progress: { step: string; percent: number; since?: string | null; detail?: string | null; detailAt?: string | null } | null;
}

const KIND: Record<Build['kind'], string> = { module: 'Module', flow: 'Flow', superflow: 'Super Flow' };
const SOURCE: Record<Build['source'], string> = {
  plan: 'from a plan',
  chat: 'from chat',
  revise: 'a revision',
  extend: 'a new action',
  run_fix: 'an AI fix from a run',
  self_fix: 'a fix: its app changed',
};

export function Builds() {
  const { me } = useMe();
  const [all, setAll] = useState(false);
  const builds = useLive(() => api<{ builds: Build[] }>(`/builds${all ? '?scope=all' : ''}`), 2000, [all]);
  // A clock for "for 1m 05s".
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const canSeeAll = me.role === 'admin' || me.role === 'approver';
  const list = builds.data?.builds ?? [];
  return (
    <Page
      title="Building"
      description="What the AI is building now: modules, Flows and Super Flows. Each one waits for review when it is done."
      actions={
        canSeeAll ? (
          <div className="segmented" role="group" aria-label="Whose builds">
            <button type="button" aria-pressed={!all} onClick={() => setAll(false)}>Mine</button>
            <button type="button" aria-pressed={all} onClick={() => setAll(true)}>Everyone's</button>
          </div>
        ) : null
      }
    >
      <ErrorText>{builds.error}</ErrorText>
      {!builds.data ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>Nothing is being built right now. Ask for a module or a Flow under <Link to="/create">Create</Link>.</Empty>
      ) : (
        <div className="builds" aria-label="Builds in progress">
          {list.map((b) => (
            <Card
              key={b.id}
              title={b.link ? <Link to={b.link}>{b.title}</Link> : b.title}
              actions={<span className={`badge build-kind-${b.kind}`}>{KIND[b.kind] ?? b.kind}</span>}
            >
              <p className="muted">
                {SOURCE[b.source] ?? b.source}
                {b.planTitle ? <> · plan <Link to={b.link ?? '/plans'}>“{b.planTitle}”</Link></> : null}
                {all && b.by ? <> · by {b.by}</> : null}
                {b.link ? <> · <Link to={b.link}>Open</Link></> : null}
              </p>
              {b.status === 'queued' || !b.progress ? (
                <p className="muted">Waiting for a free slot…</p>
              ) : (
                <>
                  <div className="build-meter-row"><span>{b.progress.step}{b.progress.since ? ` · for ${elapsed(b.progress.since, now)}` : ''}</span><span>{b.progress.percent}%</span></div>
                  <div className="build-meter-track" role="progressbar" aria-valuenow={b.progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${b.title}: ${b.progress.percent}%`}>
                    <div className="build-meter-fill" style={{ width: `${Math.max(2, b.progress.percent)}%` }} />
                  </div>
                  <p className="build-now" aria-live="polite">› {activityText(b.progress, now)}</p>
                </>
              )}
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}

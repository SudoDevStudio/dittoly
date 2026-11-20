import { api, post } from './api';
import { Card, Empty, ErrorText, Loading, When, useAction, useLoad } from './components';
import { Notice } from './ui';

interface JournalEntry {
  id: string;
  kind: string;
  origin: string;
  text: string;
  versionRef: string | null;
  by: string | null;
  at: string;
  supersededAt: string | null;
}

/**
 * How this {what} came to be what it is: what was asked for, what people said since, what an approver decided and
 * what the checks found. A revision is given this, so it does not quietly drop what the first request asked for.
 */
export function ArtifactJournal({ type, id }: { type: 'flow' | 'module'; id: string }) {
  const what = type === 'flow' ? 'Flow' : 'module';
  const list = useLoad(() => api<{ entries: JournalEntry[]; unreadable: number }>(`/journal/${type}/${id}`), [type, id]);
  const act = useAction();
  const change = (fn: () => Promise<unknown>, said: string) => act.run(async () => (await fn(), list.reload()), said);
  const label: Record<string, string> = {
    request: 'asked for',
    constraint: 'must hold',
    decision: 'decided',
    failure: 'failed',
    fix: 'fixed',
    open: 'still open',
    suggestion: 'the AI suggested',
  };
  return (
    <Card title="How this {what} came to be">
      <p className="muted">
        Kept with the {what}, in the words they were given in: a revision is told what the first request asked for, what people have said since, and what an approver decided.
        What an AI suggested is kept to read, never handed back as a rule. Nothing here lets the {what} do more: every version still goes through its checks and its approver.
      </p>
      {list.data?.unreadable ? (
        <Notice>
          <strong>{list.data.unreadable} entry(ies) cannot be read with the key in use.</strong> Drafts are told they are missing rather than left to guess. If the master key was
          rotated or restored, check the backup.
        </Notice>
      ) : null}
      {list.error ? <ErrorText>{list.error}</ErrorText> : !list.data ? <Loading /> : !list.data.entries.length ? (
        <Empty>Nothing yet. What you ask for when you draft or revise this {what} turns up here.</Empty>
      ) : (
        <ul className="list">
          {list.data.entries.map((e) => (
            <li key={e.id} className={e.supersededAt ? 'muted' : ''}>
              <div>
                <strong>{label[e.kind] ?? e.kind}</strong> <span>{e.text}</span>
                <div className="muted">
                  {e.by ? `${e.by} · ` : ''}{e.versionRef ? `${e.versionRef} · ` : ''}<When at={e.at} />
                  {e.supersededAt ? ' · no longer given to drafts' : ''}
                </div>
              </div>
              {e.supersededAt ? null : (
                <button type="button" className="ghost small" disabled={act.busy} onClick={() => change(() => post(`/journal/${type}/${id}/${e.id}/supersede`, {}), 'No longer given to drafts')}>
                  No longer true
                </button>
              )}
              <button type="button" className="ghost small" disabled={act.busy} onClick={() => change(() => api(`/journal/${type}/${id}/${e.id}`, { method: 'DELETE' }), 'Deleted')}>
                Delete it
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

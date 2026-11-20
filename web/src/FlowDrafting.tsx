import { useState, type ReactNode } from 'react';
import { post } from './api';
import { ClassificationPanel, MissingPartItem, needsAnswers, type Classification, type MissingPart, type NeedsAnswers } from './Classification';
import { Card, ErrorText, useAction } from './components';
import { navigate } from './router';
import { Icon } from './ui';

/** POST /flows/generate's answer when the AI could not build all of the Flow: the person picks what to do. */
interface FlowPart { title: string; request: string }
interface CannotDraft { cannotDraft: true; reason: string; missing: MissingPart[]; split?: FlowPart[] }
const isCannot = (r: unknown): r is CannotDraft => !!r && (r as CannotDraft).cannotDraft === true;

/**
 * Drafting a Flow from a request, used by the Create and Flows pages: questions come first; when an approved
 * module lacks something the Flow needs, the person chooses (add it to that module, build a new one, draft without
 * it, or change the request) instead of getting an error.
 */
export function useDraftFlow(opts: { team?: string; module?: string }): { draft: (request: string) => void; busy: boolean; panels: ReactNode } {
  const act = useAction();
  const [pending, setPending] = useState<{ request: string; classification: Classification } | null>(null);
  const [cannot, setCannot] = useState<{ request: string; answers: Record<string, string>; reason: string; missing: MissingPart[]; split?: FlowPart[] } | null>(null);

  const run = (request: string, answers?: Record<string, string>, leaveOut?: string[]) =>
    act.run(async () => {
      const r = await post<{ flowId: string } | NeedsAnswers | CannotDraft>('/flows/generate', {
        request,
        ...(answers ? { answers } : {}),
        ...(leaveOut?.length ? { leaveOut } : {}),
        ...(opts.team ? { teamId: opts.team } : {}),
        ...(opts.module ? { module: opts.module } : {}),
      });
      if (needsAnswers(r)) {
        setCannot(null);
        setPending({ request, classification: r.classification });
      } else if (isCannot(r)) {
        setPending(null);
        setCannot({ request, answers: answers ?? {}, reason: r.reason, missing: r.missing, ...(r.split?.length ? { split: r.split } : {}) });
      } else navigate(`/flows/${r.flowId}`);
    });

  const panels = (
    <>
      {pending ? (
        <ClassificationPanel
          c={pending.classification}
          busy={act.busy}
          onBuild={(answers) => run(pending.request, answers)}
          onLeaveOut={(parts, answers) => run(pending.request, answers, parts)}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {cannot?.split?.length ? (
        <Card title={<><Icon name="layers" />This is more than one Flow</>}>
          <p>{cannot.reason}</p>
          <p><strong>Build it as these Flows, run together by a Super Flow:</strong></p>
          <ol>{cannot.split.map((p) => <li key={p.title}><strong>{p.title}</strong><p className="muted">{p.request}</p></li>)}</ol>
          <div className="row">
            <button type="button" className="primary" onClick={() => navigate(`/?ask=${encodeURIComponent(`${cannot.request}\n\nBuild it as these Flows, run together by a Super Flow:\n${cannot.split!.map((p, i) => `${i + 1}. ${p.title}: ${p.request}`).join('\n')}`.slice(0, 3800))}`)}>
              <Icon name="sparkles" size={16} />Plan it as a Super Flow
            </button>
            <button type="button" className="ghost" onClick={() => setCannot(null)}>Change the request</button>
          </div>
          <p className="muted">The plan builds each Flow, then the Super Flow that connects them. Every one is reviewed before it runs.</p>
        </Card>
      ) : cannot ? (
        <Card title={<><Icon name="info" />Not all of it can be built yet</>}>
          <p>{cannot.reason}</p>
          {cannot.missing.length ? (
            <>
              <p><strong>What is missing, and how to get it:</strong></p>
              <ul>{cannot.missing.map((m) => <MissingPartItem key={m.capability} m={m} />)}</ul>
            </>
          ) : null}
          <div className="row">
            <button type="button" className="primary" disabled={act.busy} onClick={() => run(cannot.request, cannot.answers, cannot.missing.length ? cannot.missing.map((m) => m.capability) : [cannot.reason.slice(0, 300)])}>
              {act.busy ? 'Working…' : 'Draft without it'}
            </button>
            <button type="button" className="ghost" disabled={act.busy} onClick={() => setCannot(null)}>Change the request</button>
          </div>
          <p className="muted">Drafting without it leaves that part out and says so in the Flow's description; you can add it later as a new version.</p>
        </Card>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </>
  );
  return {
    draft: (request) => {
      setPending(null);
      setCannot(null);
      void run(request);
    },
    busy: act.busy,
    panels,
  };
}

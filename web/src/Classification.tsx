import { useState } from 'react';
import { post } from './api';
import { Card, ErrorText, useAction } from './components';
import { navigate } from './router';
import { Icon } from './ui';

export interface ProtocolInfo { id: string; label: string; category: string; support: 'supported' | 'partial' | 'underlying' | 'unsupported'; note: string }
export interface Classification {
  summary: string;
  category: string;
  protocols: ProtocolInfo[];
  questions: { id: string; question: string; options: string[] }[];
  missing: MissingPart[];
}
/** Something a Flow needs that no approved module does; `module` is the approved module it could be added to. */
export interface MissingPart { capability: string; moduleRequest: string; module?: string }

/**
 * One missing part and how to get it: add the action to the approved module that should have it (a new draft
 * version, reviewed like any other), or build a new module.
 */
export function MissingPartItem({ m }: { m: MissingPart }) {
  const act = useAction();
  return (
    <li>
      {m.capability}{' '}
      {m.module ? (
        <button
          type="button"
          className="ghost"
          disabled={act.busy}
          onClick={() => act.run(async () => navigate(`/modules/${(await post<{ id: string }>(`/modules/by-name/${encodeURIComponent(m.module!)}/extend`, { request: m.moduleRequest })).id}`), `Drafted a new version of ${m.module}; review and approve it, then draft the Flow again`)}
        >
          {act.busy ? 'Drafting…' : `Add it to ${m.module}`}
        </button>
      ) : null}
      <button type="button" className="ghost" onClick={() => navigate(`/modules?request=${encodeURIComponent(m.moduleRequest)}`)}>
        Build a new module
      </button>
      <ErrorText>{act.error}</ErrorText>
    </li>
  );
}
/** POST /modules/generate and /flows/generate answer with this when the person has to say more first. */
export interface NeedsAnswers { needsAnswers: true; classification: Classification }
export const needsAnswers = (r: unknown): r is NeedsAnswers => !!r && (r as NeedsAnswers).needsAnswers === true;

export const CATEGORY_LABELS: Record<string, string> = {
  web_api: 'Web API (HTTPS)',
  streaming: 'Streaming and real time',
  email: 'Email',
  messaging: 'Messaging and queues',
  ai_agents: 'AI agents and tools',
  rpc: 'RPC',
  file_transfer: 'File transfer and storage',
  remote_access: 'Remote access',
  database: 'Databases and directories',
  media: 'Audio, video and peer to peer',
  network: 'Network and transport layers',
};

const TONE: Record<ProtocolInfo['support'], string> = { supported: 'tone-ok', partial: 'tone-warn', underlying: 'tone-muted', unsupported: 'tone-bad' };
const SUPPORT_LABEL: Record<ProtocolInfo['support'], string> = { supported: 'Supported', partial: 'Partly', underlying: 'Handled underneath', unsupported: 'Not supported' };

/**
 * What the AI understood before building: the kind of integration, its
 * protocols (with what Dittoly can actually do), and questions to answer.
 */
export function ClassificationPanel({
  c,
  busy,
  onBuild,
  onLeaveOut,
  onCancel,
}: {
  c: Classification;
  busy: boolean;
  /** Build with these answers (every question answered; with no questions, an empty object builds anyway). */
  onBuild: (answers: Record<string, string>) => void;
  /** Flows: draft without the missing parts (the person's choice, said in the Flow's description). */
  onLeaveOut?: (parts: string[], answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const unsupported = c.protocols.filter((p) => p.support === 'unsupported');
  const answered = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
  // Every question needs an answer: the server asks again for any left blank.
  const open = c.questions.filter((q) => !answered[q.id]).length;
  // Answers go back keyed by the question itself, so they make sense on their own later.
  const keyed = () => Object.fromEntries(Object.entries(answered).map(([id, a]) => [c.questions.find((q) => q.id === id)?.question ?? id, a]));
  return (
    <Card title={<><Icon name="sparkles"/>Before building: {CATEGORY_LABELS[c.category] ?? c.category}</>}>
      {c.summary ? <p>{c.summary}</p> : null}
      {c.protocols.length ? (
        <ul className="protocol-list">
          {c.protocols.map((p) => (
            <li key={p.id}>
              <span className={`badge ${TONE[p.support]}`}>{SUPPORT_LABEL[p.support]}</span> <strong>{p.label}</strong> <span className="muted">{p.note}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {unsupported.length ? (
        <p className="error" role="alert">
          Dittoly cannot use {unsupported.map((p) => p.label).join(', ')}. Rephrase the request with the alternative above, or build anyway and the AI will do what is possible.
        </p>
      ) : null}
      {c.missing.length ? (
        <div>
          <p><strong>No approved module can do this yet:</strong></p>
          <ul>
            {c.missing.map((m) => <MissingPartItem key={m.capability} m={m} />)}
          </ul>
        </div>
      ) : null}
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          onBuild(keyed());
        }}
      >
        {c.questions.map((q) => (
          <div className="field" key={q.id}>
            <label htmlFor={`q-${q.id}`}>{q.question}</label>
            {q.options.length ? (
              <div className="suggestions" role="group" aria-label={q.question}>
                {q.options.map((o) => (
                  <button type="button" key={o} aria-pressed={answers[q.id] === o} className={answers[q.id] === o ? 'selected' : undefined} onClick={() => setAnswers({ ...answers, [q.id]: o })}>
                    {o}
                  </button>
                ))}
              </div>
            ) : null}
            <input id={`q-${q.id}`} placeholder={q.options.length ? 'Or write your own answer' : 'Your answer'} value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
          </div>
        ))}
        <div className="row">
          <button type="submit" className="primary" disabled={busy || open > 0}>
            {busy ? 'Working…' : c.missing.length ? 'Try to build all of it' : c.questions.length ? 'Build with these answers' : 'Build anyway'}
          </button>
          {c.missing.length && onLeaveOut ? (
            <button type="button" disabled={busy || open > 0} onClick={() => onLeaveOut(c.missing.map((m) => m.capability), keyed())}>
              Draft without {c.missing.length === 1 ? 'it' : 'these parts'}
            </button>
          ) : null}
          <button type="button" className="ghost" disabled={busy} onClick={onCancel}>
            Change the request
          </button>
        </div>
      </form>
      {open > 0 ? <p className="muted">Answer {open === 1 ? 'the question' : `all ${open} questions`} to build.</p> : null}
      <p className="muted">Never put passwords or tokens here: each person stores their own credentials in their vault.</p>
    </Card>
  );
}

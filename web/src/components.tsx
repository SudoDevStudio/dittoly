import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { describeError } from './api';
import { toast } from './toast';

/** Load data and expose loading/error/reload. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the latest load may set the state: an older one that answers later (a reload racing a change of what is
  // shown) must not put back what was there before.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const call = ++latest.current;
    setLoading(true);
    load()
      .then((d) => {
        if (call !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (call === latest.current) setError(describeError(e));
      })
      .finally(() => {
        if (call === latest.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

/** Re-run `reload` every `ms` while `active` and the tab is visible. */
export function usePoll(reload: () => void, ms: number, active = true) {
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, ms);
    return () => clearInterval(id);
  }, [reload, ms, active]);
}

/** Like useLoad, but keeps the current data while reloading (no flicker for polling). */
export function useLive<T>(load: () => Promise<T>, ms: number, deps: unknown[] = [], active: (data: T | null) => boolean = () => true) {
  const state = useLoad(load, deps);
  usePoll(state.reload, ms, active(state.data));
  return state;
}

/**
 * Run an action with a busy flag and an error message. With `success`, a short message
 * confirms it worked; a failure is always shown, inline and as a message.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string | ((result: T) => string | null)): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      const text = typeof success === 'function' ? success(result) : success;
      if (text) toast('success', text);
      return result;
    } catch (e) {
      const text = describeError(e);
      setError(text);
      toast('error', text);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Page({ title, actions, children, description, eyebrow, className = '' }: { title: string; actions?: ReactNode; children: ReactNode; description?: string; eyebrow?: string; className?: string }) {
  return (
    <section className={`page ${className}`}>
      <header className="page-head">
        {/* The eyebrow ("CONTROL PLANE / ...") is no longer shown: the sidebar and the title say where you are. */}
        <div data-eyebrow={eyebrow || undefined}><h1>{title}</h1>{description ? <p className="page-description">{description}</p> : null}</div>
        {actions ? <div className="row">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Card({ title, children, actions, id, className }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string; className?: string }) {
  return (
    <div className={className ? `card ${className}` : 'card'} {...(id ? { id } : {})}>
      {title || actions ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : null;
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <p className="muted">{what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}

const STATUS_TONE: Record<string, string> = {
  succeeded: 'ok',
  approved: 'ok',
  completed: 'ok',
  running: 'info',
  pending: 'info',
  draft: 'info',
  pending_review: 'warn',
  waiting: 'warn',
  paused: 'warn',
  failed: 'bad',
  rejected: 'bad',
  expired: 'bad',
  cancelled: 'muted',
  superseded: 'muted',
  proposed: 'warn',
  partly_approved: 'warn',
  skipped: 'muted',
  not_run: 'muted',
  reading: 'info',
  drafting: 'info',
  queued: 'muted',
  needs_answers: 'warn',
  in_review: 'warn',
  needs_attention: 'bad',
  blocked: 'bad',
  drafted: 'ok',
  done: 'ok',
  enabled: 'ok',
  disabled: 'muted',
};

export function Status({ value }: { value: string }) {
  return <span className={`badge tone-${STATUS_TONE[value] ?? 'muted'}`}>{value.replace(/_/g, ' ')}</span>;
}

export function When({ at }: { at: string | null | undefined }) {
  if (!at) return <span className="muted">—</span>;
  const d = new Date(at);
  return <time dateTime={d.toISOString()} title={d.toISOString()}>{d.toLocaleString()}</time>;
}

/** A text box for asking the AI to draft or change something. */
export function ChatBox({
  placeholder,
  button,
  onSubmit,
  busy,
  suggestions,
  initial,
}: {
  placeholder: string;
  button: string;
  onSubmit: (text: string) => void;
  busy: boolean;
  suggestions?: string[];
  /** Text to start with, e.g. a module request suggested by the Flow builder. */
  initial?: string;
}) {
  const [text, setText] = useState(initial ?? '');
  return (
    <form
      className="chat"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }}
    >
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} rows={3} aria-label={placeholder} />
      {suggestions ? <div className="suggestions">{suggestions.map(s => <button key={s} type="button" onClick={() => setText(s)} disabled={busy}>{s}</button>)}</div> : null}
      <button type="submit" className="primary" disabled={busy || !text.trim()}>
        {busy ? 'Working…' : button}
      </button>
    </form>
  );
}

export function Pre({ children }: { children: string }) {
  return <pre className="pre">{children}</pre>;
}

const KEYWORDS = new Set('async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof interface let new null of return static switch this throw true try type typeof undefined var void while yield as'.split(' '));
// Comments, strings (incl. templates), numbers, words: enough to make TypeScript and JSON easy to scan.
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;

function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const [text, comment, str, num, word] = m;
    const cls = comment ? 'tok-comment' : str ? (line.slice(m.index + text.length).trimStart().startsWith(':') ? 'tok-key' : 'tok-string') : num ? 'tok-number' : word && KEYWORDS.has(word) ? 'tok-keyword' : null;
    out.push(cls ? <span key={m.index} className={cls}>{text}</span> : text);
    last = m.index + text.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** Code to read: line numbers, colours for keywords, strings and comments, long lines wrap or scroll, and copy. */
export function CodeView({ code, label }: { code: string; label: string }) {
  const [wrap, setWrap] = useState(false);
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  // Block comments over several lines are coloured line by line.
  let inBlock = false;
  const rows = lines.map((line) => {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) return [<span key="c" className="tok-comment">{line}</span>];
      inBlock = false;
      return [<span key="c" className="tok-comment">{line.slice(0, end + 2)}</span>, ...highlight(line.slice(end + 2))];
    }
    const start = line.lastIndexOf('/*');
    if (start >= 0 && line.indexOf('*/', start) < 0 && !/["'`]/.test(line.slice(0, start))) {
      inBlock = true;
      return [...highlight(line.slice(0, start)), <span key="c" className="tok-comment">{line.slice(start)}</span>];
    }
    return highlight(line);
  });
  return (
    <div className="code-view">
      <div className="code-view-bar">
        <span className="muted">{label} · {lines.length} lines</span>
        <span className="row">
          <button type="button" className="ghost small" onClick={() => setWrap(!wrap)} aria-pressed={wrap}>{wrap ? 'No wrap' : 'Wrap lines'}</button>
          <button type="button" className="ghost small" onClick={() => void navigator.clipboard?.writeText(code).then(() => toast('success', 'Copied'), () => toast('error', 'Could not copy'))}>Copy</button>
        </span>
      </div>
      <pre className={`code-view-body${wrap ? ' wrap' : ''}`} tabIndex={0} aria-label={label}>
        <code>{rows.map((r, i) => <span key={i} className="code-line"><span className="code-ln" aria-hidden="true">{i + 1}</span><span className="code-text">{r.length ? r : ' '}</span></span>)}</code>
      </pre>
    </div>
  );
}


/**
 * A page that throws while rendering shows what went wrong and a way on, never a blank screen. `resetKey` (the
 * path) clears it when the person goes elsewhere.
 */
export class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null; key: string }> {
  state: { error: Error | null; key: string } = { error: null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  componentDidCatch(error: Error) {
    console.error('page_crashed', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="page" role="alert">
        <h1>This page ran into a problem</h1>
        <p className="muted">Nothing you saved is lost. Reload the page, or go back home. If it keeps happening, send this message to whoever runs Dittoly:</p>
        <pre className="pre-wrap">{this.state.error.message || String(this.state.error)}</pre>
        <div className="row">
          <button type="button" className="primary" onClick={() => location.reload()}>Reload</button>
          <a className="button" href="/">Go home</a>
        </div>
      </section>
    );
  }
}

/** A web page the AI read while drafting: "search" was seen by Dittoly; "ai" is only what the AI says it relied on. */
export interface DraftSource { url: string; title?: string; via: 'search' | 'ai' }

/** The docs a draft is based on, for the reviewer to check that they are official and current. */
export function DraftSources({ sources }: { sources?: DraftSource[] | null }) {
  if (!sources?.length) {
    return <p className="muted">No web sources reported: the AI used what it knew and what it was given. Check versions and endpoints against the service's current docs.</p>;
  }
  const searched = sources.filter((s) => s.via === 'search');
  const named = sources.filter((s) => s.via === 'ai');
  const list = (items: DraftSource[]) => (
    <ul className="list">
      {items.map((s) => (
        <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title || s.url}</a>{s.title ? <span className="muted small"> {new URL(s.url).hostname}</span> : null}</li>
      ))}
    </ul>
  );
  return (
    <>
      {searched.length ? <><p className="muted">Pages its web search read:</p>{list(searched)}</> : null}
      {named.length ? <><p className="muted">Pages the AI says it relied on (not checked by Dittoly):</p>{list(named)}</> : null}
    </>
  );
}

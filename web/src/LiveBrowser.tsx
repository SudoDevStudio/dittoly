import { useEffect, useRef, useState } from 'react';
import { api, post } from './api';
import { ErrorText } from './components';

/**
 * A live view of a browser on the server: frames stream in over Server-Sent
 * Events. When the session lets you (its script asked for help, or you opened
 * the page yourself) your clicks, keys and scrolling go to that browser.
 */

interface Frame {
  data: string;
  width: number;
  height: number;
  url: string;
}
type LiveEvent = { type: 'frame'; frame: Frame } | { type: 'state'; help: string | null; closed: boolean };

const SPECIAL = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

export function LiveBrowser({ id, kind, onClosed }: { id: string; kind: 'step' | 'page'; onClosed?: () => void }) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [help, setHelp] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [shots, setShots] = useState<string[]>([]);
  const screen = useRef<HTMLDivElement>(null);
  // Typed characters are sent in small batches, in order.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const es = new EventSource(`/api/live/${id}/stream`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as LiveEvent;
      if (e.type === 'frame') setFrame(e.frame);
      else {
        setHelp(e.help);
        if (e.closed) {
          setClosed(true);
          es.close();
          onClosed?.();
        }
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setClosed(true);
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const canDrive = kind === 'page' || help !== null;
  const send = (body: Record<string, unknown>) => {
    queue.current = queue.current.then(() =>
      post(`/live/${id}/input`, body).then(
        () => setError(null),
        (e: Error) => setError(e.message),
      ),
    );
    return queue.current;
  };

  const point = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget.getBoundingClientRect();
    const w = frame?.width ?? 1280;
    const h = frame?.height ?? 720;
    return { x: Math.round(((e.clientX - img.left) / img.width) * w), y: Math.round(((e.clientY - img.top) / img.height) * h) };
  };

  if (closed && !frame) return <p className="muted">This browser session has ended.</p>;
  return (
    <div className={`live-browser ${canDrive ? 'driving' : ''}`}>
      {help ? (
        <div className="live-help" role="status">
          <strong>The script is waiting for you:</strong> {help}
          <button className="primary" onClick={() => void post(`/live/${id}/continue`).catch((e: Error) => setError(e.message))}>
            Continue
          </button>
        </div>
      ) : null}
      {kind === 'page' ? (
        <form
          className="live-bar"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim()) void send({ type: 'goto', url: address.trim() });
          }}
        >
          <button type="button" onClick={() => void send({ type: 'back' })} aria-label="Back">
            ←
          </button>
          <input aria-label="Address" value={address} placeholder={frame?.url ?? 'https://…'} onChange={(e) => setAddress(e.target.value)} />
          <button type="submit">Go</button>
          <button
            type="button"
            onClick={() =>
              void post<{ screenshot: string }>(`/live/${id}/screenshot`).then(
                (r) => setShots((s) => [r.screenshot, ...s]),
                (e: Error) => setError(e.message),
              )
            }
          >
            Screenshot
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void api(`/live/${id}`, { method: 'DELETE' }).then(() => (setClosed(true), onClosed?.()), (e: Error) => setError(e.message))}
          >
            Close
          </button>
        </form>
      ) : (
        <p className="muted live-url">{frame?.url ?? 'Starting…'}</p>
      )}
      <div
        ref={screen}
        className="live-screen"
        tabIndex={canDrive ? 0 : -1}
        aria-label={canDrive ? 'Live browser: click to control it, then type' : 'Live browser'}
        onKeyDown={(e) => {
          if (!canDrive || e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key.length === 1) void send({ type: 'type', text: e.key });
          else if (SPECIAL.has(e.key)) void send({ type: 'key', key: e.key });
          else return;
          e.preventDefault();
        }}
        onWheel={(e) => {
          if (canDrive) void send({ type: 'scroll', dy: Math.round(e.deltaY) });
        }}
      >
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame.data}`}
            alt={`Live browser showing ${frame.url}`}
            draggable={false}
            onClick={(e) => {
              if (!canDrive) return;
              screen.current?.focus();
              void send({ type: 'click', ...point(e) });
            }}
          />
        ) : (
          <p className="muted">Connecting to the browser…</p>
        )}
      </div>
      {canDrive ? <p className="muted">Click in the page to use it, then type. What you type is never shown to the script.</p> : null}
      <ErrorText>{error}</ErrorText>
      {shots.length ? (
        <div className="live-shots">
          {shots.map((s, i) => (
            <a key={i} href={s} download={`screenshot-${i + 1}.jpg`}>
              <img className="out-shot" src={s} alt={`Screenshot ${i + 1}`} />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

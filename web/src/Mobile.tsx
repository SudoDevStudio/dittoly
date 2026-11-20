import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, describeError, post, type Me } from './api';
import { Icon } from './ui';
import { recognizer, type Rec } from './speech';

/**
 * The phone page (/m): paired with a QR code, it takes commands by voice or text,
 * reads replies aloud (through Meta glasses, when they are the phone's headset),
 * asks for a yes before anything changes, and says when runs it started finish.
 */
interface Reply { say: string; confirm?: { id: string; summary: string }; runId?: string }
interface Line { who: 'person' | 'dittoly'; text: string }

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|confirm|do it|go( ahead)?|approve it)\b/i;
const NO = /^(no|nope|cancel|stop|don'?t|never ?mind)\b/i;
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'paused']);

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const android = /Android[^;]*;\s*([^;)]+)/.exec(ua);
  if (android) return android[1]!.replace(/Build.*/, '').trim().slice(0, 40) || 'Android phone';
  return 'Phone';
}


/**
 * Ray-Ban Display and similar heads-up displays: a small, roughly square screen where black
 * is see-through, navigated with arrow keys and Enter (no keyboard, no microphone in the web
 * app). Shows the last reply and Yes / No, nothing to scroll. `?display=glasses` forces it.
 */
const HUD_QUERY = '(max-width: 700px) and (max-height: 700px) and (min-aspect-ratio: 4/5) and (max-aspect-ratio: 5/4)';
function useHud(): boolean {
  const forced = new URLSearchParams(location.search).get('display') === 'glasses';
  const [match, setMatch] = useState(() => typeof matchMedia === 'function' && matchMedia(HUD_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(HUD_QUERY);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return forced || match;
}

/** Arrow keys move between the buttons (the glasses' controller sends arrows and Enter). */
function moveFocus(e: React.KeyboardEvent<HTMLElement>) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
  if (!buttons.length) return;
  e.preventDefault();
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[(i + step + buttons.length) % buttons.length]!.focus();
}

export function MobileApp() {
  const [stage, setStage] = useState<'loading' | 'pairing' | 'signed-out' | 'ready'>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Dittoly';
    try { document.documentElement.dataset.theme = localStorage.getItem('dittoly-theme') === 'light' ? 'light' : 'dark'; } catch { /* dark by default */ }
    (async () => {
      if (location.pathname === '/m/pair') {
        const code = location.hash.slice(1);
        history.replaceState(null, '', '/m');
        setStage('pairing');
        const res = await fetch('/auth/device/pair', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dittoly-request': '1' }, body: JSON.stringify({ code, name: deviceName() }) });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
          setError(body.detail ?? 'This code did not work. Show a new QR code in Dittoly and scan it again.');
          setStage('signed-out');
          return;
        }
      }
      try {
        setMe(await api<Me>('/me'));
        setStage('ready');
      } catch {
        setStage('signed-out');
      }
    })();
  }, []);

  if (stage === 'loading' || stage === 'pairing') return <main className="mobile"><p className="muted">{stage === 'pairing' ? 'Connecting this phone…' : 'Loading…'}</p></main>;
  if (stage === 'signed-out' || !me) {
    return (
      <main className="mobile">
        <header className="mobile-head"><span className="brand-mark"><Icon name="terminal" size={20} /></span><strong>Dittoly</strong></header>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <p>To connect this phone, open Dittoly on your computer, go to <strong>My credentials → Phone, glasses & chat apps</strong>, choose <strong>Connect a phone</strong>, and scan the code with this phone's camera.</p>
      </main>
    );
  }
  return <Commander me={me} />;
}

function Commander({ me }: { me: Me }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Reply['confirm'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(() => {
    try { return localStorage.getItem('dittoly-speak') !== 'off'; } catch { return true; }
  });
  const following = useRef(new Map<string, string>());
  const rec = useRef<Rec | null>(null);
  const Recognizer = recognizer();
  const hud = useHud();
  const endRef = useRef<HTMLDivElement>(null);

  const say = useCallback((t: string) => {
    setLines((l) => [...l, { who: 'dittoly', text: t }]);
    if (speak && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(t));
    }
  }, [speak]);

  useEffect(() => {
    try { localStorage.setItem('dittoly-speak', speak ? 'on' : 'off'); } catch { /* fine without storage */ }
  }, [speak]);
  // Braces: newer browsers return a Promise from scrollIntoView, which React would call as a cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines, pending]);

  // Start by saying what is waiting.
  useEffect(() => {
    api<Reply>('/m/inbox').then((r) => setLines([{ who: 'dittoly', text: `Hi ${me.handle}. ${r.say}` }])).catch(() => undefined);
  }, [me.handle]);

  // Runs started or touched from here: say when they finish (or need you).
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      for (const [runId, last] of following.current) {
        const r = await api<Reply & { status: string | null }>(`/m/runs/${runId}`).catch(() => null);
        if (!r?.status || r.status === last) continue;
        following.current.set(runId, r.status);
        if (FINAL.has(r.status) || r.status === 'waiting') say(r.say);
        if (FINAL.has(r.status)) following.current.delete(runId);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [say]);

  const handle = (r: Reply) => {
    say(r.say);
    setPending(r.confirm ?? null);
    if (r.runId && !following.current.has(r.runId)) following.current.set(r.runId, '');
  };

  const send = async (input: string) => {
    const t = input.trim();
    if (!t || busy) return;
    setText('');
    setLines((l) => [...l, { who: 'person', text: t }]);
    setBusy(true);
    try {
      if (pending && (YES.test(t) || NO.test(t))) {
        handle(await post<Reply>('/m/confirm', { id: pending.id, yes: YES.test(t) }));
      } else {
        const history = lines.slice(-6).map((l) => ({ role: l.who, text: l.text.slice(0, 1000) }));
        handle(await post<Reply>('/m/command', { text: t, history }));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) location.reload();
      say(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const listen = () => {
    if (!Recognizer) return;
    if (listening) {
      rec.current?.stop();
      return;
    }
    window.speechSynthesis?.cancel();
    const r = new Recognizer();
    r.lang = navigator.language || 'en-US';
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => void send(e.results[0]?.[0]?.transcript ?? '');
    r.onerror = (e) => {
      if (e.error === 'not-allowed') say('Allow the microphone for this page in your browser settings, or type instead.');
    };
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };

  if (hud) {
    const last = [...lines].reverse().find((l) => l.who === 'dittoly');
    const runs = [...following.current.keys()];
    return (
      <main className="mobile hud" onKeyDown={moveFocus} aria-label="Dittoly">
        <p className="hud-line" aria-live="polite">{busy ? '…' : last?.text ?? `Hi ${me.handle}.`}</p>
        {pending ? (
          <div className="hud-confirm" role="group" aria-label="Confirm">
            <p>{pending.summary}</p>
            <div className="row">
              <button type="button" autoFocus disabled={busy} onClick={() => void send('yes')}>Yes</button>
              <button type="button" disabled={busy} onClick={() => void send('no')}>No</button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button type="button" autoFocus disabled={busy} onClick={() => void api<Reply>('/m/inbox').then((r) => say(r.say)).catch(() => say('I could not check right now.'))}>What's waiting</button>
            {runs.length ? <button type="button" disabled={busy} onClick={() => void api<Reply>(`/m/runs/${runs.at(-1)}`).then((r) => say(r.say)).catch(() => say('I could not check right now.'))}>Last run</button> : null}
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="mobile">
      <header className="mobile-head">
        <span className="brand-mark"><Icon name="terminal" size={20} /></span>
        <strong>Dittoly</strong>
        <span className="muted">{me.handle}</span>
        <label className="speak-toggle"><input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> Speak</label>
      </header>
      <ol className="mobile-lines" aria-live="polite">
        {lines.map((l, i) => <li key={i} className={`mobile-line ${l.who}`}>{l.text}</li>)}
      </ol>
      {pending ? (
        <div className="mobile-confirm" role="group" aria-label="Confirm">
          <p>{pending.summary}</p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void send('yes')}><Icon name="check" size={16} />Yes</button>
            <button type="button" disabled={busy} onClick={() => void send('no')}><Icon name="close" size={16} />No</button>
          </div>
        </div>
      ) : null}
      <div ref={endRef} />
      <form className="mobile-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        {Recognizer ? (
          <button type="button" className={`mic ${listening ? 'listening' : ''}`} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Speak a command'} onClick={listen}>
            <Icon name="mic" size={26} />
          </button>
        ) : null}
        <input aria-label="Command" value={text} placeholder={pending ? 'Say or type yes or no' : 'e.g. run release notes for 2.4'} onChange={(e) => setText(e.target.value)} disabled={busy} />
        <button type="submit" className="primary" disabled={busy || !text.trim()}>Send</button>
      </form>
      {!Recognizer ? <p className="muted mobile-note">{window.isSecureContext ? 'This browser cannot listen; type, or use your keyboard’s dictation.' : 'Voice needs Dittoly on https. Type, or use your keyboard’s dictation.'}</p> : null}
    </main>
  );
}

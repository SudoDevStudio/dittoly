import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Link } from './router';
import { Linkified } from './ModuleLink';

/**
 * The Live panel on the right: what the AI is building for you now, and what your Flow runs are doing, said as
 * commentary ("Now drafting…", "Now on step…", "Calling GET … → 200") as it happens. Each step it reaches is
 * written to a terminal log; when a module or Flow is drafted, its code types itself out and a Flow's steps join one
 * by one. Collapsed by default to a 50px bar; it remembers when you open it. Polls only while something is being
 * built (or the panel is open), and keeps still for people who prefer reduced motion.
 */
interface Live {
  itemId: string;
  planId: string;
  planTitle: string;
  kind: 'module' | 'flow' | 'superflow';
  title: string;
  status: string;
  progress: { step: string; percent: number; since?: string | null; detail?: string | null; detailAt?: string | null } | null;
  moduleVersionId: string | null;
  flowVersionId: string | null;
  /** Where to follow it: set for builds outside a plan (a run, a module, a Flow). */
  link?: string | null;
}
interface LogLine { at: string; text: string; tone: 'info' | 'ok' | 'warn' | 'bad' }
/** A run of yours going on now (or just ended), with its latest commentary (GET /runs/live). */
interface LiveRun { runId: string; flowName: string; status: string; lines: { id: number; at: string; text: string }[] }
const RUNNING = new Set(['running', 'waiting', 'paused']);
const lineTone = (text: string): LogLine['tone'] => (/failed|→ [45]\d\d/.test(text) ? 'bad' : /^Waiting/.test(text) ? 'warn' : / done$|finished$/.test(text) ? 'ok' : 'info');
interface Shown { title: string; kind: 'code' | 'flow'; text: string; steps: { id: string; type: string; title?: string }[]; tests: { name: string; passed: boolean }[] }

const ACTIVE = new Set(['queued', 'drafting']);
/** Dispatched on window to open the Live panel from another page. */
export const OPEN_LIVE = 'dittoly:open-live';
const KEY = 'build_live_open';
/** Where the open panel sits: 'right' (default) or 'bottom'. */
const DOCK_KEY = 'build_live_dock';
type Dock = 'right' | 'bottom';
function readDock(): Dock {
  try {
    return localStorage.getItem(DOCK_KEY) === 'bottom' ? 'bottom' : 'right';
  } catch {
    return 'right';
  }
}
/** The key before it was renamed; still read so an open panel stays open. */
const OLD_KEY = 'dittoly.buildPanel.open';
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const DONE: Record<string, string> = {
  in_review: 'drafted, tests passed: sent for review',
  needs_attention: 'drafted, but its tests need fixing',
  drafted: 'drafted: waiting for an approver',
  needs_answers: 'needs your answers before it drafts',
  failed: 'drafting failed',
  split: 'too big for one Flow: split into parts',
};
/** "3m 05s" since an ISO time, by the clock `now`. */
export function elapsed(since: string | null | undefined, now: number): string {
  if (!since) return '';
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
/**
 * What the AI is doing now. A CLI sends nothing while it thinks or writes its answer, so a long quiet spell after its
 * last step is said as such rather than shown as that step still going on.
 */
export function activityText(p: { detail?: string | null; detailAt?: string | null }, now: number): string {
  if (!p.detail) return 'waiting for the AI to answer (it may think for a few minutes)';
  const quiet = p.detailAt ? (now - Date.parse(p.detailAt)) / 1000 : 0;
  if (quiet < 30) return p.detail;
  return `quiet for ${elapsed(p.detailAt, now)}: the AI is thinking or writing its answer (it shows nothing while it writes). Last step: ${p.detail}`;
}
const toneOf = (status: string): LogLine['tone'] => (status === 'failed' ? 'bad' : status === 'needs_attention' || status === 'needs_answers' ? 'warn' : 'ok');

function readOpen(): boolean {
  try {
    return (localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY)) === '1';
  } catch {
    return false;
  }
}

export function BuildPanel() {
  const [open, setOpen] = useState(readOpen);
  const [dock, setDockState] = useState<Dock>(readDock);
  const setDock = (d: Dock) => {
    setDockState(d);
    try {
      localStorage.setItem(DOCK_KEY, d);
    } catch {
      // Only a convenience.
    }
  };
  const [items, setItems] = useState<Live[]>([]);
  const [runs, setRuns] = useState<LiveRun[]>([]);
  // The last commentary line shown per run, so each poll adds only new ones.
  const runSeen = useRef(new Map<string, number>());
  const [log, setLog] = useState<LogLine[]>([]);
  const [shown, setShown] = useState<Shown | null>(null);
  const seen = useRef(new Map<string, string>());
  const fetched = useRef(new Set<string>());
  const building = items.some((i) => ACTIVE.has(i.status));
  const running = runs.filter((r) => RUNNING.has(r.status));
  const active = building || running.length > 0;
  // A clock for "running for 3m 05s", ticking only while something is being built and the panel is open.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, open]);

  // Another page asks to show it ("Watch it in Live"): open it, remembered like a click.
  useEffect(() => {
    const show = () =>
      setOpen(() => {
        try {
          localStorage.setItem(KEY, '1');
        } catch {
          // Only a convenience.
        }
        return true;
      });
    window.addEventListener(OPEN_LIVE, show);
    return () => window.removeEventListener(OPEN_LIVE, show);
  }, []);

  // Open, the panel takes its width from the page instead of covering it.
  useEffect(() => {
    document.documentElement.classList.toggle('build-live-open', open);
    document.documentElement.classList.toggle('build-live-bottom', dock === 'bottom');
    return () => document.documentElement.classList.remove('build-live-open', 'build-live-bottom');
  }, [open, dock]);

  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(KEY, o ? '0' : '1');
      } catch {
        // Only a convenience.
      }
      return !o;
    });

  // Poll: every 2s while something is being built, every 15s otherwise (only for the bar's badge).
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const [next, nextRuns] = await Promise.all([api<Live[]>('/builds/live'), api<LiveRun[]>('/runs/live').catch(() => [] as LiveRun[])]);
        if (stop) return;
        setItems(next);
        setRuns(nextRuns);
        const lines: LogLine[] = [];
        for (const r of nextRuns) {
          const after = runSeen.current.get(r.runId) ?? 0;
          for (const l of r.lines.filter((x) => x.id > after)) {
            lines.push({ at: new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), tone: lineTone(l.text), text: `run "${r.flowName}" › ${l.text}` });
          }
          const last = r.lines.at(-1)?.id;
          if (last) runSeen.current.set(r.runId, Math.max(after, last));
        }
        for (const i of [...next].reverse()) {
          const state = `${i.status}:${i.progress?.step ?? ''}:${i.progress?.detail ?? ''}`;
          if (seen.current.get(i.itemId) === state) continue;
          const first = !seen.current.has(i.itemId);
          seen.current.set(i.itemId, state);
          const what = `${i.kind === 'module' ? 'module' : i.kind === 'superflow' ? 'super flow' : 'flow'} "${i.title}"`;
          if (i.status === 'drafting') lines.push({ at: stamp(), tone: 'info', text: `${what} › now ${i.progress?.detail ? `${i.progress.detail} (${i.progress.step}, ${i.progress.percent}%)` : `${i.progress?.step ?? 'starting'}${i.progress ? ` (${i.progress.percent}%)` : ''}`}` });
          else if (i.status === 'queued') lines.push({ at: stamp(), tone: 'info', text: `${what} › queued` });
          else if (!first || ACTIVE.has(i.status) || DONE[i.status]) lines.push({ at: stamp(), tone: toneOf(i.status), text: `${what} › ${DONE[i.status] ?? i.status.replace(/_/g, ' ')}` });
        }
        if (lines.length) setLog((l) => [...l, ...lines].slice(-200));
        // A freshly drafted module or Flow: show what was built.
        const fresh = next.find((i) => !fetched.current.has(i.itemId) && (i.moduleVersionId || i.flowVersionId) && !ACTIVE.has(i.status));
        if (fresh) {
          fetched.current.add(fresh.itemId);
          if (fresh.moduleVersionId) {
            const r = await api<{ ref: string; ownSource?: string | null; source: string | null; manifest: unknown; validationReport?: { tests?: { name: string; passed: boolean }[] } | null }>(`/modules/${fresh.moduleVersionId}/review`);
            setShown({ title: r.ref, kind: 'code', text: r.ownSource ?? r.source ?? JSON.stringify(r.manifest, null, 2), steps: [], tests: r.validationReport?.tests ?? [] });
          } else if (fresh.flowVersionId) {
            const r = await api<{ definition: { steps: { id: string; type: string; title?: string }[] } }>(`/flow-versions/${fresh.flowVersionId}/review`);
            setShown({ title: fresh.title, kind: 'flow', text: JSON.stringify(r.definition, null, 2), steps: r.definition.steps ?? [], tests: [] });
          }
        }
      } catch {
        // Offline or signed out: try again later.
      }
      if (!stop) timer = setTimeout(tick, active || open ? 2000 : 15000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [active, open]);

  const current = items.filter((i) => ACTIVE.has(i.status));
  const count = current.length + running.length;
  return (
    <aside className={`build-panel ${open ? 'open' : 'closed'} dock-${dock}`} aria-label="Live">
      <button type="button" className="build-panel-bar" onClick={toggle} aria-expanded={open} title={open ? 'Hide Live' : 'Show Live: what is being built and what your runs are doing'}>
        <span className="build-panel-arrows" aria-hidden="true">{open ? '>>' : '<<'}</span>
        <span className="build-panel-label">LIVE</span>
        {count ? <span className="build-panel-pulse" aria-label={`${count} in progress`}>{count}</span> : null}
      </button>
      {open ? (
        <div className="build-panel-body">
          <header className="build-panel-head">
            <span className={`build-panel-led ${active ? 'on' : ''}`} aria-hidden="true" />
            <strong>{building ? 'Building…' : running.length ? 'Running…' : 'Idle'}</strong>
            <span className="muted">{count ? `${count} in progress` : 'Nothing being built or run right now'}</span>
            <Link to="/building" className="build-dock">all builds →</Link>
            <button type="button" className="build-dock" onClick={() => setDock(dock === 'right' ? 'bottom' : 'right')} title={dock === 'right' ? 'Move the panel to the bottom' : 'Move the panel to the right'}>
              {dock === 'right' ? '⤓ bottom' : '⇥ right'}
            </button>
          </header>
          {current.map((i) => (
            <div key={i.itemId} className="build-meter">
              <div className="build-meter-row"><Link to={i.link ?? (i.planId ? `/plans/${i.planId}#item-${i.itemId}` : '/building')}>{i.title}</Link><span>{i.progress ? `${i.progress.percent}%` : 'queued'}</span></div>
              <div className="build-meter-track"><div className="build-meter-fill" style={{ width: `${i.progress?.percent ?? 2}%` }} /></div>
              <div className="build-meter-step">{i.progress ? `${i.progress.step}${i.progress.since ? ` · for ${elapsed(i.progress.since, now)}` : ''}` : 'waiting for a free slot'}</div>
              {i.progress ? (
                <div className="build-meter-activity" aria-live="polite">
                  › {activityText(i.progress, now)}
                </div>
              ) : null}
            </div>
          ))}
          {running.map((r) => (
            <div key={r.runId} className="build-meter">
              <div className="build-meter-row"><Link to={`/runs/${r.runId}`}>{r.flowName}</Link><span>{r.status}</span></div>
              <div className="build-meter-activity" aria-live="polite">› {r.lines.at(-1)?.text ?? 'starting'}</div>
            </div>
          ))}
          <div className="build-panes">
            <Terminal lines={log} />
            {shown ? <Reveal key={`${shown.title}:${shown.text.length}`} shown={shown} /> : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function Terminal({ lines }: { lines: LogLine[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);
  return (
    <div className="build-terminal" role="log" aria-live="polite">
      {lines.length ? lines.map((l, n) => (
        <div key={n} className={`build-line build-tone-${l.tone}`}><span className="build-at">{l.at}</span> <span className="build-prompt">›</span> <Linkified text={l.text} /></div>
      )) : <div className="build-line muted">› nothing yet: what the AI builds and what your runs do will show here…</div>}
      <div ref={end} className="build-cursor" aria-hidden="true">▌</div>
    </div>
  );
}

/** What was built: code that types itself out, and a Flow's steps joining one by one. */
function Reveal({ shown }: { shown: Shown }) {
  const still = useMemo(reduced, []);
  const [n, setN] = useState(still ? shown.text.length : 0);
  useEffect(() => {
    if (still) return;
    // About two seconds for any length: a few characters a frame.
    const per = Math.max(3, Math.ceil(shown.text.length / 120));
    let raf = 0;
    const step = () => {
      setN((x) => {
        const next = Math.min(shown.text.length, x + per);
        if (next < shown.text.length) raf = requestAnimationFrame(step);
        return next;
      });
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [shown, still]);
  const done = n >= shown.text.length;
  const nodes = shown.kind === 'flow' ? shown.steps.slice(0, still || done ? shown.steps.length : Math.ceil((n / shown.text.length) * shown.steps.length)) : [];
  return (
    <section className="build-reveal" aria-label={`Built: ${shown.title}`}>
      <div className="build-reveal-title">{done ? 'BUILT' : 'WRITING'} · {shown.title}</div>
      {shown.kind === 'flow' && shown.steps.length ? (
        // The Flow as a graph, drawn as it is built: each step a node, joined to the one before it.
        <ol className="build-graph" aria-label="The Flow's steps">
          {nodes.map((s, i) => (
            <li key={s.id} className={`build-gnode build-gnode-${s.type}`} style={{ animationDelay: `${i * 40}ms` }}>
              <span className="build-gnode-n">{i + 1}</span>
              <span className="build-node-type">{s.type}</span>
              <span className="build-gnode-title">{s.title ?? s.id}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {shown.tests.length ? (
        <ul className="build-tests" aria-label="Sandbox tests">
          {shown.tests.slice(0, still || done ? shown.tests.length : Math.ceil((n / Math.max(1, shown.text.length)) * shown.tests.length)).map((t) => (
            <li key={t.name} className={t.passed ? 'build-tone-ok' : 'build-tone-bad'}>{t.passed ? '✓' : '✗'} {t.name}</li>
          ))}
        </ul>
      ) : null}
      <pre className="build-code"><code>{shown.text.slice(0, n)}</code>{done ? null : <span className="build-cursor">▌</span>}</pre>
    </section>
  );
}

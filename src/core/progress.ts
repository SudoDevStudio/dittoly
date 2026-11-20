import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How far a long piece of AI work has come (a module or Flow being drafted), told to whoever started it: the plans
 * pipeline shows it as a step and a percentage, and what the AI is doing within the step right now (a web search, a
 * thought) so a long step never looks stuck. Work that reports nothing simply shows no progress.
 */
export interface Progress {
  /** A short step, e.g. "drafting". */
  step: string;
  /** 0–100, never going back within one piece of work. */
  percent: number;
  /** Only on an activity report: what the AI is doing within the step, in a few words. */
  detail?: string;
}

interface Context {
  report: (p: Progress) => void;
  last?: { step: string; percent: number };
}

const store = new AsyncLocalStorage<Context>();

export function withProgress<T>(report: (p: Progress) => void, fn: () => T): T {
  return store.run({ report }, fn);
}

function send(ctx: Context, p: Progress): void {
  try {
    ctx.report(p);
  } catch {
    // Progress is best-effort.
  }
}

/** Reports a step of the current work; a no-op outside withProgress. Errors in the listener never reach the work. */
export function progress(step: string, percent: number): void {
  const ctx = store.getStore();
  if (!ctx) return;
  ctx.last = { step, percent: Math.max(0, Math.min(100, Math.round(percent))) };
  send(ctx, { ...ctx.last });
}

/** Activity text as shown: one line, a few words. */
export function cleanActivity(text: string): string {
  return text.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * A reporter for what the AI is doing within the current step, bound to the current work now (so it still reports
 * from a child process's callbacks); a no-op outside withProgress or before the first step.
 */
export function activityReporter(): (text: string) => void {
  const ctx = store.getStore();
  if (!ctx) return () => undefined;
  return (text) => {
    const detail = cleanActivity(text);
    if (ctx.last && detail) send(ctx, { ...ctx.last, detail });
  };
}

/**
 * Says what the work is doing now in a few words ("running the tests"), as an activity report within the current step
 * (or with no step yet); a no-op outside withProgress.
 */
export function narrate(text: string): void {
  const ctx = store.getStore();
  const detail = cleanActivity(text);
  if (ctx && detail) send(ctx, { ...(ctx.last ?? { step: '', percent: 0 }), detail });
}

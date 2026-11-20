import type { AppEngine } from './engine.js';
import type { Store } from './store.js';
import type { ScheduleDef } from './triggers.js';

/** Flows that run on a schedule. Only apps with schedules have this file (and the cron parser). */

/** Fire each schedule at its next time; with a shared store, two copies of the app never both fire one tick. */
export async function startSchedules(list: ScheduleDef[], d: { engine: AppEngine; store: Store; onError: (flow: string) => void }): Promise<() => void> {
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  if (!list.length) return () => undefined;
  const { CronExpressionParser } = await import('cron-parser');
  for (const [i, s] of list.entries()) {
    const arm = () => {
      if (stopped) return;
      const next = CronExpressionParser.parse(s.cron, { tz: s.timezone, currentDate: new Date() }).next().toDate();
      const t = setTimeout(async () => {
        // A time further away than a timer can wait: wait again.
        if (Date.now() < next.getTime() - 1000) return arm();
        try {
          if (await d.store.mark(`schedule:${i}:${s.flow}:${next.toISOString()}`, 86_400)) await d.engine.start(s.flow, s.inputs ?? {});
        } catch {
          d.onError(s.flow);
        }
        arm();
      }, Math.min(Math.max(0, next.getTime() - Date.now()), 2_000_000_000));
      t.unref?.();
      timers.push(t);
    };
    arm();
  }
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}

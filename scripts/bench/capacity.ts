/**
 * Capacity benchmark (plan item 06): a burst of runs and notifications through the real engine, job queue and
 * process sandbox, at 1, 2, 4 and 8 run slots. Apps are fakes that answer after a set delay, so the numbers are
 * Dittoly's own overhead plus that delay, not any real service's speed.
 *
 *   BENCH_DATABASE_URL=postgres://postgres@127.0.0.1:5433/dittoly_bench npx tsx scripts/bench/capacity.ts
 *
 * The database's public schema is DROPPED and recreated for each slot count: point it at a throwaway database.
 * Options (env): BENCH_RUNS (40), BENCH_LONG_RUNS (4), BENCH_NOTIFICATIONS (20), BENCH_API_MS (150),
 * BENCH_LONG_MS (3000), BENCH_SLOTS ("1,2,4,8"), BENCH_OUT (write the Markdown report there too).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { buildApp } from '../../src/app.js';
import { createMember } from '../../src/core/members.js';
import { notify } from '../../src/core/notify.js';
import { setLogSink } from '../../src/core/log.js';
import { createDb, migrate } from '../../src/db/db.js';
import { ProcessRunner } from '../../src/sandbox/runner.js';
import { approveExampleModules, FakeApps, testConfig, type World } from '../../test/helpers.js';

// Only the job timings are read; the server's other log lines are dropped.
setLogSink(() => undefined);
const url = process.env.BENCH_DATABASE_URL;
if (!url || !/bench/i.test(url)) {
  console.error('Set BENCH_DATABASE_URL to a throwaway database whose name contains "bench": its schema is dropped.');
  process.exit(2);
}
const num = (name: string, d: number) => Number(process.env[name] ?? d);
const RUNS = num('BENCH_RUNS', 40);
const LONG_RUNS = num('BENCH_LONG_RUNS', 4);
const NOTIFICATIONS = num('BENCH_NOTIFICATIONS', 20);
const API_MS = num('BENCH_API_MS', 150);
const LONG_MS = num('BENCH_LONG_MS', 3000);
const SLOTS = (process.env.BENCH_SLOTS ?? '1,2,4,8').split(',').map(Number);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (ms: number) => (Number.isNaN(ms) ? '–' : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

interface Row { slots: number; wallMs: number; runsDone: number; runsFailed: number; runP50: number; runP95: number; notifP50: number; notifP95: number; notifMax: number; queueWaitP95: number; rssMb: number; cpuS: number }

async function once(slots: number): Promise<Row> {
  const db = createDb(url!, Math.max(10, slots + 4));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const fake = new FakeApps();
  // Every app call takes API_MS; posts to C-long take LONG_MS (a stand-in for a long fix or browser step).
  const slowFetch: typeof fake.fetch = async (u, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    await sleep(body.includes('"C-long"') ? LONG_MS : API_MS);
    return fake.fetch(u, init);
  };
  const app = buildApp({ ...testConfig({ databaseUrl: url!, runWorkers: slots }), masterKey: randomBytes(32) }, db, { runner: new ProcessRunner(), ai: null, fetchImpl: slowFetch, actionTimeoutMs: 60_000 });
  const mk = (h: string, r: 'admin' | 'approver' | 'member') => createMember(db, h, r, null).then((m) => m.member);
  const [admin, approver, alice] = [await mk('admin', 'admin'), await mk('approver', 'approver'), await mk('alice', 'member')];
  await approveExampleModules({ app, db, admin, approver, alice } as unknown as World);
  await app.vault.put(alice.id, 'slack', 'xoxb-bench');
  const flow = async (name: string, channel: string) => {
    const def = { inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel, text: 'bench' } }] };
    const v = await app.flows.create(name, def, alice);
    await app.flows.decide(v.id, approver, 'approved');
    return v.id;
  };
  const quick = await flow('Bench quick', 'C-quick');
  const long = await flow('Bench long', 'C-long');

  const waits: { kind: string; waitMs: number; durationMs: number }[] = [];
  setLogSink((line) => {
    const e = JSON.parse(line) as { event: string; jobKind?: string; waitMs?: number; durationMs?: number };
    if (e.event === 'job_done') waits.push({ kind: e.jobKind!, waitMs: e.waitMs!, durationMs: e.durationMs! });
  });

  const cpu0 = process.cpuUsage();
  let rss = process.memoryUsage().rss;
  const sampler = setInterval(() => (rss = Math.max(rss, process.memoryUsage().rss)), 100);
  const t0 = Date.now();
  // The burst: long runs first (they would block everything behind them), then quick runs and notifications.
  const runIds: string[] = [];
  for (let i = 0; i < LONG_RUNS; i++) runIds.push(await app.engine.startRun(long, alice.id, {}));
  for (let i = 0; i < RUNS; i++) runIds.push(await app.engine.startRun(quick, alice.id, {}));
  for (let i = 0; i < NOTIFICATIONS; i++) await notify(db, alice.id, 'run_failed', { runId: runIds[0]! });
  app.worker.start(20);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const r = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs WHERE id = ANY($1) AND status IN ('running', 'waiting')`, [runIds])).rows[0]!.n;
    const j = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE failed_at IS NULL`)).rows[0]!.n;
    if ((r === 0 && j === 0) || Date.now() > deadline) break;
    await sleep(50);
  }
  const wallMs = Date.now() - t0;
  clearInterval(sampler);
  const cpu = process.cpuUsage(cpu0);
  await app.worker.stop();

  const runs = (await db.query<{ status: string; ms: number }>(
    `SELECT status, extract(epoch FROM (finished_at - created_at)) * 1000 AS ms FROM runs WHERE id = ANY($1)`,
    [runIds],
  )).rows;
  const quickRuns = runs.slice(LONG_RUNS);
  const notif = waits.filter((w) => w.kind === 'deliver_notification').map((w) => w.waitMs + w.durationMs);
  await db.end();
  setLogSink(() => undefined);
  return {
    slots,
    wallMs,
    runsDone: runs.filter((r) => r.status === 'succeeded').length,
    runsFailed: runs.filter((r) => r.status === 'failed').length,
    runP50: pct(quickRuns.map((r) => Number(r.ms)), 50),
    runP95: pct(quickRuns.map((r) => Number(r.ms)), 95),
    notifP50: pct(notif, 50),
    notifP95: pct(notif, 95),
    notifMax: notif.length ? Math.max(...notif) : NaN,
    queueWaitP95: pct(waits.map((w) => w.waitMs), 95),
    rssMb: Math.round(rss / 1024 / 1024),
    cpuS: Math.round(((cpu.user + cpu.system) / 1e6) * 10) / 10,
  };
}

const rows: Row[] = [];
for (const s of SLOTS) {
  process.stderr.write(`slots ${s}…\n`);
  rows.push(await once(s));
}
const report = [
  `# Capacity: ${new Date().toISOString().slice(0, 10)}`,
  '',
  `Host: ${os.cpus().length} CPUs (${os.cpus()[0]?.model ?? 'unknown'}), ${Math.round(os.totalmem() / 1024 ** 3)} GB, Node ${process.version}, process sandbox.`,
  `Burst: ${LONG_RUNS} long runs (app call ${LONG_MS} ms), then ${RUNS} quick runs (one sandboxed Slack action, app call ${API_MS} ms) and ${NOTIFICATIONS} notifications. Fake apps: the delays are stand-ins, not real services.`,
  '',
  '| Run slots | Burst done in | Runs ok / failed | Quick run p50 / p95 (queued → finished) | Notification p50 / p95 / max | Job queue wait p95 | Peak RSS | Server CPU |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.slots} | ${fmt(r.wallMs)} | ${r.runsDone} / ${r.runsFailed} | ${fmt(r.runP50)} / ${fmt(r.runP95)} | ${fmt(r.notifP50)} / ${fmt(r.notifP95)} / ${fmt(r.notifMax)} | ${fmt(r.queueWaitP95)} | ${r.rssMb} MB | ${r.cpuS} s |`),
  '',
  'One sample per row on this host; repeat before relying on a number. Server CPU and RSS are the Dittoly process only; each sandboxed action also runs in its own short-lived process.',
].join('\n');
console.log(report);
if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, `${report}\n`);
process.exit(0);

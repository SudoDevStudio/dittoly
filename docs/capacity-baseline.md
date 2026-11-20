# Capacity baseline: 28 October 2026

Measured with `scripts/bench/capacity.ts` on the base commit `e683568` plus this change (worker lanes and run slots).
The "before" row is the same burst on the old single worker.

Host: 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB, Node v26.11.1, process sandbox.
Burst: 4 long runs (app call 3000 ms), then 40 quick runs (one sandboxed Slack action, app call 150 ms) and 20 notifications. Fake apps: the delays are stand-ins, not real services.

| Run slots | Burst done in | Runs ok / failed | Quick run p50 / p95 (queued → finished) | Notification p50 / p95 / max | Job queue wait p95 | Peak RSS | Server CPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (before: one lane) | 22 s | 44 / 0 | 17 s / 21 s | 6.7 s / 22 s / 22 s | 22 s | 197 MB | 1.4 s |
| 1 | 22 s | 44 / 0 | 17 s / 21 s | 20 ms / 352 ms / 707 ms | 19 s | 213 MB | 1.7 s |
| 2 | 11 s | 44 / 0 | 8.6 s / 11 s | 22 ms / 361 ms / 617 ms | 9.8 s | 213 MB | 1.3 s |
| 4 | 5.9 s | 44 / 0 | 4.6 s / 5.5 s | 24 ms / 328 ms / 584 ms | 5.1 s | 214 MB | 1.1 s |
| 8 | 3.3 s | 44 / 0 | 1.4 s / 2.4 s | 23 ms / 327 ms / 506 ms | 2.0 s | 213 MB | 0.8 s |

## What it shows

- **Before, notifications waited behind runs.** With one worker for everything, a notification queued after a burst of runs waited for all of them (p95 22 s). With the quick lane it is delivered in about a third of a second whatever the runs are doing.
- **Run slots scale this workload nearly linearly up to 8** on this host, because the runs mostly wait on (fake) app calls. Real work that uses CPU (sandboxed code, Docker fix steps, browsers) will scale less; measure with your own Flows before raising slots.
- **Memory stays flat** in the server process (about 210 MB); each sandboxed action runs in its own short-lived process, not counted here.

## Limits of this measurement

- One sample per row, one host, process sandbox, fake apps with fixed delays, no AI calls, no Docker fix or browser steps.
- It does not set a supported concurrency. The defaults stay conservative: 2 run slots on a shared server, 1 on a local install (`DITTOLY_RUN_WORKERS`).
- Not yet covered (next slice): per-team limits, freeing a slot when a run is cancelled, and a clear answer when the server is overloaded.

Re-run: `BENCH_DATABASE_URL=postgres://…/dittoly_bench npx tsx scripts/bench/capacity.ts` (the database's schema is dropped; its name must contain "bench").

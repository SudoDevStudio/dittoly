import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Broker, BrokerRequest } from '../../runtime/broker.js';

/**
 * Warm sandboxed workers for an exported app's modules. Each worker is a Node process under the
 * permission model (no network, no child processes, no workers, files readable only in the
 * sandbox folder, an empty environment) that loads its module once and then runs one action at a
 * time. Its only way out is the broker, through stdin/stdout, which checks every request against
 * the manifest and attaches credentials, so module code never sees a secret. A worker that times
 * out or exits is replaced; each is also replaced after a number of calls.
 *
 * A worker serves one caller (a run) at a time: once it has run an action for one caller, the
 * next caller gets a fresh worker, so module state and timers never carry over between callers.
 */

export type InvokeResult = { ok: true; output: unknown } | { ok: false; errorType: string; retryable: boolean };

export interface InvokeParams {
  /** The module's file, inside the sandbox folder. */
  moduleFile: string;
  action: string;
  input: unknown;
  broker: Pick<Broker, 'handle' | 'call'>;
  timeoutMs: number;
  settings: Record<string, string>;
  /** Who the action runs for (the run). A worker is shared only between calls of the same caller; none: not shared at all. */
  caller?: string;
}

interface Turn {
  params: InvokeParams;
  resolve: (r: InvokeResult) => void;
}

const MAX_LINE = 4_000_000;

class Worker {
  readonly child: ChildProcessWithoutNullStreams;
  busy = false;
  dead = false;
  uses = 0;
  /** The caller it last ran for; null while unused (a warm worker). */
  caller: string | null = null;
  private turn: { done: (r: InvokeResult) => void; broker: InvokeParams['broker'] } | null = null;

  constructor(runner: string, moduleFile: string, sandboxDir: string, onExit: () => void) {
    this.child = spawn(
      process.execPath,
      ['--permission', `--allow-fs-read=${sandboxDir}`, '--disallow-code-generation-from-strings', '--max-old-space-size=128', runner, moduleFile, '--serve'],
      { cwd: sandboxDir, env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stderr.resume();
    this.child.stdin.on('error', () => undefined);
    const gone = () => {
      if (this.dead) return;
      this.dead = true;
      this.turn?.done({ ok: false, errorType: 'sandbox_exited', retryable: false });
      onExit();
    };
    this.child.on('error', gone);
    this.child.on('close', gone);
    readLines(this.child.stdout, MAX_LINE, (line) => this.onLine(line), () => {
      this.turn?.done({ ok: false, errorType: 'output_too_large', retryable: false });
      this.child.kill('SIGKILL');
    });
  }

  private write(msg: unknown) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onLine(line: string) {
    const t = this.turn;
    if (!t) return;
    let msg: { type?: string; id?: number; kind?: string; request?: BrokerRequest; output?: unknown; errorType?: string; retryable?: boolean };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'result') t.done({ ok: true, output: msg.output ?? null });
    else if (msg.type === 'error') {
      const et = typeof msg.errorType === 'string' && /^[a-z0-9_]{1,40}$/.test(msg.errorType) ? msg.errorType : 'module_error';
      t.done({ ok: false, errorType: et, retryable: msg.retryable === true });
    } else if (msg.type === 'http' && typeof msg.id === 'number' && msg.request) {
      const id = msg.id;
      t.broker.handle(msg.request).then(
        (out) => (out.ok ? this.write({ type: 'http_result', id, response: out.response }) : this.write({ type: 'http_error', id, error: out.error, retryable: out.retryable })),
        () => this.write({ type: 'http_error', id, error: 'broker_error', retryable: false }),
      );
    } else if (msg.type === 'call' && typeof msg.id === 'number' && typeof msg.kind === 'string' && msg.request && typeof msg.request === 'object') {
      const id = msg.id;
      t.broker.call(msg.kind, msg.request as unknown as Record<string, unknown>).then(
        (out) => (out.ok ? this.write({ type: 'call_result', id, result: out.result }) : this.write({ type: 'http_error', id, error: out.error, retryable: out.retryable })),
        () => this.write({ type: 'http_error', id, error: 'broker_error', retryable: false }),
      );
    }
  }

  run(p: InvokeParams): Promise<InvokeResult> {
    this.busy = true;
    this.uses++;
    this.caller = p.caller ?? `unshared:${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // The module may be stuck in a loop: this worker is not used again.
        done({ ok: false, errorType: 'action_timeout', retryable: true });
        this.kill();
      }, p.timeoutMs);
      const done = (r: InvokeResult) => {
        if (!this.turn) return;
        this.turn = null;
        clearTimeout(timer);
        this.busy = false;
        resolve(r);
      };
      this.turn = { done, broker: p.broker };
      this.write({ type: 'invoke', action: p.action, input: p.input, settings: p.settings });
    });
  }

  kill() {
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }

  /** Stop it for good without reporting the exit (the pool has already let it go). */
  retire() {
    this.dead = true;
    this.kill();
  }
}

export class SandboxPool {
  private readonly workers = new Map<string, Worker[]>();
  private readonly queues = new Map<string, Turn[]>();

  constructor(
    private readonly o: { sandboxDir: string; runner: string; perModule?: number; recycleAfter?: number },
  ) {}

  invoke(params: InvokeParams): Promise<InvokeResult> {
    const file = path.resolve(this.o.sandboxDir, params.moduleFile);
    if (!file.startsWith(path.resolve(this.o.sandboxDir) + path.sep)) return Promise.resolve({ ok: false, errorType: 'module_load_failed', retryable: false });
    return new Promise((resolve) => {
      const q = this.queues.get(file) ?? [];
      this.queues.set(file, q);
      q.push({ params: { ...params, moduleFile: file }, resolve });
      this.next(file);
    });
  }

  private next(file: string) {
    const q = this.queues.get(file);
    if (!q?.length) return;
    const list = (this.workers.get(file) ?? []).filter((w) => !w.dead);
    this.workers.set(file, list);
    const caller = q[0]!.params.caller ?? null;
    let w = list.find((x) => !x.busy && (x.caller === null || (caller !== null && x.caller === caller)));
    if (!w) {
      // A free worker that last ran for someone else is replaced, never handed over.
      const other = list.find((x) => !x.busy);
      if (other) {
        other.retire();
        list.splice(list.indexOf(other), 1);
      }
    }
    if (!w && list.length < (this.o.perModule ?? 2)) {
      const created: Worker = new Worker(this.o.runner, file, this.o.sandboxDir, () => {
        this.workers.set(file, (this.workers.get(file) ?? []).filter((x) => x !== created));
        this.next(file);
      });
      list.push(created);
      w = created;
    }
    if (!w) return;
    const turn = q.shift()!;
    const worker = w;
    void worker.run(turn.params).then((r) => {
      turn.resolve(r);
      if (worker.uses >= (this.o.recycleAfter ?? 1000)) worker.kill();
      this.next(file);
    });
  }

  /** Start one worker per module now, so the first run does not wait for it. */
  warm(files: string[]) {
    for (const f of files) {
      const file = path.resolve(this.o.sandboxDir, f);
      if ((this.workers.get(file) ?? []).length) continue;
      const created: Worker = new Worker(this.o.runner, file, this.o.sandboxDir, () => {
        this.workers.set(file, (this.workers.get(file) ?? []).filter((x) => x !== created));
        this.next(file);
      });
      this.workers.set(file, [created]);
    }
  }

  close() {
    for (const list of this.workers.values()) for (const w of list) w.kill();
    this.workers.clear();
  }
}

/** Newline-delimited messages with a hard size limit: a worker that never sends a newline cannot exhaust memory. */
function readLines(stream: Readable, max: number, onLine: (line: string) => void, onTooLarge: () => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let stopped = false;
  stream.on('data', (chunk: Buffer) => {
    if (stopped) return;
    let start = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, nl);
      if (size + piece.length > max) return ((stopped = true), onTooLarge());
      parts.push(piece);
      const line = Buffer.concat(parts).toString('utf8');
      parts = [];
      size = 0;
      start = nl + 1;
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      if (stopped) return;
    }
    const rest = chunk.subarray(start);
    if (size + rest.length > max) return ((stopped = true), onTooLarge());
    if (rest.length) (parts.push(rest), (size += rest.length));
  });
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, copyFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readLines } from './lines.js';
import { randomUUID } from 'node:crypto';
import type { Broker, BrokerRequest } from './broker.js';
import { ConfigError, type SandboxBackend } from '../config.js';
import { RUNNER_SCRIPT } from '../paths.js';
import { containerEngine, type ContainerEngine } from './engine.js';
import { ownerLabels, sandboxTempDir } from './owner.js';

export { RUNNER_SCRIPT };

export interface InvokeParams {
  code: string;
  action: string;
  input: unknown;
  broker: BrokerLike;
  timeoutMs?: number;
  /** Organization settings the module declares, as ctx.settings. */
  settings?: Record<string, string>;
  /** The most an action may take in all, waits for a person included (tests shorten it). */
  wallClockMs?: number;
}

/** How many times one action may ask a person for help (page.askForHelp). */
export const MAX_HELP_REQUESTS = 2;
/** The most one action may take in all, including the time it waits for a person. */
export const ACTION_WALL_CLOCK_MS = 30 * 60_000;

/** The broker as the runner sees it; `call` (non-HTTP protocols) is absent where no network is allowed. */
export type BrokerLike = Pick<Broker, 'handle'> & Partial<Pick<Broker, 'call'>>;

export type InvokeResult =
  | { ok: true; output: unknown }
  | { ok: false; errorType: string; retryable: boolean };

export interface SandboxRunner {
  readonly backend: SandboxBackend;
  invoke(params: InvokeParams): Promise<InvokeResult>;
}

const MAX_LINE = 4_000_000;

interface Prepared {
  dir: string;
  modulePath: string;
  runnerPath: string;
}

/** Shared driver: write the module to a fresh directory, start the sandbox, speak the protocol. */
abstract class StdioRunner implements SandboxRunner {
  abstract readonly backend: SandboxBackend;
  protected abstract start(p: Prepared, name: string): ChildProcessWithoutNullStreams;
  protected abstract kill(child: ChildProcessWithoutNullStreams, name: string): void;

  async invoke({ code, action, input, broker, timeoutMs = 60_000, settings = {}, wallClockMs = ACTION_WALL_CLOCK_MS }: InvokeParams): Promise<InvokeResult> {
    // macOS temp paths include symlinked parents; Node permissions need the canonical path.
    const dir = await realpath(await sandboxTempDir('sbx'));
    const prepared: Prepared = {
      dir,
      modulePath: path.join(dir, 'module.mjs'),
      runnerPath: path.join(dir, 'runner.mjs'),
    };
    try {
      await writeFile(prepared.modulePath, code, { mode: 0o644 });
      await copyFile(RUNNER_SCRIPT, prepared.runnerPath);
      await chmod(prepared.runnerPath, 0o644);
      await chmod(dir, 0o755);
      return await this.drive(prepared, action, input, broker, timeoutMs, settings, wallClockMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private drive(
    p: Prepared,
    action: string,
    input: unknown,
    broker: BrokerLike,
    timeoutMs: number,
    settings: Record<string, string>,
    wallClockMs: number,
  ): Promise<InvokeResult> {
    const name = `dty-${randomUUID()}`;
    const child = this.start(p, name);
    return new Promise<InvokeResult>((resolve) => {
      let settled = false;
      let helpRequests = 0;
      const finish = (r: InvokeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(wall);
        this.kill(child, name);
        resolve(r);
      };
      const deadline = Date.now() + wallClockMs;
      const timeout = () => setTimeout(() => finish({ ok: false, errorType: 'action_timeout', retryable: true }), Math.max(0, Math.min(timeoutMs, deadline - Date.now())));
      let timer = timeout();
      // However often the clock stops for a person, the action ends at the wall-clock limit.
      const wall = setTimeout(
        () => finish(helpRequests > 0 ? { ok: false, errorType: 'help_limit_reached', retryable: false } : { ok: false, errorType: 'action_timeout', retryable: true }),
        wallClockMs,
      );

      // stderr is drained and discarded: it may contain personal data.
      child.stderr.resume();
      child.on('error', () => finish({ ok: false, errorType: 'sandbox_start_failed', retryable: false }));
      // 'close' fires after stdout is fully read, so a final result line is never lost.
      child.on('close', () => finish({ ok: false, errorType: 'sandbox_exited', retryable: false }));
      child.stdin.on('error', () => undefined);

      const write = (msg: unknown) => {
        if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + '\n');
      };
      readLines(child.stdout, MAX_LINE, (line) => {
        let msg: { type?: string; id?: number; kind?: string; request?: BrokerRequest; output?: unknown; errorType?: string; retryable?: boolean };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === 'result') finish({ ok: true, output: msg.output ?? null });
        else if (msg.type === 'error') {
          const et = typeof msg.errorType === 'string' && /^[a-z0-9_]{1,40}$/.test(msg.errorType) ? msg.errorType : 'module_error';
          finish({ ok: false, errorType: et, retryable: msg.retryable === true });
        } else if (msg.type === 'http' && typeof msg.id === 'number' && msg.request) {
          const id = msg.id;
          broker.handle(msg.request).then(
            (out) =>
              out.ok
                ? write({ type: 'http_result', id, response: out.response })
                : write({ type: 'http_error', id, error: out.error, retryable: out.retryable }),
            () => write({ type: 'http_error', id, error: 'broker_error', retryable: false }),
          );
        } else if (msg.type === 'call' && typeof msg.id === 'number' && typeof msg.kind === 'string' && msg.request && typeof msg.request === 'object') {
          const id = msg.id;
          // Waiting for a person (a browser script's askForHelp) does not count against the action's time:
          // the clock stops, and the script gets its full time again once they hand back.
          // At most MAX_HELP_REQUESTS of those per action (the broker counts too).
          const waitsForPerson = msg.kind === 'browser' && (msg.request as { op?: unknown }).op === 'askForHelp';
          if (waitsForPerson && ++helpRequests > MAX_HELP_REQUESTS) {
            write({ type: 'http_error', id, error: 'help_limit_reached', retryable: false });
            return;
          }
          if (waitsForPerson) clearTimeout(timer);
          const pending = broker.call
            ? broker.call(msg.kind, msg.request as unknown as Record<string, unknown>)
            : Promise.resolve({ ok: false as const, error: 'no_network_during_load', retryable: false, violation: true });
          pending
            .finally(() => {
              if (waitsForPerson && !settled) timer = timeout();
            })
            .then(
              (out) => (out.ok ? write({ type: 'call_result', id, result: out.result }) : write({ type: 'http_error', id, error: out.error, retryable: out.retryable })),
              () => write({ type: 'http_error', id, error: 'broker_error', retryable: false }),
            );
        }
      }, () => finish({ ok: false, errorType: 'output_too_large', retryable: false }));
      write({ type: 'invoke', action, input, settings });
    });
  }
}

/**
 * Local / development backend: a child Node process under Node's permission
 * model (no network, no child processes, no workers, no addons, file reads only
 * inside its own directory), with an empty environment.
 *
 * Node documents the permission model as a guard for trusted code, not a
 * security boundary against malicious code. That is why shared mode requires
 * the docker backend.
 */
export class ProcessRunner extends StdioRunner {
  readonly backend = 'process' as const;

  constructor() {
    super();
    if (!process.allowedNodeEnvironmentFlags.has('--allow-net')) {
      throw new ConfigError(
        `the process sandbox needs a Node.js version whose permission model restricts network access (has --allow-net); running ${process.version}`,
      );
    }
  }

  protected start(p: Prepared): ChildProcessWithoutNullStreams {
    return spawn(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${p.dir}`,
        '--disallow-code-generation-from-strings',
        '--max-old-space-size=128',
        p.runnerPath,
        p.modulePath,
      ],
      { cwd: p.dir, env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }

  protected kill(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

/**
 * Shared-server backend: the same runner inside a locked-down container with
 * no network interface at all; its only channel is stdin/stdout to the broker.
 */
export class DockerRunner extends StdioRunner {
  readonly backend = 'docker' as const;

  constructor(private readonly image: string) {
    super();
  }

  /**
   * The container engine for the runner's own containers. It starts one per sandbox call, where waiting for the
   * engine to be detected would show up in every module test, so the detected one is kept here once it is known
   * and Docker is used until then (the usual case, and what an unconfigured machine should report).
   */
  private engine: ContainerEngine = 'docker';
  async useDetectedEngine(): Promise<void> {
    this.engine = await containerEngine();
  }

  protected start(p: Prepared, name: string): ChildProcessWithoutNullStreams {
    return spawn(
      this.engine,
      [
        'run',
        '--rm',
        '-i',
        ...ownerLabels(),
        '--name',
        name,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '64',
        '--memory',
        '256m',
        '--cpus',
        '1',
        '--user',
        '65534:65534',
        '--env',
        'NODE_OPTIONS=',
        '-v',
        `${p.dir}:/sandbox:ro`,
        this.image,
        'node',
        '--permission',
        '--allow-fs-read=/sandbox',
        '--disallow-code-generation-from-strings',
        '--max-old-space-size=128',
        '/sandbox/runner.mjs',
        '/sandbox/module.mjs',
      ],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }

  protected kill(child: ChildProcessWithoutNullStreams, name: string): void {
    if (child.exitCode === null) {
      spawn(this.engine, ['kill', name], { stdio: 'ignore' }).on('error', () => undefined);
      child.kill('SIGKILL');
    }
  }
}

export function createRunner(backend: SandboxBackend, image: string): SandboxRunner {
  if (backend !== 'docker') return new ProcessRunner();
  const runner = new DockerRunner(image);
  // Podman where that is what the machine has; until it answers, Docker (sandbox/engine.ts).
  void runner.useDetectedEngine().catch(() => undefined);
  return runner;
}

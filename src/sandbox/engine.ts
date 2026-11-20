import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../core/log.js';

const run = promisify(execFile);

/**
 * Which container engine runs the sandboxes. Dittoly never builds images or uses an engine's own API: every
 * container it starts is one `run` with the flags both engines share, so Podman works wherever Docker does —
 * on a machine where a Docker daemon is not wanted, or where containers must run rootless.
 */
export const CONTAINER_ENGINES = ['docker', 'podman'] as const;
export type ContainerEngine = (typeof CONTAINER_ENGINES)[number];

export const isContainerEngine = (v: unknown): v is ContainerEngine => CONTAINER_ENGINES.includes(v as ContainerEngine);

let decided: Promise<ContainerEngine> | null = null;

/**
 * The engine to use: DITTOLY_CONTAINER_ENGINE when it names one, else whichever answers — Docker first, because
 * an installation with both has a daemon running for a reason. Decided once; nothing here starts a container.
 * With neither, it stays "docker", so what a person reads is the familiar "this needs Docker" rather than a
 * second thing to install.
 */
export function containerEngine(env: NodeJS.ProcessEnv = process.env): Promise<ContainerEngine> {
  const named = env.DITTOLY_CONTAINER_ENGINE?.trim().toLowerCase();
  if (isContainerEngine(named)) return Promise.resolve(named);
  decided ??= detect();
  return decided;
}

/** For tests, and for a server that is told to use another engine while it runs. */
export function setContainerEngine(engine: ContainerEngine | null): void {
  decided = engine ? Promise.resolve(engine) : null;
}

async function detect(): Promise<ContainerEngine> {
  for (const engine of CONTAINER_ENGINES) {
    const ok = await run(engine, ['info', '--format', '{{json .}}'], { timeout: 15_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }).then(
      () => true,
      () => false,
    );
    if (ok) {
      if (engine !== 'docker') log.info('container_engine', { action: engine });
      return engine;
    }
  }
  return 'docker';
}

/**
 * Making a session's network, per engine. Both get an internal network: no route out but the session's own
 * egress proxy. The difference is the bridge's address on the host, through which a container could otherwise
 * reach every port the host listens on (Dittoly itself, a database published on all interfaces):
 *
 * - Docker 28 and later take the isolated gateway mode, which leaves the bridge without one. An older Docker
 *   refuses the option, and the caller falls back to a plain internal network with a warning.
 * - Podman's internal networks have no gateway address at all (netavark), so it needs no option.
 */
export function networkCreateArgs(engine: ContainerEngine, network: string, labels: readonly string[], isolated = true): string[] {
  const opt = engine === 'docker' && isolated ? ['-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated'] : [];
  return ['network', 'create', '--internal', ...opt, ...labels, network];
}

/** Whether a failed `network create` is worth trying again without the isolated gateway (Docker before 28). */
export const isolationOptional = (engine: ContainerEngine): boolean => engine === 'docker';

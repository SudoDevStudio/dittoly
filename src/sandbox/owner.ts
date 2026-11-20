import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * This server process, as the owner of the sandbox containers, networks and folders it makes. Each one
 * carries the id (Docker labels; the folder's name starts with its first 8 characters). The process
 * renews it in sandbox_owners while it runs; what a process that stopped renewing left behind (it
 * crashed or was killed mid-step) is removed by the sweep in src/engine/sandbox-housekeeping.ts.
 */
export const SANDBOX_OWNER = randomUUID();
export const OWNER_PREFIX = SANDBOX_OWNER.slice(0, 8);

/** `docker run` / `docker network create` arguments that mark a resource as this process's sandbox. */
export const ownerLabels = (): string[] => ['--label', 'dittoly.sandbox=1', '--label', `dittoly.owner=${SANDBOX_OWNER}`];

/** The temporary folders the sweep knows: dty-<kind>-<owner prefix>-<random>. */
export const SANDBOX_DIR_KINDS = ['fix', 'app', 'env', 'sbx'] as const;
export function sandboxTempDir(kind: (typeof SANDBOX_DIR_KINDS)[number]): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `dty-${kind}-${OWNER_PREFIX}-`));
}

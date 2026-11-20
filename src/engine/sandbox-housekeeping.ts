import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Queryable } from '../db/db.js';
import { containerEngine } from '../sandbox/engine.js';
import { log } from '../core/log.js';
import { SANDBOX_DIR_KINDS, SANDBOX_OWNER } from '../sandbox/owner.js';
import { OLD } from '../core/old-prefixes.js';

/**
 * Code sandboxes kept tidy and bounded (docs/sandbox.md):
 * - each server process renews its owner id every pass; containers, networks and folders of an owner
 *   that stopped renewing (crashed or killed mid-step) are removed, and its sandbox slots freed;
 * - at most `codeSandboxes` app and fix steps build and test at once: a step takes a slot (a lease it
 *   renews while it works) or its run waits (sandbox_busy) and tries again shortly, without holding a
 *   run slot;
 * - step images Dittoly pulled itself are removed after `imageTtlHours` unused; images that were on the
 *   host before Dittoly first used them, and Dittoly's own (the proxy, the browser), are never touched.
 */

const run = promisify(execFile);
/** An owner that has not renewed for this long is gone (passes run every 30 seconds). */
const OWNER_GONE_MS = 3 * 60_000;
/** A slot's lease, renewed while its step works; a step's own lease is as long. */
export const SLOT_LEASE_MS = 30 * 60_000;
/** A run waiting for a slot tries again after this long. */
export const SLOT_RETRY_MS = 20_000;

export type Docker = (args: string[]) => Promise<string>;
export const dockerCli: Docker = async (args) => (await run(await containerEngine(), args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })).stdout;

export async function heartbeat(db: Queryable, owner = SANDBOX_OWNER): Promise<void> {
  await db.query(`INSERT INTO sandbox_owners (id, heartbeat_at) VALUES ($1, now()) ON CONFLICT (id) DO UPDATE SET heartbeat_at = now()`, [owner]);
}

/**
 * Owners of this installation (its database) that stopped renewing. An owner the table does not know
 * belongs to another installation on the same Docker host, or to a test, and is never touched.
 */
async function goneOwners(db: Queryable, owner: string): Promise<Set<string>> {
  const rows = (await db.query<{ id: string }>(`SELECT id FROM sandbox_owners WHERE heartbeat_at < now() - make_interval(secs => $1) AND id <> $2`, [OWNER_GONE_MS / 1000, owner])).rows;
  return new Set(rows.map((r) => r.id));
}

export interface SweepResult {
  containers: number;
  networks: number;
  folders: number;
  slots: number;
}

/**
 * Removes what this installation's owners that are gone left behind: their labelled containers (first, so
 * their networks can go), networks and temporary folders; frees their slots and forgets owners gone for a
 * week. Resources without a known owner are left alone.
 */
export async function sweep(db: Queryable, o: { docker?: Docker | null; tmp?: string; owner?: string } = {}): Promise<SweepResult> {
  const owner = o.owner ?? SANDBOX_OWNER;
  const dead = await goneOwners(db, owner);
  const result = await removeOwned(dead, o);
  result.slots = (await db.query(`UPDATE sandbox_slots SET owner = NULL, run_id = NULL, step_id = NULL, until = NULL WHERE owner = ANY($1::text[])`, [[...dead]])).rowCount ?? 0;
  // Long after its resources went: by then a restarted Docker host has dropped them anyway.
  await db.query(`DELETE FROM sandbox_owners WHERE heartbeat_at < now() - interval '7 days'`);
  const total = result.containers + result.networks + result.folders + result.slots;
  if (total) log.info('sandbox_swept', { count: total });
  return result;
}

/**
 * Removes the labelled containers (first, so their networks can go), networks and temporary folders of these owners.
 * A code runner machine (src/runner/housekeeping.ts) passes the owners of its earlier processes.
 */
export async function removeOwned(dead: ReadonlySet<string>, o: { docker?: Docker | null; tmp?: string } = {}): Promise<SweepResult> {
  const gone = (id: string) => dead.has(id);
  const result: SweepResult = { containers: 0, networks: 0, folders: 0, slots: 0 };
  if (!dead.size) return result;
  const docker = o.docker === undefined ? dockerCli : o.docker;
  if (docker) {
    try {
      // Labelled dittoly.*; each removed once.
      const seen = new Set<string>();
      for (const label of ['dittoly']) {
        const containers = (await docker(['ps', '-a', '--filter', `label=${label}.sandbox=1`, '--format', `{{.ID}}\t{{.Label "${label}.owner"}}`])).split('\n').filter(Boolean);
        for (const line of containers) {
          const [id, by] = line.split('\t');
          if (!id || seen.has(id)) continue;
          seen.add(id);
          if (gone(by ?? '') && (await docker(['rm', '-f', id]).then(() => true, () => false))) result.containers++;
        }
      }
      for (const label of ['dittoly']) {
        const networks = (await docker(['network', 'ls', '--filter', `label=${label}.sandbox=1`, '--format', `{{.ID}}\t{{.Label "${label}.owner"}}`])).split('\n').filter(Boolean);
        for (const line of networks) {
          const [id, by] = line.split('\t');
          if (!id || seen.has(id)) continue;
          seen.add(id);
          if (gone(by ?? '') && (await docker(['network', 'rm', id]).then(() => true, () => false))) result.networks++;
        }
      }
    } catch (err) {
      log.warn('sandbox_sweep_docker_failed', { errorType: (err as { code?: string }).code ?? 'docker' });
    }
  }
  const prefixes = new Set([...dead].map((id) => id.slice(0, 8)));
  const dir = o.tmp ?? tmpdir();
  // Folders made under the old prefix (src/core/old-prefixes.ts) are swept too.
  const name = new RegExp(`^(?:dty|${OLD})-(?:${SANDBOX_DIR_KINDS.join('|')})-([0-9a-f]{8})-`);
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const m = name.exec(entry);
    if (!m || !prefixes.has(m[1]!)) continue;
    const full = path.join(dir, entry);
    if (!(await stat(full).catch(() => null))?.isDirectory()) continue;
    await rm(full, { recursive: true, force: true }).then(() => result.folders++, () => undefined);
  }
  return result;
}

// ---------------------------------------------------------------- slots

/** One of `slots` code sandboxes for this step, or null when all are taken (the slot number otherwise). */
export async function acquireSlot(db: Queryable, slots: number, runId: string, stepId: string, owner = SANDBOX_OWNER): Promise<number | null> {
  await db.query(`INSERT INTO sandbox_slots (slot) SELECT generate_series(0, $1 - 1) ON CONFLICT (slot) DO NOTHING`, [slots]);
  const row = (
    await db.query<{ slot: number }>(
      `UPDATE sandbox_slots SET owner = $2, run_id = $3, step_id = $4, until = now() + make_interval(secs => $5)
        WHERE slot = (
          SELECT slot FROM sandbox_slots
           WHERE slot < $1 AND (until IS NULL OR until < now() OR (run_id = $3 AND step_id = $4))
           ORDER BY slot LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING slot`,
      [slots, owner, runId, stepId, SLOT_LEASE_MS / 1000],
    )
  ).rows[0];
  return row?.slot ?? null;
}

export async function renewSlot(db: Queryable, slot: number, runId: string, stepId: string): Promise<void> {
  await db.query(`UPDATE sandbox_slots SET until = now() + make_interval(secs => $4) WHERE slot = $1 AND run_id = $2 AND step_id = $3`, [slot, runId, stepId, SLOT_LEASE_MS / 1000]);
}

export async function releaseSlot(db: Queryable, slot: number, runId: string, stepId: string): Promise<void> {
  await db.query(`UPDATE sandbox_slots SET owner = NULL, run_id = NULL, step_id = NULL, until = NULL WHERE slot = $1 AND run_id = $2 AND step_id = $3`, [slot, runId, stepId]);
}

/** The slots in use now and the runs waiting for one: for the admin's queue view. */
export async function slotUse(db: Queryable, slots: number): Promise<{ slots: number; busy: number; waiting: number }> {
  const busy = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sandbox_slots WHERE slot < $1 AND until > now()`, [slots])).rows[0]!.n;
  const waiting = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs WHERE status = 'waiting' AND wait_reason = 'sandbox_busy'`)).rows[0]!.n;
  return { slots, busy, waiting };
}

// ---------------------------------------------------------------- images

/**
 * Notes that a step is about to run on this image. The first time, an image already on the host is
 * remembered as not Dittoly's (never removed); one that is not is Dittoly's to pull, and to remove later.
 */
export async function recordImageUse(db: Queryable, image: string, o: { docker?: Docker } = {}): Promise<void> {
  const known = (await db.query(`UPDATE sandbox_images SET last_used_at = now() WHERE image = $1`, [image])).rowCount;
  if (known) return;
  const docker = o.docker ?? dockerCli;
  const present = await docker(['image', 'inspect', '--format', '{{.Id}}', image]).then(() => true, () => false);
  await db.query(`INSERT INTO sandbox_images (image, pulled) VALUES ($1, $2) ON CONFLICT (image) DO UPDATE SET last_used_at = now()`, [image, !present]);
}

/** Removes the images Dittoly pulled that no step used for `ttlHours` (0: never). An image a container still uses stays. */
export async function removeUnusedImages(db: Queryable, ttlHours: number, o: { docker?: Docker } = {}): Promise<string[]> {
  if (ttlHours <= 0) return [];
  const docker = o.docker ?? dockerCli;
  const stale = (await db.query<{ image: string }>(`SELECT image FROM sandbox_images WHERE pulled AND last_used_at < now() - make_interval(hours => $1)`, [ttlHours])).rows;
  const removed: string[] = [];
  for (const { image } of stale) {
    // Without --force: Docker refuses while a container uses it, or when the tag is gone already.
    const ok = await docker(['image', 'rm', image]).then(() => true, async (err: unknown) => /No such image/i.test(String((err as { stderr?: string }).stderr ?? err)));
    if (!ok) continue;
    await db.query(`DELETE FROM sandbox_images WHERE image = $1 AND last_used_at < now() - make_interval(hours => $2)`, [image, ttlHours]);
    removed.push(image);
  }
  if (removed.length) log.info('sandbox_images_removed', { count: removed.length });
  return removed;
}

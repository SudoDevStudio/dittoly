import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../core/log.js';
import { dockerCli, removeOwned, type Docker } from '../engine/sandbox-housekeeping.js';
import { SANDBOX_OWNER } from '../sandbox/owner.js';

/**
 * A code runner's own housekeeping, without a database (the runner has none): a small state folder remembers
 * the owner ids of its processes and the step images it pulled.
 * - At start, what earlier runner processes left (crashed or killed mid-step) is removed: their labelled
 *   containers, networks and temporary folders. Resources of other owners (a Dittoly server on the same
 *   Docker host) are never touched.
 * - Step images the runner pulled are removed after `ttlHours` unused; images that were there before are kept.
 */

interface State {
  owners: string[];
  images: Record<string, { pulled: boolean; lastUsedAt: number }>;
}

export class RunnerHousekeeping {
  private state: State = { owners: [], images: {} };
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly o: { ttlHours: number; docker?: Docker; tmp?: string },
  ) {}

  private get file(): string {
    return path.join(this.dir, 'state.json');
  }

  /** Reads the state, removes what earlier processes left and records this one. */
  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>;
      this.state = { owners: Array.isArray(parsed.owners) ? parsed.owners.filter((x) => typeof x === 'string') : [], images: parsed.images && typeof parsed.images === 'object' ? parsed.images : {} };
    } catch {
      // first start, or an unreadable file: nothing remembered
    }
    const earlier = new Set(this.state.owners.filter((id) => id !== SANDBOX_OWNER));
    const removed = await removeOwned(earlier, { docker: this.o.docker, tmp: this.o.tmp });
    const total = removed.containers + removed.networks + removed.folders;
    if (total) log.info('runner_swept', { count: total });
    this.state.owners = [SANDBOX_OWNER];
    await this.save();
  }

  /** Before a step's containers run on an image: the first time, whether it was already there. */
  async onImage(image: string): Promise<void> {
    const known = this.state.images[image];
    if (known) known.lastUsedAt = Date.now();
    else {
      const docker = this.o.docker ?? dockerCli;
      const present = await docker(['image', 'inspect', '--format', '{{.Id}}', image]).then(() => true, () => false);
      this.state.images[image] = { pulled: !present, lastUsedAt: Date.now() };
    }
    await this.save();
  }

  /** Removes the images this runner pulled that no step used for ttlHours (0: never). */
  async removeUnusedImages(now = Date.now()): Promise<string[]> {
    if (this.o.ttlHours <= 0) return [];
    const docker = this.o.docker ?? dockerCli;
    const removed: string[] = [];
    for (const [image, use] of Object.entries(this.state.images)) {
      if (!use.pulled || now - use.lastUsedAt < this.o.ttlHours * 3_600_000) continue;
      // Without --force: Docker refuses while a container uses it.
      const ok = await docker(['image', 'rm', image]).then(() => true, async (err: unknown) => /No such image/i.test(String((err as { stderr?: string }).stderr ?? err)));
      if (!ok) continue;
      delete this.state.images[image];
      removed.push(image);
    }
    if (removed.length) {
      log.info('runner_images_removed', { count: removed.length });
      await this.save();
    }
    return removed;
  }

  private save(): Promise<void> {
    const write = async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
      await rename(tmp, this.file);
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }
}

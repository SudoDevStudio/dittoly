import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { AppRunner, dockerRunArgs } from '../src/engine/apps.js';
import { acquireSlot, heartbeat, recordImageUse, releaseSlot, removeUnusedImages, renewSlot, slotUse, sweep, type Docker } from '../src/engine/sandbox-housekeeping.js';
import { proxyRunArgs } from '../src/mcp/stdio.js';
import { browserRunArgs } from '../src/sandbox/browser.js';
import { SANDBOX_OWNER } from '../src/sandbox/owner.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * Code sandboxes stay bounded and tidy: at most DITTOLY_CODE_SANDBOXES app and fix steps build and test
 * at once (the rest wait their turn, without holding a run slot); what a crashed server left behind is
 * removed, and only that installation's; step images Dittoly pulled go when unused for a day.
 */
const ai = new MockProvider();
let w: World;
let base: string;
let repo: string;
const DEAD = '0dead000-0000-4000-8000-000000000000';
const OTHER_INSTALL = '0ther000-0000-4000-8000-000000000000';

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'dty-housekeeping-'));
  repo = path.join(base, 'repo');
  await mkdir(repo);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
  execFileSync('sh', ['-c', 'echo "exports.ok = 1" > lib.js && echo "process.exit(0)" > test.js'], { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  const apps = new AppRunner({
    mode: 'local',
    internalHosts: ['git.example.com'],
    directAllowed: async () => true,
    dockerAvailable: async () => false,
    clone: async (_u, ref, _t, dir) => {
      execFileSync('git', ['clone', '-q', '--branch', ref, `file://${repo}`, path.join(dir, 'src')], { stdio: 'ignore' });
      return 'c0ffee'.padEnd(40, '0');
    },
  });
  w = await makeWorld({ mode: 'local', codeSandboxes: 1, internalHosts: ['git.example.com'] }, { apps, ai });
});
afterAll(async () => {
  await w.db.end();
  await rm(base, { recursive: true, force: true });
});

describe('code sandbox slots', () => {
  it('gives out at most N; a step keeps its own; an expired or released one is free again', async () => {
    expect(await acquireSlot(w.db, 2, '00000000-0000-4000-8000-000000000001', 'a')).toBe(0);
    expect(await acquireSlot(w.db, 2, '00000000-0000-4000-8000-000000000002', 'a')).toBe(1);
    expect(await acquireSlot(w.db, 2, '00000000-0000-4000-8000-000000000003', 'a')).toBeNull();
    // The same step asking again (its job was taken over after a lost lease) gets its slot back.
    expect(await acquireSlot(w.db, 2, '00000000-0000-4000-8000-000000000001', 'a')).toBe(0);
    expect(await slotUse(w.db, 2)).toMatchObject({ slots: 2, busy: 2 });
    await renewSlot(w.db, 1, '00000000-0000-4000-8000-000000000002', 'a');
    await releaseSlot(w.db, 0, '00000000-0000-4000-8000-000000000001', 'a');
    // A holder that stopped renewing (its lease ran out) loses it.
    await w.db.query(`UPDATE sandbox_slots SET until = now() - interval '1 second' WHERE slot = 1`);
    expect(await acquireSlot(w.db, 2, '00000000-0000-4000-8000-000000000003', 'a')).toBe(0);
    expect(await acquireSlot(w.db, 2, '00000000-0000-4000-8000-000000000004', 'a')).toBe(1);
    await w.db.query(`UPDATE sandbox_slots SET owner = NULL, run_id = NULL, step_id = NULL, until = NULL`);
  });

  it('a fix step waits for a free sandbox (sandbox_busy) without counting an attempt, then runs', async () => {
    const def = {
      steps: [{ id: 'fix', type: 'fix', ai: 'organization', repo: 'https://git.example.com/acme/shop.git', ref: 'main', install: 'true', test: 'node test.js', instruction: 'Fix it' }],
    };
    const v = await w.app.flows.create('Fix when free', def, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    // The one sandbox is taken by another run's step.
    expect(await acquireSlot(w.db, 1, '00000000-0000-4000-8000-0000000000aa', 'other')).toBe(0);
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    let r = await runStatus(w, runId, w.alice);
    expect(r.status).toBe('waiting');
    expect(r.outcome.reason).toContain('a free code sandbox');
    const row = (await w.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM run_steps WHERE run_id = $1`, [runId])).rows[0]!;
    expect(row).toEqual({ status: 'pending', attempts: 0 });
    expect(await slotUse(w.db, 1)).toEqual({ slots: 1, busy: 1, waiting: 1 });

    // Freed: the run goes on at its next try.
    await releaseSlot(w.db, 0, '00000000-0000-4000-8000-0000000000aa', 'other');
    await w.db.query(`UPDATE run_steps SET resume_at = now() WHERE run_id = $1`, [runId]);
    await w.db.query(`UPDATE jobs SET run_at = now() WHERE kind = 'advance' AND payload->>'runId' = $1`, [runId]);
    ai.enqueue({ action: 'done', path: '', content: '', query: '', command: '', summary: 'Nothing to change.', regressionTest: '' });
    await w.app.worker.drain();
    r = await runStatus(w, runId, w.alice);
    expect(r.status, JSON.stringify(r.steps)).toBe('succeeded');
    // Its slot is free again.
    expect(await slotUse(w.db, 1)).toEqual({ slots: 1, busy: 0, waiting: 0 });
  });
});

describe('the sweep after a crash', () => {
  it('removes containers, networks, folders and slots of this installation\'s owners that stopped renewing, only theirs', async () => {
    await heartbeat(w.db);
    await heartbeat(w.db, DEAD);
    await w.db.query(`UPDATE sandbox_owners SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [DEAD]);
    await acquireSlot(w.db, 1, '00000000-0000-4000-8000-0000000000bb', 'x', DEAD);
    const calls: string[][] = [];
    const docker: Docker = async (args) => {
      calls.push(args);
      if (args[0] === 'ps') return `c-mine\t${SANDBOX_OWNER}\nc-dead\t${DEAD}\nc-other\t${OTHER_INSTALL}\n`;
      if (args[0] === 'network' && args[1] === 'ls') return `n-dead\t${DEAD}\nn-mine\t${SANDBOX_OWNER}\n`;
      return '';
    };
    const tmp = await mkdtemp(path.join(base, 'tmp-'));
    for (const d of [`dty-fix-${DEAD.slice(0, 8)}-a1`, `dty-env-${DEAD.slice(0, 8)}-b2`, `dty-fix-${SANDBOX_OWNER.slice(0, 8)}-c3`, `dty-app-${OTHER_INSTALL.slice(0, 8)}-d4`, 'dty-fix-unrelated']) await mkdir(path.join(tmp, d));
    expect(await sweep(w.db, { docker, tmp })).toEqual({ containers: 1, networks: 1, folders: 2, slots: 1 });
    expect(calls.filter((c) => c[0] === 'rm' || c[1] === 'rm')).toEqual([['rm', '-f', 'c-dead'], ['network', 'rm', 'n-dead']]);
    expect((await readdir(tmp)).sort()).toEqual([`dty-app-${OTHER_INSTALL.slice(0, 8)}-d4`, `dty-fix-${SANDBOX_OWNER.slice(0, 8)}-c3`, 'dty-fix-unrelated']);
    // Without Docker it still tidies the folders and slots.
    expect(await sweep(w.db, { docker: null, tmp })).toEqual({ containers: 0, networks: 0, folders: 0, slots: 0 });
  });

  it('every sandbox container and proxy carries the owner labels', () => {
    const labels = ['--label', 'dittoly.sandbox=1', '--label', `dittoly.owner=${SANDBOX_OWNER}`];
    for (const args of [
      dockerRunArgs({ src: '/s', image: 'node:26', cmd: 'npm ci', network: 'n' }),
      proxyRunArgs({ name: 'p', image: 'node:26-alpine', allow: [], allowPrivate: [] }),
      browserRunArgs({ name: 'b', image: 'pw', network: null, driverScript: '/d.mjs', playwrightDir: '/pw' }),
    ]) {
      expect(args.join(' ')).toContain(labels.join(' '));
    }
  });
});

describe('step images', () => {
  it('only images Dittoly pulled are removed, after the time unused; one in use stays', async () => {
    const present = new Set(['postgres:16']);
    const removed: string[] = [];
    const docker: Docker = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') {
        if (present.has(args.at(-1)!)) return 'sha256:x';
        throw Object.assign(new Error('no such image'), { stderr: 'Error: No such image' });
      }
      if (args[0] === 'image' && args[1] === 'rm') {
        if (args[2] === 'golang:1.27') throw Object.assign(new Error('in use'), { stderr: 'image is being used by running container' });
        removed.push(args[2]!);
      }
      return '';
    };
    for (const image of ['postgres:16', 'maven:3-eclipse-temurin-25', 'golang:1.27', 'rust:1.99-slim']) await recordImageUse(w.db, image, { docker });
    expect((await w.db.query(`SELECT image, pulled FROM sandbox_images ORDER BY image`)).rows).toEqual([
      { image: 'golang:1.27', pulled: true },
      { image: 'maven:3-eclipse-temurin-25', pulled: true },
      { image: 'postgres:16', pulled: false },
      { image: 'rust:1.99-slim', pulled: true },
    ]);
    await w.db.query(`UPDATE sandbox_images SET last_used_at = now() - interval '25 hours' WHERE image <> 'rust:1.99-slim'`);
    expect(await removeUnusedImages(w.db, 0, { docker })).toEqual([]);
    expect(await removeUnusedImages(w.db, 24, { docker })).toEqual(['maven:3-eclipse-temurin-25']);
    expect(removed).toEqual(['maven:3-eclipse-temurin-25']);
    expect((await w.db.query(`SELECT image FROM sandbox_images ORDER BY image`)).rows.map((r) => r.image)).toEqual(['golang:1.27', 'postgres:16', 'rust:1.99-slim']);
  });
});

const dockerUp = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerUp)('the sweep in Docker', () => {
  it('removes a crashed owner\'s running container and network, and leaves this process\'s', async () => {
    const label = (owner: string) => ['--label', 'dittoly.sandbox=1', '--label', `dittoly.owner=${owner}`];
    execFileSync('docker', ['network', 'create', '--internal', ...label(DEAD), 'dty-sweep-dead'], { stdio: 'ignore' });
    execFileSync('docker', ['run', '-d', '--rm', '--name', 'dty-sweep-dead', '--network', 'dty-sweep-dead', ...label(DEAD), 'node:26-alpine', 'sleep', '300'], { stdio: 'ignore' });
    execFileSync('docker', ['run', '-d', '--rm', '--name', 'dty-sweep-mine', ...label(SANDBOX_OWNER), 'node:26-alpine', 'sleep', '300'], { stdio: 'ignore' });
    try {
      await heartbeat(w.db, DEAD);
      await w.db.query(`UPDATE sandbox_owners SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [DEAD]);
      await sweep(w.db, { tmp: base });
      const names = execFileSync('docker', ['ps', '-a', '--filter', 'label=dittoly.sandbox=1', '--format', '{{.Names}}']).toString();
      expect(names).not.toContain('dty-sweep-dead');
      expect(names).toContain('dty-sweep-mine');
      expect(execFileSync('docker', ['network', 'ls', '--format', '{{.Name}}']).toString()).not.toContain('dty-sweep-dead');
    } finally {
      execFileSync('docker', ['rm', '-f', 'dty-sweep-mine', 'dty-sweep-dead'], { stdio: 'ignore' });
      execFileSync('sh', ['-c', 'docker network rm dty-sweep-dead 2>/dev/null || true']);
    }
  }, 120_000);
});

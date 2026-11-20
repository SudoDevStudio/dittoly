import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { AppRunner } from '../src/engine/apps.js';
import { runFixStep } from '../src/engine/fix.js';
import { fixStepSchema } from '../src/flows/definition.js';
import { EGRESS_NETWORK } from '../src/mcp/stdio.js';
import { testCa } from './toolchain-ca.js';

/**
 * Each language's fix step in real containers, through the egress proxy, as the error-to-fix templates
 * run it: install, build, the AI's fix (scripted), and Dittoly's checks. Every project has the same bug
 * (a cart total that ignores the quantity) and a test suite that passes with it; the fix and a regression
 * test come from test/fixtures/toolchains/<id>/fix. Pulls large images, so it runs only when asked:
 * DTY_TOOLCHAINS=all, or a comma-separated list of ids (test/fixtures/flows/toolchains.json).
 */
interface Toolchain {
  id: string;
  image: string;
  install?: string;
  build?: string;
  test: string;
  testFile: string;
}
const root = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(root, 'test', 'fixtures', 'toolchains');
const { toolchains } = JSON.parse(await readFile(path.join(root, 'test', 'fixtures', 'flows', 'toolchains.json'), 'utf8')) as { toolchains: Toolchain[] };
const asked = (process.env.DTY_TOOLCHAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const docker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();
const selected = toolchains.filter((t) => asked.includes('all') || asked.includes(t.id));

async function filesUnder(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await filesUnder(dir, p)));
    else out.push(p);
  }
  return out;
}

let base: string;
beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'dty-toolchains-'));
  if (!docker || !selected.length) return;
  try {
    execFileSync('docker', ['network', 'create', EGRESS_NETWORK], { stdio: 'ignore' });
  } catch {
    // exists
  }
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe.skipIf(!docker || !selected.length)('fix step per language in Docker', () => {
  for (const t of selected) {
    it(`${t.id}: installs, builds, shows the bug with the regression test, and verifies the fix`, async () => {
      const meta = JSON.parse(await readFile(path.join(fixtures, t.id, 'meta.json'), 'utf8')) as { regressionTest: string };
      const repo = path.join(base, t.id);
      await cp(path.join(fixtures, t.id, 'repo'), repo, { recursive: true });
      const env = await testCa(repo);
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'shop');

      const ai = new MockProvider();
      const act = (a: Record<string, string>) => ({ action: 'list', path: '', content: '', query: '', command: '', summary: '', regressionTest: '', ...a });
      const fixDir = path.join(fixtures, t.id, 'fix');
      for (const f of await filesUnder(fixDir)) ai.enqueue(act({ action: 'write', path: f, content: await readFile(path.join(fixDir, f), 'utf8') }));
      ai.enqueue(act({ action: 'run', command: meta.regressionTest }));
      ai.enqueue(act({ action: 'done', summary: 'The total now counts the quantity.', regressionTest: meta.regressionTest }));

      const apps = new AppRunner({
        mode: 'shared',
        internalHosts: [],
        directAllowed: async () => false,
        clone: async (_u, ref, _t, dir) => {
          execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', ref, `file://${repo}`, path.join(dir, 'src')], { stdio: 'ignore' });
          return 'c0ffee'.padEnd(40, '0');
        },
      });
      const step = fixStepSchema.parse({
        id: 'fix',
        type: 'fix',
        ai: 'organization',
        repo: 'https://github.com/acme/shop.git',
        ref: 'main',
        image: t.image,
        install: t.install,
        build: t.build,
        test: t.test,
        testFile: t.testFile,
        instruction: 'Fix it',
        env,
        timeoutSeconds: 1200,
      });
      const out = await runFixStep(step, { repo: 'https://github.com/acme/shop.git', ref: 'main', instruction: 'Fix it', context: {}, onlyFilesIn: null }, { apps, provider: ai, runId: `tc-${t.id}`, token: null, secrets: {}, keepAlive: async () => undefined });
      expect(out.verified, out.logTail).toEqual({ buildOk: true, reproducedBefore: null, regressionTestFailsBefore: true, regressionTestPassesAfter: true, reproducedAfter: null, testsPassAfter: true });
      expect(out.limits, out.logTail).toEqual({ ok: true, violations: [] });
      expect(out.confidence.level).toBe('high');
      // Each phase reached only the git host and the package registries.
      expect(out.network.phases.map((p) => p.phase)).toEqual(['install', 'build', 'test'].filter((p) => p !== 'build' || t.build));
      // In CI one runner tests every toolchain: its image goes once its test is done, to keep the disk free.
      if (process.env.CI) execFileSync('docker', ['image', 'rm', '-f', t.image], { stdio: 'ignore' });
    }, 1_800_000);
  }
});

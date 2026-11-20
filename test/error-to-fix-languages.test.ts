import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeam, setTeamMember } from '../src/core/teams.js';
import { makeWorld, type World } from './helpers.js';

/**
 * The error-to-fix templates for each language (scripts/error-to-fix-templates.mjs writes them from the
 * Node.js one and test/fixtures/flows/toolchains.json): up to date, valid, and approvable with the app-errors
 * module. Each toolchain's commands run in Docker in toolchains-docker.test.ts; the steps they share with
 * the Node.js template run end to end in error-to-fix-node-loki.test.ts.
 */
const root = path.resolve(import.meta.dirname, '..');
const examples = path.join(root, 'test', 'fixtures');
const MODULES = ['error-fix-policy', 'github-fix', 'loki-lan', 'app-errors', 'slack'];
const { toolchains } = JSON.parse(await readFile(path.join(examples, 'flows', 'toolchains.json'), 'utf8')) as { toolchains: { id: string; image: string; test: string; testFile: string }[] };

let w: World;
let team = '';
beforeAll(async () => {
  w = await makeWorld({ insecureHttpHosts: ['192.168.1.20:3100'], internalHosts: ['192.168.1.20:3100'] });
  team = (await createTeam(w.db, w.admin, 'Shop')).id;
  await setTeamMember(w.db, w.admin, team, w.alice.id, 'member');
  for (const name of MODULES) {
    const dir = path.join(examples, 'modules', name);
    const m = {
      manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
      code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
      tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
    };
    const mv = await w.app.modules.createDraft({ ...m, origin: 'seed' } as never, w.alice);
    if (!mv.validationReport?.passed) throw new Error(`${name} failed validation: ${JSON.stringify(mv.validationReport)}`);
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
  }
  // The tables the error-to-fix Flows write to.
  const tables: [string, [string, string][]][] = [
    ['error_fixes', [['status', 'text'], ['service', 'text'], ['message', 'text'], ['times_seen', 'number'], ['first_seen', 'date'], ['last_seen', 'date'], ['attempts', 'number'], ['branch', 'text'], ['last_attempt', 'date'], ['last_comment_at', 'date'], ['mr_url', 'text'], ['mr_iid', 'number'], ['mr_opened_at', 'date'], ['previous_mr_url', 'text'], ['note', 'text']]],
    ['error_fix_evidence', [['logs', 'text'], ['source', 'text'], ['captured_at', 'date']]],
  ];
  for (const [name, columns] of tables) {
    await w.app.tables.create(w.admin, { teamId: team, name, keyColumn: 'fingerprint', columns: columns.map(([n, type]) => ({ name: n, type })) as never });
  }
}, 180_000);
afterAll(async () => {
  await w.db.end();
});

describe('error-to-fix templates for each language', () => {
  it('are what the script writes from the Node.js template and the toolchains', () => {
    expect(() => execFileSync(process.execPath, [path.join(root, 'scripts', 'error-to-fix-templates.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  for (const t of toolchains) {
    it(`${t.id}: a valid Flow on app-errors with the toolchain's sandbox commands`, async () => {
      const tpl = JSON.parse(await readFile(path.join(examples, 'flows', `error-to-fix-${t.id}-loki-github.json`), 'utf8')) as { name: string; definition: { steps: Record<string, unknown>[] } };
      const steps = tpl.definition.steps;
      expect(steps.filter((s) => typeof s.module === 'string' && s.module.startsWith('node-errors'))).toEqual([]);
      expect(steps.find((s) => s.type === 'fix')).toMatchObject({ image: t.image, test: t.test, testFile: t.testFile });
      expect(JSON.stringify(tpl)).not.toMatch(/Node\.js|npm /);
      const v = await w.app.flows.create(tpl.name, tpl.definition, w.alice, undefined, team);
      expect(v.status).toBe('pending');
    });
  }
});

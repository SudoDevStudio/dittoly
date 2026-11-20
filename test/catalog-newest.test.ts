import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/** The AI drafts with each module's newest approved version; the full catalog (the visual editor's) keeps every one. */
let w: World;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  const dir = path.join(import.meta.dirname, 'fixtures', 'modules', 'jira');
  const mv = await w.app.modules.createDraft(
    {
      manifest: { ...JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')), version: '9.0.0' },
      code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
      tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
      origin: 'seed',
    },
    w.alice,
  );
  await w.app.modules.submit(mv.id, w.alice);
  await w.app.modules.decide(mv.id, w.admin, 'approved');
});
afterAll(async () => {
  await w.db.end();
});

describe('the AI catalog', () => {
  it('lists only the newest approved version of each module', async () => {
    const jira = (all: { module: string }[]) => [...new Set(all.filter((a) => a.module.startsWith('jira@')).map((a) => a.module))];
    const every = jira(await w.app.flowChat.catalog());
    const newest = jira(await w.app.flowChat.catalog({ newest: true }));
    expect(every).toHaveLength(2);
    expect(newest).toEqual([every.at(-1)]);
    // Other modules are still there.
    expect((await w.app.flowChat.catalog({ newest: true })).some((a) => a.module.startsWith('slack@'))).toBe(true);
  });
});

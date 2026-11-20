import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLogLevel } from '../src/core/log.js';
import { cleanupDb, cleanupLocal, KEEP_TABLES, WIPE_TABLES } from '../src/local/cleanup.js';
import { launch } from '../src/local/launcher.js';
import { MaintenanceError, withDb } from '../src/local/maintenance.js';
import { approvedReleaseFlow, approveExampleModules, giveAllCredentials, makeWorld, type World } from './helpers.js';
import { loadExampleModules } from './fixture-modules.js';

/**
 * `dittoly cleanup` starts the local install afresh: automation content and history go, access and settings stay,
 * and what the sandboxes left on the computer is removed.
 */
const count = async (db: World['db'], table: string) => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

describe('cleanup on the database', () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
    await approveExampleModules(w);
    await approvedReleaseFlow(w);
    await giveAllCredentials(w, w.alice);
  });
  afterAll(async () => {
    await w.db.end();
  });

  it('every table is either wiped or kept, never both: a new table needs a decision', async () => {
    const tables = (await w.db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name).sort();
    const listed = [...WIPE_TABLES, ...KEEP_TABLES];
    expect(new Set(listed).size).toBe(listed.length);
    expect(tables.filter((t) => !listed.includes(t as (typeof listed)[number]))).toEqual([]);
    expect(listed.filter((t) => !tables.includes(t)).sort()).toEqual([]);
  });

  it('removes modules, Flows, their runs and history and the sandboxes\' leftovers; keeps members, credentials and settings', async () => {
    const members = await count(w.db, 'members');
    const credentials = await count(w.db, 'credentials');
    expect(credentials).toBeGreaterThan(0);
    expect(await count(w.db, 'module_versions')).toBeGreaterThan(0);
    // A sandbox process of this database that is gone, with a container, a network and an image it pulled; and a
    // container of another installation.
    await w.db.query(`INSERT INTO sandbox_owners (id, heartbeat_at) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', now())`);
    await w.db.query(`INSERT INTO sandbox_images (image, pulled) VALUES ('python:3.14-slim', true), ('mine:local', false)`);
    const calls: string[] = [];
    const docker = async (args: string[]) => {
      calls.push(args.join(' '));
      if (args[0] === 'ps') return 'c1\taaaaaaaa-0000-0000-0000-000000000001\nc2\tffffffff-0000-0000-0000-00000000000f\n';
      if (args[0] === 'network' && args[1] === 'ls') return 'n1\taaaaaaaa-0000-0000-0000-000000000001\n';
      return '';
    };

    const r = await cleanupDb(w.db, { docker });

    expect(r).toMatchObject({ modules: 3, flows: 1, containers: 1, networks: 1, images: ['python:3.14-slim'] });
    expect(calls).toEqual(expect.arrayContaining(['rm -f c1', 'network rm n1', 'image rm python:3.14-slim']));
    expect(calls).not.toContain('rm -f c2');
    expect(calls).not.toContain('image rm mine:local');
    for (const t of WIPE_TABLES.filter((t) => t !== 'audit_events')) expect(await count(w.db, t), t).toBe(0);
    expect((await w.db.query<{ action: string }>(`SELECT action FROM audit_events`)).rows).toEqual([{ action: 'local.cleanup' }]);
    expect(await count(w.db, 'members')).toBe(members);
    expect(await count(w.db, 'credentials')).toBe(credentials);
  });
});

describe('dittoly cleanup on the local install', () => {
  it('needs Dittoly stopped; afterwards it starts with no modules and the same credentials', async () => {
    setLogLevel('error');
    const home = mkdtempSync(path.join(tmpdir(), 'dty-home-'));
    const port = () => String(20000 + Math.floor(Math.random() * 20000));
    const first = await launch(['--home', home, '--port', port()]);
    try {
      await loadExampleModules(first.app, first.member, first.member, ['gitlab', 'slack']);
      const cookie = (await fetch(first.signIn, { redirect: 'manual' })).headers.getSetCookie()[0]!.split(';')[0]!;
      const put = await fetch(`${first.url}/api/me/credentials/gitlab`, {
        method: 'PUT',
        headers: { cookie, 'x-dittoly-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 'glpat-mine' }),
      });
      expect(put.status).toBe(204);
      await expect(cleanupLocal(home, { docker: null })).rejects.toBeInstanceOf(MaintenanceError);
    } finally {
      await first.stop();
    }

    const r = await cleanupLocal(home, { docker: null });
    expect(r.modules).toBeGreaterThan(0);
    const after = await withDb(home, async (db) => ({ modules: await count(db, 'module_versions'), credentials: await count(db, 'credentials') }));
    expect(after).toEqual({ modules: 0, credentials: 1 });

    const again = await launch(['--home', home, '--port', port()]);
    try {
      const cookie = (await fetch(again.signIn, { redirect: 'manual' })).headers.getSetCookie()[0]!.split(';')[0]!;
      expect((await fetch(`${again.url}/api/me`, { headers: { cookie } })).status).toBe(200);
    } finally {
      await again.stop();
    }
    await expect(cleanupLocal(path.join(home, 'missing'), { docker: null })).rejects.toThrow(/no Dittoly data/);
  }, 180_000);
});

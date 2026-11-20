import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { launch } from '../src/local/launcher.js';
import { startEmbeddedPostgres } from '../src/local/pglite.js';
import { createDb } from '../src/db/db.js';
import { setLogLevel } from '../src/core/log.js';
import { loadExampleModules } from './fixture-modules.js';

describe('single-user local install (embedded Postgres)', () => {
  it('starts on PGlite, signs in with the printed link, keeps data across restarts, and rotates the link', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dty-home-'));
    const port = String(20000 + Math.floor(Math.random() * 20000));

    const first = await launch(['--home', home, '--port', port]);
    try {
      expect(statSync(path.join(home, 'master.key')).mode & 0o777).toBe(0o600);
      // The embedded database has no password, so it listens only on a socket in an owner-only directory.
      expect(statSync(path.join(home, 'run')).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(home, 'run', '.s.PGSQL.5432')).isSocket()).toBe(true);
      const signIn = await fetch(first.signIn, { redirect: 'manual' });
      expect(signIn.status).toBe(302);
      const cookie = signIn.headers.getSetCookie()[0]!.split(';')[0]!;
      const me = await (await fetch(`${first.url}/api/me`, { headers: { cookie } })).json();
      expect(me.role).toBe('admin');
      const modules = await (await fetch(`${first.url}/api/modules`, { headers: { cookie } })).json();
      // No ready-made modules: the AI drafts them on request.
      expect(modules).toEqual([]);
      await loadExampleModules(first.app, first.member, first.member, ['slack']);
      // Local mode refuses shared-mode-only behaviour such as adding members.
      const add = await fetch(`${first.url}/api/members`, {
        method: 'POST',
        headers: { cookie, 'x-dittoly-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ handle: 'other', role: 'member' }),
      });
      expect(add.status).toBe(409);
    } finally {
      await first.stop();
    }

    const second = await launch(['--home', home, '--port', port]);
    try {
      expect((await fetch(first.signIn, { redirect: 'manual' })).status).toBe(401);
      const signIn = await fetch(second.signIn, { redirect: 'manual' });
      const cookie = signIn.headers.getSetCookie()[0]!.split(';')[0]!;
      const modules = await (await fetch(`${second.url}/api/modules`, { headers: { cookie } })).json();
      expect(modules.map((m: { name: string; status: string }) => [m.name, m.status])).toEqual([['slack', 'approved']]); // kept across the restart
    } finally {
      await second.stop();
      setLogLevel('info');
    }
  }, 120_000);

  it('a home too deep for a Unix socket path (e.g. a nested app folder) uses a private temp directory, removed on stop', async () => {
    const deep = path.join(mkdtempSync(path.join(tmpdir(), 'dty-deep-')), 'apps', 'api', 'dittoly.git', 'x'.repeat(60));
    mkdirSync(deep, { recursive: true });
    const pg = await startEmbeddedPostgres(path.join(deep, 'pgdata'), { socketDir: path.join(deep, 'run') });
    const socketDir = new URL(pg.url).searchParams.get('host')!;
    try {
      expect(socketDir.startsWith(tmpdir())).toBe(true);
      expect(statSync(socketDir).mode & 0o777).toBe(0o700);
      const db = createDb(pg.url, 1);
      expect((await db.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
      await db.end();
    } finally {
      await pg.stop();
    }
    expect(existsSync(socketDir)).toBe(false);
  }, 60_000);
});

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setLogLevel } from '../src/core/log.js';
import { ENCRYPTED_COLUMNS, keyMatches, rotateMasterKey } from '../src/core/rekey.js';
import { createDb } from '../src/db/db.js';
import { launch } from '../src/local/launcher.js';
import { backup, MaintenanceError, openBackup, restore, rotateLocalKey, sealBackup, settlePendingKey } from '../src/local/maintenance.js';
import { startEmbeddedPostgres } from '../src/local/pglite.js';
import { approvedReleaseFlow, approveExampleModules, giveAllCredentials, makeWorld, releaseInputs, testConfig, type World } from './helpers.js';

describe('master-key rotation', () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
    await approveExampleModules(w);
    await giveAllCredentials(w, w.alice);
    const version = await approvedReleaseFlow(w);
    // Encrypted values in as many places as possible: credentials, trigger secrets, run inputs and outputs, schedules.
    await w.app.webhooks.create({ flowVersionId: version.id, provider: 'standard', payloadSchema: {}, inputMap: {} }, w.alice);
    await w.app.scheduler.create({ flowVersionId: version.id, cron: '0 9 * * *', timezone: 'UTC', inputs: releaseInputs }, w.alice);
    await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
  });
  afterAll(() => w.db.end());

  it('a file that is not a Dittoly backup is refused', async () => {
    await expect(openBackup(Buffer.from('OTHER-BACKUP-1\n{}\n'), 'old passphrase')).rejects.toThrow(/not a Dittoly backup/);
  });

  it('covers every encrypted column in the schema', async () => {
    const { rows } = await w.db.query<{ t: string; c: string }>(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name LIKE '%\\_enc' ORDER BY 1, 2`,
    );
    const covered = new Set(ENCRYPTED_COLUMNS.map((x) => `${x.table}.${x.column}`));
    expect(rows.map((r) => `${r.t}.${r.c}`).filter((c) => !covered.has(c))).toEqual([]);
  });

  it('re-encrypts everything with the new key; the old key no longer opens anything', async () => {
    const oldKey = (w.app.config as { masterKey: Buffer }).masterKey;
    const newKey = randomBytes(32);
    const { values } = await rotateMasterKey(w.db, oldKey, newKey);
    expect(values).toBeGreaterThan(5);
    expect(await keyMatches(w.db, newKey)).toBe(true);
    expect(await keyMatches(w.db, oldKey)).toBe(false);
    // A server started with the new key reads what the old one wrote.
    const after = buildApp(testConfig({ masterKey: newKey }), w.db, { ai: null });
    expect(await after.vault.reveal(w.alice.id, 'gitlab')).toBe('glpat-alice');
    const schedule = (await w.db.query(`SELECT id, inputs_enc FROM schedules LIMIT 1`)).rows[0];
    expect(after.cipher.decryptJson(schedule.inputs_enc, `schedule:${schedule.id}:inputs`)).toEqual(releaseInputs);
  });

  it('with the wrong current key it fails and changes nothing', async () => {
    const before = (await w.db.query(`SELECT secret_enc FROM credentials ORDER BY service`)).rows;
    await expect(rotateMasterKey(w.db, randomBytes(32), randomBytes(32))).rejects.toThrow(/does not decrypt/);
    expect((await w.db.query(`SELECT secret_enc FROM credentials ORDER BY service`)).rows).toEqual(before);
  });
});

describe('local backup, restore and key rotation', () => {
  const PASS = 'correct horse battery staple';
  let home: string;
  let signIn: (h: string) => Promise<{ cookie: string; url: string; stop: () => Promise<void> }>;

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'dty-home-'));
    signIn = async (h) => {
      const port = String(20000 + Math.floor(Math.random() * 20000));
      const l = await launch(['--home', h, '--port', port]);
      const res = await fetch(l.signIn, { redirect: 'manual' });
      return { cookie: res.headers.getSetCookie()[0]!.split(';')[0]!, url: l.url, stop: l.stop };
    };
    const first = await signIn(home);
    try {
      const put = await fetch(`${first.url}/api/me/credentials/gitlab`, {
        method: 'PUT',
        headers: { cookie: first.cookie, 'x-dittoly-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 'glpat-mine' }),
      });
      expect(put.status).toBe(204);
      // Maintenance refuses while the server runs.
      await expect(backup(home, path.join(home, 'while-running.dtybackup'), PASS)).rejects.toThrow(/running/);
    } finally {
      await first.stop();
    }
  }, 120_000);
  afterAll(() => setLogLevel('info'));

  async function credentialWith(h: string): Promise<string | null> {
    const pg = await startEmbeddedPostgres(path.join(h, 'pgdata'), { socketDir: path.join(h, 'run') });
    const db = createDb(pg.url, 1);
    try {
      const key = Buffer.from(readFileSync(path.join(h, 'master.key'), 'utf8').trim(), 'base64');
      const app = buildApp(testConfig({ masterKey: key }), db, { ai: null });
      const me = (await db.query(`SELECT id FROM members LIMIT 1`)).rows[0];
      return await app.vault.reveal(me.id, 'gitlab');
    } finally {
      await db.end();
      await pg.stop();
    }
  }

  it('a backup restores on a fresh data directory, credentials included', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dty-bk-')), 'dittoly.dtybackup');
    await backup(home, file, PASS);
    expect(readFileSync(file).subarray(0, 17).toString()).toBe('DITTOLY-BACKUP-1\n');
    expect(readFileSync(file).includes(Buffer.from('glpat-mine'))).toBe(false);

    const fresh = path.join(mkdtempSync(path.join(tmpdir(), 'dty-restore-')), 'home');
    await expect(restore(fresh, file, 'wrong passphrase!!')).rejects.toThrow(/wrong passphrase/);
    expect(existsSync(path.join(fresh, 'master.key'))).toBe(false);
    await restore(fresh, file, PASS);
    expect(await credentialWith(fresh)).toBe('glpat-mine');
    const again = await signIn(fresh);
    try {
      expect((await fetch(`${again.url}/api/me`, { headers: { cookie: again.cookie } })).status).toBe(200);
    } finally {
      await again.stop();
    }
    // Never over existing data.
    await expect(restore(fresh, file, PASS)).rejects.toThrow(/already has Dittoly data/);
  }, 120_000);

  it('rejects short passphrases and tampered files', async () => {
    await expect(backup(home, path.join(home, 'short.dtybackup'), 'short')).rejects.toBeInstanceOf(MaintenanceError);
    const sealed = await sealBackup(Buffer.from('payload'), PASS);
    sealed[sealed.length - 20]! ^= 1;
    await expect(openBackup(sealed, PASS)).rejects.toThrow(/changed/);
  });

  it('rotate-key re-encrypts the local install and it still starts', async () => {
    const before = readFileSync(path.join(home, 'master.key'), 'utf8');
    const { values } = await rotateLocalKey(home);
    expect(values).toBeGreaterThan(0);
    expect(readFileSync(path.join(home, 'master.key'), 'utf8')).not.toBe(before);
    expect(existsSync(path.join(home, 'master.key.new'))).toBe(false);
    expect(await credentialWith(home)).toBe('glpat-mine');
  }, 120_000);

  it('an interrupted rotation settles on whichever key the data actually uses', async () => {
    const current = readFileSync(path.join(home, 'master.key'), 'utf8');
    // Crashed before the database commit: the pending key is unused and is dropped.
    writeFileSync(path.join(home, 'master.key.new'), randomBytes(32).toString('base64'));
    await settlePendingKey(home);
    expect(existsSync(path.join(home, 'master.key.new'))).toBe(false);
    expect(readFileSync(path.join(home, 'master.key'), 'utf8')).toBe(current);
    // Crashed after the commit but before the rename: the pending key is the real one.
    const newKey = randomBytes(32);
    const pg = await startEmbeddedPostgres(path.join(home, 'pgdata'), { socketDir: path.join(home, 'run') });
    const db = createDb(pg.url, 1);
    await rotateMasterKey(db, Buffer.from(current.trim(), 'base64'), newKey);
    await db.end();
    await pg.stop();
    writeFileSync(path.join(home, 'master.key.new'), newKey.toString('base64'));
    await settlePendingKey(home);
    expect(readFileSync(path.join(home, 'master.key'), 'utf8').trim()).toBe(newKey.toString('base64'));
    expect(await credentialWith(home)).toBe('glpat-mine');
  }, 120_000);
});

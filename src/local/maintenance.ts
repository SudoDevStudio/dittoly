import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { keyMatches, rotateMasterKey } from '../core/rekey.js';
import { createDb } from '../db/db.js';
import { startEmbeddedPostgres } from './pglite.js';

/**
 * Maintenance for the single-user local install: backup, restore and master-key
 * rotation. All of them need the server stopped (the embedded database has a
 * single owner), which the lock file enforces.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const MAGIC = 'DITTOLY-BACKUP-1\n';
const KDF = { N: 2 ** 17, r: 8, p: 1 };
export const MIN_PASSPHRASE = 12;

export class MaintenanceError extends Error {}

// ---------------------------------------------------------------- lock

const lockFile = (home: string) => path.join(home, 'dittoly.pid');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Homes locked by this process (the launcher and a maintenance command can share one process, e.g. in tests). */
const held = new Set<string>();

/** Take the install's lock; fails if a live process (or this one) holds it. Returns the release function. */
export function lock(home: string): () => void {
  const file = lockFile(home);
  if (held.has(path.resolve(home))) throw new MaintenanceError('Dittoly is running. Stop it first.');
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (pid && pid !== process.pid && alive(pid)) throw new MaintenanceError(`Dittoly is running (process ${pid}). Stop it first.`);
  }
  writeFileSync(file, String(process.pid), { mode: 0o600 });
  held.add(path.resolve(home));
  return () => {
    held.delete(path.resolve(home));
    if (existsSync(file) && readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
  };
}

// ---------------------------------------------------------------- key file

const keyFile = (home: string) => path.join(home, 'master.key');
const pendingKeyFile = (home: string) => path.join(home, 'master.key.new');
const readKey = (file: string) => Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
const writeKey = (file: string, key: Buffer) => {
  writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
};

export async function withDb<T>(home: string, fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const pg = await startEmbeddedPostgres(
    path.join(home, 'pgdata'),
    process.platform === 'win32' ? { port: 0 } : { socketDir: path.join(home, 'run') },
  );
  const db = createDb(pg.url, 1);
  try {
    return await fn(db);
  } finally {
    await db.end();
    await pg.stop();
  }
}

/**
 * A rotation writes the new key to master.key.new, commits the database, then
 * renames it over master.key. If it was interrupted, use whichever key the
 * stored data actually decrypts with.
 */
export async function settlePendingKey(home: string): Promise<void> {
  const pending = pendingKeyFile(home);
  if (!existsSync(pending)) return;
  const newKey = readKey(pending);
  const matches = existsSync(path.join(home, 'pgdata')) ? await withDb(home, (db) => keyMatches(db, newKey)) : null;
  if (matches) renameSync(pending, keyFile(home));
  else rmSync(pending, { force: true });
}

export async function rotateLocalKey(home: string): Promise<{ values: number }> {
  const release = lock(home);
  try {
    await settlePendingKey(home);
    if (!existsSync(keyFile(home))) throw new MaintenanceError(`no Dittoly data in ${home}`);
    const oldKey = readKey(keyFile(home));
    const newKey = randomBytes(32);
    writeKey(pendingKeyFile(home), newKey);
    const result = await withDb(home, (db) => rotateMasterKey(db, oldKey, newKey)).catch((err: unknown) => {
      rmSync(pendingKeyFile(home), { force: true });
      throw err;
    });
    renameSync(pendingKeyFile(home), keyFile(home));
    return result;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- backup file

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scrypt(passphrase.normalize('NFC'), salt, 32, { ...KDF, maxmem: 256 * 1024 * 1024 });
}

/** MAGIC, a JSON header line (KDF parameters, salt, iv), then AES-256-GCM ciphertext + tag. The header is authenticated. */
export async function sealBackup(payload: Buffer, passphrase: string, magic = MAGIC): Promise<Buffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.from(magic + JSON.stringify({ kdf: 'scrypt', ...KDF, salt: salt.toString('base64'), iv: iv.toString('base64') }) + '\n');
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
}

export async function openBackup(file: Buffer, passphrase: string): Promise<Buffer> {
  const magic = [MAGIC].find((m) => file.subarray(0, m.length).equals(Buffer.from(m)));
  if (!magic) throw new MaintenanceError('not a Dittoly backup file');
  const end = file.indexOf(0x0a, magic.length);
  if (end < 0) throw new MaintenanceError('damaged backup file');
  const header = file.subarray(0, end + 1);
  const h = JSON.parse(header.subarray(magic.length).toString('utf8')) as { kdf: string; N: number; r: number; p: number; salt: string; iv: string };
  if (h.kdf !== 'scrypt' || h.N !== KDF.N || h.r !== KDF.r || h.p !== KDF.p) throw new MaintenanceError('unsupported backup format');
  const body = file.subarray(end + 1);
  if (body.length < 16) throw new MaintenanceError('damaged backup file');
  const decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, Buffer.from(h.salt, 'base64')), Buffer.from(h.iv, 'base64'));
  decipher.setAAD(header);
  decipher.setAuthTag(body.subarray(body.length - 16));
  try {
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch {
    throw new MaintenanceError('wrong passphrase, or the file was changed');
  }
}

/** Payload: 4-byte length + master key (base64 text), then the database as a gzipped tar. */
function pack(key: Buffer, dump: Buffer): Buffer {
  const k = Buffer.from(key.toString('base64'));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(k.length);
  return Buffer.concat([len, k, dump]);
}

function unpack(payload: Buffer): { key: Buffer; dump: Buffer } {
  const len = payload.readUInt32BE(0);
  return { key: Buffer.from(payload.subarray(4, 4 + len).toString(), 'base64'), dump: payload.subarray(4 + len) };
}

export async function backup(home: string, file: string, passphrase: string): Promise<void> {
  if (passphrase.length < MIN_PASSPHRASE) throw new MaintenanceError(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  if (existsSync(file)) throw new MaintenanceError(`${file} already exists`);
  const release = lock(home);
  try {
    await settlePendingKey(home);
    if (!existsSync(keyFile(home)) || !existsSync(path.join(home, 'pgdata'))) throw new MaintenanceError(`no Dittoly data in ${home}`);
    const db = await PGlite.create(path.join(home, 'pgdata'));
    let dump: Buffer;
    try {
      dump = Buffer.from(await (await db.dumpDataDir('gzip')).arrayBuffer());
    } finally {
      await db.close();
    }
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(file, await sealBackup(pack(readKey(keyFile(home)), dump), passphrase), { mode: 0o600, flag: 'wx' });
  } finally {
    release();
  }
}

/** Restore into an empty home directory (never over existing data). */
export async function restore(home: string, file: string, passphrase: string): Promise<void> {
  if (existsSync(keyFile(home)) || existsSync(path.join(home, 'pgdata'))) {
    throw new MaintenanceError(`${home} already has Dittoly data. Restore into an empty folder (--home), or move the existing data away first.`);
  }
  const { key, dump } = unpack(await openBackup(readFileSync(file), passphrase));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const release = lock(home);
  try {
    const db = await PGlite.create({ dataDir: path.join(home, 'pgdata'), loadDataDir: new Blob([new Uint8Array(dump)]) });
    await db.query('SELECT 1');
    await db.close();
    writeKey(keyFile(home), key);
  } catch (err) {
    rmSync(path.join(home, 'pgdata'), { recursive: true, force: true });
    throw err;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- passphrase prompt

/** Read a passphrase without echo from the terminal, or from DITTOLY_BACKUP_PASSPHRASE when there is no terminal. */
export async function askPassphrase(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const fromEnv = process.env.DITTOLY_BACKUP_PASSPHRASE;
    if (!fromEnv) throw new MaintenanceError('no terminal to ask for a passphrase; set DITTOLY_BACKUP_PASSPHRASE');
    return fromEnv;
  }
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new MaintenanceError('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    stdin.on('data', onData);
  });
}

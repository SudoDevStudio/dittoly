import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/**
 * Embedded Postgres for the single-user local install: PGlite (Postgres compiled
 * to WebAssembly) persisted in a directory and served over the Postgres wire
 * protocol, so the normal `pg` driver and every query run unchanged.
 *
 * PGlite has no authentication, so by default it listens on a Unix socket in a
 * directory only the owner can open (other users and their processes cannot
 * connect). A TCP port on loopback is for development tools only: any local
 * process can connect to it.
 */
export async function startEmbeddedPostgres(
  dataDir: string,
  listen: { socketDir: string } | { port: number },
): Promise<{ url: string; stop: () => Promise<void> }> {
  const db = await PGlite.create(dataDir);
  let server: PGLiteSocketServer;
  let url: string;
  let tempDir: string | undefined;
  if ('socketDir' in listen) {
    let socketDir = listen.socketDir;
    // Socket paths are limited to about 104 bytes (macOS); a deeply nested home (e.g. inside
    // a deeply nested app folder) gets a fresh owner-only directory under the system temp dir instead.
    if (Buffer.byteLength(path.join(socketDir, '.s.PGSQL.5432')) > 100) socketDir = tempDir = mkdtempSync(path.join(tmpdir(), 'dty-'));
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    chmodSync(socketDir, 0o700);
    const socket = path.join(socketDir, '.s.PGSQL.5432');
    rmSync(socket, { force: true }); // left behind by a crash
    server = new PGLiteSocketServer({ db, path: socket, maxConnections: 20 });
    await server.start();
    url = `postgres://postgres@localhost:5432/postgres?host=${encodeURIComponent(socketDir)}`;
  } else {
    server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: listen.port, maxConnections: 20 });
    await server.start();
    const address = (server as unknown as { server?: { address(): { port: number } } }).server?.address();
    url = `postgres://postgres@127.0.0.1:${address?.port ?? listen.port}/postgres`;
  }
  return {
    url,
    stop: async () => {
      await server.stop();
      await db.close();
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

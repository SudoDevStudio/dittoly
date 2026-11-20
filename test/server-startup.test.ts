import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/db.js';
import { startEmbeddedPostgres } from '../src/local/pglite.js';
import { localSignInUrl } from '../src/local/sign-in.js';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

describe('local server entrypoint', () => {
  it('prints browser-facing URLs instead of wildcard bind addresses', () => {
    expect(localSignInUrl('http://0.0.0.0:8080', 'dty_test')).toBe('http://localhost:8080/auth/local?token=dty_test');
    expect(localSignInUrl('http://[::]:8080', 'dty_test')).toBe('http://localhost:8080/auth/local?token=dty_test');
    expect(localSignInUrl('https://dittoly.example/', 'dty_test')).toBe('https://dittoly.example/auth/local?token=dty_test');
  });

  it('loads .env, respects shell overrides, prints a working link, and preserves the admin across restarts', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dty-startup-'));
    const pg = await startEmbeddedPostgres(path.join(home, 'pgdata'), { socketDir: path.join(home, 'run') });
    const port = await freePort();
    const publicUrl = `http://localhost:${port}`;
    const settings = {
      DATABASE_URL: pg.url,
      DITTOLY_DB_POOL_MAX: '1',
      DITTOLY_MODE: 'local',
      DITTOLY_MASTER_KEY: randomBytes(32).toString('base64'),
      DITTOLY_AI_PROVIDER: 'none',
      DITTOLY_SANDBOX: 'process',
      DITTOLY_AMQP_URL: '',
      DITTOLY_OIDC_ISSUER: '',
      DITTOLY_OIDC_CLIENT_ID: '',
      DITTOLY_PUBLIC_URL: 'http://localhost:1',
      HOST: '0.0.0.0',
      PORT: String(port),
    };
    const envFile = path.join(home, '.env');
    writeFileSync(envFile, Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 });
    const env = { ...process.env };
    for (const key of Object.keys(settings)) delete env[key];
    env.DITTOLY_PUBLIC_URL = publicUrl;
    const children: ChildProcessWithoutNullStreams[] = [];
    const start = async () => {
      // Use the same .env loading and main entrypoint as npm start.
      const child = spawn(process.execPath, [`--env-file-if-exists=${envFile}`, '--import', 'tsx', path.resolve('src/main.ts')], { env, stdio: 'pipe' });
      children.push(child);
      let output = '';
      const started = new Promise<void>((resolve, reject) => {
        // Startup runs every migration on an embedded Postgres: a loaded CI runner can take well over 10 s.
        const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output.slice(-500)}`)), 60000);
        child.on('error', reject);
        child.on('exit', () => { clearTimeout(timeout); reject(new Error('Server exited before startup')); });
        child.stdout.on('data', data => {
          output += String(data);
          if (output.includes('"event":"started"')) { clearTimeout(timeout); resolve(); }
        });
        child.stderr.resume();
      });
      await started;
      await new Promise(resolve => setTimeout(resolve, 200));
      // Fail on the user's exact symptom: local mode runs but its logs have no link.
      const link = /http:\/\/localhost:\d+\/auth\/local\?token=dty_[\w-]+/.exec(output)?.[0];
      expect(Boolean(link), 'Local-mode server must print its sign-in link at startup').toBe(true);
      return { child, link: link! };
    };
    try {
      const first = await start();
      const signIn = await fetch(first.link, { redirect: 'manual' });
      expect(signIn.status).toBe(302);
      const cookie = signIn.headers.getSetCookie()[0]!.split(';')[0]!;
      const me = await (await fetch(`${publicUrl}/api/me`, { headers: { cookie } })).json();
      expect(me.role).toBe('admin');
      await stop(first.child);

      const second = await start();
      expect(second.link).not.toBe(first.link);
      expect((await fetch(first.link, { redirect: 'manual' })).status).toBe(401);
      const nextSignIn = await fetch(second.link, { redirect: 'manual' });
      expect(nextSignIn.status).toBe(302);
      const nextCookie = nextSignIn.headers.getSetCookie()[0]!.split(';')[0]!;
      const nextMe = await (await fetch(`${publicUrl}/api/me`, { headers: { cookie: nextCookie } })).json();
      expect(nextMe.id).toBe(me.id);
      await stop(second.child);
      const db = createDb(pg.url, 1);
      try { expect((await db.query('SELECT count(*)::int AS n FROM members')).rows[0]!.n).toBe(1); }
      finally { await db.end(); }
    } finally {
      await Promise.all(children.map(stop));
      // Let the socket server finish deferred connection-close callbacks before closing PGlite.
      await new Promise(resolve => setTimeout(resolve, 100));
      await pg.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 180000);
});

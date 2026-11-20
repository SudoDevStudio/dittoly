import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/setup-local.mjs');

function withHome(test: (home: string, run: () => ReturnType<typeof spawnSync>) => void) {
  const home = mkdtempSync(path.join(tmpdir(), 'dty-setup-'));
  const env = { ...process.env };
  delete env.DITTOLY_MASTER_KEY;
  const run = () => spawnSync(process.execPath, [script], { cwd: home, env, encoding: 'utf8' });
  try { test(home, run); } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('local .env setup', () => {
  it('creates working host settings once and preserves the encryption key on repeated setup', () => {
    withHome((home, run) => {
      const first = run();
      expect(first.status).toBe(0);
      const config = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      expect(config.DITTOLY_MODE).toBe('local');
      expect(config.DITTOLY_SANDBOX).toBe('process');
      expect(new URL(config.DATABASE_URL!).hostname).toBe('127.0.0.1');
      expect(new URL(config.DITTOLY_AMQP_URL!).hostname).toBe('127.0.0.1');
      expect(Buffer.from(config.DITTOLY_MASTER_KEY!, 'base64').length).toBe(32);
      expect(first.stdout).not.toContain(config.DITTOLY_MASTER_KEY);
      expect(run().status).toBe(0);
      expect(parseEnv(readFileSync(path.join(home, '.env'), 'utf8')).DITTOLY_MASTER_KEY).toBe(config.DITTOLY_MASTER_KEY);
    });
  });

  it('retains custom settings and secrets when configuring personal mode', () => {
    withHome((home, run) => {
      const key = Buffer.alloc(32, 7).toString('base64');
      writeFileSync(path.join(home, '.env'), `DITTOLY_MASTER_KEY=${key}\nDITTOLY_MODE=shared\nDATABASE_URL=postgres://user:password@127.0.0.1:5544/custom\nPORT=9090\nDITTOLY_PUBLIC_URL=http://localhost:9090\nOPENAI_API_KEY=existing-secret\n`);
      expect(run().status).toBe(0);
      expect(parseEnv(readFileSync(path.join(home, '.env'), 'utf8'))).toMatchObject({
        DITTOLY_MASTER_KEY: key, DITTOLY_MODE: 'local', DATABASE_URL: 'postgres://user:password@127.0.0.1:5544/custom',
        PORT: '9090', DITTOLY_PUBLIC_URL: 'http://localhost:9090', OPENAI_API_KEY: 'existing-secret',
      });
    });
  });

  it('derives the sign-in URL from a custom port when no public URL is set', () => {
    withHome((home, run) => {
      writeFileSync(path.join(home, '.env'), 'PORT=9090\n');
      expect(run().status).toBe(0);
      expect(parseEnv(readFileSync(path.join(home, '.env'), 'utf8')).DITTOLY_PUBLIC_URL).toBe('http://localhost:9090');
    });
  });

  it('converts the bundled container hostnames to host connections', () => {
    withHome((home, run) => {
      writeFileSync(path.join(home, '.env'), 'DATABASE_URL=postgres://postgres@postgres:5432/dittoly\nDITTOLY_AMQP_URL=amqp://dittoly:dittoly@rabbitmq:5672\nHOST=0.0.0.0\n');
      expect(run().status).toBe(0);
      const config = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      expect(new URL(config.DATABASE_URL!).host).toBe('127.0.0.1:5433');
      expect(new URL(config.DITTOLY_AMQP_URL!).host).toBe('127.0.0.1:5672');
      expect(config.HOST).toBe('127.0.0.1');
    });
  });

  it('updates the default native Postgres port to the Docker host port while preserving credentials', () => {
    withHome((home, run) => {
      writeFileSync(path.join(home, '.env'), 'DATABASE_URL=postgres://postgres:existing-password@localhost:5432/dittoly\n');
      expect(run().status).toBe(0);
      const config = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      const database = new URL(config.DATABASE_URL!);
      expect(database.host).toBe('127.0.0.1:5433');
      expect(database.password).toBe('existing-password');
    });
  });

  it('leaves an invalid existing encryption key untouched and never echoes it', () => {
    withHome((home, run) => {
      const source = 'DITTOLY_MASTER_KEY=invalid-existing-secret\n';
      writeFileSync(path.join(home, '.env'), source);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('invalid-existing-secret');
      expect(readFileSync(path.join(home, '.env'), 'utf8')).toBe(source);
    });
  });
});

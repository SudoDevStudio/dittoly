import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ConfigError, MIN_RUNNER_TOKEN } from '../config.js';

/** The code runner's settings (docs/code-runner.md); it reads no Dittoly settings but these. */
export interface RunnerConfig {
  token: string;
  host: string;
  port: number;
  slots: number;
  internalHosts: string[];
  imageTtlHours: number;
  stateDir: string;
  tls: { cert: string; key: string } | undefined;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const schema = z.object({
  DITTOLY_RUNNER_TOKEN: z.string().optional(),
  DITTOLY_RUNNER_HOST: z.string().default('0.0.0.0'),
  DITTOLY_RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  DITTOLY_RUNNER_SLOTS: z.coerce.number().int().min(1).max(64).default(2),
  DITTOLY_RUNNER_TLS_CERT: z.string().optional(),
  DITTOLY_RUNNER_TLS_KEY: z.string().optional(),
  DITTOLY_RUNNER_STATE_DIR: z.string().optional(),
  DITTOLY_INTERNAL_HOSTS: z.string().optional(),
  DITTOLY_SANDBOX_IMAGE_TTL_HOURS: z.coerce.number().int().min(0).max(24 * 365).default(24),
});

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(set);
  if (!parsed.success) throw new ConfigError(`invalid runner configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const e = parsed.data;
  if (!e.DITTOLY_RUNNER_TOKEN || e.DITTOLY_RUNNER_TOKEN.length < MIN_RUNNER_TOKEN) {
    throw new ConfigError(`the runner needs DITTOLY_RUNNER_TOKEN (at least ${MIN_RUNNER_TOKEN} characters: openssl rand -base64 32), the same as Dittoly's`);
  }
  if (!!e.DITTOLY_RUNNER_TLS_CERT !== !!e.DITTOLY_RUNNER_TLS_KEY) throw new ConfigError('TLS needs both DITTOLY_RUNNER_TLS_CERT and DITTOLY_RUNNER_TLS_KEY');
  const tls = e.DITTOLY_RUNNER_TLS_CERT ? { cert: readFileSync(e.DITTOLY_RUNNER_TLS_CERT, 'utf8'), key: readFileSync(e.DITTOLY_RUNNER_TLS_KEY!, 'utf8') } : undefined;
  // The token and the steps' secrets never cross a network in the clear: plain http only behind a TLS proxy on this machine.
  if (!tls && !LOOPBACK.has(e.DITTOLY_RUNNER_HOST)) {
    throw new ConfigError('the runner listens on other addresses only with TLS: set DITTOLY_RUNNER_TLS_CERT and DITTOLY_RUNNER_TLS_KEY, or DITTOLY_RUNNER_HOST=127.0.0.1 behind an https proxy on this machine');
  }
  return {
    token: e.DITTOLY_RUNNER_TOKEN,
    host: e.DITTOLY_RUNNER_HOST,
    port: e.DITTOLY_RUNNER_PORT,
    slots: e.DITTOLY_RUNNER_SLOTS,
    internalHosts: (e.DITTOLY_INTERNAL_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    imageTtlHours: e.DITTOLY_SANDBOX_IMAGE_TTL_HOURS,
    stateDir: e.DITTOLY_RUNNER_STATE_DIR ?? stateDirDefault(),
    tls,
  };
}

/** ~/.dittoly-runner. */
function stateDirDefault(): string {
  return path.join(homedir(), '.dittoly-runner');
}

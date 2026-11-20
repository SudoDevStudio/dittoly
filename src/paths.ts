import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package root, found by walking up from this file. Works the same when
 * running from source (tsx, src/) and from the compiled build (dist/src/).
 */
function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'dittoly') return dir;
    dir = path.dirname(dir);
  }
  throw new Error('dittoly package root not found');
}

export const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
export const MIGRATIONS_DIR = path.join(ROOT, 'src', 'db', 'migrations');
export const RUNNER_SCRIPT = path.join(ROOT, 'sandbox-runtime', 'runner.mjs');
export const EGRESS_PROXY_SCRIPT = path.join(ROOT, 'sandbox-runtime', 'egress-proxy.mjs');
/** Code runner machine: the forward into a running app (src/engine/apps.ts publishApp). */
export const TCP_FORWARD_SCRIPT = path.join(ROOT, 'sandbox-runtime', 'tcp-forward.mjs');
/** Dittoly with a remote code runner: the relay to a running app's tunnel (src/engine/remote-runner.ts). */
export const APP_RELAY_SCRIPT = path.join(ROOT, 'sandbox-runtime', 'app-relay.mjs');
export const BROWSER_DRIVER_SCRIPT = path.join(ROOT, 'sandbox-runtime', 'browser-driver.mjs');
/** Types for a module's TypeScript source; git sync writes them to a synced repository. */
export const MODULE_TYPES = path.join(ROOT, 'sandbox-runtime', 'dittoly-module.d.ts');
export const WEB_ROOT = path.join(ROOT, 'dist', 'web');
export const SKILLS_DIR = path.join(ROOT, 'skills');

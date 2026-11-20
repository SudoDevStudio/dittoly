#!/usr/bin/env node
// Single-user local install. Requires the compiled build (`npm run build`).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../dist/src/local/launcher.js', import.meta.url));
if (!existsSync(launcher)) {
  process.stderr.write('dittoly: not built yet. Run `npm run build` in the package directory.\n');
  process.exit(1);
}
process.argv[1] = launcher;
await import(launcher);

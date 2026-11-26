#!/usr/bin/env node
// `dittoly run` (from a clone: npx dittoly run) sets up and starts Dittoly on this machine with Docker for
// PostgreSQL and RabbitMQ (scripts/run.mjs). Anything else is the single-user local install, which needs the
// compiled build (`npm run build`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'run') {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 26) {
    process.stderr.write(
      `dittoly run: Dittoly needs Node.js 26 or later (this is ${process.version}).\n` +
        `Install it from https://nodejs.org, or with nvm: nvm install 26 && nvm use\n` +
        `(./run.sh in the clone does that switch for you when nvm is installed).\n`,
    );
    process.exit(1);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  // The questions need the prompt library: on a fresh clone the packages are installed first.
  if (!existsSync(new URL('../node_modules/@clack/prompts/package.json', import.meta.url))) {
    process.stdout.write('Installing npm packages first (npm ci)…\n');
    const r = spawnSync('npm', ['ci'], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  // scripts/run.mjs reads its own options: `run` is the command, not one of them.
  process.argv.splice(2, 1);
  await import(new URL('../scripts/run.mjs', import.meta.url).href);
} else {
  const launcher = fileURLToPath(new URL('../dist/src/local/launcher.js', import.meta.url));
  if (!existsSync(launcher)) {
    process.stderr.write('dittoly: not built yet. Run `npm run build` in the package directory, or `npx dittoly run` to set everything up.\n');
    process.exit(1);
  }
  process.argv[1] = launcher;
  await import(launcher);
}

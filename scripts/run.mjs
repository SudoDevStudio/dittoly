#!/usr/bin/env node
// Run Dittoly on this machine in one step: `npx dittoly run` from the clone (or npm run up, or ./run.sh).
//
// It does only what is still missing, in order: checks Docker, installs packages when the lockfile changed,
// creates .env from .env.example (an existing encryption key is never replaced), asks which AI drafts modules and
// Flows when none is set, pulls and starts PostgreSQL and RabbitMQ, builds when the sources changed, and starts
// Dittoly. Running it again is safe.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import * as p from '@clack/prompts';
import { setupLocalEnv } from './setup-local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const ENV = path.join(ROOT, '.env');
const COMPOSE = ['compose', '-f', 'docker-compose.local.yml'];
const PROVIDERS = ['claude-cli', 'codex-cli', 'anthropic', 'openai', 'ollama', 'none'];

const HELP = `Set up and start Dittoly on this machine, from the clone.

  npx dittoly run                    set up what is missing, then start
  npx dittoly run --ai claude-cli    choose the AI without being asked
                                     (${PROVIDERS.join(', ')})
  npx dittoly run --setup-only       everything except starting
  npx dittoly run --rebuild          build again before starting
  npx dittoly run --stop             stop PostgreSQL and RabbitMQ (your data is kept)

The same: npm run up -- <options>, or ./run.sh <options> (which also switches to Node.js 26 with nvm).
Run it inside the clone: the name "dittoly" on the npm registry belongs to someone else.`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      ai: { type: 'string' },
      'setup-only': { type: 'boolean', default: false },
      rebuild: { type: 'boolean', default: false },
      stop: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (error) {
  console.error(`${error.message}\n\n${HELP}`);
  process.exit(1);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.ai && !PROVIDERS.includes(args.ai)) stop(`Unknown AI "${args.ai}". Choose one of: ${PROVIDERS.join(', ')}.`);

/** Asking needs a terminal; without one (CI, a pipe) nothing is asked and what .env says is kept. */
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

function stop(message) {
  p.cancel(message);
  process.exit(1);
}
/** A prompt the person backed out of (Ctrl+C or Esc) ends the run without changing anything else. */
function answered(value) {
  if (p.isCancel(value)) stop('Stopped. Nothing after this step was changed; run it again any time.');
  return value;
}
function has(command) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' }).status === 0;
}
function run(command, commandArgs, { quiet = false } = {}) {
  const r = spawnSync(command, commandArgs, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
/** Long steps run behind a spinner; their output is shown only when they fail. */
async function withSpinner(title, done, command, commandArgs) {
  // An animated spinner only makes sense on a terminal; in a log it would print every frame.
  const s = process.stdout.isTTY
    ? p.spinner()
    : { start: (m) => p.log.step(`${m}…`), stop: (m, code) => (code ? p.log.error(m) : p.log.success(m)) };
  s.start(title);
  const r = await new Promise((resolve) => {
    let out = '';
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
    child.on('error', (error) => resolve({ ok: false, out: String(error) }));
  });
  if (!r.ok) {
    s.stop(`${title}: failed`, 1);
    console.error(r.out.trim().split('\n').slice(-30).join('\n'));
    stop(`${title} failed; the output above says why.`);
  }
  s.stop(done);
}

// ------------------------------------------------------------------------------------------------ .env helpers
function envGet(name) {
  return (parseEnv(readFileSync(ENV, 'utf8'))[name] ?? '').trim();
}
/** One setting written with setup-local.mjs's quoting: the real line first, else its commented example in place. */
function envSet(name, value) {
  let source = readFileSync(ENV, 'utf8');
  const line = `${name}=${JSON.stringify(value)}`;
  const live = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'm');
  const example = new RegExp(`^[ \\t]*#[ \\t]*${name}[ \\t]*=.*$`, 'm');
  if (live.test(source)) source = source.replace(live, () => line);
  else if (example.test(source)) source = source.replace(example, () => line);
  else source = `${source.trimEnd()}\n${line}\n`;
  writeFileSync(ENV, source, { mode: 0o600 });
  chmodSync(ENV, 0o600);
}
const known = (name) => Boolean(process.env[name]?.trim() || envGet(name));

// ------------------------------------------------------------------------------------------------ --stop
if (args.stop) {
  const r = run('docker', [...COMPOSE, 'down']);
  if (!r.ok) process.exit(1);
  console.log('PostgreSQL and RabbitMQ stopped. Your data is kept; npx dittoly run starts them again.');
  process.exit(0);
}

p.intro(' Dittoly ');

// ------------------------------------------------------------------------------------------------ 1. tools
const major = Number(process.versions.node.split('.')[0]);
if (major < 26) {
  stop(
    `Dittoly needs Node.js 26 or later (this is ${process.version}): Node.js 22 cannot enforce the sandbox's\n` +
      `network limits. Install it from https://nodejs.org, or with nvm: nvm install 26 && nvm use\n` +
      `(./run.sh does that switch for you when nvm is installed).`,
  );
}
if (!has('docker')) stop('Docker is not installed. Install Docker Desktop, or Docker Engine with the Compose plugin.');
if (!run('docker', ['compose', 'version'], { quiet: true }).ok) stop('Docker Compose is missing: install the Compose v2 plugin (docker compose).');
if (!run('docker', ['info'], { quiet: true }).ok) stop('Docker is installed but not running. Start Docker Desktop (or the Docker service), then run this again.');
p.log.success(`Node.js ${process.version} · Docker Compose ${run('docker', ['compose', 'version', '--short'], { quiet: true }).out.trim()}`);

// ------------------------------------------------------------------------------------------------ 2. packages
const lock = path.join(ROOT, 'node_modules', '.package-lock.json');
if (!existsSync(lock) || statSync('package-lock.json').mtimeMs > statSync(lock).mtimeMs) {
  await withSpinner('Installing npm packages', 'npm packages installed', 'npm', ['ci']);
}

// ------------------------------------------------------------------------------------------------ 3. .env
const hadEnv = existsSync(ENV);
const { createdKey } = await setupLocalEnv(ENV);
p.log.success(
  hadEnv
    ? `.env is ready${createdKey ? '; a new encryption key was added' : ' (your encryption key is unchanged)'}`
    : '.env created from .env.example, with a new encryption key',
);
if (createdKey) p.log.warn('Keep a copy of DITTOLY_MASTER_KEY from .env somewhere safe: it encrypts every stored credential and cannot be recovered.');

// ------------------------------------------------------------------------------------------------ 4. AI
function detectedClis() {
  return ['claude', 'codex', 'ollama'].filter(has);
}
async function chooseAi() {
  const found = detectedClis();
  const all = [
    { value: 'claude-cli', label: 'Claude Code CLI', hint: 'your own Claude login, no key stored', cli: 'claude' },
    { value: 'codex-cli', label: 'OpenAI Codex CLI', hint: 'your own Codex login, no key stored', cli: 'codex' },
    { value: 'ollama', label: 'Ollama', hint: 'a model running on this machine', cli: 'ollama' },
    { value: 'anthropic', label: 'Anthropic API', hint: 'asks for ANTHROPIC_API_KEY' },
    { value: 'openai', label: 'OpenAI API', hint: 'asks for OPENAI_API_KEY' },
    { value: 'none', label: 'No AI for now', hint: 'everything except drafting from a description works' },
  ];
  // What is already on this machine comes first and is marked, so the obvious choice is the first one.
  const options = [
    ...all.filter((o) => o.cli && found.includes(o.cli)).map((o) => ({ ...o, hint: `${o.hint} · found on this machine` })),
    ...all.filter((o) => !(o.cli && found.includes(o.cli))),
  ].map(({ value, label, hint }) => ({ value, label, hint }));
  p.log.info('No AI is set up yet. Dittoly works without one, but cannot draft a module or Flow from a description.');
  return answered(await p.select({ message: 'Which AI should draft modules and Flows?', options, initialValue: options[0].value }));
}

const current = envGet('DITTOLY_AI_PROVIDER');
let ai = args.ai || process.env.DITTOLY_AI_PROVIDER?.trim() || (current && current !== 'none' ? current : '');
if (!ai) {
  if (interactive) ai = await chooseAi();
  else {
    ai = current || 'none';
    p.log.info('Not asking: there is no terminal to ask on. Choose one with: npx dittoly run --ai <provider>');
  }
}
envSet('DITTOLY_AI_PROVIDER', ai);

const needKey = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }[ai];
if (needKey && !known(needKey)) {
  if (!interactive) stop(`${ai} needs ${needKey}: set it in .env or in your shell.`);
  const key = answered(
    await p.password({
      message: `${needKey} (hidden while you type; saved only in .env, which is private and never committed)`,
      validate: (v) => (v?.trim() ? undefined : 'Paste the key, or press Ctrl+C to stop.'),
    }),
  );
  envSet(needKey, key.trim());
}
if (ai === 'ollama') {
  if (!known('DITTOLY_AI_MODEL')) {
    if (!interactive) stop('ollama needs DITTOLY_AI_MODEL (a model you pulled): set it in .env or in your shell.');
    const pulled = has('ollama')
      ? run('ollama', ['list'], { quiet: true }).out.split('\n').slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean)
      : [];
    const model = pulled.length
      ? answered(
          await p.select({
            message: 'Which Ollama model?',
            options: [...pulled.map((m) => ({ value: m, label: m })), { value: '', label: 'Another model', hint: 'type its name' }],
          }),
        ) ||
        answered(await p.text({ message: 'Model name (for example gemma4:12b)', validate: (v) => (v?.trim() ? undefined : 'Type a model name.') }))
      : answered(await p.text({ message: 'Model name, as pulled with `ollama pull` (for example gemma4:12b)', validate: (v) => (v?.trim() ? undefined : 'Type a model name.') }));
    envSet('DITTOLY_AI_MODEL', model.trim());
  }
  if (!known('DITTOLY_OLLAMA_URL')) envSet('DITTOLY_OLLAMA_URL', 'http://127.0.0.1:11434');
}
if ((ai === 'claude-cli' && !has('claude')) || (ai === 'codex-cli' && !has('codex'))) {
  p.log.warn(`The ${ai.replace('-cli', '')} CLI is not on your PATH yet: install it and sign in, or drafting will fail.`);
}
const aiSummary = {
  anthropic: 'ANTHROPIC_API_KEY is in .env (hidden)',
  openai: 'OPENAI_API_KEY is in .env (hidden)',
  ollama: `model ${envGet('DITTOLY_AI_MODEL') || process.env.DITTOLY_AI_MODEL} at ${envGet('DITTOLY_OLLAMA_URL') || process.env.DITTOLY_OLLAMA_URL}`,
  'claude-cli': 'uses your own Claude login; no key stored',
  'codex-cli': 'uses your own Codex login; no key stored',
  none: 'drafting from a description is off',
}[ai];
p.log.success(`AI: ${ai} — ${aiSummary}. Change it any time: npx dittoly run --ai <provider>`);

// ------------------------------------------------------------------------------------------------ 5. services
await withSpinner(
  'Starting PostgreSQL and RabbitMQ in Docker (the first time pulls the images)',
  'PostgreSQL (127.0.0.1:5433) and RabbitMQ (127.0.0.1:5672) are up',
  'docker',
  [...COMPOSE, 'up', '-d', '--wait'],
);

// ------------------------------------------------------------------------------------------------ 6. build
const stamp = path.join(ROOT, 'dist', '.run-built');
/** True when the file, or anything under the folder, changed after `ref` (a time in ms). */
function newerThan(file, ref) {
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st) return false;
  if (!st.isDirectory()) return st.mtimeMs > ref;
  return readdirSync(file, { recursive: true, withFileTypes: true }).some(
    (entry) => entry.isFile() && statSync(path.join(entry.parentPath, entry.name)).mtimeMs > ref,
  );
}
const builtAt = statSync(stamp, { throwIfNoEntry: false })?.mtimeMs;
if (args.rebuild || !existsSync('dist/web/index.html') || !builtAt || ['src', 'web', 'package-lock.json'].some((f) => newerThan(f, builtAt))) {
  await withSpinner('Building the portal and server', 'Built', 'npm', ['run', 'build']);
  writeFileSync(stamp, '');
}

// ------------------------------------------------------------------------------------------------ 7. start
const port = envGet('PORT') || '8080';
p.note(
  [
    `Address    http://localhost:${port}  (open the sign-in link printed below)`,
    `AI         ${ai}`,
    'Services   PostgreSQL 127.0.0.1:5433 · RabbitMQ 127.0.0.1:5672 (Docker)',
    'Settings   .env — keep DITTOLY_MASTER_KEY safe; it cannot be recovered',
    'Stop       Ctrl+C · then npx dittoly run --stop (data is kept)',
  ].join('\n'),
  args['setup-only'] ? 'Ready' : 'Starting Dittoly',
);
if (args['setup-only']) {
  p.outro('Everything is set up. Start it with: npx dittoly run');
  process.exit(0);
}
p.outro('Starting…');
const app = spawn('npm', ['start'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.kill(signal));
app.on('exit', (code) => process.exit(code ?? 0));

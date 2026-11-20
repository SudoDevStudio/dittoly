import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { badRequest } from '../core/errors.js';
import { ROOT } from '../paths.js';
import type { AppBundle } from './bundle.js';
import { compileFlow } from './codegen/compile.js';
import { envExample } from './env.js';
import { CORE_JS } from './frontend/core.js';
import { defaultPlan, planFlows } from './frontend/plan.js';
import { RENDER_JS } from './frontend/render.js';
import { APP_CSS } from './frontend/styles.js';
import { frontendFiles, FRONTEND_OUT } from './frontend/templates.js';
import { openapi } from './openapi.js';
import type { TarFile } from './tar.js';
import { themeCss } from './theme.js';

/**
 * An export as a TypeScript project, all of it source code:
 * - src/flows/<flow>.ts: each Flow as code, written out from its approved definition;
 * - src/app.ts and src/main.ts: what the app is made of, and what starts it;
 * - src/runtime/: the runtime as TypeScript: the engine, the server, the broker that checks every
 *   module request, and only the parts this app uses (a database driver, AI steps, a state store
 *   are there only when a Flow or module needs them);
 * - sandbox/modules: the modules' approved code.
 * No database comes with it: runs are in memory, or in the Redis or Postgres STATE_URL names
 * when a Flow waits for people or keeps table rows.
 */

/** Where the runtime's sources are; both folders import nothing outside themselves. */
const RUNTIME_DIRS = ['src/runtime', 'src/export/app-runtime'];

const IMPORT = /((?:from\s+|import\s*\(\s*|import\s+)['"])([^'"]+)(['"])/g;
const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

/**
 * The runtime files the generated sources import, and the files those import, as the app's own
 * src/runtime/*.ts. Every import between them becomes "./<file>.js". Also the packages they use.
 */
export function runtimeSources(generated: string[], root = ROOT): { files: TarFile[]; packages: Set<string> } {
  const where = new Map<string, string>();
  for (const dir of RUNTIME_DIRS) {
    for (const f of readdirSync(path.join(root, dir))) {
      if (!f.endsWith('.ts')) continue;
      if (where.has(f)) throw new Error(`runtime file ${f} is in two folders`);
      where.set(f, path.join(root, dir, f));
    }
  }
  if (!where.size) throw badRequest('export_runtime_missing', 'the app runtime sources are not installed with this Dittoly');
  const packages = new Set<string>();
  const queue: string[] = [];
  const need = (spec: string) => {
    if (spec.startsWith('node:')) return;
    if (!spec.startsWith('.')) return void packages.add(packageOf(spec));
    queue.push(path.posix.basename(spec).replace(/\.js$/, '.ts'));
  };
  for (const code of generated) for (const m of code.matchAll(IMPORT)) if (/^\.{1,2}\/runtime\//.test(m[2]!) || !m[2]!.startsWith('.')) need(m[2]!);
  const files = new Map<string, string>();
  while (queue.length) {
    const name = queue.shift()!;
    if (files.has(name)) continue;
    const file = where.get(name);
    if (!file) throw new Error(`the runtime has no file ${name}`);
    const code = readFileSync(file, 'utf8').replace(IMPORT, (all, open: string, spec: string, close: string) => {
      if (!spec.startsWith('.')) {
        need(spec);
        return all;
      }
      const target = path.basename(path.resolve(path.dirname(file), spec)).replace(/\.js$/, '.ts');
      if (where.get(target) !== path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts')) throw new Error(`runtime file ${name} imports ${spec}, outside the runtime`);
      queue.push(target);
      return `${open}./${target.replace(/\.ts$/, '.js')}${close}`;
    });
    files.set(name, code);
  }
  return { files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => ({ path: `src/runtime/${name}`, content })), packages };
}

/** Exact versions, as installed in this Dittoly. */
function versionOf(pkg: string, root = ROOT): string {
  return (JSON.parse(readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')) as { version: string }).version;
}

const moduleFile = (m: { name: string; version: string }) => `modules/${m.name}@${m.version}.mjs`;
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function packageJson(b: AppBundle, packages: Set<string>, root = ROOT): string {
  const deps: Record<string, string> = {};
  for (const p of [...packages].sort()) deps[p] = versionOf(p, root);
  // Type declarations for packages that do not carry their own.
  const types: Record<string, string> = { '@types/node': versionOf('@types/node', root) };
  for (const p of [...packages].sort()) {
    const t = `@types/${p.replace(/^@/, '').replace('/', '__')}`;
    if (existsSync(path.join(root, 'node_modules', t, 'package.json'))) types[t] = versionOf(t, root);
  }
  return JSON.stringify(
    {
      name: b.slug,
      version: '1.0.0',
      private: true,
      description: `${b.name}: exported from Dittoly ${b.dittolyVersion}.`,
      type: 'module',
      engines: { node: '>=26' },
      scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/main.js' },
      dependencies: deps,
      devDependencies: { ...types, typescript: versionOf('typescript', root) },
    },
    null,
    2,
  );
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'es2024',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      skipLibCheck: true,
      outDir: 'dist',
      rootDir: 'src',
      types: ['node'],
    },
    include: ['src'],
  },
  null,
  2,
);

/** src/app.ts: what the app is, its modules (manifests and approved code hashes) and its Flows. */
export function appSource(b: AppBundle): string {
  const plan = b.frontend?.plan ?? b.uiPlan ?? defaultPlan(planFlows(b.flows, b.modules));
  const ident = (key: string) => `flow_${key.replace(/[^a-z0-9]/g, '_')}`;
  const look = { name: b.name, primary: b.theme?.light.primary ?? '#2f6fdf', onPrimary: b.theme?.light.onPrimary ?? '#ffffff', font: b.theme?.font ?? 'system-ui, sans-serif' };
  const def = {
    format: 'dittoly.app/2',
    name: b.name,
    slug: b.slug,
    kind: b.kind,
    sha256: b.sha256,
    dittolyVersion: b.dittolyVersion,
    theme: b.theme,
    plan,
    humanSteps: b.needs.humanSteps,
    needsState: b.needs.state,
    look,
    env: b.env,
    schedules: b.schedules,
    hooks: b.hooks.map(({ env: _env, ...h }) => h),
    tables: b.tables.map((t) => ({ name: t.name, keyColumn: t.keyColumn, columns: t.columns })),
  };
  const body = JSON.stringify(def, null, 2).replace(/\n}$/, '');
  const modules = b.modules.map((m) => ({ ref: `${m.name}@${m.version}`, name: m.name, version: m.version, manifest: m.manifest, file: moduleFile(m), codeSha256: m.codeSha256 }));
  return [
    `// ${oneLine(b.name)}: what the app is made of, exported from Dittoly ${b.dittolyVersion}. The Flows are in ./flows.`,
    "import type { AppDefinition } from './runtime/main.js';",
    ...b.flows.map((f) => `import ${ident(f.key)} from './flows/${f.key}.js';`),
    '',
    `export const app: AppDefinition = ${body},`,
    `  "modules": ${JSON.stringify(modules, null, 2).replace(/\n/g, '\n  ')},`,
    `  "flows": [${b.flows.map((f) => ident(f.key)).join(', ')}],`,
    '};',
    '',
  ].join('\n');
}

const SQL_DRIVERS = { postgres: ['db-postgres', 'postgres'], mysql: ['db-mysql', 'mysql'], mssql: ['db-mssql', 'sqlServer'] } as const;
const TRANSPORTS = { smtp: ['transport-smtp', 'smtp'], amqp: ['transport-amqp', 'amqp'], mqtt: ['transport-mqtt', 'mqtt'], websocket: ['transport-ws', 'ws'], sse: ['transport-sse', 'sse'] } as const;

/** src/main.ts: starts the app with the parts of the runtime it uses, and only those. */
export function mainSource(b: AppBundle): string {
  const imports = new Map<string, Set<string>>();
  const use = (file: string, ...names: string[]) => {
    const set = imports.get(file) ?? new Set<string>();
    for (const n of names) set.add(n);
    imports.set(file, set);
  };
  const features: string[] = [];
  const steps = b.flows.flatMap((f) => (f.definition.steps as { type: string }[]) ?? []);
  const protocols = new Set(b.modules.flatMap((m) => ((m.manifest.endpoints ?? []) as { protocol: string }[]).map((e) => e.protocol)));
  const google = b.modules.some((m) => (m.manifest.credentials as { placement: { type: string } }[]).some((c) => c.placement.type === 'google_service_account'));
  if (b.needs.state) {
    use('state', 'openStore');
    features.push('openStore');
  }
  if (b.needs.humanSteps) {
    use('notify', 'notices');
    features.push('notices');
  }
  const kinds: string[] = [];
  if (steps.some((s) => s.type === 'report')) {
    use('report', 'formatReport');
    kinds.push('report: formatReport');
  }
  if (steps.some((s) => s.type === 'input')) {
    use('input-steps', 'inputSteps');
    kinds.push('input: inputSteps');
  }
  if (steps.some((s) => s.type === 'table')) {
    use('table-steps', 'tableStep');
    kinds.push('table: tableStep');
  }
  if (kinds.length) features.push(`steps: { ${kinds.join(', ')} }`);
  if (b.hooks.length) {
    use('hooks', 'receiveHook');
    features.push('receiveHook');
  }
  if (b.schedules.length) {
    use('schedules', 'startSchedules');
    features.push('schedules: startSchedules');
  }
  if (steps.some((s) => s.type === 'ai')) {
    use('ai-steps', 'aiSteps');
    features.push('aiSteps');
  }
  if (protocols.size) {
    use('endpoint-calls', 'endpointCaller');
    const makers: string[] = [];
    for (const [protocol, [file, name]] of Object.entries(TRANSPORTS)) {
      if (!protocols.has(protocol)) continue;
      use(file, name);
      makers.push(name);
    }
    const sql = Object.entries(SQL_DRIVERS).filter(([d]) => protocols.has(d));
    if (sql.length) {
      use('databases', 'sqlQueries');
      for (const [, [file, name]] of sql) use(file, name);
      const drivers = sql.map(([d, [, name]]) => (d === name ? name : `${d}: ${name}`)).join(', ');
      makers.push(`db: (policy) => sqlQueries({ ${drivers} }, policy)`);
    }
    if (protocols.has('mongodb')) {
      use('db-mongo', 'mongo');
      makers.push('mongo');
    }
    features.push(`calls: endpointCaller({ ${makers.join(', ')} })`);
  }
  if (google) {
    use('google-auth', 'googleAccessToken');
    use('egress', 'guardedFetch');
    features.push('googleToken: (key, scopes) => googleAccessToken(key, scopes, guardedFetch({ internalHosts: [], loopbackHosts: [] }))');
  }
  use('main', 'runApp', 'type Features');
  return [
    '// Starts the app: reads its settings from the environment and serves its Flows.',
    "import path from 'node:path';",
    "import { app } from './app.js';",
    ...[...imports].sort(([a], [b]) => a.localeCompare(b)).map(([file, names]) => `import { ${[...names].sort((x, y) => x.replace('type ', '').localeCompare(y.replace('type ', ''))).join(', ')} } from './runtime/${file}.js';`),
    '',
    '/** The parts of the runtime this app uses, beyond the engine, the server and the broker. */',
    features.length ? `export const features: Features = {\n${features.map((f) => `  ${f},`).join('\n')}\n};` : 'export const features: Features = {};',
    '',
    "// node dist/main.js: run from the app's folder, where sandbox/, public/ and openapi.json are.",
    "if (import.meta.main) void runApp(app, path.resolve(import.meta.dirname, '..'), features);",
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- web files

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The built-in UI ("API + simple UI"): the plan rendered with plain DOM, styled by the theme. */
function simpleUi(b: AppBundle): TarFile[] {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(b.name)}</title>
${b.theme?.brand.logo ? `<link rel="icon" href="${esc(b.theme.brand.logo)}">` : ''}
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/app.css">
<script type="module" src="/main.js"></script>
</head>
<body>
<div id="root"><p class="dty-main">Loading…</p></div>
<noscript>This app needs JavaScript.</noscript>
</body>
</html>`;
  return [
    { path: 'public/index.html', content: html },
    { path: 'public/theme.css', content: b.theme ? themeCss(b.theme) : '' },
    { path: 'public/app.css', content: APP_CSS },
    { path: 'public/main.js', content: `import { mount } from './render.js';\nmount(document.getElementById('root'));\n` },
    { path: 'public/render.js', content: RENDER_JS },
    { path: 'public/core.js', content: CORE_JS },
  ];
}

/** "/" of a runner or headless API: what this is and where its API is described. */
function infoPage(b: AppBundle): string {
  const flows = b.flows.filter((f) => f.exposed);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(b.name)}</title>
<style>:root { color-scheme: light dark; } body { margin: 0; font: 16px/1.5 system-ui, sans-serif; } main { max-width: 640px; margin: 0 auto; padding: 48px 16px; } .muted { opacity: .75; } a { color: inherit; }</style>
</head><body><main><h1>${esc(b.name)}</h1>
<p class="muted">An app exported from Dittoly. It runs ${flows.length} Flow${flows.length === 1 ? '' : 's'}${b.kind === 'runner' ? ' on schedules and webhooks' : ' through its API'}.</p>
${b.kind === 'runner' ? '' : '<p>API description: <a href="/openapi.json">/openapi.json</a></p>'}
<ul>${flows.map((f) => `<li><strong>${esc(f.name)}</strong>${f.description ? ` — ${esc(f.description)}` : ''}</li>`).join('')}</ul></main></body></html>`;
}

// ---------------------------------------------------------------- docker and docs

export function dockerfile(b: AppBundle): string {
  const out = b.frontend ? FRONTEND_OUT[b.frontend.framework] : null;
  return [
    `# ${oneLine(b.name)}: exported from Dittoly ${b.dittolyVersion} (bundle ${b.sha256.slice(0, 12)}).`,
    `# Build: docker build -t ${b.slug} .    Run: docker compose up -d   (settings in .env, see .env.example)`,
    ...(out
      ? ['', '# The frontend (generated, see frontend/).', 'FROM node:26-alpine AS web', 'WORKDIR /web', 'COPY frontend/package.json ./', 'RUN npm install --no-audit --no-fund', 'COPY frontend/ ./', 'RUN npm run build']
      : []),
    '',
    '# The app: its Flows compiled from src/, with only the packages it uses.',
    'FROM node:26-alpine AS build',
    'WORKDIR /app',
    'COPY package.json tsconfig.json ./',
    'RUN npm install --no-audit --no-fund',
    'COPY src/ ./src/',
    'RUN npm run build && npm prune --omit=dev',
    '',
    'FROM node:26-alpine',
    'WORKDIR /app',
    'COPY --from=build /app/package.json ./',
    'COPY --from=build /app/node_modules ./node_modules',
    'COPY --from=build /app/dist ./dist',
    'COPY sandbox/ ./sandbox/',
    'COPY openapi.json ./',
    out ? `COPY --from=web /web/${out} ./public` : 'COPY public/ ./public/',
    'USER node',
    'ENV NODE_ENV=production PORT=8080',
    'EXPOSE 8080',
    'HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1',
    'CMD ["node", "dist/main.js"]',
    '',
  ].join('\n');
}

export function compose(b: AppBundle): string {
  const state = b.needs.state;
  return `# ${oneLine(b.name)}. Copy .env.example to .env and fill it in, then: docker compose up -d --build
services:
  app:
    build: .
    image: ${b.slug}:latest
    env_file: .env
    ports:
      - "8080:8080"
    restart: unless-stopped
${
  state
    ? `    depends_on:
      - state
  # Where runs that wait for people, delays and table rows are kept (STATE_URL=redis://state:6379).
  # Point STATE_URL at your own Redis or Postgres instead, and remove this service, if you have one.
  state:
    image: redis:8-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - state:/data
    restart: unless-stopped
volumes:
  state: {}
`
    : ''
}`;
}

export function readme(b: AppBundle): string {
  const flows = b.flows.filter((f) => f.exposed);
  const required = b.env.filter((v) => v.required);
  const kinds = { runner: 'a runner: its Flows run on schedules and webhooks', api: 'a headless API (see openapi.json)', ui: 'an API with a built-in web app', custom: `an API with a ${b.frontend?.framework ?? ''} frontend (frontend/)` } as const;
  return `# ${oneLine(b.name)}

Exported from Dittoly ${b.dittolyVersion} as ${kinds[b.kind]}. Source sha256: \`${b.sha256}\`.
It runs on its own: no connection to Dittoly, and no database of its own.

## What is in it

- \`src/flows/\`: each Flow as TypeScript, written out from its approved version. Every step's inputs are
  expressions of the run form and earlier steps' results; the runtime runs the steps in order.
- \`src/app.ts\`: the app's settings, modules' manifests, schedules and webhooks; \`src/main.ts\` starts it.
- \`src/runtime/\`: the runtime, as TypeScript: the engine that runs the steps, the HTTP server, the warm
  sandbox workers, the broker that checks each module request against its manifest, and only the parts these
  Flows and modules use.
- \`sandbox/modules/\`: the modules' code, exactly as approved. The app checks their sha256 when it starts.

Changing a Flow file makes the app do something other than what was approved.

## Run it

\`\`\`sh
cp .env.example .env      # fill in the required values
docker compose up -d --build
open http://localhost:8080
\`\`\`

Without Docker: \`npm install && npm run build && node dist/main.js\` (Node.js 26), with the settings in the environment.
Every variable can also be given as \`<NAME>_FILE\` (a file holding the value), for Docker and Kubernetes secrets.

${
  b.needs.state
    ? `Runs that wait for a person, a delay or that use a table are kept in \`STATE_URL\`: Redis
(\`redis://\`) or Postgres (\`postgres://\`; the app creates its three tables). docker-compose.yml starts a Redis
for it. Other runs live in memory.`
    : `Runs live in memory: no Flow here waits for people, waits a while or keeps table rows.`
}

## Required settings

${required.map((v) => `- \`${v.name}\`: ${v.description}`).join('\n') || '- none beyond the defaults'}

All settings, with descriptions, are in \`.env.example\`.

## Flows

${flows.map((f) => `- **${f.name}** (\`${f.key}\`, ${f.access === 'public' ? 'public' : 'needs APP_API_TOKEN'})${f.description ? `: ${f.description}` : ''}`).join('\n')}
${b.schedules.length ? `\nSchedules: ${b.schedules.map((s) => `${s.flow} at \`${s.cron}\` (${s.timezone})`).join(', ')}. Set \`DISABLE_SCHEDULES=true\` to turn them off.\n` : ''}${b.hooks.length ? `\nWebhooks: ${b.hooks.map((h) => `\`POST /hooks/${h.flow}\` (${h.provider}, signed with \`${h.env}\`)`).join(', ')}.\n` : ''}
## API

${b.kind === 'runner' ? 'This app has no API beyond its webhooks and /health.' : `- \`POST /api/flows/<flow>/runs?wait=20\` with \`{ "inputs": { ... } }\` starts a run and waits up to 20 s for it.
- \`GET /api/runs/<id>\` reads a run (its steps' results and what it waits for).
- \`POST /api/runs/<id>/steps/<step>/decision\` with \`{ "decision": "approved" }\` (admin token) decides an approval.
- \`POST /api/runs/<id>/steps/<step>/input\` with \`{ "values": { ... } }\` answers a form the run waits for.
- \`GET /api/inbox\` lists what waits for a person (admin token).

Send \`Authorization: Bearer <APP_API_TOKEN>\` (or \`APP_ADMIN_TOKEN\`). A public Flow needs no token; its response
includes a \`runToken\` that lets the same caller read that run and answer its forms (\`X-Run-Token\` header).
The full description is in \`openapi.json\` (also served at /openapi.json).`}

## People in the loop

${b.needs.humanSteps ? `Some Flows wait for approval or a form. They wait in the app's inbox (admin token), and when
\`NOTIFY_WEBHOOK_URL\` or \`NOTIFY_EMAIL\` (with \`SMTP_URL\`) is set, a notice with signed approve and reject links
(valid 7 days) is sent once for each waiting step.` : 'No Flow in this app waits for a person.'}

## Security

- Module code runs in warm sandboxed workers: Node processes with no network, no child processes and an empty
  environment, that can read only the sandbox folder. Each request they make goes through the broker, which
  allows only the hosts and queries the manifest declares and attaches credentials outside the module's code.
- Every run uses one identity: the credentials in the \`CRED_*\` variables. Give them only the access these Flows need.
- Keep \`APP_SECRET\` the same across restarts; it signs links and encrypts what goes to \`STATE_URL\`.
`;
}

/** Every file of the export, under <slug>/. */
export function bundleFiles(b: AppBundle, root = ROOT): TarFile[] {
  const keyOf = (flowId: string, version: number) => {
    const f = b.flows.find((x) => x.sourceFlowId === flowId && x.version === version);
    if (!f) throw badRequest('export_not_possible', `a Flow runs a Flow version that is not in the export`);
    return f.key;
  };
  const runner = readFileSync(path.join(root, 'sandbox-runtime', 'runner.mjs'));
  for (const m of b.modules) if (sha256(m.code) !== m.codeSha256) throw badRequest('export_not_possible', `module ${m.name}@${m.version} does not match its approved hash`);
  const source = [
    { path: 'src/main.ts', content: mainSource(b) },
    { path: 'src/app.ts', content: appSource(b) },
    ...b.flows.map((f) => ({ path: `src/flows/${f.key}.ts`, content: compileFlow(f, keyOf, '../runtime/flow.js') })),
  ];
  const runtime = runtimeSources(source.map((f) => f.content), root);
  const files: TarFile[] = [
    { path: 'package.json', content: packageJson(b, runtime.packages, root) },
    { path: 'tsconfig.json', content: TSCONFIG },
    { path: 'Dockerfile', content: dockerfile(b) },
    { path: 'docker-compose.yml', content: compose(b) },
    { path: '.env.example', content: envExample(b.env, b.name) },
    { path: '.dockerignore', content: '.env\nnode_modules\ndist\nfrontend/node_modules\nfrontend/dist\nfrontend/out\nfrontend/.next\nfrontend/.astro\nfrontend/.angular\n' },
    { path: '.gitignore', content: '.env\nnode_modules\ndist\n' },
    { path: 'openapi.json', content: JSON.stringify(openapi(b), null, 2) },
    { path: 'README.md', content: readme(b) },
    ...source,
    ...runtime.files,
    { path: 'sandbox/runner.mjs', content: runner },
    ...b.modules.map((m) => ({ path: `sandbox/${moduleFile(m)}`, content: m.code })),
    ...(b.kind === 'ui' ? simpleUi(b) : b.kind === 'custom' ? [] : [{ path: 'public/index.html', content: infoPage(b) }]),
    ...(b.frontend && b.theme ? frontendFiles(b).map((f) => ({ ...f, path: `frontend/${f.path}` })) : []),
  ];
  return files.map((f) => ({ ...f, path: `${b.slug}/${f.path}` }));
}

/** For names inside comments of generated files: a line break would end the comment and make the rest code. */
export const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { flowDefinitionSchema } from '../flows/definition.js';
import { manifestSchema } from '../modules/manifest.js';
import { COMPILE_OPTIONS } from '../modules/source.js';
import { moduleTestSchema } from '../modules/validate.js';
import { brandInput } from '../export/theme.js';
import { MODULE_TYPES } from '../paths.js';
import type { RepoFile } from './remote.js';

/**
 * The files that make a synced repository a TypeScript project: `npm run check` type-checks the modules against
 * Dittoly's runtime types, and `npm run build` compiles them the way Dittoly does (same esbuild version and
 * options), for running or testing them outside Dittoly. JSON Schemas give editors completion and checks for
 * manifests, tests, Flows and apps. "Export everything approved now" writes them; Dittoly never reads them back.
 */

/** Pinned exactly: the build must give what Dittoly compiles. Keep esbuild in step with Dittoly's package.json. */
const ESBUILD = '0.28.2';
const TYPESCRIPT = '7.0.2';

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function schema(s: z.ZodType, title: string): Record<string, unknown> {
  return { title, ...z.toJSONSchema(s, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) };
}

const flowFile = z.object({
  format: z.literal('dittoly-flow'),
  formatVersion: z.number().int(),
  name: z.string(),
  team: z.string(),
  version: z.number().int(),
  definition: flowDefinitionSchema,
  children: z.array(z.object({ flowId: z.string(), version: z.number().int(), name: z.string().nullable(), team: z.string().nullable() })).optional(),
});
const appFile = z.object({
  format: z.literal('dittoly-app'),
  formatVersion: z.number().int(),
  name: z.string(),
  team: z.string(),
  version: z.number().int(),
  flows: z.array(z.object({ flowId: z.string(), name: z.string().nullable() })),
  plan: z.unknown(),
  brand: brandInput.nullable().optional(),
});

const BUILD_SCRIPT = `// Compiles each modules/<name>/module.ts the way Dittoly does, to dist/modules/<name>/module.mjs
// (\`npm run build -- --js\` names them module.js). A module still in JavaScript (module.mjs) is copied as is.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const OPTIONS = ${JSON.stringify(COMPILE_OPTIONS)};
const ext = process.argv.includes('--js') ? 'js' : 'mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modules = path.join(root, 'modules');
const out = path.join(root, 'dist', 'modules');
await rm(out, { recursive: true, force: true });
let built = 0;
for (const name of existsSync(modules) ? (await readdir(modules)).sort() : []) {
  const dir = path.join(modules, name);
  const target = path.join(out, name, \`module.\${ext}\`);
  if (existsSync(path.join(dir, 'module.ts'))) {
    const source = await readFile(path.join(dir, 'module.ts'), 'utf8');
    const { code } = await transform(source, { ...OPTIONS, sourcefile: \`modules/\${name}/module.ts\` });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, code);
  } else if (existsSync(path.join(dir, 'module.mjs'))) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(dir, 'module.mjs'), target);
  } else continue;
  built++;
}
console.log(\`Built \${built} module\${built === 1 ? '' : 's'} into dist/modules (.\${ext}).\`);
`;

const README = `# Dittoly

Written by Dittoly from approved versions. Each change arrives as a pull request.

- \`modules/<name>/\`: a module's manifest, code (\`module.ts\`, TypeScript), sandbox tests and \`MODULE.md\` (what each
  action does and how to use it; written by Dittoly, read only). A module written
  before modules were TypeScript has \`module.mjs\` (JavaScript) instead, until its next version.
- \`flows/<team>/<flow>/flow.json\`: a Flow or Super Flow definition. A Super Flow lists the Flows it runs under "children".
  \`FLOW.md\` beside it says what it does, step by step; a Super Flow's covers every Flow it runs (read only).
- \`apps/<team>/<app>/app.json\`: an app's Flows, page layout and look.

Approvals, run history and secrets are never written here. Changes merged into this branch come back to Dittoly as
new versions that wait for approval there. Dittoly compiles a module's \`module.ts\` itself when it reads it back.

## Working on the modules here

\`\`\`sh
cd <this folder>
npm install
npm run check        # type-checks every module.ts against Dittoly's runtime types (types/dittoly.d.ts)
npm run build        # compiles them the way Dittoly does, to dist/modules/<name>/module.mjs
npm run build -- --js   # the same, named module.js
\`\`\`

- Module code may not import anything: \`ModuleContext\`, \`ModuleActions\` and the other types are global.
- \`schemas/\` holds JSON Schemas for manifests, tests, Flows and apps; \`.vscode/settings.json\` applies them in VS Code when you open
  this folder.
- \`package.json\`, \`tsconfig.json\`, \`types/\`, \`schemas/\`, \`scripts/\` and this file are rewritten by
  "Export everything approved now". \`dist/\` is not committed.
`;

/** Every scaffold file, under the connection's folder. */
export async function scaffoldFiles(folder: string): Promise<RepoFile[]> {
  const at = (p: string) => `${folder}/${p}`;
  return [
    { path: at('README.md'), content: README },
    {
      path: at('package.json'),
      content: json({
        name: 'dittoly-automations',
        private: true,
        type: 'module',
        scripts: { check: 'tsc -p .', build: 'node scripts/build.mjs' },
        devDependencies: { esbuild: ESBUILD, typescript: TYPESCRIPT },
      }),
    },
    {
      path: at('tsconfig.json'),
      content: json({
        compilerOptions: { target: 'esnext', module: 'esnext', moduleResolution: 'bundler', lib: ['esnext'], types: [], strict: true, noEmit: true, isolatedModules: true, verbatimModuleSyntax: true },
        include: ['modules/**/*.ts', 'types/*.d.ts'],
      }),
    },
    { path: at('.gitignore'), content: 'node_modules/\ndist/\n' },
    { path: at('types/dittoly.d.ts'), content: await readFile(MODULE_TYPES, 'utf8') },
    { path: at('scripts/build.mjs'), content: BUILD_SCRIPT },
    { path: at('schemas/manifest.schema.json'), content: json(schema(manifestSchema, 'Dittoly module manifest')) },
    { path: at('schemas/tests.schema.json'), content: json(schema(z.array(moduleTestSchema), 'Dittoly module sandbox tests')) },
    { path: at('schemas/flow.schema.json'), content: json(schema(flowFile, 'Dittoly Flow file')) },
    { path: at('schemas/app.schema.json'), content: json(schema(appFile, 'Dittoly app file')) },
    {
      path: at('.vscode/settings.json'),
      content: json({
        'json.schemas': [
          { fileMatch: ['modules/*/manifest.json'], url: './schemas/manifest.schema.json' },
          { fileMatch: ['modules/*/tests.json'], url: './schemas/tests.schema.json' },
          { fileMatch: ['flows/*/*/flow.json'], url: './schemas/flow.schema.json' },
          { fileMatch: ['apps/*/*/app.json'], url: './schemas/app.schema.json' },
        ],
      }),
    },
  ];
}

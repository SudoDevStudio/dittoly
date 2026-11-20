// Writes test/fixtures/flows/error-to-fix-<toolchain>-loki-github.json for each toolchain in
// test/fixtures/flows/toolchains.json, from the Node.js template (error-to-fix-node-loki-github.json): the same
// steps, with the app-errors module (every language) and the toolchain's image, commands and folders.
// `node scripts/error-to-fix-templates.mjs` rewrites them; `--check` fails when one is out of date
// (test/error-to-fix-languages.test.ts runs it).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const flows = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'flows');
const APP_ERRORS = 'app-errors@1.0.0';

export async function templates() {
  const base = JSON.parse(await readFile(path.join(flows, 'error-to-fix-node-loki-github.json'), 'utf8'));
  const { toolchains } = JSON.parse(await readFile(path.join(flows, 'toolchains.json'), 'utf8'));
  const out = new Map();
  for (const t of toolchains) {
    const def = structuredClone(base.definition);
    def.description = def.description
      .replace('For a Node.js app', `For a ${t.title} app`)
      .replace('fixes and verifies it with npm in a sandbox', `fixes and verifies it in a sandbox (${t.image})`);
    for (const s of def.steps) {
      if (s.module?.startsWith('node-errors@')) {
        s.module = APP_ERRORS;
        // The module's defaults: the usual container folders and a Loki query for any language's errors.
        delete s.input.containerRoots;
        delete s.input.lokiQuery;
        s.input.testDirs = t.testDirs;
        if (s.action === 'choose' || s.action === 'find_error' || s.action === 'pick_error') s.input.fallbackFiles = t.sourceDirs;
      }
      if (typeof s.title === 'string') s.title = s.title.replace('the Node.js error', 'the error');
      if (s.type === 'ai' && typeof s.instruction === 'string') s.instruction = s.instruction.replace('a Node.js service', `a ${t.title} service`);
      if (s.type === 'fix') {
        s.image = t.image;
        for (const k of ['install', 'build']) {
          if (t[k]) s[k] = t[k];
          else delete s[k];
        }
        s.test = t.test;
        s.testFile = t.testFile;
        s.instruction = s.instruction
          .replace('in the Node.js application code', `in the ${t.title} application code`)
          .replace("in the repository's test folder and with its test framework", 'where the repository keeps its tests and with its test framework')
          .replace('Do not change package.json, the lock file or the build setup.', 'Do not change the dependency manifests, the lock files or the build setup.');
      }
    }
    out.set(`error-to-fix-${t.id}-loki-github.json`, { name: base.name.replace('(Node.js, Loki, GitHub)', `(${t.title}, Loki, GitHub)`), definition: def });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [file, tpl] of await templates()) {
    const text = `${JSON.stringify(tpl, null, 2)}\n`;
    const current = await readFile(path.join(flows, file), 'utf8').catch(() => '');
    if (current === text) continue;
    if (check) stale.push(file);
    else await writeFile(path.join(flows, file), text);
  }
  if (stale.length) {
    console.error(`Out of date (run node scripts/error-to-fix-templates.mjs): ${stale.join(', ')}`);
    process.exit(1);
  }
}

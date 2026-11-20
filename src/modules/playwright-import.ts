import { badRequest } from '../core/errors.js';

/**
 * Turn a pasted Playwright script into a browser module draft.
 *
 * Each test(...) becomes one action (a plain script becomes one action named
 * "run"). The page and expect the script uses are Dittoly's: the same calls,
 * carried out by the broker on a browser that may load only the sites the
 * script visits. Each action gets a live sandbox test that runs it against
 * those sites. Like any module, the draft is reviewed and approved before a
 * Flow can use it.
 *
 * Kept deliberately narrow: scripts that sign in or change data are built
 * with the AI instead, which writes offline tests and uses the member's vault.
 */

export interface PlaywrightImport {
  /** Module name, e.g. "checkout-smoke". */
  name: string;
  title: string;
  script: string;
  /** Extra sites the pages load (CDNs, sign-in pages); the ones the script visits are found automatically. */
  hosts?: string[];
}

const UNSUPPORTED: [RegExp, string][] = [
  [/\bpage\.evaluate(Handle)?\s*\(|\$eval\s*\(|\$\$eval\s*\(/, 'running JavaScript in the page (evaluate)'],
  [/\bpage\.route\s*\(|\bcontext\.route\s*\(/, 'intercepting requests (route)'],
  [/\brequest\.(get|post|put|patch|delete|fetch)\s*\(|\bapiRequest\b/, 'API requests (use a regular module for APIs)'],
  [/setInputFiles\s*\(/, 'uploading files'],
  [/\bpage\.on\s*\(|waitForEvent\s*\(|waitForResponse\s*\(|waitForRequest\s*\(/, 'listening for page events'],
  [/frameLocator\s*\(|\bframes?\s*\(/, 'frames'],
  [/\bfillSecret\s*\(|\.fill\s*\([^)]*(password|passwd|secret|token)[^)]*,\s*['"`]/i, 'signing in (build sign-in scripts with the AI, so your login stays in your vault)'],
  [/\brequire\s*\(|\bimport\s*\(|\bprocess\.|\bfs\./, 'Node.js modules or files'],
];

/** Index just past the brace that closes the one at `open`, skipping strings, templates and comments. */
function closeBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i + 2) === -1 ? src.length : src.indexOf('*/', i + 2) + 1;
    else if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

const snake = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'test_$1')
    .slice(0, 60) || 'run';

/** Blocks like test('title', async ({ page }) => { ... }); with their titles and bodies. */
function blocks(src: string, head: RegExp): { title: string; body: string; start: number; end: number }[] {
  const out: { title: string; body: string; start: number; end: number }[] = [];
  for (const m of src.matchAll(head)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const end = closeBrace(src, open);
    if (end === -1) throw badRequest('invalid_script', `the block "${m[2] ?? m[0]}" is not closed`);
    out.push({ title: m[2] ?? '', body: src.slice(open + 1, end - 1), start: m.index ?? 0, end });
  }
  return out;
}

const TEST_HEAD = /\btest(?:\.only)?\(\s*(['"`])(.+?)\1\s*,\s*async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{/g;
const BEFORE_HEAD = /\btest\.beforeEach\(\s*async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{/g;

/** Plain scripts: drop the browser setup the platform does itself. */
function plainBody(src: string): string {
  return src
    .replace(/^\s*\(\s*async\s*\(\s*\)\s*=>\s*\{/, '')
    .replace(/\}\s*\)\s*\(\s*\)\s*;?\s*$/, '')
    .split('\n')
    .filter((l) => !/\b(chromium|firefox|webkit)\.launch\s*\(|\bbrowser\.newContext\s*\(|\.newPage\s*\(|\b(browser|context)\.close\s*\(/.test(l))
    .join('\n');
}

function hostsOf(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/['"`](https?):\/\/([a-z0-9.-]+(?::\d+)?)[/'"`?#]/gi)) out.add(m[2]!.toLowerCase());
  return [...out];
}

export function playwrightToModule(input: PlaywrightImport): { manifest: unknown; code: string; tests: unknown[] } {
  const script = input.script.replace(/\r\n/g, '\n');
  if (script.length > 100_000) throw badRequest('invalid_script', 'the script is longer than 100 KB');
  // The test runner's own imports go; anything else Node-specific is refused below.
  const src = script.replace(/^\s*import\s[^;\n]*;?\s*$/gm, '').replace(/^\s*const\s*\{[^}]*\}\s*=\s*require\(\s*['"](@playwright\/test|playwright|playwright-core)['"]\s*\);?\s*$/gm, '');
  const problems = UNSUPPORTED.filter(([re]) => re.test(src)).map(([, what]) => what);
  if (problems.length) throw badRequest('script_unsupported', `this script uses ${problems.join('; ')}, which pasted scripts cannot do`);
  if (/\bgoto\(\s*['"`]\//.test(src)) throw badRequest('invalid_script', 'use full URLs in page.goto (https://...), not paths');
  const before = blocks(src, BEFORE_HEAD).map((b) => b.body).join('\n');
  const tests = blocks(src, TEST_HEAD);
  const bodies = tests.length ? tests.map((t) => ({ name: t.title, body: `${before}\n${t.body}` })) : [{ name: 'run', body: plainBody(src) }];

  const names = new Set<string>();
  const actions = bodies.map((b) => {
    let n = snake(b.name);
    while (names.has(n)) n = `${n}_2`;
    names.add(n);
    return { ...b, action: n };
  });
  const hosts = [...new Set([...hostsOf(script), ...(input.hosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)])];
  if (!hosts.length) throw badRequest('invalid_script', 'the script visits no site: add the sites it should open');

  const indent = (s: string) =>
    s
      .split('\n')
      .map((l) => (l.trim() ? `    ${l.replace(/^\s{0,4}/, '')}` : ''))
      .join('\n');
  const code = `// Imported from a pasted Playwright script. page and expect are Dittoly's, carried out by the broker.
export const actions = {
${actions
  .map(
    (a) => `  async ${a.action}(input, { page, expect }) {
    const test = { step: async (_name, fn) => fn() };
${indent(a.body)}
    return { passed: true, url: await page.url(), screenshot: await page.screenshot() };
  },`,
  )
  .join('\n')}
};
`;
  const manifest = {
    name: input.name,
    version: '1.0.0',
    title: input.title,
    description: `Runs the pasted Playwright script in a headless browser and reports whether it passed, with a screenshot. Needs no key.`,
    hosts: [],
    browser: { hosts },
    credentials: [],
    actions: actions.map((a) => ({
      name: a.action,
      title: a.name === 'run' ? 'Run the script' : a.name.slice(0, 80),
      description: `Runs "${a.name}" from the script; fails if any expectation fails.`.slice(0, 300),
      effect: 'read',
      credentials: [],
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: { passed: { type: 'boolean' }, url: { type: 'string' }, screenshot: { type: 'string' } },
        required: ['passed'],
      },
    })),
  };
  const testsOut = actions.map((a) => ({ name: `${a.name} (live)`, action: a.action, input: {}, http: [], expectOk: true, live: true }));
  return { manifest, code, tests: testsOut };
}

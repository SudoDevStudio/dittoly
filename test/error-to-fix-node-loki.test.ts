import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { createTeam, setTeamMember } from '../src/core/teams.js';
import { AppRunner } from '../src/engine/apps.js';
import { fingerprint } from '../src/flows/template.js';
import { loadExampleModules } from './fixture-modules.js';
import { moduleTestSchema, validateModule } from '../src/modules/validate.js';
import type { FetchLike } from '../src/sandbox/broker.js';
import { ProcessRunner } from '../src/sandbox/runner.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * The Node.js + self-hosted Loki + GitHub variant of "error to verified fix", end to end: the
 * template as shipped (only its placeholders filled in), a Grafana-shaped webhook alert, a Loki on a
 * LAN address over plain http (allowed by the admin's settings), pino JSON log lines, an npm project
 * tested with its own npm scripts, a fake GitHub and Slack, and a scripted AI.
 */

const examples = path.resolve(import.meta.dirname, 'fixtures');
const LOKI = '192.168.1.20:3100';
const REPO = 'your-org/your-app';
const DB_SECRET = 'postgres://app:n0de-Pa55word@db.test:5432/shop_test';
const ai = new MockProvider();
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// ---------------------------------------------------------------- fake Loki, GitHub and Slack

const pino = (msg: string, err: { type: string; message: string; stack: string }, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ level: 50, time: 1792491298120, pid: 1, hostname: 'web-1', service: 'storefront', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', err, msg, ...extra });

class Fakes {
  calls: { method: string; url: string; auth: string | null }[] = [];
  /** The log lines Loki answers with, newest first. */
  lokiLines: string[] = [];
  lokiQueries: URLSearchParams[] = [];
  refs = new Map<string, string>([['main', 'c0ffee0'.padEnd(40, '0')]]);
  trees = new Map<string, { path: string; content?: string }[]>();
  commits = new Map<string, { tree: string; message: string }>();
  prs: { number: number; head: string; base: string; title: string; body: string; draft: boolean; state: string; html_url: string; labels: string[] }[] = [];
  comments: { number: number; body: string }[] = [];
  slack: string[] = [];

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    this.calls.push({ method, url, auth: headers.get('authorization') });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

    if (u.host === LOKI && u.pathname === '/loki/api/v1/query_range') {
      this.lokiQueries.push(u.searchParams);
      const values = this.lokiLines.map((line, i) => [`${1792491298120 - i * 1000}000000`, line]);
      return json({ status: 'success', data: { resultType: 'streams', result: [{ stream: { service_name: 'storefront', container: 'storefront-1' }, values }] } });
    }
    if (u.host === 'api.github.com') {
      const p = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(u.pathname);
      if (!p || `${p[1]}/${p[2]}` !== REPO) return json({ message: 'Not Found' }, 404);
      const rest = p[3]!;
      const sha = () => `${this.refs.size + this.commits.size + this.trees.size + 1}`.padStart(40, 'b');
      if (rest === 'pulls' && method === 'GET') return json(this.prs.filter((x) => `your-org:${x.head}` === u.searchParams.get('head')).reverse());
      const ref = /^git\/ref\/heads\/(.+)$/.exec(rest);
      if (ref && method === 'GET') {
        const at = this.refs.get(decodeURIComponent(ref[1]!));
        return at ? json({ ref: `refs/heads/${ref[1]}`, object: { sha: at, type: 'commit' } }) : json({ message: 'Not Found' }, 404);
      }
      if (rest === 'git/refs' && method === 'POST') {
        const name = String(body.ref).replace(/^refs\/heads\//, '');
        if (this.refs.has(name)) return json({ message: 'Reference already exists' }, 422);
        this.refs.set(name, body.sha);
        return json({ ref: body.ref, object: { sha: body.sha } }, 201);
      }
      const commit = /^git\/commits\/([0-9a-f]{40})$/.exec(rest);
      if (commit && method === 'GET') return json({ sha: commit[1], tree: { sha: this.commits.get(commit[1]!)?.tree ?? 'd'.repeat(40) } });
      if (rest === 'git/trees' && method === 'POST') {
        const t = sha();
        this.trees.set(t, body.tree);
        return json({ sha: t }, 201);
      }
      if (rest === 'git/commits' && method === 'POST') {
        const c = sha();
        this.commits.set(c, { tree: body.tree, message: body.message });
        return json({ sha: c, html_url: `https://github.com/${REPO}/commit/${c}` }, 201);
      }
      const move = /^git\/refs\/heads\/(.+)$/.exec(rest);
      if (move && method === 'PATCH') {
        this.refs.set(decodeURIComponent(move[1]!), body.sha);
        return json({ ref: `refs/heads/${move[1]}`, object: { sha: body.sha } });
      }
      if (rest === 'pulls' && method === 'POST') {
        if (this.prs.some((x) => x.head === body.head && x.state === 'open')) return json({ message: 'A pull request already exists' }, 422);
        const number = this.prs.length + 1;
        const pr = { number, head: body.head, base: body.base, title: body.title, body: body.body, draft: body.draft === true, state: 'open', html_url: `https://github.com/${REPO}/pull/${number}`, labels: [] as string[] };
        this.prs.push(pr);
        return json(pr, 201);
      }
      const labels = /^issues\/(\d+)\/labels$/.exec(rest);
      if (labels && method === 'POST') {
        this.prs.find((x) => x.number === Number(labels[1]))?.labels.push(...body.labels);
        return json(body.labels.map((name: string) => ({ name })));
      }
      const comment = /^issues\/(\d+)\/comments$/.exec(rest);
      if (comment && method === 'POST') {
        this.comments.push({ number: Number(comment[1]), body: body.body });
        return json({ id: 7000 + this.comments.length, html_url: `https://github.com/${REPO}/pull/${comment[1]}#issuecomment-${7000 + this.comments.length}` }, 201);
      }
    }
    if (u.host === 'slack.com' && u.pathname === '/api/chat.postMessage') {
      this.slack.push(body.text);
      return json({ ok: true, ts: `1700000000.00${this.slack.length}` });
    }
    return json({ error: 'unexpected' }, 404);
  };
}

// ---------------------------------------------------------------- the npm project with the bugs

async function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

// "npm test" runs every test file; "npm test -- <file>" runs one (the template's testFile).
const RUN_TESTS = `const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
if (!process.env.DATABASE_URL) { console.log('DATABASE_URL is not set'); process.exit(3); }
console.log('test database: ' + process.env.DATABASE_URL);
const files = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync('test').filter((f) => f.endsWith('.test.js')).map((f) => 'test/' + f);
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, [f], { stdio: 'pipe' }); console.log('ok ' + f); } catch { failed++; console.log('FAIL ' + f); }
}
process.exit(failed ? 1 : 0);
`;
const PACKAGE_JSON = `${JSON.stringify({ name: 'storefront', version: '1.0.0', private: true, scripts: { build: 'node build.js', test: 'node run-tests.js' } }, null, 2)}\n`;
const PACKAGE_LOCK = `${JSON.stringify({ name: 'storefront', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'storefront', version: '1.0.0' } } }, null, 2)}\n`;
const CART_BUG = 'exports.total = (cart) => cart.items.reduce((n, i) => n + i.price * i.qty, 0);\n';
const CART_FIXED = 'exports.total = (cart) => (cart.items ?? []).reduce((n, i) => n + i.price * i.qty, 0);\n';
const CART_REGRESSION = "const assert = require('node:assert');\nconst { total } = require('../src/cart.js');\nassert.strictEqual(total({}), 0);\n";
const API = "const { total } = require('./cart.js');\nexports.checkout = async (cart) => ({ total: total(cart) });\n";
const SHIPPING = 'exports.cost = (weight) => (weight > 10 ? 15 : 5);\n';
const CART_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'reduce')",
  '    at exports.total (file:///usr/src/app/src/cart.js:1:43)',
  '    at async exports.checkout (/usr/src/app/src/api.js:2:51)',
  '    at Layer.handle (/usr/src/app/node_modules/express/lib/router/layer.js:95:5)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
].join('\n');
const NODE_API_LOG = {
  timestamp: '2026-10-23T02:20:01.025Z', service: 'node-api', level: 'error', message: 'Simulated internal server error', requestId: 'b8474dab-12c1-42bd-b4cd-3c20f21c7bdd',
  method: 'GET', path: '/users', status: 500, durationMs: 0.32,
  error: {
    name: 'HttpError',
    message: 'Simulated internal server error',
    stack: 'HttpError: Simulated internal server error\n    at Server.<anonymous> (file:///app/src/app.js:102:15)\n    at Server.emit (node:events:514:28)\n    at parserOnIncoming (node:_http_server:1293:12)',
  },
};
const CART_ERR = { type: 'TypeError', message: "Cannot read properties of undefined (reading 'reduce')", stack: CART_STACK };

async function makeRepo(dir: string) {
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'test'));
  await writeFile(path.join(dir, 'src', 'cart.js'), CART_BUG);
  await writeFile(path.join(dir, 'src', 'api.js'), API);
  await writeFile(path.join(dir, 'src', 'shipping.js'), SHIPPING);
  await writeFile(path.join(dir, 'build.js'), "for (const m of ['cart', 'api', 'shipping']) require('./src/' + m + '.js');\n");
  await writeFile(path.join(dir, 'run-tests.js'), RUN_TESTS);
  await writeFile(path.join(dir, 'package.json'), PACKAGE_JSON);
  await writeFile(path.join(dir, 'package-lock.json'), PACKAGE_LOCK);
  await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(dir, 'test', 'cart.test.js'), "const assert = require('node:assert');\nassert.strictEqual(require('../src/cart.js').total({ items: [{ price: 2, qty: 3 }] }), 6);\n");
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'storefront');
}

// ---------------------------------------------------------------- the scripted AI

const act = (a: Record<string, string>) => ({ action: 'list', path: '', content: '', query: '', command: '', summary: '', regressionTest: '', ...a });
const triage = (verdict: 'bug' | 'noise', confidence: number, evidence: string[], reason: string) => ai.enqueue({ text: JSON.stringify({ verdict, confidence, evidence, reason }) });
function scriptFix(writes: [string, string][], summary: string, regressionTest: string) {
  ai.enqueue(act({ action: 'read', path: writes[0]![0] }));
  for (const [p, content] of writes) ai.enqueue(act({ action: 'write', path: p, content }));
  ai.enqueue(act({ action: 'run', command: regressionTest }));
  ai.enqueue(act({ action: 'run', command: 'test' }));
  ai.enqueue(act({ action: 'done', summary, regressionTest }));
}

// ---------------------------------------------------------------- the world

const fake = new Fakes();
let w: World;
let api: ReturnType<typeof buildServer>;
let base = '';
let team = '';
const cloned: { url: string; ref: string; token: string | null }[] = [];
const MODULES = ['error-fix-policy', 'github-fix', 'loki-lan', 'node-errors', 'slack'];
const PUSH_STEPS = ['push_branch', 'push_commit', 'push_mr'];
const ACCEPT = [
  { sink: 'fix', reason: 'The triage only decides whether the fix step runs and gives it context; the fix step verifies its own change in the sandbox.' },
  { sink: 'record_stop', reason: "Writes the triage's verdict to our own error_fixes table." },
  { sink: 'record_failed', reason: 'Records a failed attempt in our own error_fixes table.' },
  { sink: 'record_waiting', reason: 'Notes in our own error_fixes table that a push waits for a sign-off.' },
  { sink: 'record_mr', reason: 'Records the pull request in our own error_fixes table.' },
  { sink: 'notify', reason: 'Posts the pull request link to our own fixes channel.' },
  { sink: 'notify_failed', reason: 'Posts that a fix did not verify to our own fixes channel.' },
  // When the posted error has an unknown shape, the AI reads it out; that text reaches these too.
  { sink: 'record_seen', reason: 'Counts the error in our own error_fixes table.' },
  { sink: 'comment_seen', reason: 'Says on our own open fix pull request that the error happened again.' },
  { sink: 'clear_logs', reason: 'Keeps the evidence in our own error_fix_evidence table.' },
  { sink: 'claim', reason: 'Reserves the error in our own error_fixes table so equivalent alerts start one investigation.' },
];
const TABLES = [
  {
    name: 'error_fixes',
    keyColumn: 'fingerprint',
    columns: [
      ['status', 'text'], ['service', 'text'], ['message', 'text'], ['times_seen', 'number'], ['first_seen', 'date'], ['last_seen', 'date'],
      ['attempts', 'number'], ['branch', 'text'], ['last_attempt', 'date'], ['last_comment_at', 'date'], ['mr_url', 'text'], ['mr_iid', 'number'],
      ['mr_opened_at', 'date'], ['previous_mr_url', 'text'], ['note', 'text'],
    ],
  },
  { name: 'error_fix_evidence', keyColumn: 'fingerprint', columns: [['logs', 'text'], ['source', 'text'], ['captured_at', 'date']] },
];

async function load(name: string) {
  const dir = path.join(examples, 'modules', name);
  return {
    manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
    code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
    tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')) as unknown[],
  };
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'dty-e2f-node-'));
  const repo = path.join(base, 'repo');
  await makeRepo(repo);
  const apps = new AppRunner({
    mode: 'local',
    internalHosts: [],
    directAllowed: async () => true,
    dockerAvailable: async () => false,
    clone: async (url, ref, token, dir) => {
      cloned.push({ url: url.href, ref, token });
      execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', ref, `file://${repo}`, path.join(dir, 'src')], { stdio: 'ignore' });
      return 'c0ffee0'.padEnd(40, '0');
    },
  });
  // The admin's settings for a Loki on the LAN over plain http: the address is allowed, nothing else.
  w = await makeWorld({ insecureHttpHosts: [LOKI], internalHosts: [LOKI] }, { apps, ai, fetchImpl: fake.fetch });
  api = buildServer(w.app);
  team = (await createTeam(w.db, w.admin, 'Storefront')).id;
  await setTeamMember(w.db, w.admin, team, w.alice.id, 'member');
  for (const tb of TABLES) await w.app.tables.create(w.admin, { teamId: team, name: tb.name, keyColumn: tb.keyColumn, columns: tb.columns.map(([name, type]) => ({ name, type })) });
  for (const name of MODULES) {
    const m = await load(name);
    const mv = await w.app.modules.createDraft({ ...m, origin: 'seed' } as never, w.alice);
    if (!mv.validationReport?.passed) throw new Error(`${name} failed validation: ${JSON.stringify(mv.validationReport)}`);
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
  }
  // No Loki login: a local Loki in Docker usually has no authentication.
  await w.app.vault.put(w.alice.id, 'github', 'github_pat_alice_node');
  await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice-node');
  await w.app.vault.put(w.alice.id, 'app_test_database_url', DB_SECRET);
}, 180_000);
afterAll(async () => {
  await api.close();
  await w.db.end();
  await rm(base, { recursive: true, force: true });
});

/** The template with its placeholders filled in: only the Slack channel; the npm commands are used as shipped. */
async function flowDefinition() {
  const t = JSON.parse(await readFile(path.join(examples, 'flows', 'error-to-fix-node-loki-github.json'), 'utf8')) as { name: string; definition: { steps: Record<string, unknown>[] } };
  const steps = t.definition.steps.map((s) => (s.id === 'notify' || s.id === 'notify_failed' ? { ...s, input: { ...(s.input as object), channel: 'C-fixes' } } : s));
  return { name: t.name, definition: { ...t.definition, steps } };
}

/** The trigger for a Grafana alert. */
async function grafanaTrigger(flowVersionId: string) {
  const res = await api.inject({
    method: 'POST',
    url: '/api/triggers',
    headers: auth(w.tokens.alice),
    payload: {
      flowVersionId,
      provider: 'token',
      payloadSchema: { type: 'object', required: ['status', 'alerts'], properties: { status: { const: 'firing' }, alerts: { type: 'array', minItems: 1 } } },
      inputMap: { payload: '' },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; secret: string };
}

let alertNo = 0;
/** A Grafana webhook body (as Grafana's webhook contact point sends it), with one alert. */
function grafanaBody(status: 'firing' | 'resolved' = 'firing', labels: Record<string, string> = {}) {
  alertNo += 1;
  const alert = {
    status,
    labels: { alertname: 'Storefront errors', grafana_folder: 'Apps', service_name: 'storefront', repo: REPO, ...labels },
    annotations: { summary: 'Errors in storefront' },
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: '0001-01-01T00:00:00Z',
    generatorURL: `http://192.168.1.20:3000/alerting/grafana/x/view?n=${alertNo}`,
    fingerprint: `c6eadffa33fcdf${alertNo.toString().padStart(2, '0')}`,
    silenceURL: 'http://192.168.1.20:3000/alerting/silence/new',
    values: { A: 3 },
  };
  return {
    receiver: 'Dittoly', status, orgId: 1, alerts: [alert], groupLabels: { alertname: 'Storefront errors' }, commonLabels: alert.labels,
    commonAnnotations: alert.annotations, externalURL: 'http://192.168.1.20:3000/', version: '1', groupKey: `{}:{alertname="Storefront errors"}#${alertNo}`, truncatedAlerts: 0,
    title: `[${status.toUpperCase()}:1] Storefront errors`, state: status === 'firing' ? 'alerting' : 'ok', message: '',
  };
}

async function send(trigger: { id: string; secret: string }, body: unknown) {
  return api.inject({ method: 'POST', url: `/hooks/${trigger.id}`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${trigger.secret}` } });
}
async function view(runId: string) {
  const r = await runStatus(w, runId, w.alice);
  return { ...r, by: Object.fromEntries(r.steps.map((s) => [s.id, s])) as Record<string, (typeof r.steps)[number]> };
}
async function alert(trigger: { id: string; secret: string }) {
  const res = await send(trigger, grafanaBody());
  expect(res.statusCode, res.body).toBe(202);
  await w.app.worker.drain();
  return view(res.json().runId as string);
}
const statuses = (r: Awaited<ReturnType<typeof view>>, ids: string[]) => Object.fromEntries(ids.map((id) => [id, r.by[id]!.status]));
async function row(key: string) {
  const tb = (await w.app.tables.byName(w.db, team, 'error_fixes'))!;
  return w.app.tables.getRow(w.db, tb, key);
}

// ---------------------------------------------------------------- the scenarios

describe('the Node.js modules', () => {
  it('node-errors passes its sandbox tests with no OWASP or Performance warning', async () => {
    const m = await load('node-errors');
    const { report } = await validateModule(new ProcessRunner(), m.manifest, m.code, m.tests.map((t) => moduleTestSchema.parse(t)));
    expect(report.tests.filter((t) => !t.passed), JSON.stringify(report.tests)).toEqual([]);
    expect(report.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.details?.join(', ')}`)).toEqual([]);
  }, 60_000);

  it('loki-lan passes only where the admin allows plain http to the Loki address', async () => {
    const m = await load('loki-lan');
    const tests = m.tests.map((t) => moduleTestSchema.parse(t));
    const allowed = await validateModule(new ProcessRunner(), m.manifest, m.code, tests, { insecureHttpHosts: [LOKI] });
    expect(allowed.report.tests.filter((t) => !t.passed), JSON.stringify(allowed.report.tests)).toEqual([]);
    expect(allowed.report.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.details?.join(', ')}`)).toEqual([]);
    const refused = await validateModule(new ProcessRunner(), m.manifest, m.code, tests);
    expect(refused.report.passed).toBe(false);
    expect(refused.report.tests.find((t) => t.name.includes('pino'))!.errorType).toBe('egress_denied_scheme');
  }, 60_000);
});

describe('error to verified fix PR for Node.js, Loki on the LAN and GitHub, end to end', () => {
  let trigger: { id: string; secret: string };
  let key = '';
  let flowId = '';

  it('approved with the same accepted paths as the GitHub template; only the push steps keep their evidence gate', async () => {
    const f = await flowDefinition();
    const created = await api.inject({ method: 'POST', url: '/api/flows', headers: auth(w.tokens.alice), payload: { name: f.name, definition: f.definition, teamId: team } });
    expect(created.statusCode, created.body).toBe(201);
    const versionId = created.json().id as string;
    flowId = created.json().flowId as string;
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: auth(w.tokens.approver) })).json();
    expect([...review.injection.sinks].sort()).toEqual(['claim', 'clear_logs', 'comment_seen', 'fix', 'notify', 'notify_failed', ...PUSH_STEPS, 'record_failed', 'record_mr', 'record_seen', 'record_stop', 'record_waiting']);
    // The AI that reads an error of unknown shape also reaches the push: only runs where it ran ask a person.
    expect(review.evidenceGates).toEqual(PUSH_STEPS.map((step) => ({ step, rule: 'steps.fix.output.autoPushAllowed', fixStep: 'fix', autoPushAt: 90, otherSources: ['extract'] })));
    const decided = await api.inject({ method: 'POST', url: `/api/flow-versions/${versionId}/decision`, headers: auth(w.tokens.approver), payload: { decision: 'approved', accept: ACCEPT } });
    expect(decided.statusCode, decided.body).toBe(200);
    const approved = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: auth(w.tokens.alice) })).json();
    expect(approved.injection.guarded).toEqual(PUSH_STEPS);
    trigger = await grafanaTrigger(versionId);
  }, 120_000);

  it('a Grafana alert: Loki read over http on the LAN, the pino error picked, fixed with npm in the sandbox, one draft PR', async () => {
    fake.lokiLines = [
      JSON.stringify({ level: 30, time: 1792491298500, msg: 'GET /health 200' }),
      pino('request failed', CART_ERR, { reqId: 'req-41', userEmail: 'jane@example.com' }),
      JSON.stringify({ level: 'error', message: 'upstream timeout', service: 'storefront' }),
    ];
    triage('bug', 90, ['cart.items is undefined: total() reads .reduce of it'], 'total() does not handle a cart without items.');
    scriptFix([['src/cart.js', CART_FIXED], ['test/cart-empty.test.js', CART_REGRESSION]], 'A cart without items now totals 0.', 'test/cart-empty.test.js');
    const r = await alert(trigger);
    expect(r.status, JSON.stringify(r.steps.map((s) => [s.id, s.status, s.errorType]))).toBe('succeeded');

    // The alert, the Loki query (plain http to the allowed LAN address, no login) and the picked error.
    expect(r.by.find!.output).toMatchObject({ needsLogs: true, needsAi: false, service: 'storefront', repo: REPO, commit: '' });
    expect(statuses(r, ['logs', 'pick', 'extract'])).toEqual({ logs: 'succeeded', pick: 'succeeded', extract: 'skipped' });
    expect(r.by.error!.output).toMatchObject({ source: 'loki', service: 'storefront', appFiles: ['src/cart.js', 'src/api.js'] });
    expect(fake.lokiQueries).toHaveLength(1);
    expect(fake.lokiQueries[0]!.get('query')).toBe('{service_name="storefront"} |~ "(?i)(error|exception|\\"level\\":\\\\s*(50|60))"');
    const lokiCall = fake.calls.find((c) => c.url.includes(LOKI))!;
    expect(lokiCall.url.startsWith(`http://${LOKI}/loki/api/v1/query_range?`)).toBe(true);
    expect(lokiCall.auth).toBeNull();
    expect(r.by.pick!.output).toMatchObject({
      found: true,
      message: "TypeError: Cannot read properties of undefined (reading 'reduce')",
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      appFiles: ['src/cart.js', 'src/api.js'],
      onlyFilesIn: ['src/cart.js', 'src/api.js', 'test/', 'tests/', '__tests__/'],
    });
    expect((r.by.pick!.output as { stack: string }).stack).toContain('at exports.total (src/cart.js:1:43)\n    at exports.checkout (src/api.js:2:51)');
    expect(r.by.normalize!.output).toMatchObject({ topFrame: 'exports.total (src/cart.js)', errorType: 'TypeError', ref: 'main' });
    key = fingerprint((r.by.normalize!.output as { text: string }).text);

    // The fix step ran the template's npm commands on the deployed branch of the GitHub repository.
    expect(cloned.at(-1)).toEqual({ url: `https://github.com/${REPO}.git`, ref: 'main', token: 'github_pat_alice_node' });
    const fix = r.by.fix!.output as Record<string, any>;
    expect(fix.verified).toEqual({ buildOk: true, reproducedBefore: null, regressionTestFailsBefore: true, regressionTestPassesAfter: true, reproducedAfter: null, testsPassAfter: true });
    expect(fix.limits).toEqual({ ok: true, violations: [] });
    expect(fix.confidence).toMatchObject({ score: 95, level: 'high' });
    expect(fix.autoPushAllowed).toBe(true);
    expect(fix.logTail).toContain('node run-tests.js test/cart-empty.test.js');
    expect(fix.logTail).toContain('test database: [secret removed]');
    expect(fix.change.files.map((f: { path: string }) => f.path)).toEqual(['src/cart.js', 'test/cart-empty.test.js']);
    expect(JSON.stringify(r)).not.toContain('n0de-Pa55word');

    // GitHub: one branch, one commit, one draft pull request with the confidence report; the team is told.
    const branch = `dittoly/fix-${key}`;
    expect([...fake.refs.keys()]).toEqual(['main', branch]);
    expect(fake.prs).toHaveLength(1);
    expect(fake.prs[0]).toMatchObject({ head: branch, base: 'main', draft: true, labels: ['dittoly', 'auto-fix'], title: 'Fix TypeError in storefront at exports.total (src/cart.js)' });
    expect(fake.prs[0]!.body).toContain('### Confidence: 95/100 (high)');
    expect(fake.prs[0]!.body).not.toContain('jane@example.com');
    expect(fake.slack.at(-1)).toContain(fake.prs[0]!.html_url);
    expect(await row(key)).toMatchObject({ status: 'mr_open', mr_iid: 1, branch });
  }, 180_000);

  it('the same error again: one "seen again" comment on the open pull request, nothing new', async () => {
    const again = await alert(trigger);
    expect(again.status).toBe('succeeded');
    expect(fingerprint((again.by.normalize!.output as { text: string }).text)).toBe(key);
    expect(again.by.decide!.output).toMatchObject({ decision: 'comment_open_mr', timesSeen: 2, mrNumber: 1 });
    expect(statuses(again, ['comment_seen', 'triage', 'fix', ...PUSH_STEPS])).toEqual({ comment_seen: 'succeeded', triage: 'skipped', fix: 'skipped', push_branch: 'skipped', push_commit: 'skipped', push_mr: 'skipped' });
    expect(fake.comments).toEqual([{ number: 1, body: expect.stringContaining('happened 2 times') }]);
    expect(fake.prs).toHaveLength(1);
  }, 120_000);

  it('a resolved alert starts nothing', async () => {
    const runs = (await w.db.query(`SELECT count(*)::int AS n FROM runs`)).rows[0].n;
    const res = await send(trigger, grafanaBody('resolved'));
    expect(res.statusCode).toBe(422);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM runs`)).rows[0].n).toBe(runs);
  });

  it('a fix that changes a file outside the stack trace is outside its limits: the push waits for a person', async () => {
    const shippingErr = { type: 'RangeError', message: 'Invalid weight -1', stack: 'RangeError: Invalid weight -1\n    at exports.checkout (/usr/src/app/src/api.js:2:51)' };
    fake.lokiLines = [pino('request failed', shippingErr)];
    triage('bug', 80, ['checkout passes a negative weight'], 'Negative weights reach checkout.');
    scriptFix(
      [['src/shipping.js', 'exports.cost = (weight) => (weight > 10 ? 15 : weight < 0 ? 0 : 5);\n'], ['test/shipping.test.js', "const assert = require('node:assert');\nassert.strictEqual(require('../src/shipping.js').cost(-1), 0);\n"]],
      'Negative weights now cost nothing.',
      'test/shipping.test.js',
    );
    const r = await alert(trigger);
    expect(r.by.pick!.output).toMatchObject({ appFiles: ['src/api.js'] });
    const fix = r.by.fix!.output as Record<string, any>;
    expect(fix.limits).toEqual({ ok: false, violations: ['src/shipping.js: not one of the files the fix may change (onlyFilesIn)'] });
    expect(fix.autoPushAllowed).toBe(false);
    expect(r).toMatchObject({ status: 'waiting', waitReason: 'approval' });
    expect(r.by.push_branch).toMatchObject({ status: 'waiting', errorType: 'awaiting_sign_off' });
    expect(fake.prs).toHaveLength(1);
  }, 180_000);
  it("any JSON posted to a Flow URL: the app's own log entry is read as it is, with no Loki and no AI", async () => {
    const url = await api.inject({ method: 'POST', url: `/api/flows/${flowId}/endpoints`, headers: auth(w.tokens.alice), payload: { name: 'node-api', followLatest: true } });
    expect(url.statusCode, url.body).toBe(201);
    const { id, token } = url.json() as { id: string; token: string };
    const queries = fake.lokiQueries.length;
    triage('noise', 90, ['a simulated error'], 'The route throws on purpose.');
    // Posted exactly as the app logs it; the Flow URL has no body mapping.
    const res = await api.inject({ method: 'POST', url: `/sflow/${id}`, headers: { 'x-sflow-token': token, 'content-type': 'application/json' }, payload: NODE_API_LOG });
    expect(res.statusCode, res.body).toBe(202);
    await w.app.worker.drain();
    const r = await view(res.json().runId as string);
    expect(r.status, JSON.stringify(r.steps.map((s) => [s.id, s.status, s.errorType]))).toBe('succeeded');
    expect(statuses(r, ['logs', 'pick', 'extract'])).toEqual({ logs: 'skipped', pick: 'skipped', extract: 'skipped' });
    expect(fake.lokiQueries).toHaveLength(queries);
    expect(r.by.error!.output).toMatchObject({
      source: 'payload',
      service: 'node-api',
      message: 'HttpError: Simulated internal server error',
      appFiles: ['src/app.js'],
      onlyFilesIn: ['src/app.js', 'test/', 'tests/', '__tests__/'],
    });
    expect((r.by.error!.output as { stack: string }).stack).toContain('at Server.<anonymous> (src/app.js:102:15)');
    expect(r.by.verdict!.output).toMatchObject({ stop: true });
  }, 120_000);

  it('a shape the rules do not know: the AI reads the error out of it', async () => {
    ai.enqueue({ text: JSON.stringify({ found: true, message: 'RangeError: Invalid weight -1', stack: 'RangeError: Invalid weight -1\n    at exports.cost (/usr/src/app/src/shipping.js:1:20)', service: 'storefront', time: '', commit: '' }) });
    triage('noise', 90, ['a test report'], 'Reported by hand.');
    const url = await api.inject({ method: 'POST', url: `/api/flows/${flowId}/endpoints`, headers: auth(w.tokens.alice), payload: { name: 'support desk', followLatest: true } });
    const { id, token } = url.json() as { id: string; token: string };
    const res = await api.inject({ method: 'POST', url: `/sflow/${id}`, headers: { 'x-sflow-token': token, 'content-type': 'application/json' }, payload: { ticket: 812, note: 'Checkout shows a blank page for a parcel with weight -1 since 10:00' } });
    expect(res.statusCode, res.body).toBe(202);
    await w.app.worker.drain();
    const r = await view(res.json().runId as string);
    expect(r.status, JSON.stringify(r.steps.map((s) => [s.id, s.status, s.errorType]))).toBe('succeeded');
    expect(r.by.find!.output).toMatchObject({ found: false, needsAi: true });
    expect(statuses(r, ['logs', 'pick', 'extract'])).toEqual({ logs: 'skipped', pick: 'skipped', extract: 'succeeded' });
    expect(r.by.error!.output).toMatchObject({ source: 'ai', service: 'storefront', message: 'RangeError: Invalid weight -1', appFiles: ['src/shipping.js'] });
  }, 120_000);
});

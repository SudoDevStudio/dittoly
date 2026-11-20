import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { createTeam, setTeamMember } from '../src/core/teams.js';
import { AppRunner } from '../src/engine/apps.js';
import { fingerprint } from '../src/flows/template.js';
import type { FetchLike } from '../src/sandbox/broker.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * "Error to verified fix MR", end to end: the template Flow as shipped (only its placeholders
 * filled in), the example modules, a token webhook receiving Datadog-style alerts, fake Datadog,
 * GitLab and Slack APIs, a local git repository with real bugs, and a scripted AI. The fix step
 * runs in direct mode (no Docker). After the approval, no person signs anything for a verified fix.
 */

const examples = path.resolve(import.meta.dirname, 'fixtures');
const DB_SECRET = 'postgres://app:t3st-Pa55word@db.test:5432/shop_test';
const PROJECT = 'your-group/your-app';
const GH_REPO = 'your-org/your-app';
const ai = new MockProvider();
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// ---------------------------------------------------------------- fake Datadog, GitLab, GitHub and Slack

class FakeServices {
  calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  branches = new Map<string, string>([['main', 'c0ffee0']]);
  commits: { branch: string; message: string; actions: { action: string; file_path: string; content?: string }[] }[] = [];
  mrs: { iid: number; source_branch: string; target_branch: string; title: string; description: string; labels: string; state: string; web_url: string }[] = [];
  notes: { iid: number; body: string }[] = [];
  /** GitLab: the ref each new branch was created from. */
  branchFrom: string[] = [];
  slack: { channel: string; text: string }[] = [];
  datadogQueries: { filter: { query: string; from: string; to: string } }[] = [];
  // GitHub: refs to commit shas, commits (sha -> tree), trees (sha -> the files written), pull requests, comments.
  gh = {
    refs: new Map<string, string>([['main', 'c0ffee0'.padEnd(40, '0')]]),
    trees: new Map<string, { path: string; content?: string; sha?: null }[]>(),
    treeFiles: new Map<string, Record<string, string>>([['d'.repeat(40), {}]]),
    commits: new Map<string, { tree: string; message: string; parents: string[] }>(),
    prs: [] as { number: number; head: string; base: string; title: string; body: string; draft: boolean; state: string; html_url: string; labels: string[] }[],
    comments: [] as { number: number; body: string }[],
  };

  /** Requests ("METHOD host/path" prefixes) the app handles but whose answer is lost on the way back, once each. */
  lose: string[] = [];

  fetch: FetchLike = async (url, init) => {
    const res = await this.handle(url, init);
    const u = new URL(url);
    const key = `${(init.method ?? 'GET').toUpperCase()} ${u.host}${u.pathname}`;
    const i = this.lose.findIndex((prefix) => key.startsWith(prefix));
    if (i >= 0 && res.ok) {
      this.lose.splice(i, 1);
      throw new TypeError('fetch failed');
    }
    return res;
  };

  private handle: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    this.calls.push({ method, url, auth: headers.get('authorization') ?? headers.get('private-token'), body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

    if (u.host === 'api.datadoghq.com' && u.pathname === '/api/v2/logs/events/search' && method === 'POST') {
      this.datadogQueries.push(body);
      const service = /service:(\S+)/.exec(body.filter.query)?.[1] ?? '';
      return json({
        data: [
          { id: 'AQAAAY1', attributes: { timestamp: '2026-10-20T10:14:58.000Z', service, status: 'error', host: 'web-1', message: 'request failed', attributes: { error: { kind: 'TypeError', message: "Cannot read properties of undefined (reading 'reduce')", stack: 'TypeError: x\n    at exports.total (/app/src/cart.js:1:43)' }, version: '4.2.1' } } },
          { id: 'AQAAAY2', attributes: { timestamp: '2026-10-20T10:14:57.000Z', service, status: 'error', host: 'web-1', message: 'POST /checkout 500 (cart had no items field)', attributes: {} } },
        ],
        meta: { page: {} },
      });
    }
    if (u.host === 'gitlab.com') {
      const p = /^\/api\/v4\/projects\/([^/]+)\/(.*)$/.exec(u.pathname);
      if (!p || decodeURIComponent(p[1]!) !== PROJECT) return json({ message: '404 Project Not Found' }, 404);
      const rest = p[2]!;
      if (rest === 'merge_requests' && method === 'GET') {
        const branch = u.searchParams.get('source_branch');
        return json(this.mrs.filter((m) => m.source_branch === branch).reverse());
      }
      const branchRead = /^repository\/branches\/(.+)$/.exec(rest);
      if (branchRead && method === 'GET') {
        const name = decodeURIComponent(branchRead[1]!);
        const id = this.branches.get(name);
        if (!id) return json({ message: '404 Branch Not Found' }, 404);
        const c = this.commits[Number.parseInt(id.replace(/^a+/, ''), 10) - 1];
        return json({ name, commit: { id, short_id: id.slice(0, 8), message: c && /^a+\d+$/.test(id) ? c.message : 'Earlier work', web_url: `https://gitlab.com/${PROJECT}/-/commit/${id}` } });
      }
      const fileRead = /^repository\/files\/([^/]+)$/.exec(rest);
      if (fileRead && method === 'GET') {
        // The files the fix commits wrote on that branch (files from before are not modelled).
        const file = decodeURIComponent(fileRead[1]!);
        let content: string | undefined;
        for (const c of this.commits.filter((x) => x.branch === u.searchParams.get('ref'))) {
          for (const a of c.actions) if (a.file_path === file) content = a.action === 'delete' ? undefined : a.content;
        }
        return content === undefined ? json({ message: '404 File Not Found' }, 404) : json({ file_path: file, encoding: 'base64', content: Buffer.from(content).toString('base64') });
      }
      if (rest === 'repository/branches' && method === 'POST') {
        if (this.branches.has(body.branch)) return json({ message: 'Branch already exists' }, 400);
        // GitLab takes a branch name or a commit SHA as ref.
        const from = this.branches.get(body.ref) ?? (/^[0-9a-f]{40}$/.test(body.ref) ? body.ref : undefined);
        if (!from) return json({ message: 'Invalid reference name' }, 400);
        this.branchFrom.push(body.ref);
        this.branches.set(body.branch, from);
        return json({ name: body.branch, commit: { id: from }, web_url: `https://gitlab.com/${PROJECT}/-/tree/${body.branch}` }, 201);
      }
      if (rest === 'repository/commits' && method === 'POST') {
        if (!this.branches.has(body.branch)) return json({ message: 'You can only create or edit files when you are on a branch' }, 400);
        this.commits.push({ branch: body.branch, message: body.commit_message, actions: body.actions });
        const id = `${this.commits.length}`.padStart(40, 'a');
        this.branches.set(body.branch, id);
        return json({ id, short_id: id.slice(0, 8), web_url: `https://gitlab.com/${PROJECT}/-/commit/${id}` }, 201);
      }
      if (rest === 'merge_requests' && method === 'POST') {
        if (this.mrs.some((m) => m.source_branch === body.source_branch && m.state === 'opened')) return json({ message: ['Another open merge request already exists for this source branch'] }, 409);
        const iid = this.mrs.length + 1;
        const mr = { iid, source_branch: body.source_branch, target_branch: body.target_branch, title: body.title, description: body.description, labels: body.labels ?? '', state: 'opened', web_url: `https://gitlab.com/${PROJECT}/-/merge_requests/${iid}` };
        this.mrs.push(mr);
        return json({ ...mr, draft: body.title.startsWith('Draft:') }, 201);
      }
      const note = /^merge_requests\/(\d+)\/notes$/.exec(rest);
      if (note && method === 'POST') {
        this.notes.push({ iid: Number(note[1]), body: body.body });
        return json({ id: 9000 + this.notes.length }, 201);
      }
    }
    if (u.host === 'api.github.com') {
      const p = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(u.pathname);
      if (!p || `${decodeURIComponent(p[1]!)}/${decodeURIComponent(p[2]!)}` !== GH_REPO) return json({ message: 'Not Found' }, 404);
      const rest = p[3]!;
      const gh = this.gh;
      const sha = () => `${gh.refs.size + gh.commits.size + gh.trees.size + 1}`.padStart(40, 'b');
      if (rest === 'pulls' && method === 'GET') {
        const head = u.searchParams.get('head') ?? '';
        return json(gh.prs.filter((x) => `${GH_REPO.split('/')[0]}:${x.head}` === head).reverse());
      }
      const ref = /^git\/ref\/heads\/(.+)$/.exec(rest);
      if (ref && method === 'GET') {
        const at = gh.refs.get(decodeURIComponent(ref[1]!));
        return at ? json({ ref: `refs/heads/${ref[1]}`, object: { sha: at, type: 'commit' } }) : json({ message: 'Not Found' }, 404);
      }
      if (rest === 'git/refs' && method === 'POST') {
        const name = String(body.ref).replace(/^refs\/heads\//, '');
        if (gh.refs.has(name)) return json({ message: 'Reference already exists' }, 422);
        gh.refs.set(name, body.sha);
        return json({ ref: body.ref, object: { sha: body.sha } }, 201);
      }
      const commit = /^git\/commits\/([0-9a-f]{40})$/.exec(rest);
      if (commit && method === 'GET') {
        const c = gh.commits.get(commit[1]!);
        return json({ sha: commit[1], message: c?.message ?? 'Earlier work', tree: { sha: c?.tree ?? 'd'.repeat(40) }, html_url: `https://github.com/${GH_REPO}/commit/${commit[1]}` });
      }
      if (rest === 'git/trees' && method === 'POST') {
        // Trees are content-addressed, as in git: the same files give the same tree.
        const files = { ...(gh.treeFiles.get(body.base_tree) ?? {}) };
        for (const e of body.tree as { path: string; content?: string; sha?: null }[]) {
          if (e.sha === null) delete files[e.path];
          else files[e.path] = e.content!;
        }
        const t = createHash('sha1').update(JSON.stringify(Object.entries(files).sort())).digest('hex');
        if (!gh.treeFiles.has(t)) {
          gh.treeFiles.set(t, files);
          gh.trees.set(t, body.tree);
        }
        return json({ sha: t }, 201);
      }
      if (rest === 'git/commits' && method === 'POST') {
        const c = sha();
        gh.commits.set(c, { tree: body.tree, message: body.message, parents: body.parents });
        return json({ sha: c, html_url: `https://github.com/${GH_REPO}/commit/${c}` }, 201);
      }
      const move = /^git\/refs\/heads\/(.+)$/.exec(rest);
      if (move && method === 'PATCH') {
        const name = decodeURIComponent(move[1]!);
        if (!gh.refs.has(name)) return json({ message: 'Reference does not exist' }, 422);
        gh.refs.set(name, body.sha);
        return json({ ref: `refs/heads/${name}`, object: { sha: body.sha } });
      }
      if (rest === 'pulls' && method === 'POST') {
        if (!gh.refs.has(body.head)) return json({ message: 'Validation Failed' }, 422);
        if (gh.prs.some((x) => x.head === body.head && x.state === 'open')) return json({ message: 'A pull request already exists' }, 422);
        const number = gh.prs.length + 1;
        const pr = { number, head: body.head, base: body.base, title: body.title, body: body.body, draft: body.draft === true, state: 'open', html_url: `https://github.com/${GH_REPO}/pull/${number}`, labels: [] as string[] };
        gh.prs.push(pr);
        return json(pr, 201);
      }
      const labels = /^issues\/(\d+)\/labels$/.exec(rest);
      if (labels && method === 'POST') {
        gh.prs.find((x) => x.number === Number(labels[1]))?.labels.push(...body.labels);
        return json(body.labels.map((name: string) => ({ name })));
      }
      const comment = /^issues\/(\d+)\/comments$/.exec(rest);
      if (comment && method === 'POST') {
        gh.comments.push({ number: Number(comment[1]), body: body.body });
        return json({ id: 7000 + gh.comments.length, html_url: `https://github.com/${GH_REPO}/pull/${comment[1]}#issuecomment-${7000 + gh.comments.length}` }, 201);
      }
    }
    if (u.host === 'slack.com' && u.pathname === '/api/chat.postMessage') {
      this.slack.push({ channel: body.channel, text: body.text });
      return json({ ok: true, ts: `1700000000.00${this.slack.length}` });
    }
    return json({ error: 'unexpected' }, 404);
  };

  writes() {
    return this.calls.filter((c) => c.method !== 'GET' && !c.url.includes('datadoghq') && !c.url.includes('slack.com'));
  }
}

// ---------------------------------------------------------------- the repository with the bugs

async function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

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
const CART_BUG = 'exports.total = (cart) => cart.items.reduce((n, i) => n + i.price * i.qty, 0);\n';
const CART_FIXED = 'exports.total = (cart) => (cart.items ?? []).reduce((n, i) => n + i.price * i.qty, 0);\n';
const CART_REGRESSION = "const assert = require('node:assert');\nconst { total } = require('../src/cart.js');\nassert.strictEqual(total({}), 0);\n";
const DISCOUNT_BUG = "const CODES = { SAVE10: 0.1 };\nexports.apply = (price, code) => {\n  const pct = CODES[code];\n  if (pct === undefined) throw new RangeError('Unknown discount code ' + code);\n  return price - price * pct;\n};\n";
const DISCOUNT_FIXED = DISCOUNT_BUG.replace('CODES[code]', 'CODES[String(code).toUpperCase()]');
const DISCOUNT_REGRESSION = "const assert = require('node:assert');\nconst { apply } = require('../src/discount.js');\nassert.strictEqual(apply(100, 'save10'), 90);\n";
const PACKAGE_JSON = '{ "name": "shop", "private": true }\n';
// A bug the suite misses, shown by a reproduce command (repro.js) rather than a regression test.
const PRICE_BUG = "exports.format = (p) => p.amount.toFixed(2) + ' ' + p.currency;\n";
const PRICE_FIXED = "exports.format = (p) => Number(p.amount).toFixed(2) + ' ' + p.currency;\n";
const REPRO = "const { format } = require('./src/price.js');\nif (format({ amount: '2.5', currency: 'EUR' }) !== '2.50 EUR') process.exit(1);\n";
const SHIPPING = 'exports.cost = (weight) => (weight > 10 ? 15 : 5);\n';

async function makeRepo(dir: string) {
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'test'));
  await writeFile(path.join(dir, 'src', 'cart.js'), CART_BUG);
  await writeFile(path.join(dir, 'src', 'discount.js'), DISCOUNT_BUG);
  await writeFile(path.join(dir, 'src', 'shipping.js'), SHIPPING);
  await writeFile(path.join(dir, 'src', 'price.js'), PRICE_BUG);
  await writeFile(path.join(dir, 'repro.js'), REPRO);
  await writeFile(path.join(dir, 'build.js'), "for (const m of ['cart', 'discount', 'shipping', 'price']) require('./src/' + m + '.js');\n");
  await writeFile(path.join(dir, 'run-tests.js'), RUN_TESTS);
  await writeFile(path.join(dir, 'package.json'), PACKAGE_JSON);
  // The suite passes with the bugs: it never tries a cart without items or a lower-case code.
  await writeFile(path.join(dir, 'test', 'cart.test.js'), "const assert = require('node:assert');\nassert.strictEqual(require('../src/cart.js').total({ items: [{ price: 2, qty: 3 }] }), 6);\n");
  await writeFile(path.join(dir, 'test', 'discount.test.js'), "const assert = require('node:assert');\nassert.strictEqual(require('../src/discount.js').apply(100, 'SAVE10'), 90);\n");
  await writeFile(path.join(dir, 'test', 'shipping.test.js'), "const assert = require('node:assert');\nassert.strictEqual(require('../src/shipping.js').cost(1), 5);\n");
  await writeFile(path.join(dir, 'test', 'price.test.js'), "const assert = require('node:assert');\nassert.strictEqual(require('../src/price.js').format({ amount: 2, currency: 'EUR' }), '2.00 EUR');\n");
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'shop');
}

// ---------------------------------------------------------------- the scripted AI

const act = (a: Record<string, string>) => ({ action: 'list', path: '', content: '', query: '', command: '', summary: '', regressionTest: '', ...a });
const triage = (verdict: 'bug' | 'noise', confidence: number, evidence: string[], reason: string) => ai.enqueue({ text: JSON.stringify({ verdict, confidence, evidence, reason }) });
function scriptFix(writes: [string, string][], summary: string, regressionTest: string, read = writes[0]![0]) {
  ai.enqueue(act({ action: 'read', path: read }));
  for (const [p, content] of writes) ai.enqueue(act({ action: 'write', path: p, content }));
  // Without a regression test the AI runs the fix step's reproduce command.
  ai.enqueue(act({ action: 'run', command: regressionTest || 'reproduce' }));
  ai.enqueue(act({ action: 'run', command: 'test' }));
  ai.enqueue(act({ action: 'done', summary, regressionTest }));
}

// ---------------------------------------------------------------- the world

const fake = new FakeServices();
let w: World;
/** The commit the fix step cloned and verified against. */
const VERIFIED = 'c0ffee0'.padEnd(40, '0');
/** Runs right after a clone: lets a test move the branch on, as other pushes would. */
let afterClone: (() => void) | undefined;
let api: ReturnType<typeof buildServer>;
let base: string;
let team = '';
const cloned: { url: string; ref: string; token: string | null }[] = [];

type Template = { name: string; definition: { steps: Record<string, unknown>[]; [k: string]: unknown } };
interface Variant { dailyCap?: number; file?: string; name?: string; fix?: Record<string, unknown> }
/** The template with its placeholders filled in for the test repository: fixed values only, no logic changed. */
async function flowDefinition({ dailyCap = 5, file = 'error-to-fix.json', fix = {} }: Variant = {}) {
  const t = JSON.parse(await readFile(path.join(examples, 'flows', file), 'utf8')) as Template;
  const steps = t.definition.steps.map((s) => {
    if (s.id === 'fix') return { ...s, image: 'node:26', install: 'true', build: 'node build.js', test: 'node run-tests.js', ...fix };
    if (s.id === 'decide') return { ...s, input: { ...(s.input as object), dailyCap } };
    if (s.id === 'notify' || s.id === 'notify_failed') return { ...s, input: { ...(s.input as object), channel: 'C-fixes' } };
    return s;
  });
  return { name: t.name, definition: { ...t.definition, steps } };
}

/** The steps an approver accepts by design: the triage steering the fix step, and AI-derived text reaching the table and the team's channel. */
const ACCEPT = [
  { sink: 'fix', reason: 'The triage only decides whether the fix step runs and gives it context; the fix step verifies its own change in the sandbox.' },
  { sink: 'record_stop', reason: "Writes the triage's verdict to our own error_fixes table." },
  { sink: 'record_failed', reason: 'Records a failed attempt in our own error_fixes table.' },
  { sink: 'record_waiting', reason: 'Notes in our own error_fixes table that a push waits for a sign-off.' },
  { sink: 'record_mr', reason: 'Records the merge request in our own error_fixes table.' },
  { sink: 'notify', reason: 'Posts the merge request link to our own fixes channel.' },
  { sink: 'notify_failed', reason: 'Posts that a fix did not verify to our own fixes channel.' },
];
const PUSH_STEPS = ['push_branch', 'push_commit', 'push_mr'];

async function createAndApprove(variant: Variant = {}) {
  const f = await flowDefinition(variant);
  const name = variant.name ?? (variant.dailyCap && variant.dailyCap !== 5 ? `${f.name} (cap ${variant.dailyCap})` : f.name);
  const created = await api.inject({ method: 'POST', url: '/api/flows', headers: auth(w.tokens.alice), payload: { name, definition: f.definition, teamId: team } });
  expect(created.statusCode, created.body).toBe(201);
  const versionId = created.json().id as string;
  const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: auth(w.tokens.approver) })).json();
  const decided = await api.inject({ method: 'POST', url: `/api/flow-versions/${versionId}/decision`, headers: auth(w.tokens.approver), payload: { decision: 'approved', accept: ACCEPT } });
  expect(decided.statusCode, decided.body).toBe(200);
  return { versionId, review };
}

/** A token trigger configured for a Datadog monitor webhook. */
async function datadogTrigger(flowVersionId: string) {
  const res = await api.inject({
    method: 'POST',
    url: '/api/triggers',
    headers: auth(w.tokens.alice),
    payload: {
      flowVersionId,
      provider: 'token',
      deliveryIdPointer: '/id',
      timestampPointer: '/date',
      maxAgeSeconds: 600,
      payloadSchema: { type: 'object', required: ['id', 'date', 'service', 'message'], properties: { transition: { not: { const: 'Recovered' } } } },
      inputMap: { service: '/service', message: '/message', stack: '/stack', traceId: '/traceId', time: '/date', repo: '/repo', commit: '/commit', logSource: '/logSource' },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; secret: string };
}

let alertNo = 7000;
/** POST a Datadog-style alert to the trigger, run everything it starts, and return the run. */
async function alert(trigger: { id: string; secret: string }, service: string, message: string, stack = '', repo = PROJECT) {
  const payload = { id: String(++alertNo), date: String(Date.now()), transition: 'Triggered', service, message, stack, traceId: '', commit: '', repo, logSource: 'datadog' };
  const res = await api.inject({ method: 'POST', url: `/hooks/${trigger.id}`, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', 'x-dittoly-token': trigger.secret } });
  expect(res.statusCode, res.body).toBe(202);
  await w.app.worker.drain();
  return view(res.json().runId as string);
}
async function view(runId: string) {
  const r = await runStatus(w, runId, w.alice);
  return { ...r, by: Object.fromEntries(r.steps.map((s) => [s.id, s])) as Record<string, (typeof r.steps)[number]> };
}
const statuses = (r: Awaited<ReturnType<typeof view>>, ids: string[]) => Object.fromEntries(ids.map((id) => [id, r.by[id]!.status]));
async function row(key: string) {
  const tb = (await w.app.tables.byName(w.db, team, 'error_fixes'))!;
  return w.app.tables.getRow(w.db, tb, key);
}
/** Move the row's last attempt back in time (as if the alert came back later). */
async function attemptedHoursAgo(key: string, hours: number) {
  const tb = (await w.app.tables.byName(w.db, team, 'error_fixes'))!;
  await w.app.tables.putRow(w.db, tb, key, { last_attempt: new Date(Date.now() - hours * 3_600_000).toISOString() }, { memberId: w.alice.id });
}
/** The fingerprint the Flow computes: the same as fingerprint() over normalize's text. */
async function fp(runId: string) {
  return fingerprint(((await view(runId)).by.normalize!.output as { text: string }).text);
}
async function audits(runId: string) {
  return (await w.db.query<{ action: string; subject_id: string; error_type: string | null }>(`SELECT action, subject_id, error_type FROM audit_events WHERE subject_id LIKE $1 ORDER BY id`, [`${runId}:%`])).rows;
}

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

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'dty-e2f-'));
  const repo = path.join(base, 'repo');
  await makeRepo(repo);
  const apps = new AppRunner({
    mode: 'local',
    internalHosts: ['gitlab.com'],
    directAllowed: async () => true,
    dockerAvailable: async () => false,
    clone: async (url, ref, token, dir) => {
      cloned.push({ url: url.href, ref, token });
      execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', ref, `file://${repo}`, path.join(dir, 'src')], { stdio: 'ignore' });
      afterClone?.();
      return VERIFIED;
    },
  });
  w = await makeWorld({}, { apps, ai, fetchImpl: fake.fetch });
  api = buildServer(w.app);
  team = (await createTeam(w.db, w.admin, 'Payments')).id;
  await setTeamMember(w.db, w.admin, team, w.alice.id, 'member');
  for (const tb of TABLES) await w.app.tables.create(w.admin, { teamId: team, name: tb.name, keyColumn: tb.keyColumn, columns: tb.columns.map(([name, type]) => ({ name, type })) });
  // The example modules the template uses (Loki too: the logSource input picks one), validated in
  // the sandbox, submitted by a member and approved by the admin.
  for (const name of ['error-fix-policy', 'gitlab-fix', 'github-fix', 'datadog-logs', 'loki', 'slack']) {
    const dir = path.join(examples, 'modules', name);
    const mv = await w.app.modules.createDraft(
      {
        manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
        code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
        tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
        origin: 'seed',
      },
      w.alice,
    );
    if (!mv.validationReport?.passed) throw new Error(`${name} failed validation: ${JSON.stringify(mv.validationReport)}`);
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
  }
  // The runs run as alice (the trigger's owner): her own tokens, and the test database for the app's tests.
  await w.app.vault.put(w.alice.id, 'gitlab', 'glpat-alice-e2f');
  await w.app.vault.put(w.alice.id, 'github', 'github_pat_alice_e2f');
  await w.app.vault.put(w.alice.id, 'datadog', 'ddpat-alice-e2f');
  await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice-e2f');
  await w.app.vault.put(w.alice.id, 'app_test_database_url', DB_SECRET);
}, 180_000);
afterAll(async () => {
  await api.close();
  await w.db.end();
  await rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the scenarios

describe('error to verified fix MR, end to end', () => {
  let trigger: { id: string; secret: string };
  let cartFp = '';
  const CART_ERROR = "TypeError: Cannot read properties of undefined (reading 'reduce') for order 5512 (user jane@example.com, req 3fa85f64-5717-4562-b3fc-2c963f66afa6)";
  const CART_STACK = "TypeError: Cannot read properties of undefined (reading 'reduce')\n    at exports.total (/app/src/cart.js:1:43)\n    at checkout (/app/src/api.js:12:9)\n    at /app/node_modules/express/lib/router/layer.js:95:5";

  it('review: the injection paths and guarded steps; the approver accepts the paths that are by design, and the push steps keep their evidence gate', async () => {
    const { versionId, review } = await createAndApprove();
    const paths = (review.injection.paths as { source: string; sink: string }[]).map((p) => `${p.source} -> ${p.sink}`);
    console.log(`Injection paths:\n  ${paths.join('\n  ')}\nEvidence gates: ${JSON.stringify(review.evidenceGates)}`);
    expect([...review.injection.sinks].sort()).toEqual(['fix', 'notify', 'notify_failed', 'push_branch', 'push_commit', 'push_mr', 'record_failed', 'record_mr', 'record_stop', 'record_waiting']);
    // Only the triage reaches the fix step and record_stop; everything after the fix step is the fix step's own (its verified change).
    expect(paths.filter((p) => p.startsWith('triage'))).toEqual(['triage -> record_stop', 'triage -> fix']);
    expect(paths.filter((p) => p.startsWith('fix')).sort()).toEqual(['notify', 'notify_failed', ...PUSH_STEPS, 'record_failed', 'record_mr', 'record_waiting'].map((s) => `fix -> ${s}`));
    // Everything else carried here is what the apps and the webhook sent: shown to the approver, gating nothing,
    // because it lands in destinations this version fixed (src/flows/injection.ts).
    const outside = (review.injection.paths as { source: string; sink: string; sourceKind: string; influence: string }[]).filter(
      (p) => !['triage', 'fix'].includes(p.source),
    );
    expect(outside.every((p) => ['app-data', 'webhook'].includes(p.sourceKind))).toBe(true);
    // Only one of them takes any authority: the branch the fix step clones and runs, which an app named. Every
    // other one is carried into a destination this version fixed, and gates nothing of its own.
    expect([...new Set(outside.filter((p) => ['destination', 'executable'].includes(p.influence)).map((p) => p.sink))]).toEqual(['fix']);
    // None of them makes a step wait that was not already waiting for what the triage or the fix step wrote.
    expect(review.injection.sinks).not.toContain('claim');
    // The evidence gate still sees the fix step as the only source that could close it.
    expect(review.evidenceGates).toEqual(PUSH_STEPS.map((step) => ({ step, rule: 'steps.fix.output.autoPushAllowed', fixStep: 'fix', autoPushAt: 90, otherSources: [] })));
    expect(review.summary).toContain('EVIDENCE GATE');
    expect(review.summary).toContain('Secret env vars: DATABASE_URL from the "app_test_database_url" credential');
    expect(review.injection.guarded.sort()).toEqual([...review.injection.sinks].sort());
    // Approved by another person, with the accepted paths: only the push steps wait for a sign-off, unless the evidence holds.
    const approved = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: auth(w.tokens.alice) })).json();
    expect(approved.status).toBe('approved');
    expect(approved.injection.guarded).toEqual(PUSH_STEPS);
    expect(approved.injection.accepted.map((a: { sink: string; by: string }) => [a.sink, a.by])).toEqual(ACCEPT.map((a) => [a.sink, 'approver']));
    trigger = await datadogTrigger(versionId);
  }, 120_000);

  it('a new real bug: logs read, triaged, reproduced, fixed, verified and pushed as a draft MR with no sign-off at run time', async () => {
    triage('bug', 90, ['cart.items is undefined: total() reads .reduce of it', 'POST /checkout 500 (cart had no items field)'], 'total() does not handle a cart without items.');
    scriptFix([['src/cart.js', CART_FIXED], ['test/cart-empty.test.js', CART_REGRESSION]], 'total() read cart.items without checking it; a cart without items now totals 0.', 'test/cart-empty.test.js');
    const r = await alert(trigger, 'checkout', CART_ERROR, CART_STACK);
    expect(r.status, JSON.stringify(r.steps.map((s) => [s.id, s.status, s.errorType]))).toBe('succeeded');
    cartFp = await fp(r.id);
    expect(cartFp).toMatch(/^[0-9a-f]{16}$/);

    // The logs: Datadog was asked for the service's errors around the alert, with alice's token; the digest went to the triage.
    expect(fake.datadogQueries).toHaveLength(1);
    expect(fake.datadogQueries[0]!.filter.query).toBe('status:error service:checkout');
    expect(fake.calls.find((c) => c.url.includes('datadoghq'))!.auth).toBe('Bearer ddpat-alice-e2f');
    expect((r.by.logs_datadog!.output as { count: number }).count).toBe(2);
    const triagePrompt = ai.requests.find((q) => q.prompt.includes('cart had no items field'))!.prompt;
    expect(triagePrompt).toContain('DATA');
    expect(r.by.verdict!.output).toMatchObject({ proceed: true, isBug: true, confidence: 90, reason: 'bug' });

    // The fix step: cloned the deployed branch with alice's GitLab token, and Dittoly's own checks hold.
    expect(cloned.at(-1)).toEqual({ url: `https://gitlab.com/${PROJECT}.git`, ref: 'main', token: 'glpat-alice-e2f' });
    const fix = r.by.fix!.output as Record<string, any>;
    expect(fix.verified).toEqual({ buildOk: true, reproducedBefore: null, regressionTestFailsBefore: true, regressionTestPassesAfter: true, reproducedAfter: null, testsPassAfter: true });
    expect(fix.logTail).toContain('regression test (original code)');
    expect(fix.limits).toEqual({ ok: true, violations: [] });
    expect(fix.confidence).toMatchObject({ score: 95, level: 'high' });
    expect(fix.autoPushAllowed).toBe(true);
    expect(fix.regressionTest).toBe('test/cart-empty.test.js');
    expect(fix.change.files).toEqual([
      { path: 'src/cart.js', action: 'update', content: CART_FIXED },
      { path: 'test/cart-empty.test.js', action: 'create', content: CART_REGRESSION },
    ]);
    // The test database credential reached the tests, never the AI, the output or the logs.
    expect(fix.logTail).toContain('test database: [secret removed]');
    expect(JSON.stringify(r)).not.toContain('t3st-Pa55word');
    for (const q of ai.requests) expect(q.prompt).not.toContain('t3st-Pa55word');

    // The push: released by the evidence, no person; audited.
    expect(statuses(r, ['gate', ...PUSH_STEPS, 'record_mr', 'notify', 'record_failed', 'notify_failed', 'record_stop', 'record_waiting', 'comment_seen'])).toEqual({
      gate: 'succeeded', push_branch: 'succeeded', push_commit: 'succeeded', push_mr: 'succeeded', record_mr: 'succeeded', notify: 'succeeded',
      record_failed: 'skipped', notify_failed: 'skipped', record_stop: 'skipped', record_waiting: 'skipped', comment_seen: 'skipped',
    });
    for (const s of PUSH_STEPS) expect(r.by[s]!.decision).toMatchObject({ decision: 'approved', by: null, automatic: { fixStep: 'fix', confidence: 95, level: 'high', limitsOk: true } });
    const released = (await audits(r.id)).filter((a) => a.action === 'guard.auto_released');
    expect(released.map((a) => a.subject_id)).toEqual(PUSH_STEPS.map((s) => `${r.id}:${s}`));
    expect(released[0]!.error_type).toBe('evidence_confidence_95');
    const signOffs = await w.db.query(`SELECT count(*)::int AS n FROM gate_decisions WHERE run_id = $1 AND decided_by IS NOT NULL`, [r.id]);
    expect(signOffs.rows[0].n).toBe(0);

    // GitLab: one branch, one commit with exactly the changed files, one draft MR with the confidence report.
    const branch = `dittoly/fix-${cartFp}`;
    expect([...fake.branches.keys()]).toEqual(['main', branch]);
    expect(fake.commits).toHaveLength(1);
    expect(fake.commits[0]).toMatchObject({ branch, actions: [{ action: 'update', file_path: 'src/cart.js', content: CART_FIXED }, { action: 'create', file_path: 'test/cart-empty.test.js', content: CART_REGRESSION }] });
    expect(fake.commits[0]!.message).toContain(`fingerprint ${cartFp}`);
    expect(fake.mrs).toHaveLength(1);
    const mr = fake.mrs[0]!;
    expect(mr).toMatchObject({ source_branch: branch, target_branch: 'main', labels: 'dittoly,auto-fix' });
    expect(mr.title).toBe('Draft: Fix TypeError in checkout at exports.total (src/cart.js)');
    expect(mr.description).toContain('### Confidence: 95/100 (high)');
    expect(mr.description).toContain('| Regression test fails before the fix | yes |');
    expect(mr.description).toContain('Limits: within limits');
    expect(mr.description).toContain('allowed by the confidence rules');
    expect(mr.description).not.toContain('jane@example.com');
    for (const c of fake.writes()) expect(c.auth).toBe('glpat-alice-e2f');

    // The table and the team.
    expect(await row(cartFp)).toMatchObject({ status: 'mr_open', mr_url: mr.web_url, mr_iid: 1, times_seen: 1, attempts: 1, branch, service: 'checkout' });
    expect(fake.slack).toEqual([{ channel: 'C-fixes', text: expect.stringContaining(`Draft fix ready for review: Fix TypeError in checkout`) }]);
    expect(fake.slack[0]!.text).toContain(mr.web_url);
  }, 180_000);

  it('the same error again (other ids and numbers): one "seen again" comment, counted, nothing pushed; a third time the same day only counts', async () => {
    const writesBefore = fake.writes().length;
    const again = await alert(trigger, 'checkout', CART_ERROR.replace('5512', '98').replace('jane@example.com', 'bob@example.org').replace('3fa85f64-5717-4562-b3fc-2c963f66afa6', '00000000-1111-2222-3333-444444444444'), CART_STACK.replace(':1:43', ':1:44').replace(':12:9', ':14:2'));
    expect(again.status).toBe('succeeded');
    expect(await fp(again.id)).toBe(cartFp);
    expect(again.by.decide!.output).toMatchObject({ decision: 'comment_open_mr', attempt: false, timesSeen: 2 });
    expect(statuses(again, ['comment_seen', 'logs_datadog', 'triage', 'fix', ...PUSH_STEPS])).toEqual({ comment_seen: 'succeeded', logs_datadog: 'skipped', triage: 'skipped', fix: 'skipped', push_branch: 'skipped', push_commit: 'skipped', push_mr: 'skipped' });
    expect(fake.notes).toEqual([{ iid: 1, body: expect.stringContaining('happened 2 times') }]);
    expect(fake.writes().length).toBe(writesBefore + 1);
    expect(fake.commits).toHaveLength(1);
    expect(fake.mrs).toHaveLength(1);
    expect(await row(cartFp)).toMatchObject({ status: 'mr_open', times_seen: 2, mr_iid: 1 });

    const third = await alert(trigger, 'checkout', CART_ERROR.replace('5512', '7'), CART_STACK);
    expect(third.by.decide!.output).toMatchObject({ decision: 'mr_open_commented_recently', comment: false, timesSeen: 3 });
    expect(third.by.comment_seen!.status).toBe('skipped');
    expect(fake.notes).toHaveLength(1);
    expect(fake.writes().length).toBe(writesBefore + 1);
    expect(await row(cartFp)).toMatchObject({ status: 'mr_open', times_seen: 3 });
    expect(fake.datadogQueries).toHaveLength(1);
  }, 120_000);

  it('a fix that touches package.json: verified but outside its limits, so the push waits for a person; nothing is pushed until one signs off', async () => {
    triage('bug', 85, ['Unknown discount code save10: the code is valid in upper case'], 'Discount codes are compared case-sensitively.');
    scriptFix(
      [['src/discount.js', DISCOUNT_FIXED], ['test/discount-case.test.js', DISCOUNT_REGRESSION], ['package.json', '{ "name": "shop", "private": true, "engines": { "node": ">=26" } }\n']],
      'Discount codes are now matched case-insensitively.',
      'test/discount-case.test.js',
    );
    const notesBefore = (await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE member_id = $1 AND kind = 'approval_needed'`, [w.approver.id])).rows[0].n;
    const r = await alert(trigger, 'checkout', 'RangeError: Unknown discount code save10 for order 4410', 'RangeError: Unknown discount code save10\n    at exports.apply (/app/src/discount.js:4:35)');
    const fix = r.by.fix!.output as Record<string, any>;
    expect(fix.verified).toMatchObject({ buildOk: true, regressionTestFailsBefore: true, regressionTestPassesAfter: true, testsPassAfter: true });
    expect(fix.limits).toEqual({ ok: false, violations: ['package.json: a blocked path (CI/CD, dependencies, build or infrastructure)'] });
    expect(fix.confidence).toMatchObject({ score: 40, level: 'medium' });
    expect(fix.autoPushAllowed).toBe(false);
    expect(r.by.gate!.output).toMatchObject({ push: true, recordFailed: false, needsSignOff: true });

    // The run waits at the first push step; the approver is told; nothing reached GitLab.
    expect(r).toMatchObject({ status: 'waiting', waitReason: 'approval' });
    expect(r.by.push_branch).toMatchObject({ status: 'waiting', errorType: 'awaiting_sign_off' });
    expect((await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE member_id = $1 AND kind = 'approval_needed' AND run_id = $2 AND step_id = 'push_branch'`, [w.approver.id, r.id])).rows[0].n).toBe(1);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE member_id = $1 AND kind = 'approval_needed'`, [w.approver.id])).rows[0].n).toBe(notesBefore + 1);
    expect((await audits(r.id)).filter((a) => a.action === 'guard.auto_released')).toEqual([]);
    const discountFp = await fp(r.id);
    expect(fake.branches.has(`dittoly/fix-${discountFp}`)).toBe(false);
    expect(fake.commits).toHaveLength(1);
    // The row says the push waits for a person (failed until it is pushed, so a recurrence only counts).
    expect(r.by.record_waiting!.status).toBe('succeeded');
    expect(await row(discountFp)).toMatchObject({ status: 'failed', note: expect.stringContaining("waits for a person's sign-off to push (outside its limits)") });

    // A person signs off each push step: then it pushes, and the MR says a person signed off.
    for (const step of PUSH_STEPS) {
      expect((await view(r.id)).by[step]).toMatchObject({ status: 'waiting', errorType: 'awaiting_sign_off' });
      await w.app.engine.decideGate(r.id, step, w.approver, 'approved');
      await w.app.worker.drain();
    }
    const done = await view(r.id);
    expect(done.status).toBe('succeeded');
    expect(done.by.push_mr!.decision).toMatchObject({ decision: 'approved', by: 'approver' });
    expect(fake.commits).toHaveLength(2);
    expect(fake.commits[1]!.actions.map((a) => a.file_path)).toEqual(['package.json', 'src/discount.js', 'test/discount-case.test.js']);
    expect(fake.mrs[1]!.description).toContain('NOT within limits (package.json: a blocked path');
    expect(fake.mrs[1]!.description).toContain("Pushed without a person's sign-off: no, a person signed off");
    expect(await row(discountFp)).toMatchObject({ status: 'mr_open', mr_iid: 2 });
  }, 180_000);

  it('a fix that breaks the test suite is recorded as failed, the team is told, and nothing is pushed or asked', async () => {
    triage('bug', 80, ['shipping cost NaN for a weight given as text'], 'cost() does not parse its input.');
    scriptFix([['src/shipping.js', 'exports.cost = (weight) => (Number(weight) > 10 ? 15 : 6);\n'], ['test/shipping-text.test.js', "const assert = require('node:assert');\nassert.strictEqual(require('../src/shipping.js').cost('3'), 6);\n"]], 'cost() now parses its input.', 'test/shipping-text.test.js');
    const writesBefore = fake.writes().length;
    const r = await alert(trigger, 'shipping', 'Error: shipping cost NaN for parcel 77', 'Error: shipping cost NaN\n    at exports.cost (/app/src/shipping.js:1:30)');
    expect(r.status).toBe('succeeded');
    const fix = r.by.fix!.output as Record<string, any>;
    expect(fix.verified.testsPassAfter).toBe(false);
    expect(fix.autoPushAllowed).toBe(false);
    expect(r.by.gate!.output).toMatchObject({ push: false, recordFailed: true });
    expect(statuses(r, [...PUSH_STEPS, 'record_failed', 'notify_failed', 'notify'])).toEqual({ push_branch: 'skipped', push_commit: 'skipped', push_mr: 'skipped', record_failed: 'succeeded', notify_failed: 'succeeded', notify: 'skipped' });
    expect(fake.writes().length).toBe(writesBefore);
    expect(await row(await fp(r.id))).toMatchObject({ status: 'failed', note: expect.stringContaining('the test suite does not pass after the fix') });
    expect(fake.slack.at(-1)!.text).toContain('the fix did not verify');
  }, 180_000);

  it('noise: the triage says it is not a bug, so nothing is fixed or pushed, and the row says not_a_bug', async () => {
    triage('noise', 95, ['connect ETIMEDOUT 10.0.0.12:5432: the database was briefly unreachable'], 'A transient network failure, not a bug in the code.');
    const writesBefore = fake.writes().length;
    const clonesBefore = cloned.length;
    const r = await alert(trigger, 'checkout', 'Error: connect ETIMEDOUT 10.0.0.12:5432');
    expect(r.status).toBe('succeeded');
    expect(r.by.verdict!.output).toMatchObject({ proceed: false, stop: true, status: 'not_a_bug', reason: 'noise' });
    expect(statuses(r, ['record_stop', 'fix', 'gate', ...PUSH_STEPS])).toEqual({ record_stop: 'succeeded', fix: 'skipped', gate: 'skipped', push_branch: 'skipped', push_commit: 'skipped', push_mr: 'skipped' });
    expect(cloned.length).toBe(clonesBefore);
    expect(fake.writes().length).toBe(writesBefore);
    expect(await row(await fp(r.id))).toMatchObject({ status: 'not_a_bug', note: expect.stringContaining('noise') });
  }, 120_000);

  it('the daily cap: with the cap lowered to the merge requests already opened today, a new error is recorded but not attempted', async () => {
    const { versionId } = await createAndApprove({ dailyCap: 2 });
    const capped = await datadogTrigger(versionId);
    const writesBefore = fake.writes().length;
    const queued = ai.requests.length;
    const r = await alert(capped, 'checkout', 'ReferenceError: taxRate is not defined', 'ReferenceError: taxRate is not defined\n    at exports.total (/app/src/tax.js:3:10)');
    expect(r.status).toBe('succeeded');
    expect(r.by.decide!.output).toMatchObject({ decision: 'daily_cap_reached', attempt: false, mrsLast24h: 2 });
    expect(statuses(r, ['record_seen', 'logs_datadog', 'triage', 'fix', ...PUSH_STEPS])).toEqual({ record_seen: 'succeeded', logs_datadog: 'skipped', triage: 'skipped', fix: 'skipped', push_branch: 'skipped', push_commit: 'skipped', push_mr: 'skipped' });
    expect(ai.requests.length).toBe(queued);
    expect(fake.writes().length).toBe(writesBefore);
    expect(fake.mrs).toHaveLength(2);
    expect(await row(await fp(r.id))).toMatchObject({ status: 'new', times_seen: 1, mr_url: null });
  }, 120_000);

  it('a bug shown by the reproduce command instead of a regression test: reproduced before, gone after, scored high and pushed', async () => {
    // The template with the fix step's reproduce command set (a placeholder value, like its test command).
    const { versionId } = await createAndApprove({ name: 'Error to verified fix MR (reproduce)', fix: { reproduce: 'node repro.js' } });
    const t = await datadogTrigger(versionId);
    triage('bug', 85, ['p.amount.toFixed is not a function: the amount came as text'], 'format() assumes the amount is a number.');
    scriptFix([['src/price.js', PRICE_FIXED]], 'format() now takes an amount given as text.', '');
    const mrsBefore = fake.mrs.length;
    const r = await alert(t, 'pricing', 'TypeError: p.amount.toFixed is not a function', 'TypeError: p.amount.toFixed is not a function\n    at exports.format (/app/src/price.js:1:35)');
    expect(r.status, JSON.stringify(r.steps.map((s) => [s.id, s.status, s.errorType]))).toBe('succeeded');
    const fix = r.by.fix!.output as Record<string, any>;
    expect(fix.verified).toEqual({ buildOk: true, reproducedBefore: true, regressionTestFailsBefore: null, regressionTestPassesAfter: null, reproducedAfter: false, testsPassAfter: true });
    expect(fix.regressionTest).toBeNull();
    expect(fix.logTail).toContain('reproduce (before): node repro.js');
    expect(fix.logTail).toContain('reproduce (with the change): node repro.js');
    expect(fix.confidence).toMatchObject({ score: 95, level: 'high' });
    expect(fix.confidence.reasons).toEqual(expect.arrayContaining(['✓ the reproduce command failed before the change (the bug was there)', '✓ the reproduce command passes with the change', '? no regression test was run on the original code']));
    expect(fix.autoPushAllowed).toBe(true);
    // The AI was told the reproduce command fails now.
    expect(ai.requests.some((q) => q.prompt.includes('The reproduce command FAILS now (the bug shows).'))).toBe(true);
    // The gate takes the reproduce command's evidence: pushed with no sign-off.
    expect(r.by.gate!.output).toMatchObject({ push: true, needsSignOff: false });
    expect(statuses(r, [...PUSH_STEPS, 'record_mr', 'record_waiting', 'record_failed'])).toEqual({ push_branch: 'succeeded', push_commit: 'succeeded', push_mr: 'succeeded', record_mr: 'succeeded', record_waiting: 'skipped', record_failed: 'skipped' });
    expect(fake.mrs).toHaveLength(mrsBefore + 1);
    const mr = fake.mrs.at(-1)!;
    expect(fake.commits.at(-1)!.actions).toEqual([{ action: 'update', file_path: 'src/price.js', content: PRICE_FIXED }]);
    expect(mr.description).toContain('| Error reproduced before the fix | yes |');
    expect(mr.description).toContain('| Error reproduced after the fix | no |');
    expect(mr.description).toContain('Regression test: `none`');
    expect(mr.description).toContain('### Confidence: 95/100 (high)');
    expect(await row(await fp(r.id))).toMatchObject({ status: 'mr_open', mr_url: mr.web_url, attempts: 1 });
  }, 180_000);

  it('a push waiting for a person is rejected: nothing is pushed, the run fails, the row stays failed; a recurrence only counts until the retry wait is over', async () => {
    triage('bug', 85, ['Unknown discount code welcome: the code exists in upper case'], 'Discount codes are compared case-sensitively.');
    scriptFix(
      [['src/discount.js', DISCOUNT_FIXED], ['test/discount-case.test.js', DISCOUNT_REGRESSION], ['package.json', '{ "name": "shop", "private": true, "engines": { "node": ">=26" } }\n']],
      'Discount codes are now matched case-insensitively.',
      'test/discount-case.test.js',
    );
    const MSG = 'RangeError: Unknown discount code welcome for basket 31';
    const STACK = 'RangeError: Unknown discount code welcome\n    at exports.apply (/app/src/discount.js:4:35)';
    const writesBefore = fake.writes().length;
    const r = await alert(trigger, 'promotions', MSG, STACK);
    expect(r).toMatchObject({ status: 'waiting', waitReason: 'approval' });
    expect(r.by.gate!.output).toMatchObject({ push: true, needsSignOff: true });
    const key = await fp(r.id);
    const branch = `dittoly/fix-${key}`;
    expect(await row(key)).toMatchObject({ status: 'failed', note: expect.stringContaining("waits for a person's sign-off to push") });

    // The approver rejects the push: the run ends failed there, and nothing reaches GitLab or Slack.
    const slackBefore = fake.slack.length;
    await w.app.engine.decideGate(r.id, 'push_branch', w.approver, 'rejected');
    await w.app.worker.drain();
    const done = await view(r.id);
    expect(done.status).toBe('failed');
    expect(done.by.push_branch).toMatchObject({ status: 'failed', errorType: 'sign_off_rejected', decision: { decision: 'rejected', by: 'approver' } });
    expect(statuses(done, ['push_commit', 'push_mr', 'record_mr', 'notify', 'notify_failed'])).toEqual({ push_commit: 'not_run', push_mr: 'not_run', record_mr: 'not_run', notify: 'not_run', notify_failed: 'not_run' });
    expect(fake.writes().length).toBe(writesBefore);
    expect(fake.branches.has(branch)).toBe(false);
    expect(fake.slack.length).toBe(slackBefore);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'gate.rejected' AND subject_id = $1`, [`${r.id}:push_branch`])).rowCount).toBe(1);
    expect(await row(key)).toMatchObject({ status: 'failed', attempts: 1, times_seen: 1, mr_url: null, note: expect.stringContaining('if the sign-off is rejected, this stays failed') });

    // It comes back the same day: counted only (the last attempt failed less than 24 hours ago).
    const again = await alert(trigger, 'promotions', MSG.replace('31', '32'), STACK);
    expect(again.status).toBe('succeeded');
    expect(again.by.decide!.output).toMatchObject({ decision: 'failed_recently', attempt: false, timesSeen: 2 });
    expect(statuses(again, ['logs_datadog', 'triage', 'fix', ...PUSH_STEPS])).toEqual({ logs_datadog: 'skipped', triage: 'skipped', fix: 'skipped', push_branch: 'skipped', push_commit: 'skipped', push_mr: 'skipped' });
    expect(await row(key)).toMatchObject({ status: 'failed', times_seen: 2, attempts: 1 });

    // After the retry wait: a new attempt, on a new branch (here the triage is unsure, so it stops there).
    await attemptedHoursAgo(key, 25);
    triage('bug', 30, ['maybe the code list changed'], 'Not sure.');
    const later = await alert(trigger, 'promotions', MSG.replace('31', '33'), STACK);
    expect(later.status).toBe('succeeded');
    expect(later.by.decide!.output).toMatchObject({ decision: 'attempt', attempt: true, attempts: 2, branch: `${branch}-2`, timesSeen: 3 });
    expect(later.by.verdict!.output).toMatchObject({ proceed: false, reason: 'low_confidence' });
    expect(await row(key)).toMatchObject({ status: 'failed', times_seen: 3, attempts: 2, branch: `${branch}-2` });
    expect(fake.writes().length).toBe(writesBefore);
  }, 180_000);

  it('GitHub: the GitHub template pushes a verified fix as one draft pull request, and a recurrence comments on it once', async () => {
    const { versionId, review } = await createAndApprove({ file: 'error-to-fix-github.json' });
    expect(review.evidenceGates).toEqual(PUSH_STEPS.map((step) => ({ step, rule: 'steps.fix.output.autoPushAllowed', fixStep: 'fix', autoPushAt: 90, otherSources: [] })));
    const gh = await datadogTrigger(versionId);
    triage('bug', 90, ['cart.items is undefined: total() reads .reduce of it'], 'total() does not handle a cart without items.');
    scriptFix([['src/cart.js', CART_FIXED], ['test/cart-empty.test.js', CART_REGRESSION]], 'A cart without items now totals 0.', 'test/cart-empty.test.js');
    // main moves on while the fix is being verified: the branch still starts from the commit that was verified.
    afterClone = () => fake.gh.refs.set('main', 'feed'.padEnd(40, '1'));
    const r = await alert(gh, 'storefront', CART_ERROR, CART_STACK, GH_REPO).finally(() => (afterClone = undefined));
    expect(r.status, JSON.stringify(r.steps.map((s) => [s.id, s.status, s.errorType]))).toBe('succeeded');
    expect(cloned.at(-1)).toEqual({ url: `https://github.com/${GH_REPO}.git`, ref: 'main', token: 'github_pat_alice_e2f' });
    expect((r.by.fix!.output as { baseCommit: string }).baseCommit).toBe(VERIFIED);
    expect((r.by.fix!.output as { autoPushAllowed: boolean }).autoPushAllowed).toBe(true);
    const key = await fp(r.id);
    const branch = `dittoly/fix-${key}`;

    // One branch, one commit (one tree with the files inline), one draft pull request with its labels.
    expect([...fake.gh.refs.keys()]).toEqual(['main', branch]);
    expect([...fake.gh.trees.values()]).toEqual([[
      { path: 'src/cart.js', mode: '100644', type: 'blob', content: CART_FIXED },
      { path: 'test/cart-empty.test.js', mode: '100644', type: 'blob', content: CART_REGRESSION },
    ]]);
    const [commitSha, commit] = [...fake.gh.commits.entries()][0]!;
    expect(fake.gh.refs.get(branch)).toBe(commitSha);
    expect(commit.parents).toEqual([VERIFIED]);
    expect(commit.message).toContain(`fingerprint ${key}`);
    expect(fake.gh.prs).toHaveLength(1);
    const pr = fake.gh.prs[0]!;
    expect(pr).toMatchObject({ number: 1, head: branch, base: 'main', draft: true, state: 'open', labels: ['dittoly', 'auto-fix'], title: 'Fix TypeError in storefront at exports.total (src/cart.js)' });
    expect(pr.body).toContain('### Confidence: 95/100 (high)');
    for (const c of fake.calls.filter((x) => x.url.startsWith('https://api.github.com/'))) expect(c.auth).toBe('Bearer github_pat_alice_e2f');
    expect(await row(key)).toMatchObject({ status: 'mr_open', mr_url: pr.html_url, mr_iid: 1, branch });
    expect(fake.slack.at(-1)!.text).toContain(pr.html_url);

    // The same error again: the open pull request is found on its branch; one "seen again" comment, no second one.
    const again = await alert(gh, 'storefront', CART_ERROR.replace('5512', '77'), CART_STACK, GH_REPO);
    expect(again.status).toBe('succeeded');
    expect(again.by.decide!.output).toMatchObject({ decision: 'comment_open_mr', attempt: false, timesSeen: 2, mrNumber: 1 });
    expect(statuses(again, ['comment_seen', 'triage', 'fix', ...PUSH_STEPS])).toEqual({ comment_seen: 'succeeded', triage: 'skipped', fix: 'skipped', push_branch: 'skipped', push_commit: 'skipped', push_mr: 'skipped' });
    expect(fake.gh.comments).toEqual([{ number: 1, body: expect.stringContaining('happened 2 times') }]);
    const third = await alert(gh, 'storefront', CART_ERROR.replace('5512', '78'), CART_STACK, GH_REPO);
    expect(third.by.decide!.output).toMatchObject({ decision: 'mr_open_commented_recently', comment: false, timesSeen: 3 });
    expect(fake.gh.comments).toHaveLength(1);
    expect(fake.gh.prs).toHaveLength(1);
    expect(await row(key)).toMatchObject({ status: 'mr_open', times_seen: 3, mr_iid: 1 });
  }, 180_000);

  const DISCOUNT_STACK = 'RangeError: Unknown discount code save10\n    at exports.apply (/app/src/discount.js:4:35)';
  const DISCOUNT_FILES: [string, string][] = [['src/discount.js', DISCOUNT_FIXED], ['test/discount-case.test.js', DISCOUNT_REGRESSION]];

  it('GitLab: every publish answer is lost once; the retries find the branch, the commit and the merge request the first calls made, and make no second one', async () => {
    const { versionId } = await createAndApprove({ name: 'Error to verified fix MR (lost answers)', dailyCap: 50 });
    const t = await datadogTrigger(versionId);
    triage('bug', 90, ['the code is compared in the wrong case'], 'apply() looks codes up case-sensitively.');
    scriptFix(DISCOUNT_FILES, 'Discount codes are looked up in upper case.', 'test/discount-case.test.js');
    const api = `gitlab.com/api/v4/projects/${encodeURIComponent(PROJECT)}`;
    fake.lose = [`POST ${api}/repository/branches`, `POST ${api}/repository/commits`, `POST ${api}/merge_requests`];
    const [mrs, commits] = [fake.mrs.length, fake.commits.length];
    const r = await alert(t, 'promos', 'RangeError: Unknown discount code save10 for order 5120', DISCOUNT_STACK);
    expect(r.status, JSON.stringify(r.steps.map((s) => [s.id, s.status, s.errorType]))).toBe('succeeded');
    expect(fake.lose).toEqual([]);
    for (const s of PUSH_STEPS) expect(r.by[s], s).toMatchObject({ status: 'succeeded', attempts: 2, output: expect.objectContaining({ reused: true }) });
    const branch = `dittoly/fix-${await fp(r.id)}`;
    expect(fake.commits.slice(commits).map((c) => c.branch)).toEqual([branch]);
    expect(fake.mrs.slice(mrs).map((m) => m.source_branch)).toEqual([branch]);
    expect(r.by.push_mr!.output).toMatchObject({ iid: fake.mrs.at(-1)!.iid });
    expect(fake.slack.at(-1)!.text).toContain(fake.mrs.at(-1)!.web_url);
  }, 180_000);

  it('GitHub: every publish answer is lost once; the retries find the branch, the commit and the pull request the first calls made, and make no second one', async () => {
    const { versionId } = await createAndApprove({ file: 'error-to-fix-github.json', name: 'Error to verified fix PR (lost answers)', dailyCap: 50 });
    const t = await datadogTrigger(versionId);
    triage('bug', 90, ['the code is compared in the wrong case'], 'apply() looks codes up case-sensitively.');
    scriptFix(DISCOUNT_FILES, 'Discount codes are looked up in upper case.', 'test/discount-case.test.js');
    const api = `api.github.com/repos/${GH_REPO}`;
    fake.lose = [`POST ${api}/git/refs`, `PATCH ${api}/git/refs/heads/`, `POST ${api}/pulls`];
    const [prs, commits] = [fake.gh.prs.length, fake.gh.commits.size];
    const r = await alert(t, 'promos-gh', 'RangeError: Unknown discount code save10 for order 5121', DISCOUNT_STACK, GH_REPO);
    expect(r.status, JSON.stringify(r.steps.map((s) => [s.id, s.status, s.errorType]))).toBe('succeeded');
    expect(fake.lose).toEqual([]);
    for (const s of PUSH_STEPS) expect(r.by[s], s).toMatchObject({ status: 'succeeded', attempts: 2, output: expect.objectContaining({ reused: true }) });
    const branch = `dittoly/fix-${await fp(r.id)}`;
    // One commit: the retry saw its own commit at the branch head and the same tree, so it made none.
    expect(fake.gh.commits.size).toBe(commits + 1);
    const head = fake.gh.commits.get(fake.gh.refs.get(branch)!)!;
    expect(head.parents).toEqual([VERIFIED]);
    expect(fake.gh.prs.slice(prs).map((p) => [p.head, p.labels])).toEqual([[branch, ['dittoly', 'auto-fix']]]);
    expect(r.by.push_mr!.output).toMatchObject({ number: fake.gh.prs.at(-1)!.number, labelsApplied: true });
  }, 180_000);
});

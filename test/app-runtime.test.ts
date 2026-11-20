import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileFlow, condition, expr } from '../src/export/codegen/compile.js';
import { AppEngine, type ModuleDef } from '../src/export/app-runtime/engine.js';
import { inputSteps } from '../src/export/app-runtime/input-steps.js';
import { tableStep } from '../src/export/app-runtime/table-steps.js';
import { formatReport } from '../src/runtime/report.js';
import { fingerprint as exportedFingerprint, look, notEmpty, ref, text, type FlowCode, type StepCode } from '../src/export/app-runtime/flow.js';
import { fingerprint as dittolyFingerprint, resolve } from '../src/flows/template.js';
import { SandboxPool } from '../src/export/app-runtime/pool.js';
import { openStore } from '../src/export/app-runtime/state.js';
import { MemoryStore, Sealer, type RunRecord, type Store } from '../src/export/app-runtime/store.js';
import { parseManifest, type Manifest } from '../src/modules/manifest.js';
import { FakeApps } from './helpers.js';

/** The exported apps' engine: Dittoly's step rules, run as code, with warm sandboxed module workers. */

const root = path.resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'dty-app-runtime-'));
const sandboxDir = path.join(tmp, 'sandbox');
const modules = new Map<string, ModuleDef>();
let pool: SandboxPool;

beforeAll(() => {
  mkdirSync(path.join(sandboxDir, 'modules'), { recursive: true });
  copyFileSync(path.join(root, 'sandbox-runtime', 'runner.mjs'), path.join(sandboxDir, 'runner.mjs'));
  for (const name of ['jira', 'gitlab', 'slack']) {
    const dir = path.join(root, 'test', 'fixtures', 'modules', name);
    const manifest = (parseManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))) as { manifest: Manifest }).manifest;
    const file = `modules/${name}@${manifest.version}.mjs`;
    copyFileSync(path.join(dir, 'module.mjs'), path.join(sandboxDir, file));
    modules.set(`${name}@${manifest.version}`, { ref: `${name}@${manifest.version}`, name, version: manifest.version, manifest, file, codeSha256: '' });
  }
  pool = new SandboxPool({ sandboxDir, runner: path.join(sandboxDir, 'runner.mjs'), perModule: 2 });
});
afterAll(() => {
  pool.close();
  rmSync(tmp, { recursive: true, force: true });
});

const ref_ = (m: string) => [...modules.keys()].find((k) => k.startsWith(`${m}@`))!;
const flow = (key: string, steps: StepCode[], inputs: Record<string, unknown> = { type: 'object', properties: {} }): FlowCode => ({
  key, name: key, description: '', version: 1, access: 'token', exposed: true, inputs, form: null, steps,
});

function engine(flows: FlowCode[], o: { store?: Store; fake?: FakeApps; tables?: { name: string; keyColumn: string; columns: { name: string; type: 'text' | 'number' | 'boolean' | 'date' }[] }[]; onWaiting?: (r: RunRecord, s: string) => void } = {}) {
  const fake = o.fake ?? new FakeApps();
  return {
    fake,
    e: new AppEngine({
      flows: new Map(flows.map((f) => [f.key, f])),
      modules,
      tables: new Map((o.tables ?? []).map((t) => [t.name, t])),
      store: o.store ?? new MemoryStore(),
      sandbox: pool,
      settings: { jira: { site: 'example.atlassian.net' } },
      credentials: { jira: 'app@example.com:jira-token', gitlab: 'glpat-app', slack: 'xoxb-app' },
      insecureHttpHosts: [],
      internalHosts: [],
      retentionDays: 30,
      fetchImpl: fake.fetch,
      retry: { autoRetries: 2, backoffMs: 20 },
      steps: { report: formatReport, input: inputSteps, table: tableStep },
      ...(o.onWaiting ? { onWaiting: o.onWaiting } : {}),
    }),
  };
}

async function until(e: AppEngine, store: Store | undefined, id: string, pred: (r: RunRecord) => boolean, ms = 15_000): Promise<RunRecord> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await e.settle(id, 2000);
    if (r && pred(r)) return r;
    if (Date.now() > end) throw new Error(`run ${id} is ${r?.status} (${r?.waitReason})`);
    await new Promise((res) => setTimeout(res, 30));
  }
}

describe('generated code', () => {
  const evalExpr = (code: string) => new Function('ref', 'text', 'look', 'notEmpty', `return ${code}`)(ref, text, look, notEmpty) as (s: unknown) => unknown;
  const uses = { names: new Set<string>(), use(n: string) { this.names.add(n); return n; } };
  const scope = { inputs: { a: 'x', n: 3, list: [1, 2] }, steps: { s1: { output: { title: 'T`${x}', ok: true } } } };

  it('templates become expressions with the same meaning', () => {
    const f = evalExpr(`(s) => ${expr({ whole: '{{ inputs.n }}', mixed: 'n={{ inputs.n }} t={{ steps.s1.output.title }}', lit: 'plain \\ `tick`', arr: ['{{ inputs.list }}', 1, null], deep: { x: '{{inputs.a}}' } }, uses as never).replace(/^\{/, '({').replace(/\}$/, '})')}`);
    expect(f(scope)).toEqual({ whole: 3, mixed: 'n=3 t=T`${x}', lit: 'plain \\ `tick`', arr: [[1, 2], 1, null], deep: { x: 'x' } });
    // A missing value fails the step, as in Dittoly.
    expect(() => evalExpr(`(s) => ${expr('{{ inputs.nope }}', uses as never)}`)(scope)).toThrow(/template_unresolved|TemplateError|^$/);
  });

  it('fingerprint() gives the same value as in Dittoly, whole or inside text', () => {
    const u = { names: new Set<string>(), use(n: string) { this.names.add(n); return n; } };
    const code = `(s) => (${expr({ id: '{{ fingerprint(inputs.err) }}', note: 'seen {{ fingerprint( inputs.err ) }} for {{ inputs.a }}' }, u as never)})`;
    expect([...u.names].sort()).toEqual(['fingerprint', 'ref', 'text']);
    const f = new Function('ref', 'text', 'fingerprint', `return ${code}`)(ref, text, exportedFingerprint) as (s: unknown) => { id: string; note: string };
    const s = { ...scope, inputs: { ...scope.inputs, err: 'TypeError at 2026-10-27T10:00:00Z id 42' } };
    const expected = dittolyFingerprint(s.inputs.err);
    expect(f(s)).toEqual({ id: expected, note: `seen ${expected} for x` });
    expect(resolve('{{ fingerprint(inputs.err) }}', s as never)).toBe(expected);
  });

  it('a guarded step is written out with guard: true', () => {
    const code = compileFlow({ key: 'k', name: 'K', description: '', version: 1, access: 'token', exposed: true, guarded: ['post'], definition: { steps: [{ id: 'post', type: 'delay', seconds: 1 }, { id: 'other', type: 'delay', seconds: 1 }] } }, () => 'x', '../runtime/flow.js');
    expect(code.match(/guard: true/g)).toHaveLength(1);
    expect(code).toMatch(/id: 'post',\s+type: 'delay',\s+title: null,\s+guard: true/);
  });

  it('conditions too', () => {
    expect(evalExpr(condition({ notEmpty: 'inputs.list' }, uses as never))(scope)).toBe(true);
    expect(evalExpr(condition({ notEmpty: 'inputs.none' }, uses as never))(scope)).toBe(false);
    expect(evalExpr(condition({ isTrue: 'steps.s1.output.ok' }, uses as never))(scope)).toBe(true);
    expect(evalExpr(condition({ equals: ['inputs.a', 'x'] }, uses as never))(scope)).toBe(true);
    expect(evalExpr(condition({ equals: ['inputs.n', '3'] }, uses as never))(scope)).toBe(false);
  });
});

describe('warm workers', () => {
  it('serve one caller at a time: the next caller gets a fresh worker, so state and timers do not carry over', async () => {
    // Module state a caller could leave behind: a counter, and a timer that keeps changing it.
    writeFileSync(
      path.join(sandboxDir, 'modules', 'stateful.mjs'),
      `let calls = 0; let ticks = 0;
       export const actions = {
         count() { calls++; return { calls, ticks }; },
         leave() { setInterval(() => ticks++, 5); return null; },
       };`,
    );
    const p = new SandboxPool({ sandboxDir, runner: path.join(sandboxDir, 'runner.mjs'), perModule: 1 });
    const broker = { handle: async () => ({ ok: false as const, error: 'x', retryable: false, violation: false }), call: async () => ({ ok: false as const, error: 'x', retryable: false, violation: false }) };
    const call = (action: string, caller?: string) => p.invoke({ moduleFile: 'modules/stateful.mjs', action, input: {}, broker, timeoutMs: 10_000, settings: {}, caller });
    try {
      p.warm(['modules/stateful.mjs']);
      expect(await call('count', 'run-a')).toEqual({ ok: true, output: { calls: 1, ticks: 0 } });
      await call('leave', 'run-a');
      await new Promise((r) => setTimeout(r, 50));
      // The same caller keeps its worker.
      expect(await call('count', 'run-a')).toMatchObject({ ok: true, output: { calls: 2 } });
      // Another caller starts clean.
      expect(await call('count', 'run-b')).toEqual({ ok: true, output: { calls: 1, ticks: 0 } });
      // A call without a caller shares with no one, before or after.
      expect(await call('count')).toEqual({ ok: true, output: { calls: 1, ticks: 0 } });
      expect(await call('count')).toEqual({ ok: true, output: { calls: 1, ticks: 0 } });
    } finally {
      p.close();
    }
  });
});

describe('the engine', () => {
  it('runs module actions in warm sandboxes: forEach, conditions and reports', async () => {
    const f = flow('release', [
      { id: 'mrs', type: 'action', title: 'Find', module: ref_('gitlab'), action: 'list_merge_requests', input: (s) => ({ project: ref(s, 'inputs.project') }) },
      { id: 'merge', type: 'action', title: 'Merge', module: ref_('gitlab'), action: 'merge_merge_request', when: (s) => notEmpty(look(s, 'steps.mrs.output.mergeRequests')), forEach: (s) => ref(s, 'steps.mrs.output.mergeRequests'), input: (s) => ({ project: ref(s, 'inputs.project'), iid: ref(s, 'item.iid') }) },
      { id: 'skip', type: 'action', title: 'Never', module: ref_('slack'), action: 'post_message', when: (s) => look(s, 'inputs.loud') === true, input: () => ({ channel: 'C', text: 'x' }) },
      { id: 'post', type: 'action', title: 'Tell', module: ref_('slack'), action: 'post_message', input: (s) => ({ channel: 'C-rel', text: `Merged ${text(ref(s, 'steps.merge.output.length'))}` }) },
      { id: 'sum', type: 'report', title: null, step: { id: 'sum', heading: 'Done' }, items: (s) => ref(s, 'steps.merge.output') },
    ], { type: 'object', properties: { project: { type: 'string' }, loud: { type: 'boolean' } }, required: ['project'] });
    const { e, fake } = engine([f]);
    await expect(e.start('release', {})).rejects.toMatchObject({ code: 'invalid_inputs' });
    const run = await e.start('release', { project: 'acme/app' });
    const done = await until(e, undefined, run.id, (r) => r.status !== 'running');
    expect(done.status).toBe('succeeded');
    expect(done.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'skipped', 'succeeded', 'succeeded']);
    expect(fake.merged).toEqual([7, 8]);
    expect(fake.messages).toEqual([{ channel: 'C-rel', text: 'Merged 2', auth: 'Bearer xoxb-app' }]);
    expect(done.steps[4]!.output).toMatchObject({ summary: expect.any(String) });
    e.close();
  });

  it('retries what the module says may work later, and pauses on what will not', async () => {
    const f = flow('post', [{ id: 'post', type: 'action', title: 'Post', module: ref_('slack'), action: 'post_message', input: () => ({ channel: 'C', text: 'hi' }) }]);
    const { e, fake } = engine([f]);
    fake.failNext['POST slack.com'] = [503, 503];
    const ok = await until(e, undefined, (await e.start('post', {})).id, (r) => r.status === 'succeeded' || r.status === 'paused');
    expect(ok.status).toBe('succeeded');
    expect(ok.steps[0]!.attempts).toBe(3);
    fake.failNext['POST slack.com'] = [404];
    const paused = await until(e, undefined, (await e.start('post', {})).id, (r) => r.status === 'paused');
    expect(paused).toMatchObject({ waitReason: 'http_404', steps: [{ status: 'failed', errorType: 'http_404', attempts: 1 }] });
    e.close();
  });

  it('waits for sign-offs and forms, and takes the answers as data', async () => {
    const f = flow('ask', [
      { id: 'form', type: 'input', title: 'How many?', intro: null, fields: [{ name: 'count', label: 'Count', widget: 'number', required: true }, { name: 'tone', label: 'Tone', widget: 'select', options: { fixed: [{ value: 'calm' }, { value: 'loud' }] } }], defaults: () => ({ tone: 'calm' }) },
      { id: 'ok', type: 'approval', title: 'Sign off' },
      { id: 'post', type: 'action', title: 'Post', module: ref_('slack'), action: 'post_message', input: (s) => ({ channel: 'C', text: `${text(ref(s, 'steps.form.output.count'))} ${text(ref(s, 'steps.form.output.tone'))}` }) },
    ]);
    const waited: string[] = [];
    const { e, fake } = engine([f], { onWaiting: (_r, s) => waited.push(s) });
    const run = await e.start('ask', {});
    let r = await until(e, undefined, run.id, (x) => x.status === 'waiting');
    expect(r.waitReason).toBe('input_needed');
    expect(e.inputView(r, 'form')).toMatchObject({ fields: [{ name: 'count', required: true }, { name: 'tone', default: 'calm', choices: [{ value: 'calm' }, { value: 'loud' }] }] });
    await expect(e.submitInput(run.id, 'form', { count: 2, tone: 'angry' })).rejects.toMatchObject({ code: 'invalid_answers' });
    await expect(e.decide(run.id, 'ok', 'approved')).rejects.toMatchObject({ code: 'not_waiting_for_approval' });
    await e.submitInput(run.id, 'form', { count: 2, tone: 'loud' });
    r = await until(e, undefined, run.id, (x) => x.waitReason === 'approval');
    await e.decide(run.id, 'ok', 'approved');
    r = await until(e, undefined, run.id, (x) => x.status === 'succeeded');
    expect(fake.messages.at(-1)!.text).toBe('2 loud');
    expect(waited).toEqual(['form', 'ok']);

    const rejected = await e.start('ask', {});
    await until(e, undefined, rejected.id, (x) => x.status === 'waiting');
    await e.submitInput(rejected.id, 'form', { count: 1 });
    await until(e, undefined, rejected.id, (x) => x.waitReason === 'approval');
    await e.decide(rejected.id, 'ok', 'rejected');
    expect(await until(e, undefined, rejected.id, (x) => x.status === 'failed')).toMatchObject({ steps: [{ status: 'succeeded' }, { status: 'failed', errorType: 'approval_rejected' }, { status: 'not_run' }] });
    e.close();
  });

  it('a step text an AI wrote could steer waits for a sign-off, as in Dittoly', async () => {
    const f = flow('steered', [{ id: 'post', type: 'action', title: 'Post', guard: true, module: ref_('slack'), action: 'post_message', input: () => ({ channel: 'C', text: 'from the AI' }) }]);
    const waited: string[] = [];
    const { e, fake } = engine([f], { onWaiting: (_r, s) => waited.push(s) });
    const sent = fake.messages.length;
    const run = await e.start('steered', {});
    const r = await until(e, undefined, run.id, (x) => x.status === 'waiting');
    expect(r).toMatchObject({ waitReason: 'approval', steps: [{ status: 'waiting', errorType: 'awaiting_sign_off' }] });
    // The approver sees exactly what the step will do; a decision on other values is refused.
    const signOff = r.steps[0]!.signOff!;
    expect(signOff.values).toEqual({ module: ref_('slack'), action: 'post_message', input: { channel: 'C', text: 'from the AI' } });
    await expect(e.decide(run.id, 'post', 'approved', '0'.repeat(64))).rejects.toThrow('sign_off_values_changed');
    expect(fake.messages.length).toBe(sent);
    await e.decide(run.id, 'post', 'approved', signOff.sha256);
    expect(await until(e, undefined, run.id, (x) => x.status === 'succeeded')).toMatchObject({ steps: [{ status: 'succeeded', errorType: null }] });
    expect(fake.messages.at(-1)!.text).toBe('from the AI');
    expect(waited).toEqual(['post']);

    const rejected = await e.start('steered', {});
    await until(e, undefined, rejected.id, (x) => x.status === 'waiting');
    await e.decide(rejected.id, 'post', 'rejected');
    expect(await until(e, undefined, rejected.id, (x) => x.status === 'failed')).toMatchObject({ steps: [{ status: 'failed', errorType: 'sign_off_rejected' }] });
    e.close();
  });

  it('a sign-off covers the values it was given: when they differ as the step runs, it asks again', async () => {
    let n = 0;
    const f = flow('drifting', [{ id: 'post', type: 'action', title: null, guard: true, module: ref_('slack'), action: 'post_message', input: () => ({ channel: 'C', text: `value ${n++}` }) }]);
    const { e, fake } = engine([f]);
    const sent = fake.messages.length;
    const run = await e.start('drifting', {});
    const first = (await until(e, undefined, run.id, (x) => x.status === 'waiting')).steps[0]!.signOff!;
    await e.decide(run.id, 'post', 'approved', first.sha256);
    const again = await until(e, undefined, run.id, (x) => x.status === 'waiting' && !x.steps[0]!.decision);
    expect(again.steps[0]).toMatchObject({ status: 'waiting', errorType: 'awaiting_sign_off' });
    expect(again.steps[0]!.signOff!.sha256).not.toBe(first.sha256);
    expect(fake.messages.length).toBe(sent);
    e.close();
  });

  it('keeps table rows: put, get, increment, list, delete', async () => {
    const t = { name: 'handled', keyColumn: 'ticket', columns: [{ name: 'release', type: 'text' as const }, { name: 'tries', type: 'number' as const }] };
    const f = flow('tbl', [
      { id: 'put', type: 'table', title: null, table: 'handled', op: 'put', key: () => 'REL-1', values: () => ({ release: '2.4' }) },
      { id: 'inc', type: 'table', title: null, table: 'handled', op: 'increment', key: () => 'REL-1', column: 'tries', by: () => 2 },
      { id: 'get', type: 'table', title: null, table: 'handled', op: 'get', key: () => 'REL-1' },
      { id: 'list', type: 'table', title: null, table: 'handled', op: 'list', where: { column: 'release', equals: () => '2.4' } },
      { id: 'del', type: 'table', title: null, table: 'handled', op: 'delete', key: () => 'REL-1' },
      { id: 'bad', type: 'table', title: null, table: 'handled', op: 'put', key: () => 'REL-2', values: () => ({ nope: 1 }) },
    ]);
    const { e } = engine([f], { tables: [t] });
    const r = await until(e, undefined, (await e.start('tbl', {})).id, (x) => x.status === 'paused');
    expect(r.steps.map((s) => s.output)).toEqual([
      { row: { ticket: 'REL-1', release: '2.4', tries: null }, created: true },
      { value: 2, row: { ticket: 'REL-1', release: '2.4', tries: 2 } },
      { found: true, row: { ticket: 'REL-1', release: '2.4', tries: 2 } },
      { rows: [{ ticket: 'REL-1', release: '2.4', tries: 2 }], count: 1 },
      { deleted: true },
      undefined,
    ]);
    expect(r.steps[5]).toMatchObject({ status: 'failed', errorType: 'unknown_column' });
    e.close();
  });

  it('runs child Flows together and hands their results to the Super Flow', async () => {
    const child = (key: string, channel: string) => ({ ...flow(key, [{ id: 'post', type: 'action' as const, title: 'Post', module: ref_('slack'), action: 'post_message', input: (s: Parameters<typeof ref>[0]) => ({ channel, text: ref(s, 'inputs.text') }) }], { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }), exposed: false });
    const parent = flow('both', [{ id: 'all', type: 'flow', title: null, runs: [{ id: 'a', flow: 'a', input: (s) => ({ text: ref(s, 'inputs.text') }) }, { id: 'b', flow: 'b', input: () => ({ text: 'fixed' }) }] }], { type: 'object', properties: { text: { type: 'string' } } });
    const { e, fake } = engine([parent, child('a', 'C-a'), child('b', 'C-b')]);
    const r = await until(e, undefined, (await e.start('both', { text: 'go' })).id, (x) => x.status === 'succeeded', 20_000);
    expect(r.steps[0]!.output).toMatchObject({ a: { status: 'succeeded', steps: { post: { ts: expect.any(String) } } }, b: { status: 'succeeded' } });
    expect(fake.messages.map((m) => `${m.channel}:${m.text}`).sort()).toEqual(['C-a:go', 'C-b:fixed']);
    e.close();
  });
});

describe('state stores', () => {
  const run = (id: string, status: RunRecord['status'], flow = 'f'): RunRecord => ({ id, flow, status, waitReason: null, createdAt: new Date(Date.now() - Number(id.slice(-1)) * 1000).toISOString(), finishedAt: null, inputs: { secret: 'value' }, steps: [], parent: null, notified: [], expiresAt: null });
  const contract = async (s: Store) => {
    const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003'];
    await s.putRun(run(ids[0]!, 'waiting'));
    await s.putRun(run(ids[1]!, 'succeeded', 'g'));
    await s.putRun({ ...run(ids[2]!, 'running'), parent: { runId: ids[0]!, stepId: 'x', key: 'k' } });
    expect((await s.getRun(ids[0]!))!.inputs).toEqual({ secret: 'value' });
    expect((await s.listRuns({ limit: 10 })).map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect((await s.listRuns({ flow: 'g', limit: 10 })).map((r) => r.id)).toEqual([ids[1]]);
    expect((await s.activeRuns()).map((r) => r.id).sort()).toEqual([ids[0], ids[2]]);
    await s.putRun({ ...run(ids[0]!, 'succeeded'), expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await s.sweep(new Date())).toBe(1);
    expect(await s.getRun(ids[0]!)).toBeNull();
    await s.tablePut('t', 'k1', { a: 1 });
    expect(await s.tableGet('t', 'k1')).toEqual({ a: 1 });
    expect(await s.tableRows('t')).toEqual([{ key: 'k1', row: { a: 1 } }]);
    expect(await s.tableDelete('t', 'k1')).toBe(true);
    expect(await s.tableDelete('t', 'k1')).toBe(false);
    expect(await s.mark('m1', 60)).toBe(true);
    expect(await s.mark('m1', 60)).toBe(false);
  };

  it('memory', async () => contract(new MemoryStore()));

  it('postgres: run data is sealed with a key from APP_SECRET', async () => {
    const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/dittoly_test';
    const s = await openStore(url, 'z'.repeat(40));
    try {
      const pg = await import('pg');
      const c = new pg.default.Client({ connectionString: url });
      await c.connect();
      await c.query('DELETE FROM dty_runs; DELETE FROM dty_rows; DELETE FROM dty_marks');
      await contract(s);
      await s.putRun(run('00000000-0000-0000-0000-000000000009', 'waiting'));
      const raw = (await c.query(`SELECT data FROM dty_runs`)).rows.map((r) => r.data as string).join();
      expect(raw).not.toContain('value');
      await c.query('DROP TABLE dty_runs, dty_rows, dty_marks');
      await c.end();
    } finally {
      await s.close();
    }
  });

  it.skipIf(!process.env.TEST_REDIS_URL)('redis', async () => {
    const s = await openStore(process.env.TEST_REDIS_URL!, 'z'.repeat(40));
    try {
      const { createClient } = await import('redis');
      const c = createClient({ url: process.env.TEST_REDIS_URL! });
      await c.connect();
      for (const k of await c.keys('dty:*')) await c.del(k);
      await contract(s);
      // A record sealed with another secret is skipped, not fatal.
      const other = await openStore(process.env.TEST_REDIS_URL!, 'o'.repeat(40));
      await other.putRun(run('00000000-0000-0000-0000-000000000008', 'waiting'));
      await other.close();
      expect((await s.activeRuns()).map((r) => r.id)).not.toContain('00000000-0000-0000-0000-000000000008');
      expect(s.unreadable).toBeGreaterThan(0);
      for (const k of await c.keys('dty:*')) await c.del(k);
      await c.close();
    } finally {
      await s.close();
    }
  });

  it('a sealed value opens only with the same secret and purpose', () => {
    const a = new Sealer('a'.repeat(40));
    const sealed = a.seal({ x: 1 }, 'run:1');
    expect(a.open(sealed, 'run:1')).toEqual({ x: 1 });
    expect(() => a.open(sealed, 'run:2')).toThrow();
    expect(() => new Sealer('b'.repeat(40)).open(sealed, 'run:1')).toThrow();
  });
});

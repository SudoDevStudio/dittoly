import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SKILL_SETS, skillPrompt } from '../src/ai/skills.js';
import { parseManifest, type Manifest } from '../src/modules/manifest.js';
import { performanceChecks } from '../src/modules/validate.js';
import { makeWorld, type World } from './helpers.js';

/** Performance rules for generated modules (skills/performant-modules) and the review checks that match them. */

const manifest = (extra: Record<string, unknown> = {}, input: Record<string, unknown> = { type: 'object', properties: { id: { type: 'string', maxLength: 20 } } }) => {
  const p = parseManifest({
    name: 'tickets',
    version: '1.0.0',
    title: 'Tickets',
    description: 'Reads tickets. Needs a token.',
    hosts: ['api.example.com'],
    credentials: [{ id: 'tok', service: 'tickets', label: 'Token', hosts: ['api.example.com'], placement: { type: 'bearer' } }],
    actions: [{ name: 'get_tickets', title: 'Get tickets', description: 'Reads tickets.', effect: 'read', credentials: ['tok'], input, output: { type: 'object' } }],
    ...extra,
  });
  if (!p.ok) throw new Error(p.issues.join('; '));
  return p.manifest;
};
const failing = (m: Manifest, code: string) => performanceChecks(m, code).filter((c) => !c.passed).map((c) => c.name.split(':')[0]);

const good = `export const actions = {
  async get_tickets(input, ctx) {
    const res = await ctx.http.request({ method: 'GET', url: 'https://api.example.com/tickets?per_page=100&fields=id,title', credential: 'tok' });
    if (!res.ok) throw new ctx.ActionError('tickets_' + res.status, { retryable: res.status === 429 || res.status >= 500 });
    const data = res.json();
    return { tickets: data.items.map((t) => ({ id: t.id, title: t.title })) };
  },
};`;

describe('performance checks', () => {
  it('the module prompt carries the performance rules', () => {
    expect(SKILL_SETS.module).toContain('performant-modules');
    expect(skillPrompt(SKILL_SETS.module)).toContain('Performance P1');
  });

  it('a module written to the rules passes every check, and all checks are warnings', () => {
    const checks = performanceChecks(manifest(), good);
    expect(checks.map((c) => c.name.split(':')[0])).toEqual(['Performance P1', 'Performance P2', 'Performance P3', 'Performance P4', 'Performance P5', 'Performance P6', 'Performance P7', 'Performance P8']);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
    expect(checks.every((c) => c.advisory)).toBe(true);
  });

  it.each([
    ['P1', 'for (const id of input.ids) { const r = await ctx.http.request({ url: `https://api.example.com/t/${id}` }); }'],
    ['P1', 'input.ids.forEach(async (id) => { await ctx.http.request({ url: id }); });'],
    ['P2', 'await Promise.all(input.ids.map((id) => ctx.http.request({ url: id })));'],
    ['P3', 'while (true) { const r = await next(); if (!r) break; }'],
    ['P4', 'await new Promise((r) => setTimeout(r, 1000));'],
    ['P5', 'const res = await ctx.http.request({ url }); return res.json();'],
    ['P6', 'const copy = JSON.parse(JSON.stringify(data));'],
  ])('%s flags: %s', (check, code) => {
    expect(failing(manifest(), code)).toEqual([`Performance ${check}`]);
  });

  it('P7: SELECT * and scans or sorts without a limit; a lookup by key is fine', () => {
    // Only the queries matter here: the full database manifest is covered in sql-modules.test.ts.
    const db = (sql: string) => ({ ...manifest(), endpoints: [{ id: 'db', protocol: 'postgres', queries: [{ id: 'q', effect: 'read', sql, maxRows: 50 }] }] }) as unknown as Manifest;
    const p7 = (sql: string) => performanceChecks(db(sql), good).find((c) => c.name.startsWith('Performance P7'))!.details;
    expect(p7('SELECT id, total FROM orders WHERE id = :id')).toEqual([]);
    expect(p7('SELECT id, total FROM orders WHERE customer = :c ORDER BY created_at DESC LIMIT 50')).toEqual([]);
    expect(p7('SELECT * FROM orders WHERE id = :id')).toEqual(['query q selects every column; name the columns the action returns']);
    expect(p7('SELECT id FROM orders ORDER BY created_at DESC')).toEqual([expect.stringContaining('no LIMIT, TOP or FETCH FIRST')]);
  });

  it('P8: list inputs need maxItems, also nested ones', () => {
    const m = manifest({}, { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', maxItems: 5, items: { type: 'object', properties: { tags: { type: 'array' } } } } } });
    expect(performanceChecks(m, good).find((c) => c.name.startsWith('Performance P8'))!.details).toEqual(['get_tickets: input ids has no maxItems', 'get_tickets: input groups[].tags has no maxItems']);
  });
});

describe('P9: calls per sandbox test', () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
  }, 60_000);
  afterAll(async () => {
    await w.db.end();
  });

  it('a test that makes more than 10 calls is flagged, without failing the review', async () => {
    const chatty = `export const actions = {
  async get_tickets(input, ctx) {
    const out = [];
    for (let page = 1; page <= 12; page++) {
      const res = await ctx.http.request({ method: 'GET', url: 'https://api.example.com/tickets?page=' + page, credential: 'tok' });
      if (!res.ok) throw new ctx.ActionError('tickets_' + res.status, { retryable: false });
      out.push(...res.json().items.map((t) => ({ id: t.id })));
    }
    return { tickets: out };
  },
};`;
    const tests = [{ name: 'twelve pages', action: 'get_tickets', input: {}, http: [{ method: 'GET', urlPrefix: 'https://api.example.com/tickets', status: 200, json: { items: [{ id: '1' }] } }], expectOk: true }];
    const d = await w.app.modules.createDraft({ manifest: manifest(), code: chatty, tests, origin: 'seed' } as never, w.alice);
    const report = d.validationReport!;
    expect(report.passed, JSON.stringify(report.checks.filter((c) => !c.passed && !c.advisory))).toBe(true);
    expect(report.checks.find((c) => c.name.startsWith('Performance P9'))).toMatchObject({ passed: false, advisory: true, details: ['test "twelve pages" made 12 calls for one action'] });
    expect(report.checks.find((c) => c.name.startsWith('Performance P1'))).toMatchObject({ passed: false });
  });
});

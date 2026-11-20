import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMember } from '../src/core/members.js';
import { makeWorld, type World } from './helpers.js';

/** Drafts tested before a schema-refused refusal test could pass get a fresh report; approved modules are left alone. */
let w: World;
beforeAll(async () => {
  w = await makeWorld();
});
afterAll(async () => {
  await w.db.end();
});

const manifest = (version: string) => ({
  name: 'tickets',
  version,
  title: 'Tickets',
  description: 'Closes tickets.',
  hosts: ['tickets.example.com'],
  credentials: [{ id: 'token', service: 'tickets', label: 'Token', hosts: ['tickets.example.com'], placement: { type: 'bearer' } }],
  actions: [
    {
      name: 'close',
      title: 'Close',
      description: 'Closes a ticket.',
      effect: 'write',
      credentials: ['token'],
      input: { type: 'object', properties: { id: { type: 'string', pattern: '^T-[0-9]+$' } }, required: ['id'], additionalProperties: false },
      output: { type: 'object', properties: { closed: { type: 'boolean' } }, required: ['closed'] },
    },
  ],
});
const code = `export const actions = {
  async close(input, ctx) {
    const res = await ctx.http.request({ method: 'POST', url: 'https://tickets.example.com/tickets/' + input.id + '/close', credential: 'token' });
    if (!res.ok) throw new ctx.ActionError('tickets_' + res.status, { retryable: res.status >= 500 });
    return { closed: true };
  },
};`;
const tests = [
  { name: 'closes', action: 'close', input: { id: 'T-1' }, http: [{ method: 'POST', urlPrefix: 'https://tickets.example.com/tickets/T-1/close', status: 200, json: {} }] },
  { name: 'refuses header injection', action: 'close', input: { id: 'T-1\r\nX-Evil: 1' }, http: [], expectOk: false },
];
// The report such a draft got before: the refusal test counted as failed.
const oldReport = (passedFirst = true) => ({
  passed: false,
  checks: [],
  tests: [
    { name: 'closes', passed: passedFirst, requests: ['POST https://tickets.example.com/tickets/T-1/close'] },
    { name: 'refuses header injection', passed: false, errorType: 'test_input_invalid', requests: [] },
  ],
});

describe('re-checking old refusal-test failures', () => {
  it('re-runs drafts and modules waiting for review; approved modules keep their report', async () => {
    const draft = await w.app.modules.createDraft({ manifest: manifest('1.0.0'), code, tests, origin: 'seed' }, w.alice);
    const pending = await w.app.modules.createDraft({ manifest: manifest('1.0.1'), code, tests, origin: 'seed' }, w.alice);
    await w.app.modules.submit(pending.id, w.alice);
    const approved = await w.app.modules.createDraft({ manifest: manifest('1.0.2'), code, tests, origin: 'seed' }, w.alice);
    await w.app.modules.submit(approved.id, w.alice);
    await w.app.modules.decide(approved.id, (await createMember(w.db, 'reviewer', 'admin', null)).member, 'approved');
    for (const id of [draft.id, pending.id, approved.id]) await w.db.query(`UPDATE module_versions SET validation_report = $2 WHERE id = $1`, [id, JSON.stringify(oldReport())]);

    expect(await w.app.modules.recheckRefusalTests()).toBe(2);
    const report = async (id: string) => (await w.app.modules.get(w.db, id))!.validationReport!;
    for (const id of [draft.id, pending.id]) {
      const r = await report(id);
      expect(r.passed).toBe(true);
      expect(r.tests.find((t) => t.name === 'refuses header injection')).toMatchObject({ passed: true, errorType: 'refused_by_input_schema' });
    }
    expect((await report(approved.id)).passed).toBe(false);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'module.tests_rechecked'`)).rows[0].n).toBe(2);
    // The draft can now be sent for review; a second pass finds nothing to do.
    await w.app.modules.submit(draft.id, w.alice);
    expect(await w.app.modules.recheckRefusalTests()).toBe(0);
  });

  it('leaves a draft alone when the failing test expected success (the test itself is wrong)', async () => {
    const d = await w.app.modules.createDraft({ manifest: manifest('2.0.0'), code, tests: [{ ...tests[0]!, input: { id: 'not an id' } }], origin: 'seed' }, w.alice);
    const before = (await w.app.modules.get(w.db, d.id))!.validationReport!;
    expect(before.tests[0]).toMatchObject({ passed: false, errorType: 'test_input_invalid' });
    expect(await w.app.modules.recheckRefusalTests()).toBe(0);
  });
});

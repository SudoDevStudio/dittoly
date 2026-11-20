import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { Cipher } from '../src/core/crypto.js';
import { rotateMasterKey } from '../src/core/rekey.js';
import { createTeam, setTeamMember } from '../src/core/teams.js';
import { Tables } from '../src/tables/service.js';
import { makeWorld, type World } from './helpers.js';

/** Data tables: a team's small tables that its Flows read and write, and its members edit. */
let w: World;
let api: ReturnType<typeof buildServer>;
let ops = '';
let tableId = '';
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  ops = (await createTeam(w.db, w.admin, 'Ops')).id;
  await setTeamMember(w.db, w.admin, ops, w.alice.id, 'member');
  await setTeamMember(w.db, w.admin, ops, w.bob.id, 'member');
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const table = { teamId: '', name: 'Handled tickets', keyColumn: 'ticket', columns: [{ name: 'status', type: 'text' }, { name: 'tries', type: 'number' }, { name: 'urgent', type: 'boolean' }, { name: 'seen', type: 'date' }] };

describe('tables and rows', () => {
  it('team admins create tables; members cannot; names and columns are checked', async () => {
    const body = { ...table, teamId: ops };
    expect((await api.inject({ method: 'POST', url: '/api/tables', headers: auth(w.tokens.alice), payload: body })).statusCode).toBe(403);
    const dup = await api.inject({ method: 'POST', url: '/api/tables', headers: auth(w.tokens.admin), payload: { ...body, columns: [{ name: 'ticket', type: 'text' }] } });
    expect(dup.json().detail).toContain('key column');
    const r = await api.inject({ method: 'POST', url: '/api/tables', headers: auth(w.tokens.admin), payload: body });
    expect(r.statusCode, r.body).toBe(201);
    tableId = r.json().id;
    expect((await api.inject({ method: 'POST', url: '/api/tables', headers: auth(w.tokens.admin), payload: body })).json()).toMatchObject({ error: 'table_name_taken' });
  });

  it('members add and change rows in the portal; values get their column type; rows are stored encrypted', async () => {
    let r = await api.inject({ method: 'PUT', url: `/api/tables/${tableId}/rows`, headers: auth(w.tokens.bob), payload: { key: 'OPS-1', values: { status: 'new', tries: '2', urgent: 'yes', seen: '2026-10-01' } } });
    expect(r.json()).toMatchObject({ ticket: 'OPS-1', status: 'new', tries: 2, urgent: true, seen: '2026-10-01' });
    r = await api.inject({ method: 'PUT', url: `/api/tables/${tableId}/rows`, headers: auth(w.tokens.bob), payload: { key: 'OPS-1', values: { status: 'done' } } });
    expect(r.json()).toMatchObject({ status: 'done', tries: 2 });
    r = await api.inject({ method: 'PUT', url: `/api/tables/${tableId}/rows`, headers: auth(w.tokens.bob), payload: { key: 'OPS-2', values: { tries: 'many' } } });
    expect(r.json().detail).toContain('tries: not a number');
    const raw = (await w.db.query(`SELECT key_enc, values_enc, key_hash FROM data_rows`)).rows;
    expect(JSON.stringify(raw)).not.toContain('OPS-1');
    expect(JSON.stringify(raw)).not.toContain('done');
    // The visual editor asks which tables a Flow can use: the chosen team's, or the person's default team's.
    const usable = (await api.inject({ method: 'GET', url: `/api/flow-tables?teamId=${ops}`, headers: auth(w.tokens.alice) })).json() as { name: string }[];
    expect(usable.map((t) => t.name)).toEqual(['Handled tickets']);
    expect((await api.inject({ method: 'GET', url: '/api/flow-tables', headers: auth(w.tokens.alice) })).json()).toEqual([]);
    // Outside the team: no access.
    expect((await api.inject({ method: 'GET', url: `/api/tables/${tableId}/rows`, headers: auth(w.tokens.approver) })).statusCode).toBe(403);
  });
});

const flow = (steps: unknown[]) => ({ inputs: { type: 'object', properties: { ticket: { type: 'string' } }, required: ['ticket'] }, steps });

describe('table steps in Flows', () => {
  it('only tables of the Flow\'s own team, and only their columns', async () => {
    await expect(w.app.flows.create('No table', flow([{ id: 'a', type: 'table', table: 'Missing', op: 'get', key: '{{ inputs.ticket }}' }]), w.alice, undefined, ops)).rejects.toThrow(/no data table "Missing"/);
    await expect(w.app.flows.create('Bad column', flow([{ id: 'a', type: 'table', table: 'Handled tickets', op: 'put', key: 'x', values: { colour: 'red' } }]), w.alice, undefined, ops)).rejects.toThrow(/no column "colour"/);
    await expect(w.app.flows.create('Not a number', flow([{ id: 'a', type: 'table', table: 'Handled tickets', op: 'increment', key: 'x', column: 'status' }]), w.alice, undefined, ops)).rejects.toThrow(/not a number column/);
    await expect(w.app.flows.create('Other team', flow([{ id: 'a', type: 'table', table: 'Handled tickets', op: 'get', key: 'x' }]), w.alice)).rejects.toThrow(/no data table/);
    await expect(w.app.flows.create('Wrong shape', flow([{ id: 'a', type: 'table', table: 'Handled tickets', op: 'list', key: 'x' }]), w.alice, undefined, ops)).rejects.toThrow(/no key/);
  });

  it('a run reads, changes, counts and lists rows; the approver sees what it changes', async () => {
    const v = await w.app.flows.create('Track a ticket', flow([
      { id: 'before', type: 'table', table: 'Handled tickets', op: 'get', key: '{{ inputs.ticket }}' },
      { id: 'mark', type: 'table', table: 'Handled tickets', op: 'put', key: '{{ inputs.ticket }}', values: { status: 'handled', urgent: false } },
      { id: 'count', type: 'table', table: 'Handled tickets', op: 'increment', key: '{{ inputs.ticket }}', column: 'tries', by: 3 },
      { id: 'handled', type: 'table', table: 'Handled tickets', op: 'list', where: { column: 'status', equals: 'handled' } },
    ]), w.alice, undefined, ops);
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.approver) })).json();
    expect(JSON.stringify(review)).toContain('CHANGES (adds or updates) a row of the team\'s data table \\"Handled tickets\\"');
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { ticket: 'OPS-9' });
    await w.app.worker.drain();
    const run = await w.app.engine.runView(runId, w.alice);
    expect(run.status).toBe('succeeded');
    const out = Object.fromEntries(run.steps.map((s) => [s.id, s.output]));
    expect(out.before).toEqual({ found: false, row: null });
    expect(out.mark).toMatchObject({ created: true, row: { ticket: 'OPS-9', status: 'handled', urgent: false } });
    expect(out.count).toMatchObject({ value: 3 });
    expect((out.handled as { count: number; rows: { ticket: string }[] }).rows.map((r) => r.ticket)).toEqual(['OPS-9']);
    const row = (await w.db.query(`SELECT updated_run FROM data_rows WHERE updated_run IS NOT NULL`)).rows[0];
    expect(row.updated_run).toBe(runId);
  });

  it('a dry run reads but changes nothing', async () => {
    const v = await w.app.flows.create('Dry table', flow([
      { id: 'read', type: 'table', table: 'Handled tickets', op: 'get', key: '{{ inputs.ticket }}' },
      { id: 'write', type: 'table', table: 'Handled tickets', op: 'delete', key: '{{ inputs.ticket }}' },
    ]), w.alice, undefined, ops);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { ticket: 'OPS-9' }, { actorId: w.alice.id, dry: true });
    await w.app.worker.drain();
    const run = await w.app.engine.runView(runId, w.alice);
    expect(run.steps.map((s) => [s.id, s.status])).toEqual([['read', 'succeeded'], ['write', 'skipped']]);
    expect((run.steps[0]!.output as { found: boolean }).found).toBe(true);
  });

  it('a value of the wrong type fails the step with a clear reason', async () => {
    const v = await w.app.flows.create('Bad value', flow([{ id: 'p', type: 'table', table: 'Handled tickets', op: 'put', key: 'x', values: { seen: '{{ inputs.ticket }}' } }]), w.alice, undefined, ops);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { ticket: 'not a date' });
    await w.app.worker.drain();
    const run = await w.app.engine.runView(runId, w.alice);
    expect(run.steps[0]).toMatchObject({ status: 'failed', errorType: 'invalid_value' });
  });
});

describe('key rotation', () => {
  it('rows are still found by key after the master key changes', async () => {
    // The test world's cipher holds its key privately; rotation needs it.
    const current = (w.app.cipher as unknown as { key: Buffer }).key;
    const newKey = randomBytes(32);
    await rotateMasterKey(w.db, current, newKey);
    const tables = new Tables(w.db, new Cipher(newKey));
    const t = (await tables.inTeam(w.db, ops))[0]!;
    expect(await tables.getRow(w.db, t, 'OPS-1')).toMatchObject({ status: 'done' });
  });
});

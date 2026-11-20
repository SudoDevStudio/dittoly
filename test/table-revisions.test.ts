import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTeamFor } from '../src/core/teams.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * Two runs of the same Flow that read a row, work something out from it and write it back used to overwrite each
 * other: the second simply won, and the first run's work was gone with nothing to show for it. A put can now say
 * which revision it read ("ifRevision"), and a row that changed in between stops the step with row_changed instead.
 */
let w: World;
let teamId: string;
beforeAll(async () => {
  w = await makeWorld();
  teamId = await defaultTeamFor(w.db, w.alice.id);
});
afterAll(async () => {
  await w.db.end();
});

/** Reads the budget, then writes back what it worked out — only if nobody else changed it meanwhile. */
const spendFlow = (guarded: boolean) => ({
  inputs: { type: 'object', properties: { team: { type: 'string' }, spend: { type: 'number' } }, required: ['team', 'spend'] },
  tables: [{ name: 'budgets', purpose: 'What each team has left.', keyColumn: 'team', columns: [{ name: 'left', type: 'number' }] }],
  steps: [
    { id: 'look', type: 'table', table: 'budgets', op: 'get', key: '{{ inputs.team }}' },
    { id: 'signoff', type: 'approval' },
    {
      id: 'spend',
      type: 'table',
      table: 'budgets',
      op: 'put',
      key: '{{ inputs.team }}',
      values: { left: '{{ steps.look.output.row.left }}' },
      ...(guarded ? { ifRevision: '{{ steps.look.output.row.revision }}' } : {}),
    },
  ],
});

describe('a row that changed since the run read it', () => {
  it('stops the write with row_changed, and without the guard the Flow overwrites it as before', async () => {
    const tables = w.app.tables!;
    const guarded = await w.app.flows.create('Spend carefully', spendFlow(true), w.alice, undefined, teamId);
    await w.app.flows.decide(guarded.id, w.approver, 'approved');
    const table = (await tables.byName(w.db, teamId, 'budgets'))!;

    // What a get step reads: the row, with the revision to write back against.
    await tables.putRow(w.db, table, 'payments', { left: 100 }, { memberId: w.alice.id });
    const read = await tables.getRow(w.db, table, 'payments');
    expect(read).toMatchObject({ team: 'payments', left: 100, revision: 1 });

    // Another run changes it between this run's read and its write.
    await tables.putRow(w.db, table, 'payments', { left: 40 }, { memberId: w.bob.id });
    expect((await tables.getRow(w.db, table, 'payments'))!.revision).toBe(2);
    await expect(tables.putRow(w.db, table, 'payments', { left: 90 }, { memberId: w.alice.id }, 1)).rejects.toMatchObject({ code: 'row_changed' });
    expect((await tables.getRow(w.db, table, 'payments'))!.left).toBe(40);

    // The same thing inside a run: it reads, waits for a sign-off, and by the time it writes the row has moved.
    const run = await w.app.engine.startRun(guarded.id, w.alice.id, { team: 'payments', spend: 10 });
    await w.app.worker.drain();
    expect((await runStatus(w, run, w.alice)).status).toBe('waiting');
    await tables.putRow(w.db, table, 'payments', { left: 7 }, { memberId: w.bob.id });
    await w.app.engine.decideGate(run, 'signoff', w.approver, 'approved');
    await w.app.worker.drain();
    const status = await runStatus(w, run, w.alice);
    expect(status.steps.find((s) => s.id === 'spend')).toMatchObject({ status: 'failed', errorType: 'row_changed' });
    expect((await tables.getRow(w.db, table, 'payments'))!.left).toBe(7);

    // "Only if it does not exist yet" is the same guard with 0.
    await expect(tables.putRow(w.db, table, 'payments', { left: 1 }, { memberId: w.alice.id }, 0)).rejects.toMatchObject({ code: 'row_changed' });
    const made = await tables.putRow(w.db, table, 'new-team', { left: 5 }, { memberId: w.alice.id }, 0);
    expect(made.created).toBe(true);
  });

  it('counts every change, so a later write sees an increment too', async () => {
    const tables = w.app.tables!;
    const table = (await tables.byName(w.db, teamId, 'budgets'))!;
    await tables.putRow(w.db, table, 'ops', { left: 10 }, { memberId: w.alice.id });
    const before = (await tables.getRow(w.db, table, 'ops'))!.revision as number;
    await tables.increment(w.db, table, 'ops', 'left', 5, { memberId: w.alice.id });
    expect((await tables.getRow(w.db, table, 'ops'))!.revision).toBe(before + 1);
    await expect(tables.putRow(w.db, table, 'ops', { left: 0 }, { memberId: w.alice.id }, before)).rejects.toMatchObject({ code: 'row_changed' });
  });
});

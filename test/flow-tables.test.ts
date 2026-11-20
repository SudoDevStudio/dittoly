import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTeamFor } from '../src/core/teams.js';
import { parseManifest } from '../src/modules/manifest.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * A Flow declares the data tables its table steps need: the draft is valid without them, the approver sees which
 * tables approving creates, and approving creates them in the Flow's team (or adds missing columns). Nobody makes a
 * table by hand.
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

const definition = (columns: { name: string; type: string }[]) => ({
  inputs: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
  tables: [{ name: 'error_fixes', purpose: 'Errors already handled, by fingerprint.', keyColumn: 'fingerprint', columns }],
  steps: [
    { id: 'seen', type: 'table', table: 'error_fixes', op: 'get', key: '{{ fingerprint(inputs.error) }}' },
    { id: 'remember', type: 'table', table: 'error_fixes', op: 'put', key: '{{ fingerprint(inputs.error) }}', values: { pr_link: 'https://example.test/pr/1' }, when: { isTrue: 'steps.seen.output.found' } },
  ],
});

describe('tables a Flow declares', () => {
  it('are created when the Flow is approved, and its table steps use them', async () => {
    const v = await w.app.flows.create('Remember errors', definition([{ name: 'pr_link', type: 'text' }]), w.alice, undefined, teamId);
    expect((await w.app.flows.review(v.id)).tablesToCreate).toEqual([{ name: 'error_fixes', purpose: 'Errors already handled, by fingerprint.', exists: false, newColumns: ['fingerprint', 'pr_link'] }]);
    expect((await w.db.query(`SELECT 1 FROM data_tables WHERE team_id = $1 AND name = 'error_fixes'`, [teamId])).rowCount).toBe(0);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const table = (await w.db.query<{ key_column: string; columns: { name: string }[] }>(`SELECT key_column, columns FROM data_tables WHERE team_id = $1 AND name = 'error_fixes'`, [teamId])).rows[0];
    expect(table).toMatchObject({ key_column: 'fingerprint', columns: [{ name: 'pr_link', type: 'text' }] });
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { error: 'TypeError: x is undefined at cart.ts:12' });
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).status).toBe('succeeded');
  });

  it('a later version adds the columns the table lacks', async () => {
    const v = await w.app.flows.create('Remember errors, with dates', definition([{ name: 'pr_link', type: 'text' }, { name: 'opened_at', type: 'date' }]), w.alice, undefined, teamId);
    expect((await w.app.flows.review(v.id)).tablesToCreate).toEqual([expect.objectContaining({ name: 'error_fixes', exists: true, newColumns: ['opened_at'] })]);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const columns = (await w.db.query<{ columns: { name: string }[] }>(`SELECT columns FROM data_tables WHERE team_id = $1 AND name = 'error_fixes'`, [teamId])).rows[0]!.columns.map((c) => c.name);
    expect(columns).toEqual(['pr_link', 'opened_at']);
  });

  it('a table step on a table that is neither the team\'s nor declared is refused, saying how to fix it', async () => {
    const def = { inputs: { type: 'object', properties: {} }, steps: [{ id: 'look', type: 'table', table: 'nowhere', op: 'list' }] };
    await expect(w.app.flows.create('No table', def, w.alice, undefined, teamId)).rejects.toThrow(/no data table "nowhere": declare it in the definition's "tables"/);
  });
});

describe('modules keep no data', () => {
  it('a manifest that declares team tables is refused: the Flow keeps data and passes it in', () => {
    const manifest = {
      name: 'video-memory', version: '1.0.0', title: 'Video memory', description: 'Remembers posted videos. Needs no key.',
      hosts: [], credentials: [],
      actions: [{ name: 'remember', title: 'Remember', description: 'Keeps the last video.', effect: 'write', credentials: [], input: { type: 'object' }, output: { type: 'object' } }],
    };
    expect(parseManifest(manifest).ok).toBe(true);
    expect(parseManifest({ ...manifest, tables: [{ name: 'Posted videos', access: 'write', purpose: 'x' }] }).ok).toBe(false);
  });
});

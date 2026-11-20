import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTeamFor } from '../src/core/teams.js';
import { Workers } from '../src/engine/jobs.js';
import { stepSchema } from '../src/flows/definition.js';
import type { DataTable } from '../src/tables/service.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * A table step can claim a row's key for a while: of runs that claim the same key at the same time, exactly one gets
 * it; the claim lapses after its hours, so a run that died does not hold it for ever. The error-to-fix Flows claim the
 * error's fingerprint, so equivalent alerts arriving together start one investigation.
 */
let w: World;
let t: DataTable;
let teamId: string;
beforeAll(async () => {
  w = await makeWorld({ runWorkers: 4 });
  teamId = await defaultTeamFor(w.db, w.alice.id);
  t = await w.app.tables.create(w.admin, { teamId, name: 'incidents', keyColumn: 'fingerprint', columns: [{ name: 'status', type: 'text' }] });
});
afterAll(async () => {
  await w.app.worker.stop();
  await w.db.end();
});

describe('claims', () => {
  it('of many runs claiming one key at once, exactly one gets it; the holder can claim again; it lapses when its run ends or its hours pass', async () => {
    // Real runs that are still going (nothing works on them here).
    const def = { inputs: { type: 'object', properties: {} }, steps: [{ id: 'wait', type: 'delay', seconds: 3600 }] };
    const v = await w.app.flows.create('Holder', def, w.alice, undefined, teamId);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runs: string[] = [];
    for (let i = 0; i < 10; i++) runs.push(await w.app.engine.startRun(v.id, w.alice.id, {}));
    const results = await Promise.all(runs.map((r) => w.app.tables.claim(w.db, t, 'fp-1', 6, r)));
    expect(results.filter((x) => x.claimed)).toHaveLength(1);
    const holder = runs[results.findIndex((x) => x.claimed)]!;
    const other = runs.find((r) => r !== holder)!;
    expect((await w.app.tables.claim(w.db, t, 'fp-1', 6, holder)).claimed).toBe(true);
    expect((await w.app.tables.claim(w.db, t, 'fp-1', 6, other)).claimed).toBe(false);
    expect((await w.app.tables.claim(w.db, t, 'fp-2', 6, other)).claimed).toBe(true);
    // Its hours pass (a run that died meanwhile no longer holds it).
    await w.db.query(`UPDATE data_claims SET until = now() - interval '1 second' WHERE run_id = $1`, [holder]);
    expect((await w.app.tables.claim(w.db, t, 'fp-1', 6, other)).claimed).toBe(true);
    // Its run ends: the next run gets it at once.
    await w.db.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [other]);
    expect((await w.app.tables.claim(w.db, t, 'fp-1', 6, holder)).claimed).toBe(true);
    // A key no run holds any more is free for anyone; ids of runs that do not exist hold nothing.
    expect((await w.app.tables.claim(w.db, t, 'fp-3', 6, randomUUID())).claimed).toBe(true);
    for (const r of runs) await w.app.engine.cancel(r, w.alice).catch(() => undefined);
  });

  it('a claim step needs a key; hours belong to claim only', () => {
    expect(stepSchema.safeParse({ id: 'c', type: 'table', table: 'incidents', op: 'claim', key: 'k', hours: 6 }).success).toBe(true);
    expect(stepSchema.safeParse({ id: 'c', type: 'table', table: 'incidents', op: 'claim' }).success).toBe(false);
    expect(stepSchema.safeParse({ id: 'c', type: 'table', table: 'incidents', op: 'get', key: 'k', hours: 6 }).success).toBe(false);
    expect(stepSchema.safeParse({ id: 'c', type: 'table', table: 'incidents', op: 'claim', key: 'k', hours: 0 }).success).toBe(false);
  });

  it('two runs of a Flow started together: only the one holding the claim goes on', async () => {
    await approveExampleModules(w);
    await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice');
    const def = {
      inputs: { type: 'object', properties: { fp: { type: 'string' } }, required: ['fp'] },
      steps: [
        { id: 'claim', type: 'table', table: 'incidents', op: 'claim', key: '{{ inputs.fp }}', hours: 6 },
        { id: 'work', type: 'action', module: 'slack@1.0.0', action: 'post_message', when: { isTrue: 'steps.claim.output.claimed' }, input: { channel: 'C-work', text: 'investigating' } },
      ],
    };
    const v = await w.app.flows.create('Claim then work', def, w.alice, undefined, teamId);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runs = await Promise.all([1, 2, 3].map(() => w.app.engine.startRun(v.id, w.alice.id, { fp: 'same-error' })));
    const workers = new Workers(w.db, (job, hb) => w.app.engine.handleJob(job, hb), { runs: 3 });
    workers.start(5);
    const end = Date.now() + 15_000;
    try {
      for (;;) {
        const views = await Promise.all(runs.map((r) => w.app.engine.runView(r, w.alice)));
        if (views.every((x) => x.status === 'succeeded') || Date.now() > end) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      await workers.stop();
    }
    const views = await Promise.all(runs.map((r) => w.app.engine.runView(r, w.alice)));
    expect(views.map((x) => x.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    const claimed = views.map((x) => (x.steps.find((s) => s.id === 'claim')!.output as { claimed: boolean }).claimed);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(w.fake.messages.filter((m) => m.channel === 'C-work')).toHaveLength(1);
  });
});

describe('the error-to-fix Flows', () => {
  it.each(['error-to-fix.json', 'error-to-fix-github.json', 'error-to-fix-node-loki-github.json'])('%s claims the fingerprint right after deciding, and only the holder investigates', async (file) => {
    const t = JSON.parse(await readFile(path.resolve(import.meta.dirname, 'fixtures', 'flows', file), 'utf8')) as { definition: { steps: { id: string; op?: string; key?: string; when?: { isTrue?: string } }[] } };
    const steps = t.definition.steps;
    const at = (id: string) => steps.findIndex((s) => s.id === id);
    const claim = steps[at('claim')]!;
    expect(at('claim')).toBe(at('decide') + 1);
    expect(claim).toMatchObject({ op: 'claim', key: '{{ fingerprint(steps.normalize.output.text) }}', when: { isTrue: 'steps.decide.output.attempt' } });
    // Nothing after the claim starts an investigation on decide alone.
    expect(steps.slice(at('claim') + 1).filter((s) => s.when?.isTrue === 'steps.decide.output.attempt')).toEqual([]);
    expect(steps[at('triage')]!.when).toEqual({ isTrue: 'steps.claim.output.claimed' });
  });
});

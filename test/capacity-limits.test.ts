import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createTeam } from '../src/core/teams.js';
import { Workers, type Job } from '../src/engine/jobs.js';
import type { FetchLike } from '../src/runtime/broker.js';
import { approveExampleModules, FakeApps, makeWorld, type World } from './helpers.js';

/**
 * Run capacity (plan item 06): an admin can cap how many runs a team has going at once, a cancelled run gives its
 * slot back at its next checkpoint, and when too many runs already wait, starting another is refused clearly.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (channel: string) => ({ inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel, text: 'hi' } }] });
let w: World | undefined;
afterEach(async () => {
  await w?.app.worker.stop();
  await w?.db.end();
  w = undefined;
});

async function approved(world: World, name: string, def: unknown, teamId?: string) {
  const v = await world.app.flows.create(name, def, world.alice, undefined, teamId);
  await world.app.flows.decide(v.id, world.approver, 'approved');
  return v.id;
}

describe('team run limits', () => {
  it('a team at its limit waits for its own runs to finish; other teams go on', async () => {
    w = await makeWorld({ runWorkers: 3 });
    await approveExampleModules(w);
    const api = buildServer(w.app);
    const team = await createTeam(w.db, w.admin, 'Ops');
    await w.db.query(`INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [team.id, w.alice.id]);
    // Only an admin sets it.
    const put = (token: string, runLimit: number | null) => api.inject({ method: 'PUT', url: `/api/teams/${team.id}/run-limit`, headers: { authorization: `Bearer ${token}` }, payload: { runLimit } });
    expect((await put(w.tokens.alice, 1)).statusCode).toBe(403);
    expect((await put(w.tokens.admin, 1)).statusCode).toBe(204);
    const teams = (await api.inject({ method: 'GET', url: '/api/teams', headers: { authorization: `Bearer ${w.tokens.admin}` } })).json() as { id: string; runLimit: number | null }[];
    expect(teams.find((t) => t.id === team.id)!.runLimit).toBe(1);

    const limited = await approved(w, 'Ops post', post('C-ops'), team.id);
    const free = await approved(w, 'Default post', post('C-default'));
    const runs = [
      await w.app.engine.startRun(limited, w.alice.id, {}),
      await w.app.engine.startRun(limited, w.alice.id, {}),
      await w.app.engine.startRun(limited, w.alice.id, {}),
      await w.app.engine.startRun(free, w.alice.id, {}),
    ];
    const ops = new Set(runs.slice(0, 3));
    let opsNow = 0;
    let opsMost = 0;
    let freeStartedWhileOpsBusy = false;
    const seen = new Set<string>();
    const workers = new Workers(w.db, async (job: Job) => {
      if (job.kind !== 'advance') return;
      const isOps = ops.has(job.payload.runId!);
      if (isOps) {
        opsNow++;
        opsMost = Math.max(opsMost, opsNow);
      } else if (opsNow > 0) freeStartedWhileOpsBusy = true;
      await sleep(150);
      if (isOps) opsNow--;
      seen.add(job.payload.runId!);
    }, { runs: 3 });
    workers.start(5);
    try {
      const end = Date.now() + 5000;
      while (seen.size < 4 && Date.now() < end) await sleep(20);
    } finally {
      await workers.stop();
      await api.close();
    }
    expect(seen.size).toBe(4);
    expect(opsMost).toBe(1);
    expect(freeStartedWhileOpsBusy).toBe(true);
  });
});

describe('cancelling', () => {
  it('a cancelled run stops at its next item and its slot takes the next run', async () => {
    const fake = new FakeApps();
    // Each post takes a while, like a slow app.
    const slow: FetchLike = async (url, init) => {
      await sleep(120);
      return fake.fetch(url, init);
    };
    w = await makeWorld({ runWorkers: 1 }, { fetchImpl: slow });
    await approveExampleModules(w);
    await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice');
    const many = {
      inputs: { type: 'object', properties: {} },
      steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', forEach: '{{ inputs.items }}', input: { channel: 'C-many', text: '{{ item }}' } }],
    };
    (many.inputs.properties as Record<string, unknown>).items = { type: 'array', items: { type: 'string' } };
    const long = await approved(w, 'Post many', many);
    const short = await approved(w, 'Post once', post('C-next'));
    const a = await w.app.engine.startRun(long, w.alice.id, { items: Array.from({ length: 20 }, (_, i) => `m${i}`) });
    const b = await w.app.engine.startRun(short, w.alice.id, {});
    w.app.worker.start(5);
    const end = Date.now() + 10_000;
    while (!fake.messages.some((m) => m.channel === 'C-many') && Date.now() < end) await sleep(10);
    await w.app.engine.cancel(a, w.alice);
    while ((await w.app.engine.runView(b, w.alice)).status !== 'succeeded' && Date.now() < end) await sleep(20);
    expect((await w.app.engine.runView(b, w.alice)).status).toBe('succeeded');
    expect((await w.app.engine.runView(a, w.alice)).status).toBe('cancelled');
    // It stopped well before all 20 items (one more may have been in flight).
    expect(fake.messages.filter((m) => m.channel === 'C-many').length).toBeLessThan(5);
    // Its job was finished, not left to be retried.
    expect((await w.db.query(`SELECT count(*)::int AS n FROM jobs WHERE payload->>'runId' = $1`, [a])).rows[0].n).toBe(0);
  });
});

describe('overload', () => {
  it('when too many runs already wait, a new run is refused with server_busy; Super Flow children are not', async () => {
    w = await makeWorld({ maxWaitingRuns: 2 });
    await approveExampleModules(w);
    await w.app.vault.put(w.alice.id, 'slack', 'xoxb-alice');
    const api = buildServer(w.app);
    const v = await approved(w, 'Post once', post('C1'));
    const start = () => api.inject({ method: 'POST', url: `/api/flow-versions/${v}/runs`, headers: { authorization: `Bearer ${w!.tokens.alice}`, 'x-dittoly-request': '1' }, payload: { inputs: {} } });
    expect((await start()).statusCode).toBe(202);
    expect((await start()).statusCode).toBe(202);
    const busy = await start();
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toMatchObject({ error: 'server_busy' });
    expect(busy.headers['retry-after']).toBe('60');
    // Once the queue drains, runs start again.
    await w.app.worker.drain();
    expect((await start()).statusCode).toBe(202);
    await api.close();
  });
});

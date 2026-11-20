import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, type World } from './helpers.js';

/** The home page's "Get started" checklist: ticked off from what really happened. */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
type Step = { id: string; done: boolean; optional: boolean; link: string | null };
const get = async (t: string) => (await api.inject({ method: 'GET', url: '/api/onboarding', headers: auth(t) })).json() as { steps: Step[]; complete: boolean; hidden: boolean };
const done = (o: { steps: Step[] }) => Object.fromEntries(o.steps.map((s) => [s.id, s.done]));

beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('get started', () => {
  it('shows each role its steps and ticks them off as they happen', async () => {
    // A member does not invite people or export apps; an admin on a shared server does both.
    expect((await get(w.tokens.alice)).steps.map((s) => s.id)).toEqual(['ai', 'module', 'credentials', 'flow', 'run']);
    expect((await get(w.tokens.approver)).steps.map((s) => s.id)).toEqual(['ai', 'module', 'credentials', 'flow', 'run', 'export']);
    expect((await get(w.tokens.admin)).steps.map((s) => s.id)).toEqual(['ai', 'module', 'credentials', 'flow', 'run', 'team', 'export']);
    expect(done(await get(w.tokens.alice))).toEqual({ ai: false, module: false, credentials: false, flow: false, run: false });
    expect((await get(w.tokens.admin)).steps.find((s) => s.id === 'team')!.done).toBe(true);

    await approveExampleModules(w);
    const v = await approvedReleaseFlow(w);
    expect(done(await get(w.tokens.alice))).toMatchObject({ module: true, credentials: false, flow: true, run: false });
    await giveAllCredentials(w, w.alice);
    // A dry run does not count: nothing was really done.
    await w.app.engine.startRun(v.id, w.alice.id, releaseInputs, { actorId: w.alice.id, dry: true });
    await w.app.worker.drain();
    let o = await get(w.tokens.alice);
    expect(done(o)).toMatchObject({ credentials: true, run: false });
    expect(o.complete).toBe(false);

    const run = await w.app.engine.startRun(v.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    await w.app.engine.decideGate(run, 'signoff', w.approver, 'approved');
    await w.app.worker.drain();
    o = await get(w.tokens.alice);
    // The AI is optional: everything else is done.
    expect(done(o)).toEqual({ ai: false, module: true, credentials: true, flow: true, run: true });
    expect(o.complete).toBe(true);
    // Each person's own runs and credentials count, not someone else's.
    expect(done(await get(w.tokens.bob))).toMatchObject({ credentials: false, run: false });
  });

  it('hides for one person and comes back when asked', async () => {
    const put = (t: string, payload: Record<string, unknown>) => api.inject({ method: 'PUT', url: '/api/onboarding', headers: auth(t), payload });
    expect((await put(w.tokens.bob, { hidden: true })).json().hidden).toBe(true);
    expect((await get(w.tokens.bob)).hidden).toBe(true);
    expect((await get(w.tokens.alice)).hidden).toBe(false);
    expect((await put(w.tokens.bob, { hidden: false })).json().hidden).toBe(false);
    expect((await put(w.tokens.bob, { hidden: 'yes' })).statusCode).toBe(400);
    expect((await api.inject({ method: 'GET', url: '/api/onboarding' })).statusCode).toBe(401);
  });
});

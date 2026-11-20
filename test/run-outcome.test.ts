import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { runOutcome, type OutcomeStep } from '../src/engine/outcome.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, runStatus, type World } from './helpers.js';

/**
 * Plan item 09: one result per run, derived from its steps the same way for every Flow: the step to look at,
 * why it stopped or waits, a link it returned, and the steps it skipped or never reached (never shown as success).
 */

const step = (id: string, status: string, extra: Partial<OutcomeStep> = {}): OutcomeStep => ({ id, title: null, status, errorType: null, ...extra });

describe('runOutcome', () => {
  it('a finished run that skipped steps is neutral, names the last step that ran and its link', () => {
    const o = runOutcome({ status: 'succeeded', waitReason: null }, [
      step('triage', 'succeeded'),
      step('fix', 'skipped', { title: 'Fix and verify' }),
      step('push_mr', 'skipped'),
      step('record', 'succeeded', { title: 'Record the stop', output: { note: 'x', url: 'ftp://no', html_url: 'https://github.com/o/r/pull/7' } }),
    ]);
    expect(o).toMatchObject({ state: 'succeeded', tone: 'info', headline: 'Finished after Record the stop', step: { id: 'record' }, link: { url: 'https://github.com/o/r/pull/7', stepId: 'record' }, ran: 2, skipped: ['Fix and verify', 'push_mr'] });
    expect(o.reason).toBe('2 steps were skipped by their conditions.');
  });

  it('a finished run that skipped nothing is a success; a link comes from the last step that returned one', () => {
    const o = runOutcome({ status: 'succeeded', waitReason: null, dry: true }, [step('mr', 'succeeded', { output: { webUrl: 'https://gitlab.com/x/-/merge_requests/3' } }), step('notify', 'succeeded', { output: { ok: true } })]);
    expect(o).toMatchObject({ tone: 'ok', headline: 'Finished (dry run) after notify', link: { url: 'https://gitlab.com/x/-/merge_requests/3', stepId: 'mr' }, reason: null });
  });

  it('a stop names the step, the reason in plain words, and what it never reached', () => {
    const o = runOutcome({ status: 'failed', waitReason: null }, [step('a', 'succeeded'), step('b', 'failed', { errorType: 'http_401' }), step('c', 'pending'), step('d', 'pending', { title: 'Notify' })]);
    expect(o).toMatchObject({ state: 'stopped', tone: 'bad', headline: 'Stopped at b', reason: 'An app answered HTTP 401.', notRun: ['c', 'Notify'] });
    const paused = runOutcome({ status: 'paused', waitReason: null }, [step('b', 'failed', { errorType: 'missing_credential' })]);
    expect(paused).toMatchObject({ state: 'paused', headline: 'Paused at b', reason: 'A credential it needs is not stored. It can be retried.' });
    expect(runOutcome({ status: 'failed', waitReason: null }, [step('b', 'failed', { errorType: 'something_new' })]).reason).toBe('It failed with something new.');
  });

  it('waiting says for what; cancelled and running name their step', () => {
    expect(runOutcome({ status: 'waiting', waitReason: 'approval' }, [step('a', 'succeeded'), step('gate', 'waiting'), step('b', 'pending')])).toMatchObject({ state: 'waiting', headline: 'Waiting at gate', reason: 'It waits for an approver to sign off.', notRun: ['b'] });
    expect(runOutcome({ status: 'cancelled', waitReason: null }, [step('a', 'cancelled'), step('b', 'pending')])).toMatchObject({ headline: 'Cancelled at a', notRun: ['b'] });
    expect(runOutcome({ status: 'running', waitReason: null }, [step('a', 'succeeded'), step('b', 'running')])).toMatchObject({ state: 'running', headline: 'Running b' });
  });
});

let w: World;
let api: ReturnType<typeof buildServer>;
let versionId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
  versionId = (await approvedReleaseFlow(w)).id;
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('a run\'s result in the portal', () => {
  it('the run view carries it; the inbox says how the run ended without naming its steps', async () => {
    // Alice has no credentials: the first step pauses the run.
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.outcome).toMatchObject({ state: 'paused', tone: 'bad', step: { id: r.steps[0]!.id, errorType: 'missing_credential' }, reason: 'A credential it needs is not stored. It can be retried.' });
    expect(r.outcome.notRun.length).toBe(r.steps.length - 1);
    const notes = (await api.inject({ method: 'GET', url: '/api/notifications', headers: auth(w.tokens.alice) })).json() as { kind: string; run_id: string; outcome: string | null }[];
    const n = notes.find((x) => x.run_id === runId && x.kind === 'run_paused')!;
    expect(n.outcome).toBe('It paused: a credential it needs is not stored.');
    for (const s of r.steps) expect(n.outcome).not.toContain(s.id);

    await giveAllCredentials(w, w.bob);
    const ok = await w.app.engine.startRun(versionId, w.bob.id, releaseInputs);
    await w.app.worker.drain();
    const done = await runStatus(w, ok, w.bob);
    expect(done.outcome.state).toBe(done.status === 'succeeded' ? 'succeeded' : 'waiting');
  });
});

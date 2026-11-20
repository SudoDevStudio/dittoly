import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, type World } from './helpers.js';

/** Flow tests: runs played with recorded answers (no app is called), shown to the approver of each version. */
let w: World;
let api: ReturnType<typeof buildServer>;
let flowId = '';
let versionId = '';
let runId = '';
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
type Results = { total: number; passed: number; results: { name: string; passed: boolean; status: string; problems: string[]; steps: { id: string; status: string }[] }[] };
const results = async (vid: string) => (await api.inject({ method: 'GET', url: `/api/flow-versions/${vid}/tests`, headers: auth(w.tokens.approver) })).json() as Results;

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  api = buildServer(w.app);
  await giveAllCredentials(w, w.alice);
  const v = await approvedReleaseFlow(w);
  flowId = v.flowId;
  versionId = v.id;
  runId = await w.app.engine.startRun(v.id, w.alice.id, releaseInputs);
  await w.app.worker.drain();
  await w.app.engine.decideGate(runId, 'signoff', w.approver, 'approved');
  await w.app.worker.drain();
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('tests from runs', () => {
  it('only the person a finished run belongs to can make a test of it; it is stored encrypted', async () => {
    expect((await api.inject({ method: 'POST', url: `/api/runs/${runId}/save-test`, headers: auth(w.tokens.approver), payload: { name: 'x' } })).json()).toMatchObject({ error: 'own_runs_only' });
    const r = await api.inject({ method: 'POST', url: `/api/runs/${runId}/save-test`, headers: auth(w.tokens.alice), payload: { name: 'Release 2.4 as it ran' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().flowId).toBe(flowId);
    const raw = JSON.stringify((await w.db.query(`SELECT case_enc FROM flow_tests`)).rows);
    expect(raw).not.toContain('fixVersion');
    const list = (await api.inject({ method: 'GET', url: `/api/flows/${flowId}/tests`, headers: auth(w.tokens.alice) })).json();
    expect(list[0].case.answers.merge.outputs).toHaveLength(2);
    expect(list[0].case.expect).toMatchObject({ status: 'succeeded', steps: { signoff: 'succeeded', merge: 'succeeded' } });
  });

  it('the recorded run passes on its own version; the approver sees the results', async () => {
    const r = await results(versionId);
    expect(r).toMatchObject({ total: 1, passed: 1 });
    expect(r.results[0]!.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
  });

  it('a new version that sends an app the wrong inputs fails the test, saying which step and why; no app is called', async () => {
    const before = w.fake.merged.length;
    const def = JSON.parse(JSON.stringify((await w.app.flows.getVersion(w.db, versionId))!.definition));
    def.steps.find((s: { id: string }) => s.id === 'merge').input.iid = '{{ item.title }}';
    const v2 = await w.app.flows.update(flowId, def, w.alice);
    const r = await results(v2.id);
    expect(r).toMatchObject({ total: 1, passed: 0 });
    expect(r.results[0]!.problems.join(' ')).toMatch(/step merge item 1 would send merge_merge_request inputs it does not accept/);
    expect(r.results[0]!.steps.find((s) => s.id === 'merge')!.status).toBe('failed');
    expect(w.fake.merged.length).toBe(before);
  });
});

describe('written tests', () => {
  it('a rejected sign-off stops the run before anything changes', async () => {
    const list = (await api.inject({ method: 'GET', url: `/api/flows/${flowId}/tests`, headers: auth(w.tokens.alice) })).json();
    const recorded = list[0].case;
    const body = {
      name: 'Sign-off rejected',
      case: { inputs: recorded.inputs, answers: { tickets: recorded.answers.tickets, mrs: recorded.answers.mrs }, decisions: { signoff: 'rejected' }, expect: { status: 'failed', steps: { merge: 'not_run', announce: 'not_run' } } },
    };
    expect((await api.inject({ method: 'POST', url: `/api/flows/${flowId}/tests`, headers: auth(w.tokens.bob), payload: body })).json()).toMatchObject({ error: 'owner_only' });
    expect((await api.inject({ method: 'POST', url: `/api/flows/${flowId}/tests`, headers: auth(w.tokens.alice), payload: body })).statusCode).toBe(201);
    const r = await results(versionId);
    expect(r.results.find((x) => x.name === 'Sign-off rejected')).toMatchObject({ passed: true, status: 'failed' });
  });

  it('says what is missing or wrong: no recorded answer, an answer the action does not promise, a value not as expected', async () => {
    const list = (await api.inject({ method: 'GET', url: `/api/flows/${flowId}/tests`, headers: auth(w.tokens.alice) })).json();
    const recorded = list[0].case;
    const add = (name: string, c: unknown) => api.inject({ method: 'POST', url: `/api/flows/${flowId}/tests`, headers: auth(w.tokens.alice), payload: { name, case: c } });
    await add('No answer for mrs', { inputs: recorded.inputs, answers: { tickets: recorded.answers.tickets }, expect: { status: 'succeeded' } });
    await add('Wrong answer shape', { inputs: recorded.inputs, answers: { ...recorded.answers, mrs: { output: { mergeRequests: 'two' } } } });
    await add('Wrong expectation', { inputs: recorded.inputs, answers: recorded.answers, expect: { values: [{ path: 'steps.tickets.output.issues', equals: [] }, { path: 'inputs.release', contains: '9.9' }] } });
    const r = await results(versionId);
    const by = (n: string) => r.results.find((x) => x.name === n)!;
    expect(by('No answer for mrs').problems.join(' ')).toContain('step mrs: the test has no recorded answer for it');
    expect(by('Wrong answer shape').problems.join(' ')).toContain("step mrs: the recorded answer does not match list_merge_requests's output");
    expect(by('Wrong expectation').problems.join(' ')).toMatch(/steps\.tickets\.output\.issues is .*expected \[\].*inputs\.release does not contain "9\.9"/);
    // Inputs the Flow does not accept are caught before anything else.
    await add('Bad inputs', { inputs: { release: 2 } });
    expect((await results(versionId)).results.find((x) => x.name === 'Bad inputs')!.problems[0]).toContain("the test's inputs do not fit");
  });

  it('a test that is not well formed is refused, and owners can remove tests', async () => {
    const bad = await api.inject({ method: 'POST', url: `/api/flows/${flowId}/tests`, headers: auth(w.tokens.alice), payload: { name: 'x', case: { answers: { a: { fail: 'Not A Code' } } } } });
    expect(bad.statusCode).toBe(400);
    const list = (await api.inject({ method: 'GET', url: `/api/flows/${flowId}/tests`, headers: auth(w.tokens.alice) })).json() as { id: string; name: string }[];
    const id = list.find((t) => t.name === 'Bad inputs')!.id;
    expect((await api.inject({ method: 'DELETE', url: `/api/flows/${flowId}/tests/${id}`, headers: auth(w.tokens.alice) })).statusCode).toBe(204);
  });
});

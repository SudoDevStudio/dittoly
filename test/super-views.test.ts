import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approvalQueue } from '../src/api/queries.js';
import { approveExampleModules, giveAllCredentials, makeWorld, runStatus, type World } from './helpers.js';

/**
 * Super views: the run form a Flow declares (field types, labels, choices
 * loaded live with the person's own access), and input steps that pause a run
 * until its member answers a form.
 */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Pick a merge request from a live list, then pick which open MRs to merge mid-run. */
const definition = {
  description: 'Merge the merge requests you pick.',
  inputs: {
    type: 'object',
    properties: { project: { type: 'string' }, focus: { type: 'integer' }, note: { type: 'string', enum: ['quick', 'careful'] } },
    required: ['project'],
  },
  form: {
    intro: 'Choose a project.',
    fields: [
      { name: 'project', label: 'Project', widget: 'text', placeholder: 'acme/app' },
      {
        name: 'focus',
        label: 'Merge request to look at first',
        widget: 'select',
        options: { module: 'gitlab@1.0.0', action: 'list_merge_requests', input: { project: '{{ inputs.project }}' }, items: 'mergeRequests', value: 'iid', label: 'title' },
      },
      { name: 'note', label: 'How', widget: 'select', options: { fixed: [{ value: 'quick', label: 'Quick' }, { value: 'careful', label: 'Careful' }] } },
    ],
  },
  steps: [
    { id: 'mrs', type: 'action', module: 'gitlab@1.0.0', action: 'list_merge_requests', input: { project: '{{ inputs.project }}' } },
    {
      id: 'pick',
      type: 'input',
      title: 'Choose what to merge',
      fields: [
        { name: 'iids', label: 'Merge requests', widget: 'multiselect', required: true, options: { fromStep: '{{ steps.mrs.output.mergeRequests }}', value: 'iid', label: 'title' } },
        { name: 'reason', label: 'Why', widget: 'textarea' },
      ],
    },
    { id: 'merge', type: 'action', module: 'gitlab@1.0.0', action: 'merge_merge_request', input: { project: '{{ inputs.project }}', iid: '{{ item }}' }, forEach: '{{ steps.pick.output.iids }}' },
  ],
};

beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

async function approved(def: object = definition) {
  const v = await w.app.flows.create(`Pick and merge ${Math.random()}`, def, w.alice);
  return w.app.flows.decide(v.id, w.approver, 'approved');
}

describe('Flow forms are checked and shown to the approver', () => {
  it('rejects forms that cannot work', async () => {
    const bad = async (patch: (d: typeof definition) => void) => {
      const d = structuredClone(definition);
      patch(d);
      return w.app.flows.create('bad', d, w.alice).then(
        () => null,
        (e: { code: string; message: string }) => e.message,
      );
    };
    expect(await bad((d) => delete (d.form.fields[2] as { options?: unknown }).options)).toMatch(/a select needs options/);
    expect(await bad((d) => (d.form.fields[0]!.name = 'nope'))).toMatch(/not a Flow input/);
    expect(await bad((d) => ((d.form.fields[1]!.options as { action: string }).action = 'merge_merge_request'))).toMatch(/can only come from an action that reads data/);
    expect(await bad((d) => ((d.form.fields[1] as { options: unknown }).options = { fromStep: '{{ steps.mrs.output.mergeRequests }}' }))).toMatch(/cannot use step outputs/);
    expect(await bad((d) => ((d.steps[1] as { fields: { options?: { fromStep?: string } }[] }).fields[0]!.options!.fromStep = '{{ steps.merge.output }}'))).toMatch(/does not run before it/);
  });

  it('the approver reads what the form and the input step ask, and where choices come from', async () => {
    const v = await w.app.flows.create('Summary check', definition, w.alice);
    const review = await w.app.flows.review(v.id);
    expect(review.summary).toContain('Merge request to look at first (select, choices loaded from GitLab "List merge requests" (reads data with the person\'s own gitlab access))');
    expect(review.summary).toContain('pauses and asks the person running it for: Merge requests (multiselect, choices from steps.mrs.output.mergeRequests); Why (textarea)');
  });
});

describe('the run form', () => {
  it('loads choices live with the member\'s own credential, once the fields it depends on are filled in', async () => {
    const v = await approved();
    const missing = await api.inject({ method: 'POST', url: `/api/flow-versions/${v.id}/choices`, headers: auth(w.tokens.alice), payload: { field: 'focus', values: {} } });
    expect(missing.json()).toMatchObject({ error: 'lookup_needs_input' });
    w.fake.calls.length = 0;
    const res = await api.inject({ method: 'POST', url: `/api/flow-versions/${v.id}/choices`, headers: auth(w.tokens.alice), payload: { field: 'focus', values: { project: 'acme/app' } } });
    expect(res.json()).toEqual({ choices: [{ value: 7, label: 'Add export' }, { value: 8, label: 'Fix login' }] });
    expect(w.fake.calls.map((c) => c.auth)).toEqual(['glpat-alice']);
    // Bob has no GitLab credential.
    const bob = await api.inject({ method: 'POST', url: `/api/flow-versions/${v.id}/choices`, headers: auth(w.tokens.bob), payload: { field: 'focus', values: { project: 'acme/app' } } });
    expect(bob.json()).toMatchObject({ error: 'missing_credential' });
  });

  it('the list of runnable Flows says who is ready', async () => {
    const v = await approved();
    const alice = (await api.inject({ method: 'GET', url: '/api/runnable', headers: auth(w.tokens.alice) })).json();
    expect(alice.find((r: { versionId: string }) => r.versionId === v.id)).toMatchObject({ ready: true, missing: [], asksDuringRun: true, inputs: 3 });
    const bob = (await api.inject({ method: 'GET', url: '/api/runnable', headers: auth(w.tokens.bob) })).json();
    expect(bob.find((r: { versionId: string }) => r.versionId === v.id)).toMatchObject({ ready: false, missing: [{ service: 'gitlab' }] });
  });
});

describe('input steps', () => {
  it('pause the run until its member picks from what an earlier step found; only those are used', async () => {
    const v = await approved();
    const runId = await w.app.engine.startRun(v.id, w.alice.id, { project: 'acme/app' });
    await w.app.worker.drain();
    const run = await runStatus(w, runId, w.alice);
    expect(run).toMatchObject({ status: 'waiting', waitReason: 'input_needed' });
    const pick = run.steps.find((s) => s.id === 'pick')!;
    expect(pick.input!.fields[0]).toMatchObject({ name: 'iids', widget: 'multiselect', required: true, choices: [{ value: 7, label: 'Add export' }, { value: 8, label: 'Fix login' }] });
    // Only the run's member sees the form and is asked.
    expect((await runStatus(w, runId, w.approver)).steps.find((s) => s.id === 'pick')!.input).toBeUndefined();
    expect((await approvalQueue(w.db, w.alice, 'shared')).some((a) => a.kind === 'input' && a.runId === runId)).toBe(true);

    const submit = (token: string, values: object) => api.inject({ method: 'POST', url: `/api/runs/${runId}/steps/pick/input`, headers: auth(token), payload: { values } });
    expect((await submit(w.tokens.bob, { iids: [7] })).json()).toMatchObject({ error: 'not_your_run' });
    expect((await submit(w.tokens.alice, { iids: [99] })).json()).toMatchObject({ error: 'invalid_answers', detail: 'iids: has a value that is not one of the choices' });
    expect((await submit(w.tokens.alice, {})).json()).toMatchObject({ detail: 'iids: is required' });
    expect((await submit(w.tokens.alice, { iids: [7], reason: 'ready', extra: 1 })).json()).toMatchObject({ detail: 'extra: is not a field of this form' });

    expect((await submit(w.tokens.alice, { iids: [7], reason: 'ready' })).statusCode).toBe(202);
    await w.app.worker.drain();
    const done = await runStatus(w, runId, w.alice);
    expect(done.status).toBe('succeeded');
    expect(done.steps.find((s) => s.id === 'pick')!.output).toEqual({ iids: [7], reason: 'ready' });
    expect(w.fake.merged).toEqual([7]);
    // Answered once: a second answer is refused.
    expect((await submit(w.tokens.alice, { iids: [8] })).json()).toMatchObject({ error: 'not_waiting_for_input' });
  });
});

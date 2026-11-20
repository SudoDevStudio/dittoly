import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { putTeamCredential, setCredentialMode } from '../src/core/team-credentials.js';
import { defaultTeamFor } from '../src/core/teams.js';
import { createExport } from '../src/export/service.js';
import { approveExampleModules, giveAllCredentials, makeWorld, type World } from './helpers.js';

/**
 * Apps opened inside Dittoly: shared by the team, approved per version, run on the team's shared keys, and served
 * through the same API an exported app has.
 */
let w: World;
let api: ReturnType<typeof buildServer>;
let teamId: string;
let flowId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  api.inject({ method, url: `/api${url}`, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });

const notify = {
  inputs: { type: 'object', properties: { text: { type: 'string', description: 'What to post', examples: ['Deploy done'] } }, required: ['text'] },
  steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-ops', text: '{{ inputs.text }}' } }],
};

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  // Alice has her own Slack key; the app must not use it.
  await giveAllCredentials(w, w.alice);
  const v = await w.app.flows.create('Notify ops', notify, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  flowId = v.flowId;
  teamId = await defaultTeamFor(w.db, w.alice.id);
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('apps inside Dittoly', () => {
  let appId: string;
  let versionId: string;
  let runId: string;

  it('drafts the default layout from the Flows, then saves a pending first version', async () => {
    const layout = await call(w.tokens.alice, 'POST', '/apps/layout', { name: 'Ops desk', flows: [{ flowId }] });
    expect(layout.statusCode).toBe(200);
    const { plan, ai, flows } = layout.json();
    expect(ai).toBe(false);
    expect(flows).toEqual([{ key: 'notify-ops', name: 'Notify ops' }]);
    expect(plan.pages[0]).toMatchObject({ kind: 'form', flow: 'notify-ops' });

    // A plan that names a Flow the app does not have is refused.
    const bad = await call(w.tokens.alice, 'POST', '/apps', { name: 'Ops desk', spec: { flows: [{ flowId }], plan: { ...plan, pages: [{ ...plan.pages[0], flow: 'nope' }] } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_plan');

    const created = await call(w.tokens.alice, 'POST', '/apps', { name: 'Ops desk', spec: { flows: [{ flowId }], plan } });
    expect(created.statusCode).toBe(201);
    ({ appId, versionId } = created.json());
    const list = (await call(w.tokens.bob, 'GET', '/apps')).json();
    expect(list).toEqual([expect.objectContaining({ id: appId, name: 'Ops desk', liveVersion: null, latest: expect.objectContaining({ version: 1, status: 'pending' }) })]);
  });

  it('is previewed by its author and approvers only, and opened by the team once approved', async () => {
    expect((await call(w.tokens.bob, 'GET', `/apps/${appId}/v/live/api/app`)).json().error).toBe('app_not_approved');
    expect((await call(w.tokens.bob, 'GET', `/apps/${appId}/v/${versionId}/api/app`)).statusCode).toBe(403);
    const preview = (await call(w.tokens.alice, 'GET', `/apps/${appId}/v/${versionId}/api/app`)).json();
    expect(preview).toMatchObject({ name: 'Ops desk', preview: true, version: 1, flows: [expect.objectContaining({ key: 'notify-ops' })] });
    // The Flow uses each person's own Slack key: the shared app says what the team must set up.
    expect(preview.problems.join(' ')).toMatch(/Slack token.*switch it to the team/);

    // Approvers decide, and nobody approves their own app on a shared server.
    expect((await call(w.tokens.alice, 'POST', `/app-versions/${versionId}/decision`, { decision: 'approved' })).json().error).toBe('approver_only');
    const plan = (await call(w.tokens.alice, 'GET', `/apps/${appId}`)).json().versions[0].spec.plan;
    const own = (await call(w.tokens.approver, 'POST', '/apps', { name: 'Approver desk', spec: { flows: [{ flowId }], plan } })).json();
    expect((await call(w.tokens.approver, 'POST', `/app-versions/${own.versionId}/decision`, { decision: 'approved' })).json().error).toBe('cannot_approve_own_app');
    expect((await call(w.tokens.approver, 'DELETE', `/apps/${own.appId}`)).statusCode).toBe(204);
    expect((await call(w.tokens.approver, 'POST', `/app-versions/${versionId}/decision`, { decision: 'approved' })).statusCode).toBe(204);
    expect((await call(w.tokens.bob, 'GET', `/apps/${appId}/v/live/api/app`)).json()).toMatchObject({ preview: false, plan: expect.any(Object) });
  });

  it('runs only on the team’s shared keys, never on the member’s own', async () => {
    const refused = await call(w.tokens.alice, 'POST', `/apps/${appId}/v/live/api/flows/notify-ops/runs?wait=5`, { inputs: { text: 'hi' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('app_needs_team_credentials');

    await setCredentialMode(w.db, w.admin, teamId, 'slack', 'slack', 'team');
    expect((await call(w.tokens.alice, 'POST', `/apps/${appId}/v/live/api/flows/notify-ops/runs?wait=5`, { inputs: { text: 'hi' } })).json().detail).toMatch(/no team admin has stored/);
    await putTeamCredential(w.db, w.app.cipher, w.admin, teamId, 'slack', 'xoxb-team');

    const started = await call(w.tokens.alice, 'POST', `/apps/${appId}/v/live/api/flows/notify-ops/runs`, { inputs: { text: 'hi' } });
    expect(started.statusCode).toBe(201);
    runId = started.json().runId;
    expect(started.json().run).toMatchObject({ id: runId, flow: 'notify-ops', mine: true });
    await w.app.worker.drain();
    const run = (await call(w.tokens.alice, 'GET', `/apps/${appId}/v/live/api/runs/${runId}`)).json();
    expect(run).toMatchObject({ id: runId, flow: 'notify-ops', status: 'succeeded' });
    expect(run.result).toBeTruthy();
    // The team's key went out, not Alice's own.
    expect(w.fake.messages.at(-1)).toMatchObject({ text: 'hi', auth: 'Bearer xoxb-team' });
  });

  it('is shared: a teammate sees the app’s runs and results, and nothing outside the app', async () => {
    const runs = (await call(w.tokens.bob, 'GET', `/apps/${appId}/v/live/api/runs`)).json().runs;
    expect(runs).toEqual([expect.objectContaining({ id: runId, flow: 'notify-ops', status: 'succeeded', startedBy: 'alice' })]);
    expect((await call(w.tokens.bob, 'GET', `/apps/${appId}/v/live/api/runs/${runId}`)).json()).toMatchObject({ id: runId, mine: false, result: expect.anything() });

    // A run started elsewhere is not reachable through the app.
    const other = await w.app.engine.startRun((await w.app.flows.versions(flowId)).at(-1)!.id, w.alice.id, { text: 'x' });
    expect((await call(w.tokens.alice, 'GET', `/apps/${appId}/v/live/api/runs/${other}`)).statusCode).toBe(404);
  });

  it('a change is a new pending version; the approved one stays live until it is approved', async () => {
    const live = (await call(w.tokens.alice, 'GET', `/apps/${appId}`)).json();
    const plan = live.versions[0].spec.plan;
    const next = await call(w.tokens.alice, 'POST', `/apps/${appId}/versions`, { name: 'Ops desk', spec: { flows: [{ flowId }], plan: { ...plan, layout: { nav: 'sidebar-left', width: 'wide' } } } });
    expect(next.statusCode).toBe(201);
    expect(next.json().version).toBe(2);
    expect((await call(w.tokens.bob, 'GET', `/apps/${appId}/v/live/api/app`)).json()).toMatchObject({ version: 1 });
    // Only its author or an admin changes it.
    expect((await call(w.tokens.bob, 'POST', `/apps/${appId}/versions`, { spec: { flows: [{ flowId }], plan } })).statusCode).toBe(403);
    await call(w.tokens.approver, 'POST', `/app-versions/${next.json().versionId}/decision`, { decision: 'approved' });
    expect((await call(w.tokens.bob, 'GET', `/apps/${appId}/v/live/api/app`)).json()).toMatchObject({ version: 2, plan: { layout: { nav: 'sidebar-left' } } });
    expect((await call(w.tokens.alice, 'GET', `/apps/${appId}`)).json().versions.map((v: { status: string }) => v.status)).toEqual(['approved', 'superseded']);
  });

  it('serves its page shell and the export’s renderer', async () => {
    const page = await api.inject({ method: 'GET', url: `/a/${appId}/notify-ops` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain(`data-api="/api/apps/${appId}/v/live"`);
    expect(page.body).toContain(`data-base="/a/${appId}"`);
    const render = await api.inject({ method: 'GET', url: '/app-ui/render.js' });
    expect(render.headers['content-type']).toMatch(/javascript/);
    expect(render.body).toContain('basePath');
    expect((await api.inject({ method: 'GET', url: '/a/not-a-uuid' })).statusCode).toBe(400);
  });

  it('refuses a Flow that hands a step to a teammate, and checks a Super Flow’s Flows too', async () => {
    const handed = await w.app.flows.create('Handed over', { ...notify, steps: [{ ...notify.steps[0], delegateTo: w.bob.id }] }, w.alice);
    await w.app.flows.decide(handed.id, w.approver, 'approved');
    const { teamCredentialGaps, appFlows } = await import('../src/team-apps/service.js');
    const flows = (await appFlows(w.app, teamId, [{ flowId: handed.flowId }])).flows;
    expect(await teamCredentialGaps(w.app, teamId, flows)).toEqual([expect.objectContaining({ label: 'step post', problem: 'delegated' })]);

    const parent = await w.app.flows.create('Train', { inputs: notify.inputs, steps: [{ id: 'go', type: 'flow', runs: [{ id: 'a', flow: handed.flowId, version: 1, input: { text: '{{ inputs.text }}' } }] }] }, w.alice);
    await w.app.flows.decide(parent.id, w.approver, 'approved');
    const parentFlows = (await appFlows(w.app, teamId, [{ flowId: parent.flowId }])).flows;
    expect(await teamCredentialGaps(w.app, teamId, parentFlows)).toEqual([expect.objectContaining({ flow: 'Train → Handed over', problem: 'delegated' })]);
  });

  it('exports with the layout and brand the team used', async () => {
    const live = (await call(w.tokens.alice, 'GET', `/apps/${appId}`)).json().versions.find((v: { status: string }) => v.status === 'approved');
    const brand = { name: 'Ops desk', primary: '#0f766e', font: 'serif', radius: 'large' };
    const out = await createExport(w.app, w.admin, { name: 'Ops desk', kind: 'ui', flows: live.spec.flows.map((f: { flowId: string }) => ({ ...f, access: 'token' })), plan: live.spec.plan, brand });
    expect(out.bundle.uiPlan).toEqual(live.spec.plan);
    expect(out.bundle.theme?.font).toMatch(/serif/i);
    // Without a layout the built-in UI still gets a page per Flow.
    expect((await createExport(w.app, w.admin, { name: 'Plain', kind: 'ui', flows: [{ flowId, access: 'token' }] })).bundle.uiPlan).toBeNull();
  });

  it('deleting archives it: it no longer opens', async () => {
    expect((await call(w.tokens.bob, 'DELETE', `/apps/${appId}`)).statusCode).toBe(403);
    expect((await call(w.tokens.alice, 'DELETE', `/apps/${appId}`)).statusCode).toBe(204);
    expect((await call(w.tokens.bob, 'GET', `/apps/${appId}/v/live/api/app`)).statusCode).toBe(404);
    expect((await call(w.tokens.bob, 'GET', '/apps')).json()).toEqual([]);
  });
});

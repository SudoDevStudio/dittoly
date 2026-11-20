import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, giveAllCredentials, makeWorld, releaseFlow, releaseInputs, type World } from './helpers.js';

/** Flows belong to teams: members see and run their teams' Flows; team admins manage their team. */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let payments: string;

beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  await giveAllCredentials(w, w.bob);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('teams', () => {
  it('everyone starts in the default team; org admins administer it', async () => {
    const teams = (await api.inject({ method: 'GET', url: '/api/teams', headers: auth(w.tokens.bob) })).json();
    expect(teams).toEqual([expect.objectContaining({ name: 'Default', isDefault: true, myRole: 'member', members: 4 })]);
    expect((await api.inject({ method: 'GET', url: '/api/teams', headers: auth(w.tokens.admin) })).json()[0]).toMatchObject({ myRole: 'admin' });
  });

  it('only org admins create teams; the creator administers it; team admins manage members', async () => {
    expect((await api.inject({ method: 'POST', url: '/api/teams', headers: auth(w.tokens.alice), payload: { name: 'Payments' } })).json()).toEqual({ error: 'admin_only' });
    const created = await api.inject({ method: 'POST', url: '/api/teams', headers: auth(w.tokens.admin), payload: { name: 'Payments' } });
    expect(created.statusCode).toBe(201);
    payments = created.json().id;
    expect((await api.inject({ method: 'POST', url: '/api/teams', headers: auth(w.tokens.admin), payload: { name: 'Payments' } })).json()).toEqual({ error: 'team_name_taken' });

    const put = (token: string, member: string, role: string) => api.inject({ method: 'PUT', url: `/api/teams/${payments}/members/${member}`, headers: auth(token), payload: { role } });
    expect((await put(w.tokens.alice, w.alice.id, 'admin')).json()).toEqual({ error: 'team_admin_only' });
    expect((await put(w.tokens.admin, w.alice.id, 'admin')).statusCode).toBe(204);
    // Alice, now a team admin, adds a colleague; she cannot leave the team without an admin.
    expect((await put(w.tokens.alice, w.approver.id, 'member')).statusCode).toBe(204);
    expect((await api.inject({ method: 'DELETE', url: `/api/teams/${payments}/members/${w.admin.id}`, headers: auth(w.tokens.alice) })).statusCode).toBe(204);
    expect((await put(w.tokens.alice, w.alice.id, 'member')).json()).toEqual({ error: 'last_team_admin' });
    const members = (await api.inject({ method: 'GET', url: `/api/teams/${payments}/members`, headers: auth(w.tokens.alice) })).json();
    expect(members.map((m: { handle: string; role: string }) => [m.handle, m.role])).toEqual([['alice', 'admin'], ['approver', 'member']]);
    expect((await api.inject({ method: 'GET', url: `/api/teams/${payments}/members`, headers: auth(w.tokens.bob) })).json()).toEqual({ error: 'not_in_team' });
  });

  it("a team's Flows are seen and run by its members only; approvers review every team's", async () => {
    const f = await releaseFlow();
    expect((await api.inject({ method: 'POST', url: '/api/flows', headers: auth(w.tokens.bob), payload: { name: 'x', definition: f.definition, teamId: payments } })).json()).toEqual({ error: 'not_in_team' });
    const created = await api.inject({ method: 'POST', url: '/api/flows', headers: auth(w.tokens.alice), payload: { name: 'Payments release', definition: f.definition, teamId: payments } });
    expect(created.statusCode).toBe(201);
    const v = created.json();
    await w.app.flows.decide(v.id, w.approver, 'approved');

    const names = async (token: string) => (await api.inject({ method: 'GET', url: '/api/flows', headers: auth(token) })).json().map((x: { name: string }) => x.name);
    expect(await names(w.tokens.alice)).toContain('Payments release');
    expect(await names(w.tokens.bob)).not.toContain('Payments release');
    expect(await names(w.tokens.approver)).toContain('Payments release');
    expect((await api.inject({ method: 'GET', url: `/api/flows/${v.flowId}/versions`, headers: auth(w.tokens.bob) })).json()).toEqual({ error: 'not_in_team' });
    expect((await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.bob) })).statusCode).toBe(403);

    const run = (token: string) => api.inject({ method: 'POST', url: `/api/flow-versions/${v.id}/runs`, headers: auth(token), payload: { inputs: releaseInputs } });
    expect((await run(w.tokens.bob)).json()).toEqual({ error: 'not_in_team' });
    expect((await run(w.tokens.alice)).statusCode).toBe(202);
    expect((await api.inject({ method: 'POST', url: '/api/schedules', headers: auth(w.tokens.bob), payload: { flowVersionId: v.id, cron: '0 9 * * *', inputs: releaseInputs } })).json()).toEqual({
      error: 'not_in_team',
    });
    const runnable = async (token: string) => (await api.inject({ method: 'GET', url: '/api/runnable', headers: auth(token) })).json().map((r: { name: string }) => r.name);
    expect(await runnable(w.tokens.alice)).toContain('Payments release');
    expect(await runnable(w.tokens.bob)).not.toContain('Payments release');
    // Filter by team.
    expect((await api.inject({ method: 'GET', url: `/api/flows?team=${payments}`, headers: auth(w.tokens.alice) })).json().every((x: { team: { id: string } }) => x.team.id === payments)).toBe(true);
  });
});

describe('module settings belong to the Flow', () => {
  it('two Flows carry two different Jira sites; a host outside the reviewed pattern is refused', async () => {
    const f = await releaseFlow();
    const base = f.definition as { moduleSettings?: Record<string, Record<string, string>> };
    const withSite = (site: string) => ({ ...f.definition, moduleSettings: { ...base.moduleSettings, jira: { site } } });

    // The module's reviewed pattern still rules: a Flow cannot be saved with a site it does not allow.
    const refused = await api.inject({
      method: 'POST',
      url: '/api/flows',
      headers: auth(w.tokens.alice),
      payload: { name: 'Evil release', definition: withSite('payments.evil.example'), teamId: payments },
    });
    expect(refused.json()).toMatchObject({ error: 'invalid_flow' });

    const inTeam = await w.app.flows.create('Payments release 2', withSite('payments.atlassian.net'), w.alice, undefined, payments);
    await w.app.flows.decide(inTeam.id, w.approver, 'approved');
    const inDefault = await w.app.flows.create('Default release', withSite('example.atlassian.net'), w.alice);
    await w.app.flows.decide(inDefault.id, w.approver, 'approved');
    // Earlier tests left runs queued; drain them so what follows counts only its own calls.
    await w.app.worker.drain();
    const jiraHosts = async (versionId: string) => {
      w.fake.calls.length = 0;
      await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
      await w.app.worker.drain();
      return [...new Set(w.fake.calls.filter((c) => c.url.includes('atlassian')).map((c) => new URL(c.url).host))];
    };
    expect(await jiraHosts(inTeam.id)).toEqual(['payments.atlassian.net']);
    expect(await jiraHosts(inDefault.id)).toEqual(['example.atlassian.net']);
    // The approver reads the site this Flow gives the module.
    expect((await w.app.flows.review(inTeam.id)).summary).toContain('Hosts: payments.atlassian.net');
    expect((await w.app.flows.review(inTeam.id)).summary).toContain('Told: Your Jira Cloud site: payments.atlassian.net');
  });
});

describe('team credentials', () => {
  it('a credential marked "team" uses the shared account for every member of the team; others stay personal', async () => {
    const crew = (await api.inject({ method: 'POST', url: '/api/teams', headers: auth(w.tokens.admin), payload: { name: 'Release crew' } })).json().id as string;
    for (const m of [w.alice, w.approver]) await api.inject({ method: 'PUT', url: `/api/teams/${crew}/members/${m.id}`, headers: auth(w.tokens.admin), payload: { role: 'member' } });
    // The approver has no personal credentials at all.
    const mode = (token: string, body: object) => api.inject({ method: 'PUT', url: `/api/teams/${crew}/credential-modes`, headers: auth(token), payload: body });
    expect((await mode(w.tokens.alice, { module: 'gitlab', service: 'gitlab', mode: 'team' })).json()).toEqual({ error: 'team_admin_only' });
    for (const service of ['gitlab', 'jira', 'slack']) expect((await mode(w.tokens.admin, { module: service, service, mode: 'team' })).statusCode).toBe(204);

    const f = await releaseFlow();
    const v = await w.app.flows.create('Crew release', f.definition, w.alice, undefined, crew);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    // No shared secrets stored yet: the step stops, and the run list says the team must set them up.
    const first = await w.app.engine.startRun(v.id, w.approver.id, releaseInputs);
    await w.app.worker.drain();
    expect((await w.app.engine.runView(first, w.approver)).steps[0]).toMatchObject({ status: 'failed', errorType: 'team_credential_missing' });
    const listed = (await api.inject({ method: 'GET', url: `/api/runnable?team=${crew}`, headers: auth(w.tokens.approver) })).json()[0];
    expect(listed).toMatchObject({ ready: false, missing: [], teamMissing: expect.arrayContaining([expect.objectContaining({ service: 'gitlab' })]) });

    const store = (service: string, secret: string) => api.inject({ method: 'PUT', url: `/api/teams/${crew}/credentials/${service}`, headers: auth(w.tokens.admin), payload: { secret } });
    expect((await store('gitlab', 'glpat-crew')).statusCode).toBe(204);
    expect((await store('jira', 'crew@acme.test:jira-crew')).statusCode).toBe(204);
    expect((await store('slack', 'xoxb-crew')).statusCode).toBe(204);
    const raw = JSON.stringify((await w.db.query(`SELECT * FROM team_credentials WHERE team_id = $1`, [crew])).rows);
    expect(raw).not.toContain('glpat-crew');
    const listing = (await api.inject({ method: 'GET', url: `/api/teams/${crew}/credentials`, headers: auth(w.tokens.alice) })).json();
    expect(JSON.stringify(listing)).not.toContain('glpat-crew');
    expect(listing.find((c: { module: string }) => c.module === 'gitlab')).toMatchObject({ mode: 'team', teamStored: true });

    // The approver, who has no credentials of their own, runs it with the team's access.
    w.fake.calls.length = 0;
    const runId = await w.app.engine.startRun(v.id, w.approver.id, releaseInputs);
    await w.app.worker.drain();
    expect((await w.app.engine.runView(runId, w.approver)).steps[0]).toMatchObject({ status: 'succeeded' });
    expect(w.fake.calls.find((c) => c.url.includes('gitlab'))!.auth).toBe('glpat-crew');
    const used = await w.db.query(`SELECT actor_id, related_id FROM audit_events WHERE action = 'credential.team_used' AND subject_id LIKE $1`, [`${runId}:%`]);
    expect(used.rows[0]).toEqual({ actor_id: w.approver.id, related_id: crew });

    // The same modules in another team still use each member's own account.
    w.fake.calls.length = 0;
    const own = await w.app.flows.create('Own release', f.definition, w.alice);
    await w.app.flows.decide(own.id, w.approver, 'approved');
    await w.app.engine.startRun(own.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    expect(w.fake.calls.find((c) => c.url.includes('gitlab'))!.auth).toBe('glpat-alice');
  });
});

describe('team notification channels', () => {
  it("notifications about a team's runs go through its channels, as module actions with the team's credentials", async () => {
    const ops = (await api.inject({ method: 'POST', url: '/api/teams', headers: auth(w.tokens.admin), payload: { name: 'Ops' } })).json().id as string;
    await api.inject({ method: 'PUT', url: `/api/teams/${ops}/members/${w.alice.id}`, headers: auth(w.tokens.admin), payload: { role: 'member' } });
    const add = (body: object) => api.inject({ method: 'POST', url: `/api/teams/${ops}/channels`, headers: auth(w.tokens.admin), payload: body });
    const slack = { name: 'Ops channel', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-ops', text: '{{ message.text }} {{ message.url }} (for {{ member.name }})' } };
    // Slack is still personal in this team: refused, a channel never acts as a person.
    expect((await add(slack)).json()).toMatchObject({ error: 'channel_needs_team_credentials' });
    await api.inject({ method: 'PUT', url: `/api/teams/${ops}/credential-modes`, headers: auth(w.tokens.admin), payload: { module: 'slack', service: 'slack', mode: 'team' } });
    expect((await add(slack)).json()).toMatchObject({ error: 'channel_needs_team_credentials', detail: expect.stringContaining('store') });
    await api.inject({ method: 'PUT', url: `/api/teams/${ops}/credentials/slack`, headers: auth(w.tokens.admin), payload: { secret: 'xoxb-ops' } });
    expect((await add({ ...slack, input: { channel: 'C-ops', text: '{{ steps.x.output }}' } })).json()).toMatchObject({ error: 'invalid_channel', detail: expect.stringContaining('unknown variables') });
    expect((await add({ ...slack, input: { text: 'hi' } })).json()).toMatchObject({ error: 'invalid_channel', detail: expect.stringContaining('channel: is required') });
    expect((await api.inject({ method: 'POST', url: `/api/teams/${ops}/channels`, headers: auth(w.tokens.alice), payload: slack })).json()).toEqual({ error: 'team_admin_only' });
    const created = await add(slack);
    expect(created.statusCode).toBe(201);
    const channelId = created.json().id;

    w.fake.messages.length = 0;
    expect((await api.inject({ method: 'POST', url: `/api/teams/${ops}/channels/${channelId}/test`, headers: auth(w.tokens.admin) })).statusCode).toBe(204);
    expect(w.fake.messages.at(-1)).toMatchObject({ channel: 'C-ops', auth: 'Bearer xoxb-ops', text: expect.stringContaining('this channel works') });

    // A run in the team that waits for an approver: the approvers are told through the team's channel.
    const v = await w.app.flows.create('Ops gate', { steps: [{ id: 'gate', type: 'approval' }] }, w.alice, undefined, ops);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    w.fake.messages.length = 0;
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    const posts = w.fake.messages.filter((m) => m.channel === 'C-ops');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((m) => m.auth === 'Bearer xoxb-ops' && m.text.includes(`/runs/${runId}`) && m.text.startsWith('A step is waiting for your approval.'))).toBe(true);
    expect(posts.map((m) => m.text)).toEqual(expect.arrayContaining([expect.stringContaining('(for ')]));
    // Retrying delivery does not post again.
    await w.app.worker.drain();
    expect(w.fake.messages.filter((m) => m.channel === 'C-ops')).toHaveLength(posts.length);
  });
});

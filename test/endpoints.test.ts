import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, type World } from './helpers.js';

/** Super Flow URLs: other systems start runs with an x-sflow-token and poll for the result. */
let w: World;
let api: ReturnType<typeof buildServer>;
let flowId: string;
let releaseVersionId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const notify = {
  inputs: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] },
  steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-ops', text: '{{ inputs.text }}' } }],
};

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  const v = await w.app.flows.create('Notify ops', notify, w.alice);
  await w.app.flows.decide(v.id, w.approver, 'approved');
  flowId = v.flowId;
  releaseVersionId = (await approvedReleaseFlow(w)).id;
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const create = (body: Record<string, unknown>, token = w.tokens.alice, id = flowId) =>
  api.inject({ method: 'POST', url: `/api/flows/${id}/endpoints`, headers: auth(token), payload: body });
const call = (id: string, token: string | undefined, payload?: unknown) =>
  api.inject({ method: 'POST', url: `/sflow/${id}`, headers: token ? { 'x-sflow-token': token } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('Super Flow URLs', () => {
  it('starts a run as the creator with the token, and the caller polls the run with the same token', async () => {
    const res = await create({ name: 'CI pipeline', followLatest: true });
    expect(res.statusCode).toBe(201);
    const ep = res.json();
    expect(ep).toMatchObject({ name: 'CI pipeline', runAs: 'alice', followsLatest: true, enabled: true, url: `http://127.0.0.1:8080/sflow/${ep.id}` });
    expect(ep.token).toMatch(/^sflow_[A-Za-z0-9_-]{43}$/);
    // Only a hash is stored.
    const stored = (await w.db.query<{ token_hash: string }>(`SELECT token_hash FROM flow_endpoints WHERE id = $1`, [ep.id])).rows[0]!;
    expect(stored.token_hash).not.toContain(ep.token);
    // Listing never shows the token again.
    expect((await api.inject({ method: 'GET', url: `/api/flows/${flowId}/endpoints`, headers: auth(w.tokens.alice) })).json()[0]).not.toHaveProperty('token');

    w.fake.messages.length = 0;
    const started = await call(ep.id, ep.token, { text: 'Deploy finished' });
    expect(started.statusCode).toBe(202);
    const { runId, statusUrl } = started.json();
    expect(statusUrl).toBe(`http://127.0.0.1:8080/sflow/${ep.id}/runs/${runId}`);
    await w.app.worker.drain();
    expect(w.fake.messages).toEqual([expect.objectContaining({ channel: 'C-ops', text: 'Deploy finished', auth: 'Bearer xoxb-alice' })]);

    const status = await api.inject({ method: 'GET', url: `/sflow/${ep.id}/runs/${runId}`, headers: { 'x-sflow-token': ep.token } });
    expect(status.json()).toMatchObject({ runId, flow: 'Notify ops', status: 'succeeded', steps: [{ id: 'post', status: 'succeeded', output: { ts: '1700000000.000100' } }] });
    // The run is alice's, and the audit log says which URL started it.
    expect((await w.app.engine.runView(runId, w.alice)).runAs).toBe(w.alice.id);
    const started_ = await w.db.query(`SELECT related_id FROM audit_events WHERE action = 'run.started' AND subject_id = $1`, [runId]);
    expect(started_.rows[0]).toMatchObject({ related_id: ep.id });
  });

  it('refuses a missing or wrong token the same way as an unknown URL, and checks inputs', async () => {
    const ep = (await create({ name: 'Wrong tokens', followLatest: true })).json();
    for (const [id, token] of [[ep.id, undefined], [ep.id, 'sflow_wrong'], ['00000000-0000-0000-0000-000000000000', ep.token], ['not-a-uuid', ep.token]] as const) {
      const r = await call(id, token, { text: 'x' });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'invalid_token' });
    }
    const bad = await call(ep.id, ep.token, { text: '' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_inputs' });
    expect((await call(ep.id, ep.token, [1, 2])).json()).toMatchObject({ error: 'invalid_inputs' });
    // Another URL's token cannot read this URL's runs.
    const other = (await create({ name: 'Other', followLatest: true })).json();
    const runId = (await call(ep.id, ep.token, { text: 'mine' })).json().runId;
    expect((await api.inject({ method: 'GET', url: `/sflow/${other.id}/runs/${runId}`, headers: { 'x-sflow-token': other.token } })).statusCode).toBe(404);
    await w.app.worker.drain();
  });

  it('rotates with an optional overlap, disables, expires and deletes', async () => {
    const ep = (await create({ name: 'Rotating', followLatest: true })).json();
    const rotated = (await api.inject({ method: 'POST', url: `/api/endpoints/${ep.id}/rotate`, headers: auth(w.tokens.alice), payload: { overlapSeconds: 3600 } })).json();
    expect(rotated.token).not.toBe(ep.token);
    expect(rotated.previousTokenValidUntil).toBeTruthy();
    expect((await call(ep.id, ep.token, { text: 'old still works' })).statusCode).toBe(202);
    expect((await call(ep.id, rotated.token, { text: 'new works' })).statusCode).toBe(202);
    const again = (await api.inject({ method: 'POST', url: `/api/endpoints/${ep.id}/rotate`, headers: auth(w.tokens.alice), payload: {} })).json();
    expect((await call(ep.id, rotated.token, { text: 'revoked' })).statusCode).toBe(401);

    await api.inject({ method: 'PATCH', url: `/api/endpoints/${ep.id}`, headers: auth(w.tokens.alice), payload: { enabled: false } });
    expect((await call(ep.id, again.token, { text: 'x' })).json()).toEqual({ error: 'endpoint_disabled' });
    await api.inject({ method: 'PATCH', url: `/api/endpoints/${ep.id}`, headers: auth(w.tokens.alice), payload: { enabled: true } });
    await w.db.query(`UPDATE flow_endpoints SET expires_at = now() - interval '1 minute' WHERE id = $1`, [ep.id]);
    expect((await call(ep.id, again.token, { text: 'x' })).statusCode).toBe(410);
    expect((await create({ name: 'Past', followLatest: true, expiresAt: '2000-01-01T00:00:00Z' })).json()).toMatchObject({ error: 'expiry_in_the_past' });

    // Only its creator (or an admin) manages a URL; to anyone else it does not exist.
    expect((await api.inject({ method: 'DELETE', url: `/api/endpoints/${ep.id}`, headers: auth(w.tokens.bob) })).statusCode).toBe(404);
    expect((await api.inject({ method: 'DELETE', url: `/api/endpoints/${ep.id}`, headers: auth(w.tokens.alice) })).statusCode).toBe(204);
    expect((await call(ep.id, again.token, { text: 'x' })).statusCode).toBe(401);
    await w.app.worker.drain();
  });

  it('a pinned URL stops when its version is replaced; a following URL runs the new approved version', async () => {
    const pinned = (await create({ name: 'Pinned', versionId: (await w.app.flows.versions(flowId)).at(-1)!.id })).json();
    const following = (await create({ name: 'Latest', followLatest: true })).json();
    expect(pinned).toMatchObject({ followsLatest: false, version: 1, versionStatus: 'approved' });
    const v2 = await w.app.flows.update(flowId, { ...notify, steps: [{ ...notify.steps[0], input: { channel: 'C-ops-2', text: '{{ inputs.text }}' } }] }, w.alice);
    // While version 2 waits for approval, nothing is approved: both URLs say so.
    expect((await call(following.id, following.token, { text: 'x' })).json()).toEqual({ error: 'no_approved_version' });
    await w.app.flows.decide(v2.id, w.approver, 'approved');
    expect((await call(pinned.id, pinned.token, { text: 'x' })).json()).toMatchObject({ error: 'flow_version_not_approved' });
    w.fake.messages.length = 0;
    expect((await call(following.id, following.token, { text: 'v2' })).statusCode).toBe(202);
    await w.app.worker.drain();
    expect(w.fake.messages).toEqual([expect.objectContaining({ channel: 'C-ops-2', text: 'v2' })]);
  });

  it('needs a choice between pinning and following, and the creator must be able to run the Super Flow', async () => {
    expect((await create({ name: 'Both', followLatest: true, versionId: releaseVersionId })).json()).toMatchObject({ error: 'choose_version_or_latest' });
    expect((await create({ name: 'Neither' })).json()).toMatchObject({ error: 'choose_version_or_latest' });
    expect((await create({ name: 'Other flow', versionId: releaseVersionId })).statusCode).toBe(404);
    // A run that waits (an approval gate) reads as waiting to the caller.
    const release = (await w.app.flows.getVersion(w.db, releaseVersionId))!;
    const ep = (await create({ name: 'Release', versionId: releaseVersionId }, w.tokens.alice, release.flowId)).json();
    const runId = (await call(ep.id, ep.token, releaseInputs)).json().runId;
    await w.app.worker.drain();
    const status = (await api.inject({ method: 'GET', url: `/sflow/${ep.id}/runs/${runId}`, headers: { 'x-sflow-token': ep.token } })).json();
    expect(status).toMatchObject({ status: 'waiting', waitReason: 'approval' });
  });

  it("maps a sender's own JSON onto the inputs, so it can call without changing its payload", async () => {
    const ep = (await create({ name: 'Error reporter', followLatest: true })).json();
    // The sender's payload, with fields the Flow does not have: with no mapping, the Flow's only input
    // (text) gets the whole body, as JSON text.
    const event = { eventId: 'e-1', type: 'error', service: 'storefront', summary: 'TypeError in checkout', errors: [{ message: 'x is undefined' }] };
    w.fake.messages.length = 0;
    expect((await call(ep.id, ep.token, event)).statusCode).toBe(202);
    await w.app.worker.drain();
    expect(w.fake.messages.map((m) => JSON.parse(m.text as string))).toEqual([event]);

    // Only inputs the Flow has can be mapped, and only by its owner.
    const patch = (body: unknown, token = w.tokens.alice) => api.inject({ method: 'PATCH', url: `/api/endpoints/${ep.id}`, headers: auth(token), payload: body as object });
    expect((await patch({ inputMap: { message: '/summary' } })).json()).toMatchObject({ error: 'unknown_flow_input', detail: expect.stringContaining('its inputs: text') });
    expect((await patch({ inputMap: { text: 'summary' } })).statusCode).toBe(400); // not a JSON Pointer
    expect((await patch({ inputMap: { text: '/summary' } }, w.tokens.bob)).statusCode).toBe(404);
    expect((await patch({ inputMap: { text: '/summary' } })).json()).toMatchObject({ inputMap: { text: '/summary' } });

    // The same token, the same payload: now it starts the Flow with the mapped value.
    w.fake.messages.length = 0;
    const started = await call(ep.id, ep.token, event);
    expect(started.statusCode).toBe(202);
    await w.app.worker.drain();
    expect(w.fake.messages.map((m) => m.text)).toEqual(['TypeError in checkout']);
    // Nested fields too.
    await patch({ inputMap: { text: '/errors/0/message' } });
    await call(ep.id, ep.token, event);
    await w.app.worker.drain();
    expect(w.fake.messages.map((m) => m.text)).toEqual(['TypeError in checkout', 'x is undefined']);
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'endpoint.input_map_changed' AND subject_id = $1`, [ep.id])).rowCount).toBe(2);

    // A mapped field missing from the body: the input is missing, and the Flow's schema says so.
    expect((await call(ep.id, ep.token, { eventId: 'e-2' })).json()).toMatchObject({ error: 'invalid_inputs' });
    // Removing the mapping: the body is the inputs again.
    expect((await patch({ inputMap: null })).json()).toMatchObject({ inputMap: null });
    expect((await call(ep.id, ep.token, { text: 'plain' })).statusCode).toBe(202);
    // Set when creating the URL, too.
    expect((await create({ name: 'Mapped from the start', followLatest: true, inputMap: { text: '/summary' } })).json()).toMatchObject({ inputMap: { text: '/summary' } });
  });
});

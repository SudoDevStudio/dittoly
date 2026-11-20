import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { signGithub, signStandard } from '../src/runtime/verify.js';
import { buildApp } from '../src/app.js';
import { pruneWebhookState } from '../src/webhooks/service.js';
import { testConfig } from './helpers.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, type World } from './helpers.js';

let w: World;
let server: ReturnType<typeof buildServer>;
let flowVersionId: string;

const payloadSchema = {
  type: 'object',
  properties: { release: { type: 'string' }, project: { type: 'string' } },
  required: ['release', 'project'],
};
const inputMap = { release: '/release', project: '/project', jql: '/release', channel: '/release' };

beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  flowVersionId = (await approvedReleaseFlow(w)).id;
  server = buildServer(w.app);
});
afterAll(async () => {
  await server.close();
  await w.db.end();
});

const now = () => Math.floor(Date.now() / 1000);

async function standardTrigger(extra: Record<string, unknown> = {}) {
  return w.app.webhooks.create({ flowVersionId, provider: 'standard', payloadSchema, inputMap, ...extra }, w.alice);
}

function post(id: string, body: string, headers: Record<string, string>) {
  return server.inject({ method: 'POST', url: `/hooks/${id}`, payload: body, headers: { 'content-type': 'application/json', ...headers } });
}

function signed(secret: string, body: string, opts: { id?: string; ts?: number } = {}) {
  const id = opts.id ?? `msg_${randomUUID()}`;
  const ts = opts.ts ?? now();
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': signStandard(secret, id, ts, body) };
}

const body = JSON.stringify({ release: '2.4', project: 'acme/app' });

describe('webhook triggers', () => {
  it('lists only the owner’s trigger metadata and never exposes secrets', async () => {
    const own = await standardTrigger();
    const other = await w.app.webhooks.create({ flowVersionId, provider: 'github', payloadSchema, inputMap }, w.bob);
    const res = await server.inject({ method: 'GET', url: '/api/triggers', headers: { authorization: `Bearer ${w.tokens.alice}` } });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.find((t: { id: string }) => t.id === own.id)).toMatchObject({ provider: 'standard', flowVersionId, url: own.url, versionStatus: 'approved' });
    expect(rows.some((t: { id: string }) => t.id === other.id)).toBe(false);
    expect(res.body).not.toContain(own.secret);
    expect(res.body).not.toContain('secret_enc');
    expect(rows.every((t: object) => Object.keys(t).every(k => !k.includes('secret')))).toBe(true);
    const anon = await server.inject({ method: 'GET', url: '/api/triggers' });
    expect(anon.statusCode).toBe(401);
  });

  it('accepts a correctly signed delivery and starts a run as the trigger owner', async () => {
    const t = await standardTrigger();
    const res = await post(t.id, body, signed(t.secret, body));
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    const run = (await w.db.query(`SELECT run_as, flow_version_id, trigger_id FROM runs WHERE id = $1`, [runId])).rows[0];
    expect(run).toEqual({ run_as: w.alice.id, flow_version_id: flowVersionId, trigger_id: t.id });
  });

  it('rejects unsigned, wrongly signed and expired deliveries', async () => {
    const t = await standardTrigger();
    expect((await post(t.id, body, {})).statusCode).toBe(401);
    const bad = signed('whsec_' + Buffer.alloc(32, 1).toString('base64'), body);
    expect((await post(t.id, body, bad)).statusCode).toBe(401);
    const tampered = signed(t.secret, body);
    expect((await post(t.id, body.replace('2.4', '9.9'), tampered)).statusCode).toBe(401);
    expect((await post(t.id, body, signed(t.secret, body, { ts: now() - 301 }))).statusCode).toBe(401);
    expect((await post(t.id, body, signed(t.secret, body, { ts: now() + 301 }))).statusCode).toBe(401);
    const reasons = (await w.db.query(`SELECT error_type FROM audit_events WHERE action = 'webhook.rejected' AND subject_id = $1 ORDER BY id`, [t.id])).rows.map((r) => r.error_type);
    expect(reasons).toEqual(['unsigned', 'bad_signature', 'bad_signature', 'stale_timestamp', 'stale_timestamp']);
    expect((await w.db.query(`SELECT 1 FROM runs WHERE trigger_id = $1`, [t.id])).rowCount).toBe(0);
  });

  it('ignores a replayed delivery (same webhook-id)', async () => {
    const t = await standardTrigger();
    const headers = signed(t.secret, body);
    expect((await post(t.id, body, headers)).statusCode).toBe(202);
    const again = await post(t.id, body, headers);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ duplicate: true });
    expect((await w.db.query(`SELECT 1 FROM runs WHERE trigger_id = $1`, [t.id])).rowCount).toBe(1);
  });

  it('a payload naming another member, flow or version has no effect', async () => {
    const t = await standardTrigger();
    const evil = JSON.stringify({
      release: '2.4',
      project: 'acme/app',
      runAs: w.bob.id,
      run_as: w.bob.id,
      flowVersionId: randomUUID(),
      flow_version_id: randomUUID(),
    });
    const res = await post(t.id, evil, signed(t.secret, evil));
    expect(res.statusCode).toBe(202);
    const run = (await w.db.query(`SELECT run_as, flow_version_id FROM runs WHERE id = $1`, [res.json().runId])).rows[0];
    expect(run).toEqual({ run_as: w.alice.id, flow_version_id: flowVersionId });
  });

  it('rejects payloads that do not match the trigger schema', async () => {
    const t = await standardTrigger();
    const wrong = JSON.stringify({ release: 24 });
    expect((await post(t.id, wrong, signed(t.secret, wrong))).statusCode).toBe(422);
  });

  it('keeps the old secret working during the rotation overlap only', async () => {
    const t = await standardTrigger();
    const rotated = await w.app.webhooks.rotate(t.id, w.alice, 3600);
    expect((await post(t.id, body, signed(t.secret, body))).statusCode).toBe(202);
    expect((await post(t.id, body, signed(rotated.secret, body))).statusCode).toBe(202);
    await w.app.webhooks.rotate(t.id, w.alice, 0);
    expect((await post(t.id, body, signed(rotated.secret, body))).statusCode).toBe(401);
  });

  it('rate-limits each endpoint', async () => {
    const t = await standardTrigger({ rateLimitPerMinute: 2 });
    expect((await post(t.id, body, signed(t.secret, body))).statusCode).toBe(202);
    expect((await post(t.id, body, signed(t.secret, body))).statusCode).toBe(202);
    expect((await post(t.id, body, signed(t.secret, body))).statusCode).toBe(429);
  });

  it('verifies GitHub X-Hub-Signature-256 and dedupes X-GitHub-Delivery', async () => {
    const t = await w.app.webhooks.create({ flowVersionId, provider: 'github', payloadSchema, inputMap }, w.alice);
    const delivery = randomUUID();
    const h = { 'x-hub-signature-256': signGithub(t.secret, body), 'x-github-delivery': delivery };
    expect((await post(t.id, body, h)).statusCode).toBe(202);
    expect((await post(t.id, body, h)).json()).toEqual({ duplicate: true });
    expect((await post(t.id, body, { ...h, 'x-hub-signature-256': signGithub('wrong', body), 'x-github-delivery': randomUUID() })).statusCode).toBe(401);
    expect((await post(t.id, body, { 'x-github-delivery': randomUUID() })).statusCode).toBe(401);
  });

  it('refuses a captured GitHub delivery resent under a new X-GitHub-Delivery (the signature covers only the body)', async () => {
    const t = await w.app.webhooks.create({ flowVersionId, provider: 'github', payloadSchema, inputMap }, w.alice);
    const h = { 'x-hub-signature-256': signGithub(t.secret, body) };
    expect((await post(t.id, body, { ...h, 'x-github-delivery': randomUUID() })).statusCode).toBe(202);
    const replay = await post(t.id, body, { ...h, 'x-github-delivery': randomUUID() });
    expect(replay.json()).toEqual({ duplicate: true });
    expect((await w.db.query(`SELECT 1 FROM runs WHERE trigger_id = $1`, [t.id])).rowCount).toBe(1);
    const audited = await w.db.query(`SELECT error_type FROM audit_events WHERE action = 'webhook.replay_refused' AND subject_id = $1`, [t.id]);
    expect(audited.rows).toEqual([{ error_type: 'replayed_body' }]);
    // A different event (different body) is still accepted.
    const other = body.replace('2.4', '2.5');
    expect((await post(t.id, other, { 'x-hub-signature-256': signGithub(t.secret, other), 'x-github-delivery': randomUUID() })).statusCode).toBe(202);
  });

  it('verifies GitLab signing tokens and accepts X-Gitlab-Token only while migrating', async () => {
    const legacy = 'legacy-gitlab-secret-token-123';
    const t = await w.app.webhooks.create(
      { flowVersionId, provider: 'gitlab', payloadSchema, inputMap, legacyGitlabToken: legacy, legacyGitlabTokenDays: 1 },
      w.alice,
    );
    expect((await post(t.id, body, signed(t.secret, body))).statusCode).toBe(202);
    const legacyHeaders = { 'x-gitlab-token': legacy, 'webhook-id': randomUUID(), 'webhook-timestamp': String(now()) };
    expect((await post(t.id, body, legacyHeaders)).statusCode).toBe(202);
    expect((await post(t.id, body, { ...legacyHeaders, 'x-gitlab-token': 'wrong-token-wrong-token', 'webhook-id': randomUUID() })).statusCode).toBe(401);

    await w.db.query(`UPDATE triggers SET legacy_token_expires_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
    expect((await post(t.id, body, { ...legacyHeaders, 'webhook-id': randomUUID() })).statusCode).toBe(401);

    const plain = await w.app.webhooks.create({ flowVersionId, provider: 'gitlab', payloadSchema, inputMap }, w.alice);
    expect((await post(plain.id, body, { ...legacyHeaders, 'webhook-id': randomUUID() })).statusCode).toBe(401);
  });

  it('refuses deliveries for a flow version whose approval was cancelled', async () => {
    const t = await standardTrigger();
    const flowId = (await w.app.flows.getVersion(w.db, flowVersionId))!.flowId;
    const versions = await w.app.flows.versions(flowId);
    await w.app.flows.update(flowId, versions[0]!.definition, w.alice);
    const res = await post(t.id, body, signed(t.secret, body));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'webhook_flow_version_not_approved' });
  });

  it('the rate limit is shared by every server process using the same database', async () => {
    const fresh = (await approvedReleaseFlow(w)).id;
    const t = await standardTrigger({ rateLimitPerMinute: 2, flowVersionId: fresh });
    // A second, independent app and server on the same database (another process in production).
    const other = buildServer(buildApp(testConfig({ masterKey: (w.app.config as { masterKey: Buffer }).masterKey }), w.db, { ai: null }));
    const postTo = (srv: typeof server, h: Record<string, string>) =>
      srv.inject({ method: 'POST', url: `/hooks/${t.id}`, payload: body, headers: { 'content-type': 'application/json', ...h } });
    expect((await postTo(server, signed(t.secret, body))).statusCode).toBe(202);
    expect((await postTo(other, signed(t.secret, body))).statusCode).toBe(202);
    expect((await postTo(other, signed(t.secret, body))).statusCode).toBe(429);
    await other.close();
  });

  it('prunes old delivery IDs: a day for signed providers, 90 days for GitHub', async () => {
    const fresh = (await approvedReleaseFlow(w)).id;
    const std = await standardTrigger({ flowVersionId: fresh });
    const gh = await w.app.webhooks.create({ flowVersionId: fresh, provider: 'github', payloadSchema, inputMap }, w.alice);
    for (const [trig, age] of [[std.id, '2 days'], [std.id, '1 hour'], [gh.id, '30 days'], [gh.id, '100 days']]) {
      await w.db.query(`INSERT INTO webhook_deliveries (trigger_id, delivery_id, received_at) VALUES ($1, $2, now() - $3::interval)`, [trig, `old-${age}`, age]);
    }
    await pruneWebhookState(w.db);
    const left = (await w.db.query(`SELECT trigger_id, delivery_id FROM webhook_deliveries WHERE delivery_id LIKE 'old-%' ORDER BY delivery_id`)).rows;
    expect(left).toEqual([
      { trigger_id: std.id, delivery_id: 'old-1 hour' },
      { trigger_id: gh.id, delivery_id: 'old-30 days' },
    ]);
  });
});

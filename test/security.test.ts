import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { memberByToken, revokeApiToken, rotateApiToken } from '../src/core/members.js';
import { safeReturnTo } from '../src/core/oidc.js';
import { ajv } from '../src/modules/manifest.js';
import { guardedFetch } from '../src/runtime/egress.js';
import { signStandard } from '../src/runtime/verify.js';
import { approvedReleaseFlow, approveExampleModules, makeWorld, type World } from './helpers.js';

/** Regression tests for the findings of the security review. */
let w: World;
let api: ReturnType<typeof buildServer>;
let flowVersionId: string;
beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
  flowVersionId = (await approvedReleaseFlow(w)).id;
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const bearer = (who: keyof World['tokens']) => ({ authorization: `Bearer ${w.tokens[who]}` });
const now = () => Math.floor(Date.now() / 1000);
function signed(secret: string, body: string) {
  const id = `msg_${randomUUID()}`;
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(now()), 'webhook-signature': signStandard(secret, id, now(), body) };
}
const hook = (id: string, body: string, headers: Record<string, string>) => api.inject({ method: 'POST', url: `/hooks/${id}`, payload: body, headers });

describe('security review regressions', () => {
  it('only the owner (or an admin) can change a Flow, so nobody can cancel someone else\'s approval', async () => {
    const version = await approvedReleaseFlow(w); // created by alice
    const flowId = (await w.db.query(`SELECT flow_id FROM flow_versions WHERE id = $1`, [version.id])).rows[0].flow_id;
    const res = await api.inject({ method: 'PUT', url: `/api/flows/${flowId}`, headers: bearer('bob'), payload: { definition: version.definition } });
    expect(res.statusCode).toBe(403);
    expect((await w.db.query(`SELECT status FROM flow_versions WHERE id = $1`, [version.id])).rows[0].status).toBe('approved');
  });

  it('schema patterns run in linear time, so a webhook payload cannot stall the server', async () => {
    const t = await w.app.webhooks.create(
      { flowVersionId, provider: 'standard', payloadSchema: { type: 'object', properties: { x: { type: 'string', pattern: '^(a|a)*$' } } }, inputMap: {} },
      w.alice,
    );
    const body = JSON.stringify({ x: 'a'.repeat(50_000) + 'b' });
    const started = Date.now();
    expect((await hook(t.id, body, signed(t.secret, body))).statusCode).toBe(422);
    expect(Date.now() - started).toBeLessThan(2000);
    // Patterns RE2 cannot run in linear time are rejected when the schema is configured.
    await expect(
      w.app.webhooks.create({ flowVersionId, provider: 'standard', payloadSchema: { type: 'string', pattern: '(?=a)a' }, inputMap: {} }, w.alice),
    ).rejects.toMatchObject({ code: 'invalid_payload_schema' });
  });

  it('a schema\'s $id is never registered: one schema cannot claim another\'s, and reusing one keeps working', async () => {
    const schema = () => JSON.parse('{"$id":"https://example.com/release","type":"object","required":["release"]}');
    await w.app.webhooks.create({ flowVersionId, provider: 'standard', payloadSchema: { $id: 'https://example.com/release' }, inputMap: {} }, w.bob);
    for (let i = 0; i < 3; i++) {
      expect(ajv.validate(schema(), { release: '1' })).toBe(true);
      expect(ajv.validate(schema(), {})).toBe(false);
    }
  });

  it('API tokens: the member or an admin can issue and revoke them, other members cannot', async () => {
    expect((await api.inject({ method: 'POST', url: `/api/members/${w.bob.id}/token`, headers: bearer('alice') })).statusCode).toBe(403);
    const issued = await api.inject({ method: 'POST', url: `/api/members/${w.bob.id}/token`, headers: bearer('admin') });
    expect(issued.statusCode).toBe(200);
    const token = issued.json().token as string;
    expect((await memberByToken(w.db, token))?.id).toBe(w.bob.id);
    expect((await api.inject({ method: 'DELETE', url: `/api/members/${w.bob.id}/token`, headers: bearer('alice') })).statusCode).toBe(403);
    await revokeApiToken(w.db, w.admin, w.bob.id);
    expect(await memberByToken(w.db, token)).toBeNull();
    w.tokens.bob = await rotateApiToken(w.db, w.bob, w.bob.id);
  });

  it('trigger secrets: the owner or an admin can rotate them, other members cannot', async () => {
    const t = await w.app.webhooks.create({ flowVersionId, provider: 'standard', payloadSchema: {}, inputMap: {} }, w.alice);
    await expect(w.app.webhooks.rotate(t.id, w.bob, 0)).rejects.toMatchObject({ httpStatus: 403 });
    await expect(w.app.webhooks.rotate(t.id, w.admin, 0)).resolves.toMatchObject({ secret: expect.any(String) });
  });

  it.each([
    ['/runs/1?x=y#z', '/runs/1?x=y#z'],
    ['/\t/evil.com', '/'],
    ['/\n/evil.com', '/'],
    ['/\\evil.com', '/'],
    ['//evil.com', '/'],
    ['https://evil.com', '/'],
    ['/%2F%2Fevil.com', '/%2F%2Fevil.com'], // stays a path on this site
    ['/.//evil.com', '/'],
    ['/%2e%2e//evil.example/phish', '/'],
    ['/a/..//evil.com', '/'],
  ])('returnTo %j becomes %j', (input, expected) => expect(safeReturnTo(input)).toBe(expected));

  it('unsigned requests neither use up the rate limit nor flood the audit log', async () => {
    const inputMap = { release: '/release', project: '/project', jql: '/release', channel: '/release' };
    const t = await w.app.webhooks.create({ flowVersionId, provider: 'standard', payloadSchema: {}, inputMap, rateLimitPerMinute: 2 }, w.alice);
    const body = JSON.stringify({ release: '2.4', project: 'acme/app' });
    for (let i = 0; i < 30; i++) expect((await hook(t.id, body, { 'content-type': 'application/json' })).statusCode).toBe(401);
    const audited = await w.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'webhook.rejected' AND subject_id = $1`, [t.id]);
    expect(audited.rows[0].n).toBeLessThanOrEqual(10);
    expect((await hook(t.id, body, signed(t.secret, body))).statusCode).toBe(202);
  });

  it('guarded connections never follow redirects (the next hop would skip the address check)', async () => {
    const target: Server = createServer((_req, res) => res.writeHead(302, { location: 'http://127.0.0.2:9/admin' }).end());
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const host = `127.0.0.1:${(target.address() as AddressInfo).port}`;
    try {
      const res = await guardedFetch({ internalHosts: [], loopbackHosts: [host] })(`http://${host}/`, { method: 'GET' });
      expect(res.status).toBe(302);
    } finally {
      await new Promise<void>((r) => target.close(() => r()));
    }
  });

  it('bad query values are client errors, not server errors', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/views/constructor', headers: bearer('alice') })).statusCode).toBe(400);
    expect((await api.inject({ method: 'GET', url: '/api/runs?limit=x', headers: bearer('alice') })).statusCode).toBe(200);
  });
});

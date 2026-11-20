import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { sha256Hex } from '../src/core/crypto.js';
import { createSession, memberForOidc, updateMember, type Member } from '../src/core/members.js';
import type { FlowDefinition } from '../src/flows/definition.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, type World } from './helpers.js';

/** SCIM 2.0 provisioning: what Okta and Entra ID send, offboarding, groups as teams, roles from groups. */
let w: World;
let api: ReturnType<typeof buildServer>;
let token = '';
const ISSUER = 'https://idp.acme.test';
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const scimHeaders = () => ({ ...auth(token), 'content-type': 'application/scim+json' });
const scim = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  api.inject({ method, url: `/scim/v2${url}`, headers: scimHeaders(), ...(payload ? { payload: JSON.stringify(payload) } : {}) });
const patchOp = (...ops: object[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: ops });
const user = (userName: string, more: object = {}) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName, active: true, ...more });
const q = (s: string) => encodeURIComponent(s);
const memberRow = async (id: string) =>
  (await w.db.query<{ handle: string; role: string; disabled: boolean; token_hash: string | null; display_name: string | null; manual_role: string | null }>(`SELECT * FROM members WHERE id = $1`, [id])).rows[0]!;
const asMember = async (id: string): Promise<Member> => {
  const r = await memberRow(id);
  return { id, handle: r.handle, role: r.role as Member['role'] };
};
const audits = async (action: string, subjectId?: string) =>
  (await w.db.query<{ actor_id: string; outcome: string; error_type: string | null }>(`SELECT actor_id, outcome, error_type FROM audit_events WHERE action = $1 ${subjectId ? 'AND subject_id = $2' : ''}`, subjectId ? [action, subjectId] : [action])).rows;
const tokenId = async () => (await w.db.query<{ id: string }>(`SELECT id FROM scim_tokens WHERE revoked_at IS NULL`)).rows[0]!.id;
const inTeam = async (teamId: string, memberId: string) => (await w.db.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2`, [teamId, memberId])).rowCount === 1;

async function create(userName: string, more: object = {}): Promise<string> {
  const r = await scim('POST', '/Users', user(userName, more));
  expect(r.statusCode).toBe(201);
  return r.json().id;
}

beforeAll(async () => {
  w = await makeWorld({ oidc: { issuer: ISSUER, clientId: 'dittoly', clientSecret: 'x', allowedDomains: [] } });
  api = buildServer(w.app);
  const r = await api.inject({ method: 'POST', url: '/api/admin/scim/token', headers: auth(w.tokens.admin) });
  expect(r.statusCode).toBe(201);
  token = r.json().token;
  expect(r.json().baseUrl).toBe('http://127.0.0.1:8080/scim/v2');
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('discovery and authentication', () => {
  it('serves ServiceProviderConfig, ResourceTypes and Schemas as application/scim+json', async () => {
    const spc = await scim('GET', '/ServiceProviderConfig');
    expect(spc.statusCode).toBe(200);
    expect(spc.headers['content-type']).toContain('application/scim+json');
    expect(spc.json()).toMatchObject({ patch: { supported: true }, filter: { supported: true, maxResults: 200 }, bulk: { supported: false }, authenticationSchemes: [{ type: 'oauthbearertoken' }] });
    expect((await scim('GET', '/ResourceTypes')).json()).toMatchObject({ totalResults: 2, Resources: [{ id: 'User', endpoint: '/Users' }, { id: 'Group', endpoint: '/Groups' }] });
    const schemas = (await scim('GET', '/Schemas')).json();
    expect(schemas.Resources.map((s: { id: string }) => s.id)).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:core:2.0:Group']);
    expect((await scim('GET', '/Schemas/urn:ietf:params:scim:schemas:core:2.0:User')).json().attributes.some((a: { name: string }) => a.name === 'userName')).toBe(true);
  });

  it('refuses a missing or wrong token, a personal API token, and a SCIM token anywhere else', async () => {
    const none = await api.inject({ method: 'GET', url: '/scim/v2/Users' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401', detail: 'A valid SCIM bearer token is required.' });
    expect((await api.inject({ method: 'GET', url: '/scim/v2/Users', headers: auth('dty_scim_wrong') })).statusCode).toBe(401);
    expect((await api.inject({ method: 'GET', url: '/scim/v2/Users', headers: auth(w.tokens.admin) })).statusCode).toBe(401);
    expect((await api.inject({ method: 'GET', url: '/api/members', headers: auth(token) })).statusCode).toBe(401);
    expect((await audits('scim.auth_refused')).length).toBeGreaterThanOrEqual(3);
    // Only org admins manage the token; the hash is stored, never the token.
    expect((await api.inject({ method: 'POST', url: '/api/admin/scim/token', headers: auth(w.tokens.alice) })).statusCode).toBe(403);
    expect((await w.db.query(`SELECT 1 FROM scim_tokens WHERE token_hash = $1`, [sha256Hex(token)])).rowCount).toBe(1);
  });

  it('rotating stops the old token at once; revoking stops all', async () => {
    const old = token;
    token = (await api.inject({ method: 'POST', url: '/api/admin/scim/token', headers: auth(w.tokens.admin) })).json().token;
    expect((await api.inject({ method: 'GET', url: '/scim/v2/Users', headers: auth(old) })).statusCode).toBe(401);
    expect((await scim('GET', '/Users')).statusCode).toBe(200);
    expect(await audits('scim.token_rotated')).toHaveLength(1);
    expect((await api.inject({ method: 'DELETE', url: '/api/admin/scim/token', headers: auth(w.tokens.admin) })).statusCode).toBe(204);
    expect((await scim('GET', '/Users')).statusCode).toBe(401);
    token = (await api.inject({ method: 'POST', url: '/api/admin/scim/token', headers: auth(w.tokens.admin) })).json().token;
  });
});

describe('Users', () => {
  it('creates a member with the member role, a sanitized handle and display name, and audits it as the token', async () => {
    const r = await scim('POST', '/Users', user('Carol.Diaz@Acme.test', { externalId: 'okta-00u1', name: { givenName: 'Carol', familyName: 'Diaz' }, displayName: 'Carol‮ Diaz\u0007', emails: [{ value: 'carol.diaz@acme.test', type: 'work', primary: true }] }));
    expect(r.statusCode).toBe(201);
    const u = r.json();
    expect(r.headers.location).toBe(`http://127.0.0.1:8080/scim/v2/Users/${u.id}`);
    expect(u).toMatchObject({ userName: 'Carol.Diaz@Acme.test', externalId: 'okta-00u1', active: true, displayName: 'Carol Diaz', emails: [{ value: 'carol.diaz@acme.test' }], meta: { resourceType: 'User' } });
    const row = await memberRow(u.id);
    expect(row).toMatchObject({ handle: 'carol.diaz', role: 'member', disabled: false, token_hash: null });
    expect(await audits('scim.member_created', u.id)).toEqual([{ actor_id: await tokenId(), outcome: 'ok', error_type: null }]);
    // userName is unique (case-insensitively).
    const dup = await scim('POST', '/Users', user('carol.diaz@acme.test'));
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ status: '409', scimType: 'uniqueness' });
  });

  it('filters by userName, externalId and emails.value, and pages with startIndex and count', async () => {
    for (const n of ['p1', 'p2', 'p3']) await create(`${n}@acme.test`);
    const byName = (await scim('GET', `/Users?filter=${q('userName eq "CAROL.DIAZ@acme.test"')}`)).json();
    expect(byName).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 1, Resources: [{ userName: 'Carol.Diaz@Acme.test' }] });
    expect((await scim('GET', `/Users?filter=${q('externalId eq "okta-00u1"')}`)).json().totalResults).toBe(1);
    expect((await scim('GET', `/Users?filter=${q('externalId eq "OKTA-00U1"')}`)).json().totalResults).toBe(0);
    expect((await scim('GET', `/Users?filter=${q('emails.value eq "carol.diaz@acme.test"')}`)).json().totalResults).toBe(1);
    expect((await scim('GET', `/Users?filter=${q('userName eq "nobody@acme.test"')}`)).json()).toMatchObject({ totalResults: 0, Resources: [] });
    const page = (await scim('GET', '/Users?startIndex=2&count=2')).json();
    expect(page).toMatchObject({ totalResults: 4, startIndex: 2, itemsPerPage: 2 });
    expect(page.Resources.map((u: { userName: string }) => u.userName)).toEqual(['p1@acme.test', 'p2@acme.test']);
    // Members the identity provider does not manage are invisible to it.
    expect(page.Resources.some((u: { userName: string }) => u.userName === 'admin')).toBe(false);
    const bad = await scim('GET', `/Users?filter=${q('userName co "carol"')}`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '400', scimType: 'invalidFilter' });
  });

  it('PUT replaces the User (Okta)', async () => {
    const id = await create('dana@acme.test');
    const r = await scim('PUT', `/Users/${id}`, user('dana@acme.test', { name: { givenName: 'Dana', familyName: 'Ito' }, emails: [{ value: 'dana.ito@acme.test', primary: true }] }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ displayName: 'Dana Ito', name: { givenName: 'Dana', familyName: 'Ito' }, emails: [{ value: 'dana.ito@acme.test' }], active: true });
    expect(await audits('scim.member_updated', id)).toHaveLength(1);
    expect((await scim('GET', `/Users/${id}`)).json().displayName).toBe('Dana Ito');
  });

  it('PATCH takes Entra ID requests: "Replace"/"Add" ops, dotted and filtered paths, unknown attributes', async () => {
    const id = await create('erik@acme.test');
    const r = await scim(
      'PATCH',
      `/Users/${id}`,
      patchOp(
        { op: 'Replace', path: 'displayName', value: 'Erik Berg' },
        { op: 'Add', path: 'emails[type eq "work"].value', value: 'Erik.Berg@acme.test' },
        { op: 'Replace', path: 'name.givenName', value: 'Erik' },
        { op: 'Add', path: 'title', value: 'Engineer' },
        { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'R&D' },
        { op: 'Replace', value: { externalId: 'entra-oid-1', 'name.familyName': 'Berg' } },
      ),
    );
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ displayName: 'Erik Berg', externalId: 'entra-oid-1', name: { givenName: 'Erik', familyName: 'Berg' }, emails: [{ value: 'erik.berg@acme.test' }] });
    const bad = await scim('PATCH', `/Users/${id}`, patchOp({ op: 'Replace', path: 'active', value: 'maybe' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ scimType: 'invalidValue' });
    expect((await scim('PATCH', `/Users/${id}`, patchOp({ op: 'Move', path: 'active', value: true }))).json()).toMatchObject({ status: '400', scimType: 'invalidSyntax' });
  });

  it('answers unknown Users with a SCIM 404', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const r = await scim('GET', `/Users/${id}`);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: 'no such User' });
    }
    // A personal member (not managed by SCIM) is not a SCIM resource either.
    expect((await scim('GET', `/Users/${w.alice.id}`)).statusCode).toBe(404);
  });
});

describe('offboarding', () => {
  const gate = { steps: [{ id: 'gate', type: 'approval', title: 'Check' }] } as unknown as FlowDefinition;
  let fay = '';
  let runId = '';

  beforeAll(async () => {
    fay = await create('fay@acme.test', { name: { givenName: 'Fay', familyName: 'Lund' } });
    const asFay = await asMember(fay);
    const v = await w.app.flows.create('Fay checks', gate, asFay);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    runId = await w.app.engine.startRun(v.id, fay, {});
    await w.app.worker.drain();
    expect((await w.db.query(`SELECT status FROM runs WHERE id = $1`, [runId])).rows[0]).toEqual({ status: 'waiting' });
    // Everything that acts for Fay: a portal session, a phone, an API token, an AI agent.
    await createSession(w.db, fay, 12);
    await w.db.query(`INSERT INTO devices (member_id, name, token_hash, expires_at) VALUES ($1, 'Phone', 'dev-hash-fay', now() + interval '30 days')`, [fay]);
    await w.db.query(`UPDATE members SET token_hash = 'api-hash-fay' WHERE id = $1`, [fay]);
    const agent = (await w.db.query<{ id: string }>(`INSERT INTO mcp_tokens (member_id, name, token_hash) VALUES ($1, 'Claude', 'mcp-hash-fay') RETURNING id`, [fay])).rows[0]!.id;
    // ...and a connection an AI app signed in for (OAuth) on that agent.
    const grant = (await w.db.query<{ id: string }>(
      `INSERT INTO mcp_oauth_grants (token_id, client_id, redirect_uri, resource, scope) VALUES ($1, 'https://app.example/meta', 'https://app.example/cb', 'x', 'mcp') RETURNING id`,
      [agent],
    )).rows[0]!.id;
    await w.db.query(`INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ('oauth-refresh-fay', $1, 'refresh', now() + interval '30 days')`, [grant]);
  });

  it('deactivation (Entra: "Replace" active "False") disables the account and revokes everything at once', async () => {
    const r = await scim('PATCH', `/Users/${fay}`, patchOp({ op: 'Replace', path: 'active', value: 'False' }));
    expect(r.statusCode).toBe(200);
    expect(r.json().active).toBe(false);
    expect(await memberRow(fay)).toMatchObject({ disabled: true, token_hash: null });
    expect((await w.db.query(`SELECT 1 FROM sessions WHERE member_id = $1`, [fay])).rowCount).toBe(0);
    expect((await w.db.query(`SELECT 1 FROM devices WHERE member_id = $1 AND revoked_at IS NULL`, [fay])).rowCount).toBe(0);
    expect((await w.db.query(`SELECT 1 FROM mcp_tokens WHERE member_id = $1 AND revoked_at IS NULL`, [fay])).rowCount).toBe(0);
    expect((await w.db.query(`SELECT 1 FROM mcp_oauth_tokens WHERE token_hash = 'oauth-refresh-fay'`)).rowCount).toBe(0);
    expect((await w.db.query(`SELECT 1 FROM mcp_oauth_grants g JOIN mcp_tokens t ON t.id = g.token_id WHERE t.member_id = $1 AND g.revoked_at IS NULL`, [fay])).rowCount).toBe(0);
    // The waiting run is cancelled through the engine, which audits it with the token as the actor.
    expect((await w.db.query(`SELECT status FROM runs WHERE id = $1`, [runId])).rows[0]).toEqual({ status: 'cancelled' });
    const t = await tokenId();
    expect(await audits('run.cancel_requested', runId)).toEqual([{ actor_id: t, outcome: 'ok', error_type: null }]);
    for (const a of ['scim.member_deactivated', 'scim.sessions_revoked', 'member.token_revoked', 'mcp.token_revoked']) expect((await audits(a, fay)).map((x) => x.actor_id)).toEqual([t]);
    // Admins are told, and the Provisioning page lists what Fay owned.
    expect((await w.db.query(`SELECT 1 FROM notifications WHERE member_id = $1 AND kind = 'member_offboarded'`, [w.admin.id])).rowCount).toBe(1);
    const overview = (await api.inject({ method: 'GET', url: '/api/admin/scim', headers: auth(w.tokens.admin) })).json();
    expect(overview.offboarded.find((m: { id: string }) => m.id === fay).owned.flows).toEqual([expect.objectContaining({ name: 'Fay checks' })]);
    expect(overview.lastSyncAt).not.toBeNull();
    // History is kept: the member and its audit trail are still there.
    expect((await audits('scim.member_created', fay))).toHaveLength(1);
  });

  it('reactivation (Okta: pathless replace) re-enables the account but restores no token, agent or device', async () => {
    const r = await scim('PATCH', `/Users/${fay}`, patchOp({ op: 'replace', value: { active: true } }));
    expect(r.json().active).toBe(true);
    expect(await memberRow(fay)).toMatchObject({ disabled: false, token_hash: null });
    expect((await w.db.query(`SELECT 1 FROM mcp_tokens WHERE member_id = $1 AND revoked_at IS NULL`, [fay])).rowCount).toBe(0);
    expect((await w.db.query(`SELECT 1 FROM devices WHERE member_id = $1 AND revoked_at IS NULL`, [fay])).rowCount).toBe(0);
    expect(await audits('scim.member_reactivated', fay)).toHaveLength(1);
  });

  it('Okta PUT with active false deactivates; an account an admin disabled by hand stays disabled', async () => {
    const r = await scim('PUT', `/Users/${fay}`, user('fay@acme.test', { active: false }));
    expect(r.json().active).toBe(false);
    expect((await memberRow(fay)).disabled).toBe(true);
    await scim('PUT', `/Users/${fay}`, user('fay@acme.test', { active: true }));
    expect((await memberRow(fay)).disabled).toBe(false);
    await updateMember(w.db, w.admin, fay, { disabled: true });
    expect((await scim('PUT', `/Users/${fay}`, user('fay@acme.test', { active: true }))).json().active).toBe(false);
    await updateMember(w.db, w.admin, fay, { disabled: false });
  });

  it('DELETE disables the member (never deletes it); the same userName later comes back as the same member', async () => {
    const r = await scim('DELETE', `/Users/${fay}`);
    expect(r.statusCode).toBe(204);
    expect(await memberRow(fay)).toMatchObject({ disabled: true });
    expect((await scim('GET', `/Users/${fay}`)).statusCode).toBe(404);
    expect((await scim('GET', `/Users?filter=${q('userName eq "fay@acme.test"')}`)).json().totalResults).toBe(0);
    expect(await audits('scim.member_deleted', fay)).toHaveLength(1);
    const again = await scim('POST', '/Users', user('fay@acme.test'));
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ id: fay, active: true });
    expect((await memberRow(fay)).token_hash).toBeNull();
  });
});

describe('offboarding and delegations', () => {
  let versionId = '';
  const kinds = async (memberId: string) => (await w.db.query<{ kind: string }>(`SELECT kind FROM notifications WHERE member_id = $1 ORDER BY id`, [memberId])).rows.map((r) => r.kind);
  /** A run of the release Flow paused at the GitLab step for want of the runner's credential. */
  async function pausedOnGitlab(as: Member) {
    await giveAllCredentials(w, as);
    await w.app.vault.remove(as.id, 'gitlab');
    const runId = await w.app.engine.startRun(versionId, as.id, releaseInputs);
    await w.app.worker.drain();
    expect((await w.db.query(`SELECT status FROM runs WHERE id = $1`, [runId])).rows[0]).toEqual({ status: 'paused' });
    return runId;
  }

  beforeAll(async () => {
    await approveExampleModules(w);
    versionId = (await approvedReleaseFlow(w)).id;
  });

  it('cancels pending requests the person was asked to run: audited, the requester told, their run paused', async () => {
    const kim = await create('kim@acme.test');
    const runId = await pausedOnGitlab(w.alice);
    const id = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, kim);
    expect((await scim('PATCH', `/Users/${kim}`, patchOp({ op: 'replace', path: 'active', value: false }))).statusCode).toBe(200);
    expect((await w.db.query(`SELECT status, inputs_enc, cancelled_for FROM delegations WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'cancelled', inputs_enc: null, cancelled_for: kim });
    expect(await audits('delegation.cancelled_offboarded', id)).toEqual([{ actor_id: await tokenId(), outcome: 'ok', error_type: null }]);
    expect(await kinds(w.alice.id)).toContain('delegation_delegate_offboarded');
    // Alice's run is not cancelled (it is hers): it pauses so she can ask someone else.
    const run = await w.app.engine.runView(runId, w.alice);
    expect(run.status).toBe('paused');
    expect(run.steps.find((x) => x.id === 'mrs')).toMatchObject({ status: 'failed', errorType: 'delegate_offboarded' });
    await expect(w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.bob.id)).resolves.toBeTypeOf('string');
    // The admins' Provisioning page lists it.
    const overview = (await api.inject({ method: 'GET', url: '/api/admin/scim', headers: auth(w.tokens.admin) })).json();
    expect(overview.offboarded.find((m: { id: string }) => m.id === kim).owned.delegations).toEqual([{ id, name: `list_merge_requests in Release coordination (asked by alice)` }]);
  });

  it('cancels pending requests the person made: audited, the teammate told; their run is cancelled', async () => {
    const lou = await create('lou@acme.test');
    const asLou = await asMember(lou);
    const runId = await pausedOnGitlab(asLou);
    const id = await w.app.engine.requestDelegation(runId, 'mrs', asLou, w.bob.id);
    expect((await scim('DELETE', `/Users/${lou}`)).statusCode).toBe(204);
    expect((await w.db.query(`SELECT status, cancelled_for FROM delegations WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'cancelled', cancelled_for: lou });
    expect((await audits('delegation.cancelled_offboarded', id))).toHaveLength(1);
    expect(await kinds(w.bob.id)).toContain('delegation_cancelled');
    expect((await w.db.query(`SELECT status FROM runs WHERE id = $1`, [runId])).rows[0]).toEqual({ status: 'cancelled' });
    // Bob can no longer act on it.
    await expect(w.app.engine.decideDelegation(id, w.bob, 'approved')).rejects.toMatchObject({ code: 'delegation_not_pending' });
    const overview = (await api.inject({ method: 'GET', url: '/api/admin/scim', headers: auth(w.tokens.admin) })).json();
    expect(overview.offboarded.find((m: { id: string }) => m.id === lou).owned.delegations).toEqual([{ id, name: `list_merge_requests in Release coordination (asked of bob)` }]);
  });
});

describe('Groups as teams, and roles from groups', () => {
  let gus = '';
  let hal = '';
  let ivy = '';
  let group = '';
  let team = '';

  beforeAll(async () => {
    gus = await create('gus@acme.test');
    hal = await create('hal@acme.test');
    ivy = await create('ivy@acme.test');
  });

  it('a pushed Group becomes a team with its members', async () => {
    const r = await scim('POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Payments <Ops>', members: [{ value: gus }] });
    expect(r.statusCode).toBe(201);
    group = r.json().id;
    expect(r.json()).toMatchObject({ displayName: 'Payments <Ops>', members: [{ value: gus }] });
    const t = (await w.db.query<{ id: string; name: string }>(`SELECT t.id, t.name FROM teams t JOIN scim_groups g ON g.team_id = t.id WHERE g.id = $1`, [group])).rows[0]!;
    team = t.id;
    expect(t.name).toBe('Payments Ops');
    expect(await inTeam(team, gus)).toBe(true);
    expect(await audits('scim.group_created', team)).toHaveLength(1);
    expect((await scim('GET', `/Groups?filter=${q('displayName eq "payments <ops>"')}&excludedAttributes=members`)).json()).toMatchObject({ totalResults: 1, Resources: [{ id: group }] });
    expect((await scim('GET', `/Groups?filter=${q('displayName eq "payments <ops>"')}&excludedAttributes=members`)).json().Resources[0].members).toBeUndefined();
    expect((await scim('GET', `/Users/${gus}`)).json().groups).toEqual([expect.objectContaining({ value: group, display: 'Payments <Ops>' })]);
    expect((await scim('POST', '/Groups', { displayName: 'payments <ops>' })).json()).toMatchObject({ status: '409', scimType: 'uniqueness' });
  });

  it('PATCH adds and removes members, including Entra ID\'s members[value eq "..."] path', async () => {
    let r = await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'Add', path: 'members', value: [{ value: hal }, { value: ivy }] }));
    expect(r.statusCode).toBe(200);
    expect(await inTeam(team, hal)).toBe(true);
    r = await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'Remove', path: `members[value eq "${hal}"]` }));
    expect(r.statusCode).toBe(200);
    expect(await inTeam(team, hal)).toBe(false);
    expect(await audits('team.member_removed', team)).toHaveLength(1);
    // Okta: remove with a value list; rename with a pathless replace.
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'remove', path: 'members', value: [{ value: ivy }] }, { op: 'replace', value: { id: group, displayName: 'Payments' } }));
    expect(await inTeam(team, ivy)).toBe(false);
    expect((await w.db.query(`SELECT name FROM teams WHERE id = $1`, [team])).rows[0]).toEqual({ name: 'Payments' });
  });

  it('leaving the group keeps team memberships SCIM did not create, and never leaves someone in no team', async () => {
    // Hal was put in the team by hand before the group listed him: leaving the group keeps him there.
    await w.db.query(`INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, 'member')`, [team, hal]);
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'add', path: 'members', value: [{ value: hal }] }));
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'remove', path: 'members', value: [{ value: hal }] }));
    expect(await inTeam(team, hal)).toBe(true);
    // Gus's only team would be this one: he stays in it, and that is audited.
    await w.db.query(`DELETE FROM team_members WHERE member_id = $1 AND team_id <> $2`, [gus, team]);
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'remove', path: `members[value eq "${gus}"]` }));
    expect(await inTeam(team, gus)).toBe(true);
    expect((await audits('scim.team_member_kept', team)).map((a) => a.error_type)).toEqual(['only_team']);
  });

  it('an admin links a group to an existing team and maps it to a role; leaving removes only that role', async () => {
    const other = (await api.inject({ method: 'POST', url: '/api/teams', headers: auth(w.tokens.admin), payload: { name: 'Finance' } })).json().id;
    expect((await api.inject({ method: 'PUT', url: `/api/admin/scim/groups/${group}`, headers: auth(w.tokens.alice), payload: { grantsRole: 'admin' } })).statusCode).toBe(403);
    let r = await api.inject({ method: 'PUT', url: `/api/admin/scim/groups/${group}`, headers: auth(w.tokens.admin), payload: { teamId: other, grantsRole: 'approver' } });
    expect(r.statusCode).toBe(204);
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'add', path: 'members', value: [{ value: ivy }] }));
    expect(await inTeam(other, ivy)).toBe(true);
    expect((await memberRow(ivy)).role).toBe('approver');
    // A role set by hand is kept: Hal is an approver by hand, the group grants admin, leaving it gives approver back.
    await updateMember(w.db, w.admin, hal, { role: 'approver' });
    r = await api.inject({ method: 'PUT', url: `/api/admin/scim/groups/${group}`, headers: auth(w.tokens.admin), payload: { grantsRole: 'admin' } });
    expect(r.statusCode).toBe(204);
    expect((await memberRow(ivy)).role).toBe('admin');
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'add', path: 'members', value: [{ value: hal }] }));
    expect(await memberRow(hal)).toMatchObject({ role: 'admin', manual_role: 'approver' });
    const members = (await api.inject({ method: 'GET', url: '/api/members', headers: auth(w.tokens.admin) })).json();
    expect(members.find((m: { id: string }) => m.id === hal)).toMatchObject({ scim: true, roleFromScim: true });
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'Remove', path: `members[value eq "${hal}"]` }));
    expect(await memberRow(hal)).toMatchObject({ role: 'approver', manual_role: null });
    expect(await audits('scim.role_removed', hal)).toHaveLength(1);
    // Ivy's role came only from the group.
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'Remove', path: `members[value eq "${ivy}"]` }));
    expect((await memberRow(ivy)).role).toBe('member');
  });

  it('never removes the last enabled admin: a SCIM error, nothing changed, the refusal audited', async () => {
    await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'add', path: 'members', value: [{ value: ivy }] }));
    expect((await memberRow(ivy)).role).toBe('admin');
    // Ivy becomes the only enabled admin.
    await updateMember(w.db, w.admin, w.admin.id, { disabled: true });
    const r = await scim('PATCH', `/Groups/${group}`, patchOp({ op: 'Remove', path: `members[value eq "${ivy}"]` }));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '409', scimType: 'mutability' });
    expect((await memberRow(ivy)).role).toBe('admin');
    expect((await scim('GET', `/Groups/${group}`)).json().members.some((m: { value: string }) => m.value === ivy)).toBe(true);
    expect(await audits('scim.role_remove_refused', ivy)).toEqual([{ actor_id: await tokenId(), outcome: 'denied', error_type: 'last_admin' }]);
    const off = await scim('PATCH', `/Users/${ivy}`, patchOp({ op: 'Replace', path: 'active', value: 'False' }));
    expect(off.statusCode).toBe(409);
    expect((await memberRow(ivy)).disabled).toBe(false);
    expect((await scim('DELETE', `/Users/${ivy}`)).statusCode).toBe(409);
    expect((await audits('scim.member_deactivate_refused', ivy)).map((a) => a.outcome)).toEqual(['denied']);
    await w.db.query(`UPDATE members SET disabled = false WHERE id = $1`, [w.admin.id]);
    // Recent errors are on the admin page (codes only).
    const overview = (await api.inject({ method: 'GET', url: '/api/admin/scim', headers: auth(w.tokens.admin) })).json();
    expect(overview.errors[0]).toMatchObject({ status: 409, scimType: 'mutability', code: 'last_admin' });
  });

  it('DELETE of a group removes its members from the team but keeps the team', async () => {
    const r = await scim('DELETE', `/Groups/${group}`);
    expect(r.statusCode).toBe(204);
    expect((await scim('GET', `/Groups/${group}`)).statusCode).toBe(404);
    expect((await memberRow(ivy)).role).toBe('member');
    expect((await w.db.query(`SELECT 1 FROM teams WHERE name = 'Finance'`)).rowCount).toBe(1);
  });
});

describe('linking to SSO sign-in', () => {
  it('a SCIM-created member is linked at first SSO sign-in by verified email = userName, never by an unverified one', async () => {
    const id = await create('june@acme.test');
    // No verified email (and another subject): a separate account, not June's.
    const stranger = await memberForOidc(w.db, { issuer: ISSUER, subject: 'sub-x', email: undefined });
    expect(stranger.member.id).not.toBe(id);
    const june = await memberForOidc(w.db, { issuer: ISSUER, subject: 'sub-june', email: 'june@acme.test' });
    expect(june).toMatchObject({ member: { id }, created: false });
    expect(await audits('member.sso_linked', id)).toHaveLength(1);
    // Linked once: another identity with the same email never takes it over.
    const other = await memberForOidc(w.db, { issuer: ISSUER, subject: 'sub-june-2', email: 'june@acme.test' });
    expect(other.member.id).not.toBe(id);
  });

  it("links by externalId = the subject or Entra ID's object id", async () => {
    const id = await create('kai@acme.test', { externalId: 'oid-kai' });
    expect((await memberForOidc(w.db, { issuer: ISSUER, subject: 'pairwise-sub', email: undefined, objectId: 'oid-kai' })).member.id).toBe(id);
  });

  it('never links an existing account by email: SCIM gets a uniqueness error until an admin links it', async () => {
    const lee = await memberForOidc(w.db, { issuer: ISSUER, subject: 'sub-lee', email: 'lee@acme.test' });
    const r = await scim('POST', '/Users', user('lee@acme.test'));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ scimType: 'uniqueness' });
    expect(await audits('scim.member_create_refused')).toEqual([{ actor_id: await tokenId(), outcome: 'denied', error_type: 'existing_account_not_linked' }]);
    expect((await memberRow(lee.member.id)).disabled).toBe(false);
    // The admin links Lee's account; the identity provider then finds it by userName.
    const link = await api.inject({ method: 'PUT', url: `/api/admin/scim/members/${lee.member.id}/link`, headers: auth(w.tokens.admin), payload: { userName: 'lee@acme.test' } });
    expect(link.statusCode).toBe(204);
    expect((await scim('GET', `/Users?filter=${q('userName eq "lee@acme.test"')}`)).json().Resources[0].id).toBe(lee.member.id);
  });

  it('adopts an account that signed in with the configured issuer when externalId is its subject', async () => {
    const mo = await memberForOidc(w.db, { issuer: ISSUER, subject: 'sub-mo', email: 'mo@acme.test' });
    const r = await scim('POST', '/Users', user('mo@acme.test', { externalId: 'sub-mo' }));
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBe(mo.member.id);
  });
});

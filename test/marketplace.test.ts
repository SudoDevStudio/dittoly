import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, approvedReleaseFlow, makeWorld, type World } from './helpers.js';

let w: World;
let server: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  server = buildServer(w.app);
});
afterAll(async () => {
  await server.close();
  await w.db.end();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const moduleId = async (name: string, version = '1.0.0') =>
  (await w.db.query(`SELECT id FROM module_versions WHERE name = $1 AND version = $2`, [name, version])).rows[0].id as string;

async function newGitlabVersion(version: string, approve: boolean) {
  const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'gitlab');
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.version = version;
  const mv = await w.app.modules.createDraft(
    { manifest, code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')), origin: 'seed' },
    w.alice,
  );
  if (approve) {
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
  }
  return mv;
}

describe('marketplace: modules', () => {
  it('only admins list modules, and only approved ones', async () => {
    const draft = await newGitlabVersion('1.5.0', false);
    expect((await server.inject({ method: 'POST', url: '/api/marketplace/modules', headers: auth(w.tokens.approver), payload: { moduleVersionId: await moduleId('gitlab') } })).statusCode).toBe(403);
    const unapproved = await server.inject({ method: 'POST', url: '/api/marketplace/modules', headers: auth(w.tokens.admin), payload: { moduleVersionId: draft.id } });
    expect(unapproved.json()).toEqual({ error: 'module_not_approved' });
    const ok = await server.inject({ method: 'POST', url: '/api/marketplace/modules', headers: auth(w.tokens.admin), payload: { moduleVersionId: await moduleId('gitlab'), tags: ['scm', 'release'] } });
    expect(ok.statusCode).toBe(201);
  });

  it('a module listing offers the latest approved version, never a draft', async () => {
    await newGitlabVersion('1.2.0', true);
    const list = (await server.inject({ method: 'GET', url: '/api/marketplace?kind=module&q=gitlab', headers: auth(w.tokens.bob) })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ module: 'gitlab', latest: { ref: 'gitlab@1.2.0' }, versions: ['1.0.0', '1.2.0'], tags: ['scm', 'release'], hosts: ['gitlab.com'] });
    const detail = (await server.inject({ method: 'GET', url: `/api/marketplace/${list[0].id}`, headers: auth(w.tokens.bob) })).json();
    expect(detail.review).toContain('It can only connect to: gitlab.com.');
  });

  it('shows Flows which pinned modules have newer approved versions, without changing them', async () => {
    const v = await approvedReleaseFlow(w);
    const upgrades = (await server.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/upgrades`, headers: auth(w.tokens.alice) })).json();
    expect(upgrades).toEqual([{ kind: 'module', module: 'gitlab', pinned: '1.0.0', latest: '1.2.0' }]);
    expect((await w.app.flows.getVersion(w.db, v.id))!.status).toBe('approved');
  });
});

describe('marketplace: Flow templates', () => {
  it('approvers publish an approved Flow version; members copy it into their own Flow, which still needs approval', async () => {
    const v = await approvedReleaseFlow(w);
    expect((await server.inject({ method: 'POST', url: '/api/marketplace/templates', headers: auth(w.tokens.bob), payload: { flowVersionId: v.id, title: 'Release', summary: 's' } })).statusCode).toBe(403);
    const pub = await server.inject({
      method: 'POST',
      url: '/api/marketplace/templates',
      headers: auth(w.tokens.approver),
      payload: { flowVersionId: v.id, title: 'Release coordination', summary: 'Jira, GitLab and Slack release run', tags: ['release'] },
    });
    expect(pub.statusCode).toBe(201);
    const again = await server.inject({ method: 'POST', url: '/api/marketplace/templates', headers: auth(w.tokens.approver), payload: { flowVersionId: v.id, title: 'x', summary: 'y' } });
    expect(again.json()).toEqual({ error: 'already_listed' });

    const use = await server.inject({ method: 'POST', url: `/api/marketplace/${pub.json().id}/use`, headers: auth(w.tokens.bob), payload: { name: "Bob's release" } });
    expect(use.statusCode).toBe(201);
    const copy = use.json();
    expect(copy).toMatchObject({ status: 'pending', createdBy: w.bob.id, fromTemplate: { listingId: pub.json().id, identical: true } });
    await expect(w.app.engine.startRun(copy.id, w.bob.id, {})).rejects.toMatchObject({ code: 'flow_version_not_approved' });

    // An edited copy is no longer identical to the template.
    const edited = structuredClone(copy.definition);
    edited.description = 'changed';
    const v2 = await w.app.flows.update(copy.flowId, edited, w.bob);
    expect((await w.app.flows.review(v2.id)).fromTemplate).toMatchObject({ identical: false });
  });

  it('a superseded Flow version cannot be listed, and deprecated templates cannot be used', async () => {
    const v = await approvedReleaseFlow(w);
    const pub = await w.app.marketplace.publishTemplate({ flowVersionId: v.id, title: 'Old', summary: 'old' }, w.approver);
    await w.app.flows.update(v.flowId, v.definition, w.alice);
    await expect(w.app.marketplace.publishTemplate({ flowVersionId: v.id, title: 'Old', summary: 'old' }, w.approver)).rejects.toMatchObject({
      code: 'flow_version_not_approved',
    });
    await w.app.marketplace.deprecate(pub.id, w.admin);
    await expect(w.app.marketplace.useTemplate(pub.id, w.bob)).rejects.toMatchObject({ code: 'listing_deprecated' });
    const list = await w.app.marketplace.list({ kind: 'flow_template' });
    expect(list.find((l) => l.id === pub.id)!.deprecated).toBe(true);
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { hostMatches, parseManifest } from '../src/modules/manifest.js';
import type { FetchLike } from '../src/sandbox/broker.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * What a module needs to be told belongs to the Flow, not to the module and not to an admin page: the Flow carries
 * one value per module ("moduleSettings"), a step may override it, and a run may be asked for it through the form.
 * The module's reviewed pattern is the limit in every case.
 */
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'jira');
const seen: { url: string; auth: string | null }[] = [];
const network: FetchLike = async (url, init) => {
  seen.push({ url, auth: new Headers(init.headers).get('authorization') });
  return Response.json({ issues: [{ key: 'ACME-1', fields: { summary: 'Hi', status: { name: 'Approved' } } }] });
};

let w: World;
let api: ReturnType<typeof buildServer>;
const step = (extra: object = {}) => ({ id: 'find', type: 'action', module: 'jira@1.1.0', action: 'search_issues', input: { jql: 'project = ACME' }, ...extra });
beforeAll(async () => {
  w = await makeWorld({}, { fetchImpl: network });
  api = buildServer(w.app);
  const mv = await w.app.modules.createDraft(
    {
      manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
      code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
      tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
      origin: 'seed',
    },
    w.alice,
  );
  expect(mv.validationReport?.passed).toBe(true); // sandbox tests run against the default site
  await w.app.modules.submit(mv.id, w.alice);
  await w.app.modules.decide(mv.id, w.admin, 'approved');
  await w.app.vault.put(w.alice.id, 'jira', 'alice@acme.test:token');
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});
const as = (who: keyof World['tokens']) => ({ authorization: `Bearer ${w.tokens[who]}` });
const approved = async (definition: object) => {
  const v = await w.app.flows.create(`Flow ${Math.random().toString(36).slice(2, 8)}`, definition, w.alice);
  return (await w.app.flows.decide(v.id, w.approver, 'approved')).id;
};

describe('what a module is told comes from the Flow', () => {
  it('a host setting may only be what the reviewed pattern allows', () => {
    expect(hostMatches('*.atlassian.net', 'acme.atlassian.net')).toBe(true);
    // "**." takes one or more labels (Atlas: cluster0.abcde.mongodb.net), never zero.
    expect(hostMatches('**.mongodb.net', 'cluster0.abcde.mongodb.net')).toBe(true);
    expect(hostMatches('**.mongodb.net', 'mongodb.net')).toBe(false);
    expect(hostMatches('**.mongodb.net', 'a..mongodb.net')).toBe(false);
    expect(hostMatches('**.mongodb.net', 'x.mongodb.net.evil.com')).toBe(false);
    for (const bad of ['atlassian.net', 'a.b.atlassian.net', 'acme.atlassian.net.evil.com', 'evil.com', 'ACME.atlassian.net']) {
      expect(hostMatches('*.atlassian.net', bad)).toBe(false);
    }
    const base = { name: 'x', version: '1.0.0', title: 'X', description: 'X.', credentials: [], actions: [{ name: 'a', title: 'A', description: 'A.', effect: 'read', credentials: [], input: {}, output: {} }] };
    expect(parseManifest({ ...base, hosts: ['{{settings.site}}'] }).ok).toBe(false);
    expect(parseManifest({ ...base, hosts: ['{{settings.site}}'], settings: [{ id: 'site', type: 'host', label: 'Site', pattern: '*.atlassian.net', default: 'evil.com' }] }).ok).toBe(false);
  });

  it('a Flow that says nothing about the site is not saved at all, so no run can reach the wrong app', async () => {
    await expect(w.app.flows.create('No site', { steps: [step()] }, w.alice)).rejects.toThrow(/needs the setting "site"/);
    // Nor may it name a site the module's reviewed pattern does not allow, or a setting the module does not have.
    await expect(w.app.flows.create('Evil site', { moduleSettings: { jira: { site: 'evil.com' } }, steps: [step()] }, w.alice)).rejects.toThrow(/must be a host matching \*\.atlassian\.net/);
    await expect(w.app.flows.create('Odd setting', { moduleSettings: { jira: { site: 'acme.atlassian.net', nope: 'x' } }, steps: [step()] }, w.alice)).rejects.toThrow(/no setting "nope"/);
    expect(seen).toHaveLength(0);
  });

  it("the Flow's value is tidied once, read back on the review page, and used by its runs", async () => {
    const versionId = await approved({ moduleSettings: { jira: { site: ' Acme.Atlassian.NET ' } }, steps: [step()] });
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: as('alice') })).json();
    expect(review.summary).toContain('Hosts: acme.atlassian.net.');
    expect(review.summary).toContain('Told: Your Jira Cloud site: acme.atlassian.net');

    const run = await w.app.engine.startRun(versionId, w.alice.id, {});
    await w.app.worker.drain();
    expect((await runStatus(w, run, w.alice)).steps[0]).toMatchObject({ status: 'succeeded' });
    expect(seen.at(-1)!.url).toMatch(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/search\/jql\?/);
    expect(seen.at(-1)!.auth).toBe(`Basic ${Buffer.from('alice@acme.test:token').toString('base64')}`);
  });

  it('a step may be told something else than the rest of the Flow', async () => {
    const versionId = await approved({
      moduleSettings: { jira: { site: 'acme.atlassian.net' } },
      steps: [step({ settings: { site: 'payments.atlassian.net' } })],
    });
    await w.app.engine.startRun(versionId, w.alice.id, {});
    await w.app.worker.drain();
    expect(new URL(seen.at(-1)!.url).host).toBe('payments.atlassian.net');
  });

  it('the run may be asked for the site; what it answers is still held to the pattern', async () => {
    const versionId = await approved({
      inputs: { type: 'object', properties: { site: { type: 'string' } }, required: ['site'] },
      moduleSettings: { jira: { site: '{{ inputs.site }}' } },
      steps: [step()],
    });
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: as('alice') })).json();
    expect(review.summary).toContain('chosen when the run starts ({{ inputs.site }})');

    const ok = await w.app.engine.startRun(versionId, w.alice.id, { site: 'payments.atlassian.net' });
    await w.app.worker.drain();
    expect((await runStatus(w, ok, w.alice)).steps[0]).toMatchObject({ status: 'succeeded' });
    expect(new URL(seen.at(-1)!.url).host).toBe('payments.atlassian.net');

    const before = seen.length;
    const bad = await w.app.engine.startRun(versionId, w.alice.id, { site: 'evil.example' });
    await w.app.worker.drain();
    expect((await runStatus(w, bad, w.alice)).steps[0]).toMatchObject({ status: 'failed', errorType: 'host_not_allowed' });
    expect(seen).toHaveLength(before); // nothing was sent anywhere
  });

  it('a text setting falls back to what the module declares, and keeps its case (a project key like ACME)', async () => {
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.version = '1.9.0';
    manifest.settings.push({ id: 'project', type: 'text', label: 'Project key', default: 'DEMO' });
    const mv = await w.app.modules.createDraft(
      { manifest, code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')), origin: 'seed' },
      w.alice,
    );
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
    const versionId = await approved({
      moduleSettings: { jira: { site: 'acme.atlassian.net', project: ' ACME ' } },
      steps: [step({ module: 'jira@1.9.0' })],
    });
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${versionId}/review`, headers: as('alice') })).json();
    expect(review.summary).toContain('Told: Your Jira Cloud site: acme.atlassian.net; Project key: ACME');
    // Saying nothing about it is fine: the module's own default stands.
    const other = await approved({ moduleSettings: { jira: { site: 'acme.atlassian.net' } }, steps: [step({ module: 'jira@1.9.0' })] });
    expect((await api.inject({ method: 'GET', url: `/api/flow-versions/${other}/review`, headers: as('alice') })).json().summary).not.toContain('Project key');
  });
});

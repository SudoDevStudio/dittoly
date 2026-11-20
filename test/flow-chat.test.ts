import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, makeWorld, releaseFlow, type World } from './helpers.js';

const ai = new MockProvider();
let w: World;
let server: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  server = buildServer(w.app);
});
afterAll(async () => {
  await server.close();
  await w.db.end();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const answer = (definition: unknown, name = 'Release coordination') => ({
  name,
  definitionJson: JSON.stringify(definition),
  explanation: 'Finds approved tickets and ready merge requests, asks for sign-off, merges, and posts to Slack.',
});

describe('chat creation of Flows', () => {
  it('drafts a pending Flow from plain language using only approved modules', async () => {
    // An unapproved module must not appear in the catalog the AI sees.
    const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.version = '9.9.9';
    await w.app.modules.createDraft({ manifest, code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), tests: [], origin: 'seed' }, w.alice);

    ai.enqueue(answer((await releaseFlow()).definition));
    const res = await server.inject({
      method: 'POST',
      url: '/api/flows/generate',
      headers: auth(w.tokens.alice),
      payload: { request: 'gather approved Jira tickets, merge ready MRs, notify the channel' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.explanation).toContain('merges');
    expect(body.summary).toContain('GitLab "Merge a merge request" CHANGES data once for each item in steps.mrs.output.mergeRequests');
    expect(body.summary).toContain("using the runner's own gitlab access");
    expect(body.summary).toContain('waits for an approver to sign off');

    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain('gitlab@1.0.0 merge_merge_request (write; needs gitlab key)');
    expect(prompt).not.toContain('slack@9.9.9');

    // Drafting never approves: the version still needs an approver.
    await expect(w.app.engine.startRun(body.id, w.alice.id, {})).rejects.toMatchObject({ code: 'flow_version_not_approved' });
  });

  it('sends validation problems back to the AI once, then saves the repaired draft', async () => {
    const good = (await releaseFlow()).definition as { steps: { id: string; input?: Record<string, unknown> }[] };
    const broken = structuredClone(good);
    delete broken.steps.find((s) => s.id === 'mrs')!.input!.project;
    ai.enqueue(answer(broken));
    ai.enqueue(answer(good));
    const before = ai.requests.length;
    const res = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'release' } });
    expect(res.statusCode).toBe(201);
    expect(ai.requests.length - before).toBe(2);
    expect(ai.requests.at(-1)!.prompt).toContain('missing input "project" required by gitlab@1.0.0 list_merge_requests');
  });

  it('drafts a Flow around one approved module when asked from its page', async () => {
    ai.enqueue(answer((await releaseFlow()).definition));
    const res = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'merge what is ready', module: 'gitlab' } });
    expect(res.statusCode).toBe(201);
    expect(ai.requests.at(-1)!.prompt).toMatch(/Build this Flow around the approved module gitlab@\d+\.\d+\.\d+ \("GitLab"\): use its actions \([a-z_, ]*merge_merge_request/);
    // Only an approved module: a name with no approved version is refused before any AI call.
    const before = ai.requests.length;
    const none = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'x', module: 'no-such-module' } });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('module_not_approved');
    expect(ai.requests.length).toBe(before);
  });

  it('when the AI gives no Flow (a module lacks what it needs), answers with the reason and the choices, not an error', async () => {
    const missing = [
      { capability: 'read existing merge request comments', moduleRequest: 'An action that lists all comments of a merge request', module: 'gitlab@1.0.0' },
      { capability: 'send email', moduleRequest: 'Send email through our SMTP server', module: 'mailer' },
    ];
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Review MRs.', category: 'web_api', protocols: [], questions: [], missing }) });
    ai.enqueue({ name: 'MR review', definitionJson: 'null', explanation: 'gitlab cannot list a merge request\'s comments.' });
    const before = ai.requests.length;
    const res = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'review MRs, skip duplicates', answers: {} } });
    expect(res.statusCode).toBe(200);
    // "Add it to <module>" only for an approved module (its version dropped); an unknown one is left out.
    expect(res.json()).toEqual({
      cannotDraft: true,
      reason: "gitlab cannot list a merge request's comments.",
      missing: [{ ...missing[0], module: 'gitlab' }, { capability: 'send email', moduleRequest: 'Send email through our SMTP server' }],
    });
    // No repair round for a draft that is not there.
    expect(ai.requests.length - before).toBe(1);
  });

  it('an empty definition is read the same way', async () => {
    ai.enqueue({ name: 'PR review', definitionJson: '', explanation: 'Reading a GitHub pull request needs a module that is not approved yet.' });
    const res = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'review GitHub PRs' } });
    expect(res.json()).toMatchObject({ cannotDraft: true, reason: expect.stringContaining('needs a module that is not approved yet'), missing: [] });
  });

  it('"draft without it": the parts are left out on purpose, not asked about again, and the Flow says what it leaves out', async () => {
    // The check would flag the same missing part again; with leaveOut it is the person's choice and drafting goes ahead.
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Release.', category: 'web_api', protocols: [], questions: [], missing: [{ capability: 'skip duplicate comments', moduleRequest: 'x' }] }) });
    ai.enqueue(answer((await releaseFlow()).definition));
    const res = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'merge ready MRs', leaveOut: ['skip duplicate comments'] } });
    expect(res.statusCode).toBe(201);
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain('LEAVE OUT (the person chose to draft without these, because no approved action can do them yet):\n- skip duplicate comments');
    expect(prompt).toContain('Start the Flow\'s "description" with "Leaves out: "');
  });

  it('a plan item the AI cannot draft fails with the reason, as before', async () => {
    const { notDraftedError } = await import('../src/flows/chat.js');
    const e = notDraftedError({ reason: 'No module reads PR comments.', missing: [{ capability: 'read PR comments', moduleRequest: 'x', module: 'github' }] });
    expect(e).toMatchObject({ code: 'flow_not_drafted', message: 'The AI could not draft this Flow: No module reads PR comments. Build and approve these first: read PR comments (add it to github).' });
  });

  it('reports a draft that is still invalid after two repair rounds', async () => {
    for (let i = 0; i < 3; i++) ai.enqueue(answer({ steps: [{ id: 'x', type: 'action', module: 'nope@1.0.0', action: 'a', input: {} }] }));
    const res = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: auth(w.tokens.alice), payload: { request: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_module');
  });

  it('a chat revision is a new version and cancels the earlier approval', async () => {
    const f = await releaseFlow();
    const v1 = await w.app.flows.create(f.name, f.definition, w.alice);
    await w.app.flows.decide(v1.id, w.approver, 'approved');
    const changed = structuredClone(f.definition) as { steps: { id: string; input?: Record<string, unknown> }[] };
    changed.steps.find((s) => s.id === 'announce')!.input!.text = 'Release {{ inputs.release }} is out.';
    ai.enqueue(answer(changed));
    const res = await server.inject({
      method: 'POST',
      url: `/api/flows/${v1.flowId}/revise`,
      headers: auth(w.tokens.alice),
      payload: { feedback: 'shorter Slack message' },
    });
    expect(res.json()).toMatchObject({ version: 2, status: 'pending' });
    expect((await w.app.flows.getVersion(w.db, v1.id))!.status).toBe('superseded');
    expect((await server.inject({ method: 'POST', url: `/api/flows/${v1.flowId}/revise`, headers: auth(w.tokens.bob), payload: { feedback: 'x' } })).statusCode).toBe(403);
  });
});

describe('static checks on every Flow', () => {
  const base = async () => structuredClone((await releaseFlow()).definition) as {
    inputs: { properties: Record<string, unknown> };
    steps: { id: string; input?: Record<string, unknown>; forEach?: string }[];
  };

  it.each([
    ['a missing required input', (d: Awaited<ReturnType<typeof base>>) => void delete d.steps[0]!.input!.jql, 'missing input "jql"'],
    ['an input the action does not have', (d: Awaited<ReturnType<typeof base>>) => void (d.steps[0]!.input!.extra = 1), 'has no input "extra"'],
    ['an undeclared Flow input', (d: Awaited<ReturnType<typeof base>>) => void (d.steps[0]!.input!.jql = '{{ inputs.nope }}'), '"inputs.nope" is not a declared Flow input'],
    ['item outside forEach', (d: Awaited<ReturnType<typeof base>>) => void (d.steps[0]!.input!.jql = '{{ item.key }}'), '"item" is only available inside forEach'],
  ])('rejects %s', async (_name, mutate, message) => {
    const d = await base();
    mutate(d);
    await expect(w.app.flows.create('bad', d, w.alice)).rejects.toMatchObject({ code: 'invalid_flow', message: expect.stringContaining(message) });
  });
});

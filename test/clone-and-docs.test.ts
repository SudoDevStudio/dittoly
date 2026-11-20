import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePlan } from '../src/ai/plan.js';
import { MockProvider } from '../src/ai/provider.js';
import { docsFromAnswers } from '../src/modules/chat.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * Building something new never changes what is approved: a module that must work differently is a clone (a new
 * module from a copy, the original untouched), and a new process close to an approved Flow is a new Flow from a copy
 * of it. And a module is built from documentation: when the AI cannot find it, it asks for it.
 */
const ai = new MockProvider();
let w: World;
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
});
afterAll(async () => {
  await w.db.end();
});
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

describe('clone instead of changing what is approved', () => {
  it('the planner may extend or clone a module, and start a Flow from an approved one it may use', () => {
    const approved = [{ flow: '11111111-1111-1111-1111-111111111111', name: 'Notify', version: 2, description: 'Posts.' }];
    const out = parsePlan(
      {
        planJson: JSON.stringify({
          title: 'T', summary: 'S', questions: [],
          modules: [
            { key: 'slack_threads', title: 'Slack threads', request: 'Reply in threads.', clones: 'slack@1.0.0' },
            { key: 'slack_more', title: 'More Slack', request: 'Add an action.', extends: 'slack', clones: 'slack' },
            { key: 'jira_more', title: 'More Jira', request: 'Add an action.', extends: 'jira' },
          ],
          flows: [
            { key: 'notify_team', title: 'Notify the team', request: 'Like Notify, but in a thread.', needs: [], from: { flow: approved[0]!.flow, version: 2 } },
            { key: 'made_up', title: 'Made up', request: 'x', needs: [], from: { flow: '22222222-2222-2222-2222-222222222222', version: 1 } },
          ],
        }),
      },
      approved,
    );
    if ('error' in out) throw new Error(out.error);
    expect(out.plan.modules.map((m) => [m.key, m.extends ?? null, m.clones ?? null])).toEqual([
      ['slack_threads', null, 'slack'],
      ['slack_more', null, 'slack'], // cloning wins: the original stays as it is
      ['jira_more', 'jira', null],
    ]);
    expect(out.plan.flows.map((f) => f.from ?? null)).toEqual([{ flow: approved[0]!.flow, version: 2 }, null]);
  });

  it('a cloned module is a new module with its own name from 1.0.0; the original is untouched', async () => {
    const before = (await w.app.modules.list()).filter((m) => m.name === 'slack').length;
    ai.enqueue({
      manifestJson: await readFile(path.join(dir, 'manifest.json'), 'utf8'), // the AI kept the old name: Dittoly renames it
      configJson: '', code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
      testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8'), sourcesJson: '[]', notesMd: '',
    });
    const draft = await w.app.moduleChat.clone('slack', 'Post replies in threads.', w.alice, 'slack-threads');
    expect(draft).toMatchObject({ name: 'slack-threads', version: '1.0.0' });
    expect(draft.generation?.cloneOf).toEqual({ module: 'slack', version: '1.0.0' });
    expect(ai.requests.at(-1)!.prompt).toContain('Make a NEW module named "slack-threads", starting from the module "slack" below (it stays as it is');
    expect((await w.app.modules.list()).filter((m) => m.name === 'slack').length).toBe(before);
    // A name already taken gets a free one.
    ai.enqueue({ manifestJson: await readFile(path.join(dir, 'manifest.json'), 'utf8'), configJson: '', code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8'), sourcesJson: '[]', notesMd: '' });
    expect((await w.app.moduleChat.clone('slack', 'Again.', w.alice, 'slack-threads')).name).toBe('slack-threads-2');
    await expect(w.app.moduleChat.clone('no-such', 'x', w.alice, 'y')).rejects.toMatchObject({ code: 'module_not_approved' });
  });

  it('a new Flow from a copy of an approved one: the AI starts from its definition; the original keeps its versions', async () => {
    const def = { description: 'Posts a note.', inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C1', text: 'hi' } }] };
    const original = await w.app.flows.create('Post a note', def, w.alice);
    await w.app.flows.decide(original.id, w.approver, 'approved');
    expect((await w.app.flowChat.flowCatalog(w.alice)).map((f) => [f.flow, f.version])).toContainEqual([original.flowId, 1]);
    const changed = { ...def, steps: [{ ...def.steps[0]!, input: { channel: 'C2', text: 'hello' } }] };
    ai.enqueue({ name: 'Post a note elsewhere', definitionJson: JSON.stringify(changed), explanation: 'Posts to C2.', missingJson: '[]', splitJson: '[]', sourcesJson: '[]', notesMd: '' });
    const out = await w.app.flowChat.draft('Post to C2 instead', w.alice, {}, undefined, undefined, undefined, { flowId: original.flowId, version: 1 });
    if (!('version' in out)) throw new Error(JSON.stringify(out));
    expect(out.version.flowId).not.toBe(original.flowId);
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toMatch(/REVISE THIS EARLIER DRAFT:\n\{.*"description":"Posts a note\."/);
    expect(prompt).toContain('Build a NEW Flow from a copy of it (the original stays as it is)');
    expect((await w.app.flows.review(out.version.id)).generation).toMatchObject({ cloneOf: { flowId: original.flowId, version: 1, name: 'Post a note' } });
    expect(await w.app.flows.versions(original.flowId)).toHaveLength(1);
  });
});

describe('documentation, not guesses', () => {
  it('the module classifier is told to ask for docs it cannot find, as "api_docs"', async () => {
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Acme invoices.', category: 'web_api', protocols: ['rest'], questions: [{ id: 'api_docs', question: "Share a link to Acme's API documentation for invoices.", options: [] }] }) });
    const out = await w.app.moduleChat.generate('List Acme invoices', w.alice);
    expect(out).toMatchObject({ questions: { questions: [{ id: 'api_docs' }] } });
    expect(ai.classifications.at(-1)!.system).toContain('DOCUMENTATION: the module is built only from documentation, never from guesses.');
  });

  it('the docs the person gives become the API source: a link is read, pasted text is used', () => {
    expect(docsFromAnswers({ api_docs: 'https://developer.acme.example/api' })).toEqual({ docsUrl: 'https://developer.acme.example/api' });
    expect(docsFromAnswers({ "Share a link to Acme's API documentation": 'GET /v1/invoices returns { items: [...] } and needs a bearer token.' })).toEqual({ docs: 'GET /v1/invoices returns { items: [...] } and needs a bearer token.' });
    expect(docsFromAnswers({ api_docs: 'idk' })).toBeUndefined();
    expect(docsFromAnswers({ which_service: 'https://x.example' })).toBeUndefined();
    expect(docsFromAnswers(undefined)).toBeUndefined();
  });
});

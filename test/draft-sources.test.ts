import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider, SOURCES } from '../src/ai/provider.js';
import { approveExampleModules, makeWorld, runStatus, type World } from './helpers.js';

/**
 * Drafting reads current third-party docs: every drafting call may search the web (runs never do), and the pages a
 * draft is based on are kept with it for the reviewer: those its search read, and those the AI names.
 */
const ai = new MockProvider();
let w: World;
const slack = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
});
afterAll(async () => {
  await w.db.end();
});

describe('sources of a draft', () => {
  it('a module keeps the pages its search read and the ones the AI names; each drafting call may search', async () => {
    const manifest = JSON.parse(await readFile(path.join(slack, 'manifest.json'), 'utf8'));
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'Posts to Slack.', category: 'web_api', protocols: ['rest'], questions: [] }) });
    ai.enqueue({
      manifestJson: JSON.stringify({ ...manifest, name: 'slack-sourced', title: 'Slack sourced' }),
      code: await readFile(path.join(slack, 'module.mjs'), 'utf8'),
      testsJson: await readFile(path.join(slack, 'tests.json'), 'utf8'),
      sourcesJson: JSON.stringify([{ url: 'https://docs.slack.dev/reference/methods/chat.postMessage', title: 'chat.postMessage' }, { url: 'not a url' }]),
      [SOURCES]: [{ url: 'https://docs.slack.dev/reference/methods/chat.delete', title: 'chat.delete' }, { url: 'https://docs.slack.dev/reference/methods/chat.postMessage' }],
    });
    const before = ai.requests.length;
    const out = await w.app.moduleChat.generate('Slack: post and delete messages (write).', w.alice);
    if (!('draft' in out)) throw new Error('asked questions');
    expect(out.draft.generation?.sources).toEqual([
      { url: 'https://docs.slack.dev/reference/methods/chat.delete', title: 'chat.delete', via: 'search' },
      { url: 'https://docs.slack.dev/reference/methods/chat.postMessage', via: 'search' },
    ]);
    expect(ai.requests.slice(before).every((r) => r.webSearch === true)).toBe(true);
    expect(ai.classifications.at(-1)!.webSearch).toBe(true);
  });

  it('a Flow keeps them too; an AI step in a run never searches', async () => {
    const flow = { steps: [{ id: 'note', type: 'ai', ai: 'organization', instruction: 'Write a note.', input: {} }] };
    ai.enqueue({ name: 'Note', definitionJson: JSON.stringify(flow), explanation: 'Writes a note.', missingJson: '[]', sourcesJson: JSON.stringify([{ url: 'https://example.com/limits', title: 'Limits' }]) });
    const out = await w.app.flowChat.draft('Write a note.', w.alice, {});
    if (!('version' in out)) throw new Error('not drafted');
    const generation = (await w.db.query(`SELECT generation FROM flow_versions WHERE id = $1`, [out.version.id])).rows[0].generation;
    expect(generation.sources).toEqual([{ url: 'https://example.com/limits', title: 'Limits', via: 'ai' }]);
    expect(ai.requests.at(-1)!.webSearch).toBe(true);

    await w.app.flows.decide(out.version.id, w.approver, 'approved');
    ai.enqueue({ text: 'A note.' });
    const runId = await w.app.engine.startRun(out.version.id, w.alice.id, {});
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).status).toBe('succeeded');
    expect(ai.requests.at(-1)!.webSearch).toBeUndefined();
  });
});

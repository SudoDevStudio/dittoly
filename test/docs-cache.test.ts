import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocsCache, withDocsKey } from '../src/ai/docs-cache.js';
import { codexPage, MockProvider, SOURCES } from '../src/ai/provider.js';
import { makeWorld, type World } from './helpers.js';

/**
 * The docs the AI found while drafting a module are read once by Dittoly and kept: the rounds that fix the draft and
 * a "Try again" on the same plan item use them with web search off, and they are dropped once the module is created.
 */
const ai = new MockProvider();
let w: World;
beforeAll(async () => {
  w = await makeWorld({}, { ai });
});
afterAll(async () => {
  await w.db.end();
});

const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
const config = {
  baseUrl: 'https://slack.com/api',
  actions: { post_message: { kind: 'http', call: 'POST /chat.postMessage' }, delete_message: { kind: 'http', call: 'POST /chat.delete' } },
};
// Leaves delete_message out: the draft goes back once to fix its config.
const wrong = { actions: { post_message: { kind: 'http', call: 'POST /chat.postMessage' } } };
const answer = async (c: unknown = config) => ({
  manifestJson: await readFile(path.join(dir, 'manifest.json'), 'utf8'),
  configJson: JSON.stringify(c),
  code: await readFile(path.join(import.meta.dirname, 'fixtures', 'slack-on-base.ts.txt'), 'utf8'),
  testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8'),
  sourcesJson: '[]',
  notesMd: '',
});
const PAGE = 'https://docs.example.com/slack/chat.postMessage';
const drafts = () => ai.requests.filter((r) => 'manifestJson' in ((r.schema as { properties?: object }).properties ?? {}));

describe('docs found while drafting a module', () => {
  beforeAll(() => {
    w.fake.pages[PAGE] = '<html><body><h1>chat.postMessage</h1><p>POST https://slack.com/api/chat.postMessage sends a message to a channel. Arguments: channel, text.</p></body></html>';
  });

  it('are read once; the round that fixes the draft uses them and does not search again; gone once it is created', async () => {
    ai.enqueue({ ...(await answer(wrong)), [SOURCES]: [{ url: PAGE }] });
    ai.enqueue(await answer());
    await w.app.moduleChat.generate('Post messages to Slack and delete them', w.alice);
    const [first, fix] = drafts().slice(-2);
    expect(first!.webSearch).toBe(true);
    expect(fix!.webSearch).toBe(false);
    expect(fix!.prompt).toContain(`Page: ${PAGE}`);
    expect(fix!.prompt).toContain('sends a message to a channel');
    expect(w.fake.calls.filter((c) => c.url === PAGE)).toHaveLength(1);
    // Created: the next draft of the same request searches afresh.
    ai.enqueue(await answer());
    await w.app.moduleChat.generate('Post messages to Slack and delete them', w.alice);
    expect(drafts().at(-1)!.webSearch).toBe(true);
    expect(ai.clear()).toBe(0);
  });

  it('"Try again" on the same plan item starts from them, with web search off', async () => {
    ai.enqueue({ ...(await answer(wrong)), [SOURCES]: [{ url: PAGE }] });
    ai.fail('ai_unavailable');
    await expect(withDocsKey('plan-item:t1', () => w.app.moduleChat.generate('Post to Slack, first try', w.alice))).rejects.toThrow();
    ai.enqueue(await answer());
    // The request may change (details added); the item's docs stay.
    await withDocsKey('plan-item:t1', () => w.app.moduleChat.generate('Post to Slack, first try, with details', w.alice));
    const again = drafts().at(-1)!;
    expect(again.webSearch).toBe(false);
    expect(again.prompt).toContain(`Page: ${PAGE}`);
    expect(ai.classifications.at(-1)!.prompt).toContain('sends a message to a channel');
    expect(ai.clear()).toBe(0);
  });

  it('keep at most so many, for an hour', () => {
    const c = new DocsCache(1000, 2);
    c.set('a', '1');
    c.set('b', '2');
    c.set('c', '3');
    expect([c.get('a'), c.get('b'), c.get('c')]).toEqual([undefined, '2', '3']);
    const old = new DocsCache(-1);
    old.set('a', '1');
    expect(old.get('a')).toBeUndefined();
  });

  it('a page Codex opened while searching is kept as a source', () => {
    expect(codexPage(JSON.stringify({ type: 'item.completed', item: { type: 'web_search', query: '', action: { type: 'open_page', url: PAGE } } }))).toBe(PAGE);
    expect(codexPage(JSON.stringify({ type: 'item.completed', item: { type: 'web_search', query: 'slack post message' } }))).toBeUndefined();
    expect(codexPage('nope')).toBeUndefined();
  });
});

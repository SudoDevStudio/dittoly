import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIVITY, HOLD, MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { makeWorld, pdfOf, type World } from './helpers.js';

/**
 * Nobody is asked to make a table: a module declares the table it needs with its columns, and approving the module
 * creates it in the module's team. The live build panel reads what the AI is building now.
 */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const manifest = {
  name: 'video-memory', version: '1.0.0', title: 'Video memory', description: 'Remembers posted videos. Needs no key.',
  hosts: [], credentials: [],
  actions: [{ name: 'remember', title: 'Remember', description: 'Keeps the last video.', effect: 'write', credentials: [],
    input: { type: 'object', properties: { channel: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' }, video: { type: 'string', maxLength: 40 } }, required: ['channel', 'video'], additionalProperties: false },
    output: { type: 'object' } }],
};
const code = `export const actions = { async remember(input) { return { ok: true, channel: input.channel }; } };`;
const tests = [{ name: 'remembers', action: 'remember', input: { channel: 'UC1', video: 'abc' } }];

describe('the live build panel', () => {
  it('lists what the AI is building for this person, and only theirs', async () => {
    const res = await api.inject({ method: 'POST', url: '/api/plans', headers: auth(w.tokens.alice), payload: { fileName: 'live.pdf', pdfBase64: pdfOf(['Live plan', 'Post release notes to the team chat when a release is approved.']).toString('base64') } });
    expect(res.statusCode).toBe(201);
    ai.enqueue({ planJson: JSON.stringify({ title: 'Live', summary: 'S', questions: [], modules: [{ key: 'chat_notes', title: 'Chat notes', request: 'Post to a channel.' }], flows: [] }) });
    // Read the plan (and whatever else is due); the module's draft then fails for want of a mock answer, which is fine
    // here: what matters is that the item is listed with its state.
    await w.app.worker.drain();
    ai.clear();
    const live = (await api.inject({ method: 'GET', url: '/api/builds/live', headers: auth(w.tokens.alice) })).json();
    expect(live).toEqual([expect.objectContaining({ kind: 'module', title: 'Chat notes', planTitle: 'live', status: expect.any(String) })]);
    expect((await api.inject({ method: 'GET', url: '/api/builds/live', headers: auth(w.tokens.bob) })).json()).toEqual([]);
  });
});

describe('what the AI is doing while it drafts', () => {
  it('shows the step, since when, and its latest activity (kept encrypted); cleared once drafted', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const res = await api.inject({ method: 'POST', url: '/api/plans', headers: auth(w.tokens.alice), payload: { fileName: 'watch.pdf', pdfBase64: pdfOf(['Watch plan', 'Remember the last video posted per channel.']).toString('base64') } });
    expect(res.statusCode).toBe(201);
    ai.enqueue({ planJson: JSON.stringify({ title: 'Watch', summary: 'S', questions: [], modules: [{ key: 'video_memory_two', title: 'Video memory two', request: 'Remember the last video per channel.' }], flows: [] }) });
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, name: 'video-memory-two' }), configJson: '', code, testsJson: JSON.stringify(tests), sourcesJson: '[]', notesMd: '', [ACTIVITY]: ['searching the web: **YouTube** channel feed'], [HOLD]: hold });
    const draining = w.app.worker.drain();
    type Item = { title: string; status: string; progress: { step: string; since: string | null; detail: string | null; detailAt: string | null } | null };
    let item: Item | undefined;
    for (let i = 0; i < 100 && !item?.progress?.detail; i++) {
      await new Promise((r) => setTimeout(r, 50));
      item = ((await api.inject({ method: 'GET', url: '/api/builds/live', headers: auth(w.tokens.alice) })).json() as Item[]).find((x) => x.title === 'Video memory two');
    }
    expect(item?.status).toBe('drafting');
    expect(item?.progress).toEqual(expect.objectContaining({ step: 'drafting', detail: 'searching the web: YouTube channel feed', since: expect.any(String), detailAt: expect.any(String) }));
    // Like the item's request, the activity can echo the plan, so it is stored encrypted.
    const raw = (await w.db.query<{ progress_detail_enc: string }>(`SELECT progress_detail_enc FROM plan_items WHERE title = 'Video memory two'`)).rows[0]!.progress_detail_enc;
    expect(raw).not.toContain('YouTube');
    release();
    await draining;
    const after = (await w.db.query(`SELECT progress_step, progress_at, progress_detail_enc, progress_detail_at FROM plan_items WHERE title = 'Video memory two'`)).rows[0];
    expect(after).toEqual({ progress_step: null, progress_at: null, progress_detail_enc: null, progress_detail_at: null });
    ai.clear();
  });
});

describe('the Building page', () => {
  it('lists a module drafted from chat while the AI works (in Live too); approvers may see everyone\'s; gone when done', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'x', category: 'web_api', protocols: ['rest'], questions: [] }) });
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, name: 'video-memory-three' }), configJson: '', code, testsJson: JSON.stringify(tests), sourcesJson: '[]', notesMd: '', [ACTIVITY]: ['reading the API docs'], [HOLD]: hold });
    const drafting = api.inject({ method: 'POST', url: '/api/modules/generate', headers: auth(w.tokens.alice), payload: { request: 'Remember the newest video of each channel' } });
    type B = { title: string; kind: string; source: string; by: string | null; progress: { step: string; detail: string | null } | null };
    const builds = async (token: string, scope = '') => (await api.inject({ method: 'GET', url: `/api/builds${scope}`, headers: auth(token) })).json() as { builds: B[] };
    let mine: B | undefined;
    for (let i = 0; i < 100 && !mine?.progress?.detail; i++) {
      await new Promise((r) => setTimeout(r, 50));
      mine = (await builds(w.tokens.alice)).builds.find((b) => b.title === 'Remember the newest video of each channel');
    }
    expect(mine).toMatchObject({ kind: 'module', source: 'chat', progress: { step: 'drafting', detail: 'reading the API docs' } });
    // In the Live panel too.
    const live = (await api.inject({ method: 'GET', url: '/api/builds/live', headers: auth(w.tokens.alice) })).json() as { title: string; status: string }[];
    expect(live).toContainEqual(expect.objectContaining({ title: 'Remember the newest video of each channel', status: 'drafting' }));
    // Not bob's; bob may not look at everyone's; an approver may, and sees whose it is.
    expect((await builds(w.tokens.bob)).builds.some((b) => b.title.startsWith('Remember the newest'))).toBe(false);
    expect((await api.inject({ method: 'GET', url: '/api/builds?scope=all', headers: auth(w.tokens.bob) })).statusCode).toBe(403);
    expect((await builds(w.tokens.approver, '?scope=all')).builds).toContainEqual(expect.objectContaining({ title: 'Remember the newest video of each channel', by: 'alice' }));
    // The request and the activity are stored encrypted.
    expect(JSON.stringify((await w.db.query(`SELECT title_enc, detail_enc FROM ai_builds`)).rows)).not.toContain('newest video');
    release();
    expect((await drafting).statusCode).toBe(201);
    expect((await builds(w.tokens.alice)).builds.some((b) => b.title.startsWith('Remember the newest'))).toBe(false);
    expect((await w.db.query(`SELECT 1 FROM ai_builds`)).rowCount).toBe(0);
    ai.clear();
  });
});

describe('questions in plain words', () => {
  it('the classifier is told to ask in everyday words and never about tables', async () => {
    ai.enqueue({ classificationJson: JSON.stringify({ summary: 'x', category: 'web_api', protocols: ['rest'], questions: [] }) });
    ai.enqueue({ manifestJson: JSON.stringify(manifest), configJson: '', code, testsJson: JSON.stringify(tests), sourcesJson: '[]', notesMd: '' });
    await w.app.moduleChat.generate('Remember the last video per channel', w.alice);
    const system = ai.classifications.at(-1)!.system;
    expect(system).toContain('HOW TO ASK: the person is not a developer.');
    expect(system).toContain('Never ask about\nstorage, tables, keys or columns');
  });
});

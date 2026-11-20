import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatText } from '../src/ai/plan-chat.js';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { createTeam, setTeamMember } from '../src/core/teams.js';
import { purgeExpiredChats } from '../src/plans/chats.js';
import { makeWorld, type World } from './helpers.js';

/**
 * The home chat: the AI answers and shows its whole plan each turn (nothing is stored or built), and "Build it"
 * turns the plan the person saw into a plan that drafts at once, like a PDF plan after its questions.
 */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const plan = (p: Record<string, unknown> = {}) => ({
  title: 'Release notes',
  summary: 'Posts the release notes to chat when a release is approved. Assuming: Slack; the #release channel; no sign-off',
  questions: [],
  modules: [{ key: 'chat_notes', title: 'Chat notes', request: 'Slack: post a message to a channel (write).' }],
  flows: [{ key: 'notes', title: 'Post release notes', request: 'A person starts it with the notes; 1 post them to #release (chat_notes post_message).', needs: ['chat_notes'] }],
  reuse: [],
  superFlow: null,
  ...p,
});
const turn = (reply: string, p: Record<string, unknown> | null = {}) => ({ reply, planJson: JSON.stringify(p === null ? { title: '', summary: '', questions: [], modules: [], flows: [], reuse: [], superFlow: null } : plan(p)) });
const say = (message: string, extra: Record<string, unknown> = {}, token = w.tokens.alice) => api.inject({ method: 'POST', url: '/api/chat/plan', headers: auth(token), payload: { message, ...extra } });

describe('the home chat', () => {
  it('answers with its whole plan, from the chat fenced off as data; the chat is kept, nothing is built', async () => {
    ai.enqueue(turn('I will post the release notes to Slack. The plan is ready to check.'));
    const res = await say('post release notes to chat when a release is approved');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ chatId: expect.any(String), reply: 'I will post the release notes to Slack. The plan is ready to check.', plan: { title: 'Release notes', modules: [{ key: 'chat_notes' }], flows: [{ key: 'notes', needs: ['chat_notes'] }] } });
    const req = ai.requests.at(-1)!;
    expect(req.prompt).toContain('<<<CHAT\nPERSON: post release notes to chat when a release is approved\nCHAT>>>');
    expect(req.prompt).toContain('APPROVED ACTIONS:');
    expect(req.system).toContain('SHOW THE PLAN FIRST');
    expect((await w.db.query(`SELECT count(*)::int AS n FROM plans`)).rows[0].n).toBe(0);
    // Kept encrypted: the stored row holds no readable text.
    const row = (await w.db.query(`SELECT title, messages_enc FROM home_chats WHERE id = $1`, [res.json().chatId])).rows[0];
    expect(row.title).toBe('post release notes to chat when a release is approved');
    expect(row.messages_enc).not.toContain('release');
  });

  it('a next message continues the same chat: the AI reads what was said before', async () => {
    ai.enqueue(turn('Planned.'));
    const first = (await say('notes to slack')).json();
    ai.enqueue(turn('Changed the channel to #dev.', { summary: 'Posts notes. Assuming: #dev' }));
    const second = (await say('post to #dev instead', { chatId: first.chatId })).json();
    expect(second.chatId).toBe(first.chatId);
    expect(ai.requests.at(-1)!.prompt).toContain('PERSON: notes to slack\n\nYOU: Planned.\n\nPERSON: post to #dev instead');
    const chat = (await api.inject({ method: 'GET', url: `/api/chats/${first.chatId}`, headers: auth(w.tokens.alice) })).json();
    expect(chat.messages.map((m: { text: string }) => m.text)).toEqual(['notes to slack', 'Planned.', 'post to #dev instead', 'Changed the channel to #dev.']);
    expect(chat.plan.summary).toBe('Posts notes. Assuming: #dev');
  });

  it('a greeting gets a reply and no plan; an unusable answer is retried once, told why', async () => {
    ai.enqueue(turn('Hi! What would you like to automate?', null));
    expect((await say('hello')).json()).toMatchObject({ reply: 'Hi! What would you like to automate?', plan: null });
    ai.enqueue({ reply: 'x', planJson: 'not json' });
    ai.enqueue(turn('Fixed.'));
    expect((await say('notes to slack')).json()).toMatchObject({ reply: 'Fixed.', plan: { title: 'Release notes' } });
    expect(ai.requests.at(-1)!.prompt).toContain('YOUR PREVIOUS ANSWER COULD NOT BE USED: planJson is not valid JSON');
  });

  it('long chats keep their newest messages for the AI', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: `${i} ${'x'.repeat(3000)}` }));
    const text = chatText(long);
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(text.endsWith(`29 ${'x'.repeat(3000)}`)).toBe(true);
    expect(text).not.toContain('PERSON: 0 ');
  });
});

describe('chat history', () => {
  it('the owner and their team see a chat; someone outside the team does not', async () => {
    const ops = (await createTeam(w.db, w.admin, 'Ops')).id;
    await setTeamMember(w.db, w.admin, ops, w.alice.id, 'member');
    await setTeamMember(w.db, w.admin, ops, w.approver.id, 'member');
    ai.enqueue(turn('Planned for Ops.'));
    const { chatId } = (await say('ops digest', { teamId: ops })).json();
    const get = (token: string) => api.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers: auth(token) });
    expect((await get(w.tokens.alice)).json()).toMatchObject({ title: 'ops digest', mine: true });
    expect((await get(w.tokens.approver)).json()).toMatchObject({ title: 'ops digest', mine: false, createdBy: 'alice' });
    expect((await get(w.tokens.bob)).statusCode).toBe(404);
    const list = (token: string) => api.inject({ method: 'GET', url: '/api/chats', headers: auth(token) });
    expect((await list(w.tokens.approver)).json().map((c: { id: string }) => c.id)).toContain(chatId);
    expect((await list(w.tokens.bob)).json().map((c: { id: string }) => c.id)).not.toContain(chatId);
    // A teammate may continue it; only its owner (or an admin) deletes it.
    ai.enqueue(turn('Added a sign-off.'));
    expect((await say('add a sign-off', { chatId }, w.tokens.approver)).json()).toMatchObject({ chatId, reply: 'Added a sign-off.' });
    expect((await api.inject({ method: 'DELETE', url: `/api/chats/${chatId}`, headers: auth(w.tokens.approver) })).json()).toMatchObject({ error: 'owner_only' });
    expect((await api.inject({ method: 'DELETE', url: `/api/chats/${chatId}`, headers: auth(w.tokens.alice) })).statusCode).toBe(204);
    expect((await get(w.tokens.alice)).statusCode).toBe(404);
  });

  it('a chat is kept 30 days after its last message; an admin changes that, and a shorter period applies at once', async () => {
    ai.enqueue(turn('Planned.'));
    const { chatId } = (await say('keep me')).json();
    const kept = (await w.db.query(`SELECT extract(epoch FROM expires_at - updated_at)::int AS s FROM home_chats WHERE id = $1`, [chatId])).rows[0].s;
    expect(kept).toBe(30 * 86_400);
    expect((await api.inject({ method: 'GET', url: '/api/settings/chat-retention', headers: auth(w.tokens.alice) })).json()).toEqual({ days: 30, isDefault: true });
    const put = (token: string, days: number) => api.inject({ method: 'PUT', url: '/api/settings/chat-retention', headers: auth(token), payload: { days } });
    expect((await put(w.tokens.alice, 7)).statusCode).toBe(403);
    expect((await put(w.tokens.admin, 0)).json()).toMatchObject({ error: 'invalid_retention' });
    expect((await put(w.tokens.admin, 7)).json()).toEqual({ days: 7, isDefault: false });
    expect((await w.db.query(`SELECT extract(epoch FROM expires_at - updated_at)::int AS s FROM home_chats WHERE id = $1`, [chatId])).rows[0].s).toBe(7 * 86_400);
    // Past its time it is gone, by the maintenance sweep.
    await w.db.query(`UPDATE home_chats SET expires_at = now() - interval '1 minute' WHERE id = $1`, [chatId]);
    expect(await purgeExpiredChats(w.db)).toBeGreaterThanOrEqual(1);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM home_chats WHERE id = $1`, [chatId])).rows[0].n).toBe(0);
    await put(w.tokens.admin, 30);
  });
});

describe('Build it', () => {
  it('drafts the latest plan of the chat at once: modules are drafted for review, the Flow waits for them', async () => {
    ai.enqueue(turn('Here is the plan.', { questions: [{ id: 'q', question: 'Which channel?', options: ['#release'] }] }));
    const { chatId } = (await say('post release notes to Slack')).json();
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    ai.enqueue({ manifestJson: JSON.stringify({ ...manifest, name: 'chat-notes', title: 'Chat notes' }), code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8') });
    const res = await api.inject({ method: 'POST', url: '/api/plans/from-chat', headers: auth(w.tokens.alice), payload: { chatId } });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    expect(res.json()).toMatchObject({ title: 'Release notes', fileName: 'chat', mine: true, questions: [], fromChat: true, chatId });
    expect(res.json().items.map((i: { kind: string; status: string }) => [i.kind, i.status])).toEqual([['module', 'queued'], ['flow', 'waiting']]);
    await w.app.worker.drain();
    const after = (await api.inject({ method: 'GET', url: `/api/plans/${id}`, headers: auth(w.tokens.alice) })).json();
    expect(after.items[0]).toMatchObject({ kind: 'module', status: 'in_review', moduleName: 'chat-notes' });
    expect(after.items[1]).toMatchObject({ kind: 'flow', status: 'waiting' });
    expect((await api.inject({ method: 'GET', url: `/api/plans/${id}/pdf`, headers: auth(w.tokens.alice) })).statusCode).toBe(404);
    const audited = (await w.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'plan.created_from_chat' AND subject_id = $1`, [id])).rows[0].n;
    expect(audited).toBe(1);
    // The chat remembers what it built.
    expect((await api.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers: auth(w.tokens.alice) })).json()).toMatchObject({ planId: id });
  });

  it('the stored plan is checked again: nothing to build, or a Flow to reuse that is not approved, is refused', async () => {
    ai.enqueue(turn('Nothing yet.', { modules: [], flows: [] }));
    const empty = (await say('x')).json();
    expect((await api.inject({ method: 'POST', url: '/api/plans/from-chat', headers: auth(w.tokens.alice), payload: { chatId: empty.chatId } })).json()).toMatchObject({ error: 'plan_nothing_to_build' });
    ai.enqueue(turn('Reuse.', { modules: [], flows: [], reuse: [{ key: 'old', flow: '00000000-0000-0000-0000-000000000000', version: 1, title: 'Old', why: 'x' }] }));
    const fake = (await say('y')).json();
    expect((await api.inject({ method: 'POST', url: '/api/plans/from-chat', headers: auth(w.tokens.alice), payload: { chatId: fake.chatId } })).json()).toMatchObject({ error: 'plan_nothing_to_build' });
  });
});

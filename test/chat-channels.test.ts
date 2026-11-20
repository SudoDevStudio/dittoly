import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import type { FetchLike } from '../src/sandbox/broker.js';
import { approveExampleModules, giveAllCredentials, makeWorld, type World } from './helpers.js';

/** Telegram and WhatsApp chats give commands like a paired phone: linked with a one-time code, every change waits for a Yes. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
let versionId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const cmd = (c: Record<string, unknown>) => ({ commandJson: JSON.stringify({ say: '', ...c }) });

/** What the bot sent, and the Telegram updates waiting to be read. */
const telegramSent: { method: string; body: Record<string, unknown> }[] = [];
let updates: unknown[] = [];
const whatsappSent: Record<string, unknown>[] = [];
const APP_SECRET = 'whatsapp-app-secret-for-tests';
const VERIFY = 'verify-token-for-tests-123';

beforeAll(async () => {
  const fakes: FetchLike = async (url, init) => {
    const u = new URL(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (u.host === 'api.telegram.org') {
      const method = u.pathname.split('/').pop()!;
      const body = JSON.parse(String(init.body ?? '{}'));
      if (!u.pathname.startsWith('/bot123456:test-token-abcdefghijklmnop/')) return new Response('{"ok":false,"error_code":401}', { status: 401 });
      if (method === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true, username: 'dittoly_test_bot' } });
      if (method === 'getUpdates') {
        const out = updates.filter((x) => (x as { update_id: number }).update_id >= (body.offset ?? 0));
        updates = [];
        return json({ ok: true, result: out });
      }
      telegramSent.push({ method, body });
      return json({ ok: true, result: true });
    }
    if (u.host === 'graph.facebook.com') {
      expect(u.pathname).toBe('/v26.0/1234567890/messages');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer whatsapp-access-token-for-tests');
      whatsappSent.push(JSON.parse(String(init.body)));
      return json({ messages: [{ id: 'wamid.1' }] });
    }
    return w.fake.fetch(url, init);
  };
  w = await makeWorld(
    {
      telegram: { botToken: '123456:test-token-abcdefghijklmnop' },
      whatsapp: { token: 'whatsapp-access-token-for-tests', phoneNumberId: '1234567890', number: '4915100000000', appSecret: APP_SECRET, verifyToken: VERIFY, apiVersion: 'v26.0' },
    },
    { ai, fetchImpl: fakes },
  );
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  const v = await w.app.flows.create(
    'Release notes',
    {
      description: 'Posts release notes to Slack.',
      inputs: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] },
      steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-rel', text: 'Release {{ inputs.release }} is out' } }],
    },
    w.alice,
  );
  versionId = (await w.app.flows.decide(v.id, w.approver, 'approved')).id;
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

let nextUpdate = 1;
const telegramMessage = (text: string, chatType = 'private') => ({ update_id: nextUpdate++, message: { message_id: nextUpdate, chat: { id: 777, type: chatType }, text } });
const lastTelegram = () => telegramSent.filter((s) => s.method === 'sendMessage').at(-1)!.body;

describe('Telegram', () => {
  it('links a private chat with a one-time start link, then runs a Flow only after Yes and says when it finished', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/chat-channels', headers: auth(w.tokens.alice) })).json()).toEqual({ telegram: true, whatsapp: true });
    const link = (await api.inject({ method: 'POST', url: '/api/me/chat-links', headers: auth(w.tokens.alice), payload: { channel: 'telegram' } })).json();
    expect(link.url).toMatch(/^https:\/\/t\.me\/dittoly_test_bot\?start=[A-Za-z0-9_-]{8,64}$/);
    const code = new URL(link.url).searchParams.get('start')!;

    // Before linking, the bot only explains how to link.
    updates = [telegramMessage('run release notes')];
    await w.app.telegram!.pollOnce(0);
    expect(lastTelegram().text).toContain('not linked');

    updates = [telegramMessage(`/start ${code}`)];
    await w.app.telegram!.pollOnce(0);
    expect(lastTelegram()).toMatchObject({ chat_id: '777', text: expect.stringContaining('Linked to Dittoly as alice') });
    // The code works once.
    updates = [{ update_id: nextUpdate++, message: { message_id: 1, chat: { id: 888, type: 'private' }, text: `/start ${code}` } }];
    await w.app.telegram!.pollOnce(0);
    expect(lastTelegram().text).toContain('expired or was already used');

    ai.enqueue(cmd({ action: 'run_flow', versionId, inputs: { release: '5.0' } }));
    updates = [telegramMessage('run release notes for 5.0')];
    await w.app.telegram!.pollOnce(0);
    const question = lastTelegram();
    const buttons = (question.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]!;
    expect(buttons.map((b) => b.text)).toEqual(['Yes', 'No']);
    expect(Buffer.byteLength(buttons[0]!.callback_data)).toBeLessThanOrEqual(64);
    expect(w.fake.messages).toHaveLength(0);

    updates = [{ update_id: nextUpdate++, callback_query: { id: 'cb1', data: buttons[0]!.callback_data, message: { message_id: 5, chat: { id: 777, type: 'private' } } } }];
    await w.app.telegram!.pollOnce(0);
    expect(telegramSent.some((s) => s.method === 'answerCallbackQuery' && s.body.callback_query_id === 'cb1')).toBe(true);
    expect(telegramSent.some((s) => s.method === 'editMessageReplyMarkup')).toBe(true);
    expect(lastTelegram().text).toContain('Started');
    await w.app.worker.drain();
    expect(w.fake.messages.at(-1)).toMatchObject({ text: 'Release 5.0 is out', auth: 'Bearer xoxb-alice' });

    await w.app.chat.tick();
    expect(lastTelegram().text).toBe('Release notes finished successfully.');
    // The same Yes cannot be used twice.
    updates = [{ update_id: nextUpdate++, callback_query: { id: 'cb2', data: buttons[0]!.callback_data, message: { message_id: 5, chat: { id: 777, type: 'private' } } } }];
    await w.app.telegram!.pollOnce(0);
    expect(lastTelegram().text).toContain('expired');
  });

  it('refuses group chats, and "unlink" disconnects the chat', async () => {
    updates = [telegramMessage('what is waiting for me', 'group')];
    await w.app.telegram!.pollOnce(0);
    expect(lastTelegram().text).toBe('Dittoly only answers in a private chat.');
    const devices = (await api.inject({ method: 'GET', url: '/api/devices', headers: auth(w.tokens.alice) })).json();
    expect(devices.some((d: { name: string }) => d.name === 'Telegram')).toBe(true);
    updates = [telegramMessage('unlink')];
    await w.app.telegram!.pollOnce(0);
    expect(lastTelegram().text).toContain('Unlinked');
    updates = [telegramMessage('what is waiting for me')];
    await w.app.telegram!.pollOnce(0);
    expect(lastTelegram().text).toContain('not linked');
  });
});

describe('WhatsApp', () => {
  const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  const deliver = async (messages: unknown[], signature?: string) => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages } }] }] });
    const r = await api.inject({ method: 'POST', url: '/channels/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(body) }, payload: body });
    return r;
  };
  const settle = async () => {
    // Replies are sent after the webhook answered; wait for them.
    for (let i = 0; i < 50 && pendingBefore === whatsappSent.length; i++) await new Promise((r) => setTimeout(r, 20));
  };
  let pendingBefore = 0;
  let msgId = 1;
  const text = (body: string) => ({ from: '4915199999999', id: `wamid.in.${msgId++}`, type: 'text', text: { body } });

  it("answers Meta's subscription check only with the right verify token", async () => {
    expect((await api.inject({ method: 'GET', url: `/channels/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345` })).body).toBe('12345');
    expect((await api.inject({ method: 'GET', url: '/channels/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345' })).statusCode).toBe(403);
  });

  it('refuses deliveries with a wrong signature', async () => {
    const r = await deliver([text('hello')], 'sha256=' + '0'.repeat(64));
    expect(r.statusCode).toBe(401);
  });

  it('links with a code sent as a message, and asks with Yes / No reply buttons', async () => {
    const link = (await api.inject({ method: 'POST', url: '/api/me/chat-links', headers: auth(w.tokens.alice), payload: { channel: 'whatsapp' } })).json();
    expect(link.url).toBe(`https://wa.me/4915100000000?text=${encodeURIComponent(`link ${link.code}`)}`);
    pendingBefore = whatsappSent.length;
    expect((await deliver([text(`link ${link.code}`)])).statusCode).toBe(200);
    await settle();
    expect(whatsappSent.at(-1)).toMatchObject({ messaging_product: 'whatsapp', to: '4915199999999', type: 'text', text: { body: expect.stringContaining('Linked to Dittoly as alice') } });

    ai.enqueue(cmd({ action: 'run_flow', versionId, inputs: { release: '6.0' } }));
    pendingBefore = whatsappSent.length;
    await deliver([text('run release notes for 6.0')]);
    await settle();
    const q = whatsappSent.at(-1) as { type: string; interactive: { type: string; action: { buttons: { reply: { id: string; title: string } }[] } } };
    expect(q.type).toBe('interactive');
    expect(q.interactive.type).toBe('button');
    expect(q.interactive.action.buttons.map((b) => b.reply.title)).toEqual(['Yes', 'No']);

    // "No" by button: nothing runs.
    pendingBefore = whatsappSent.length;
    const before = w.fake.messages.length;
    await deliver([{ from: '4915199999999', id: `wamid.in.${msgId++}`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: q.interactive.action.buttons[1]!.reply.id, title: 'No' } } }]);
    await settle();
    expect(whatsappSent.at(-1)).toMatchObject({ text: { body: 'OK, cancelled. Nothing was changed.' } });
    await w.app.worker.drain();
    expect(w.fake.messages.length).toBe(before);

    // A typed "yes" answers the latest open question.
    ai.enqueue(cmd({ action: 'run_flow', versionId, inputs: { release: '6.1' } }));
    pendingBefore = whatsappSent.length;
    await deliver([text('run release notes for 6.1')]);
    await settle();
    pendingBefore = whatsappSent.length;
    await deliver([text('yes')]);
    await settle();
    expect(whatsappSent.at(-1)).toMatchObject({ text: { body: expect.stringContaining('Started') } });
    await w.app.worker.drain();
    expect(w.fake.messages.at(-1)).toMatchObject({ text: 'Release 6.1 is out' });
  });

  it('ignores a message delivered twice', async () => {
    const m = text('what is waiting for me');
    pendingBefore = whatsappSent.length;
    await deliver([m]);
    await settle();
    const count = whatsappSent.length;
    await deliver([m]);
    await new Promise((r) => setTimeout(r, 100));
    expect(whatsappSent.length).toBe(count);
  });
});

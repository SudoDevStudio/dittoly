import { errorType, log } from '../core/log.js';
import type { Db } from '../db/db.js';
import type { FetchLike } from '../sandbox/broker.js';
import type { ChatChannels, ChatSender } from './chat.js';

/**
 * Telegram Bot API over long polling (getUpdates), so the server needs no public
 * address. Only one server may poll a bot at a time (Telegram refuses a second
 * poller, and getUpdates does not work while a webhook is set for the bot).
 */

interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number; type: string } } };
}

const OFFSET_KEY = 'telegram_offset';
const POLL_SECONDS = 25;

export class TelegramBot implements ChatSender {
  private username: string | null = null;
  private running = false;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
    private readonly db: Db,
    private readonly chat: ChatChannels,
  ) {}

  private async call<T>(method: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const signal = this.abort ? AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number };
    if (!json.ok) throw new Error(`telegram_${method}_${json.error_code ?? res.status}`);
    return json.result as T;
  }

  /** The bot's @username, for the t.me link. */
  async botUsername(): Promise<string> {
    this.username ??= (await this.call<{ username: string }>('getMe', {})).username;
    return this.username;
  }

  async send(chatId: string, text: string, confirm?: { id: string }): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4000),
      ...(confirm
        ? { reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: `y:${confirm.id}` }, { text: 'No', callback_data: `n:${confirm.id}` }]] } }
        : {}),
    });
  }

  /** Read and answer what arrived since the last call. */
  async pollOnce(timeoutSeconds = POLL_SECONDS): Promise<number> {
    const offset = Number((await this.db.query<{ value: string }>(`SELECT value FROM chat_state WHERE key = $1`, [OFFSET_KEY])).rows[0]?.value ?? 0);
    const updates = await this.call<Update[]>('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] }, (timeoutSeconds + 10) * 1000);
    for (const u of updates) {
      // Saved first: an update that fails is not retried forever.
      await this.db.query(`INSERT INTO chat_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [OFFSET_KEY, String(u.update_id + 1)]);
      if (u.message) {
        const chatId = String(u.message.chat.id);
        if (typeof u.message.text !== 'string') {
          await this.send(chatId, 'Please write your request as text.').catch(() => undefined);
          continue;
        }
        await this.chat.handle('telegram', { chatId, text: u.message.text, private: u.message.chat.type === 'private' });
      } else if (u.callback_query) {
        const q = u.callback_query;
        await this.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined);
        if (!q.message || !q.data) continue;
        // The buttons are used once: remove them from the question.
        await this.call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => undefined);
        await this.chat.handle('telegram', { chatId: String(q.message.chat.id), text: null, button: q.data, private: q.message.chat.type === 'private' });
      }
    }
    return updates.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.pollOnce();
          await this.chat.tick();
        } catch (err) {
          if (!this.running) break;
          log.warn('telegram_poll_failed', { errorType: errorType(err) });
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
  }
}

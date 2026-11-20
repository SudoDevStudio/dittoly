import { createHmac, timingSafeEqual } from 'node:crypto';
import { log } from '../core/log.js';
import type { FetchLike } from '../sandbox/broker.js';
import type { ChatChannels, ChatSender } from './chat.js';

/**
 * WhatsApp Business Cloud API: messages arrive at a webhook Meta calls (signed with
 * the app secret in X-Hub-Signature-256), replies go out through the Graph API.
 * Questions that need a yes get two reply buttons.
 */

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  number: string;
  appSecret: string;
  verifyToken: string;
  apiVersion: string;
}

interface WebhookBody {
  entry?: {
    changes?: {
      value?: {
        messages?: { id?: string; from?: string; type?: string; text?: { body?: string }; interactive?: { type?: string; button_reply?: { id?: string } } }[];
      };
    }[];
  }[];
}

export class WhatsApp implements ChatSender {
  /** Meta may deliver a message more than once. */
  private readonly seen: string[] = [];

  constructor(
    private readonly cfg: WhatsAppConfig,
    private readonly fetchImpl: FetchLike,
    private readonly chat: ChatChannels,
  ) {}

  /** The link that opens a chat with the business number, with the text filled in. */
  chatLink(text: string): string {
    return `https://wa.me/${this.cfg.number}?text=${encodeURIComponent(text)}`;
  }

  async send(to: string, text: string, confirm?: { id: string }): Promise<void> {
    const body = confirm
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: text.slice(0, 1024) },
            action: {
              buttons: [
                { type: 'reply', reply: { id: `y:${confirm.id}`, title: 'Yes' } },
                { type: 'reply', reply: { id: `n:${confirm.id}`, title: 'No' } },
              ],
            },
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096) } };
    const res = await this.fetchImpl(`https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`whatsapp_send_${res.status}`);
  }

  /** Meta's subscription check: echo the challenge when the verify token matches. */
  verify(query: Record<string, string | undefined>): string | null {
    const token = query['hub.verify_token'] ?? '';
    const ok = query['hub.mode'] === 'subscribe' && token.length === this.cfg.verifyToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(this.cfg.verifyToken));
    return ok ? (query['hub.challenge'] ?? '') : null;
  }

  /** A webhook delivery. Returns false when the signature is wrong; `done` settles once replies are sent. */
  receive(raw: Buffer, signature: string | undefined): { ok: boolean; done: Promise<void> } {
    const expected = `sha256=${createHmac('sha256', this.cfg.appSecret).update(raw).digest('hex')}`;
    if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return { ok: false, done: Promise.resolve() };
    }
    let body: WebhookBody;
    try {
      body = JSON.parse(raw.toString('utf8')) as WebhookBody;
    } catch {
      return { ok: true, done: Promise.resolve() };
    }
    const work: Promise<void>[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          if (!m.from || !m.id || this.seen.includes(m.id)) continue;
          this.seen.push(m.id);
          if (this.seen.length > 500) this.seen.shift();
          const from = m.from;
          if (m.type === 'text' && typeof m.text?.body === 'string') {
            work.push(this.chat.handle('whatsapp', { chatId: from, text: m.text.body, private: true }));
          } else if (m.type === 'interactive' && m.interactive?.button_reply?.id) {
            work.push(this.chat.handle('whatsapp', { chatId: from, text: null, button: m.interactive.button_reply.id, private: true }));
          } else {
            work.push(this.send(from, 'Please write your request as text.').catch(() => undefined));
          }
        }
      }
    }
    // Status updates (sent, delivered, read) carry no messages and need nothing.
    return {
      ok: true,
      done: Promise.all(work).then(
        () => undefined,
        () => log.warn('whatsapp_handle_failed', {}),
      ),
    };
  }
}

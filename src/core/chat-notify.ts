import type { FetchLike } from '../sandbox/broker.js';

/**
 * Chat delivery of notifications. Like email, a message is one sentence and a
 * link to the portal; it never carries run inputs, outputs or Flow content.
 *
 * - Slack: a bot token (scopes chat:write, im:write, users:read, users:read.email).
 *   Each member gets a direct message, found by their sign-in email.
 * - Teams: a Workflows webhook ("Send webhook alerts to a channel") posting an
 *   Adaptive Card to one channel; the message names the member it is for.
 */

/** The member cannot be reached on this channel (no account, no email): do not retry. */
export class Unreachable extends Error {}

export interface ChatMessage {
  text: string;
  url: string;
}

const TIMEOUT_MS = 10_000;

export class SlackNotifier {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) throw new Error('slack_rate_limited'); // the delivery job retries later
    if (!res.ok) throw new Error(`slack_http_${res.status}`);
    const data = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!data.ok) {
      if (data.error === 'users_not_found' || data.error === 'user_not_found' || data.error === 'cannot_dm_bot') throw new Unreachable(data.error);
      throw new Error(`slack_${data.error ?? 'error'}`);
    }
    return data;
  }

  /** Slack user ID for an email address. */
  async lookup(email: string): Promise<string> {
    const r = await this.call<{ user: { id: string } }>('users.lookupByEmail', { email });
    return r.user.id;
  }

  async send(userId: string, msg: ChatMessage): Promise<void> {
    const dm = await this.call<{ channel: { id: string } }>('conversations.open', { users: userId });
    await this.call('chat.postMessage', {
      channel: dm.channel.id,
      text: `${msg.text} ${msg.url}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${escapeMrkdwn(msg.text)}\n<${msg.url}|Open in Dittoly>` } }],
      unfurl_links: false,
    });
  }
}

const escapeMrkdwn = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export class TeamsNotifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly fetchFn: FetchLike,
  ) {}

  /** `memberName` is shown on channel posts; null for a member's own chat. */
  async send(memberName: string | null, msg: ChatMessage): Promise<void> {
    const card = {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        ...(memberName ? [{ type: 'TextBlock', text: `For ${memberName}`, weight: 'Bolder', wrap: true }] : []),
        { type: 'TextBlock', text: msg.text, wrap: true },
      ],
      actions: [{ type: 'Action.OpenUrl', title: 'Open in Dittoly', url: msg.url }],
    };
    const res = await this.fetchFn(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`teams_http_${res.status}`);
  }
}

import { withAiContext } from '../ai/metering.js';
import { audit } from '../core/audit.js';
import { randomToken, sha256Hex } from '../core/crypto.js';
import { AppError, badRequest } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { withTx, type Db } from '../db/db.js';
import type { DeviceCommands, Reply } from '../devices/commands.js';
import { DEVICE_DAYS } from '../devices/service.js';

/**
 * Telegram and WhatsApp as command channels, the same way a paired phone works:
 * the person links a chat from the portal with a one-time code, then writes what
 * they need ("run release notes for 2.4"). The organization's AI proposes one action;
 * anything that changes something waits for their Yes. Runs started from the chat are
 * followed and the chat is told when they finish or need the person.
 *
 * A linked chat is a device (channel 'telegram' or 'whatsapp'): it shows in the
 * person's devices, expires after 30 days, and can be revoked like a phone.
 */

export type ChatChannel = 'telegram' | 'whatsapp';

/** Sends one message to a chat; `confirm` adds Yes / No buttons. */
export interface ChatSender {
  send(chatId: string, text: string, confirm?: { id: string }): Promise<void>;
}

const LINK_MINUTES = 10;
const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|confirm|do it|go( ahead)?|approve it)\b/i;
const NO = /^(no|nope|cancel|stop|don'?t|never ?mind)\b/i;
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'paused']);
const NAMES: Record<ChatChannel, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' };

export interface Incoming {
  chatId: string;
  /** Typed text, or null for a button press. */
  text: string | null;
  /** A Yes / No button: "y:<id>" or "n:<id>". */
  button?: string;
  /** A private (one-to-one) chat; group chats are refused. */
  private: boolean;
}

export class ChatChannels {
  readonly senders = new Map<ChatChannel, ChatSender>();

  constructor(
    private readonly db: Db,
    private readonly commands: () => DeviceCommands,
  ) {}

  /** A one-time code the person sends to the bot (Telegram: in the start link; WhatsApp: as a message). */
  async startLink(actor: Member, channel: ChatChannel): Promise<{ code: string; expiresAt: Date }> {
    if (!this.senders.has(channel)) throw new AppError('channel_not_configured', 409, `${NAMES[channel]} is not set up on this server.`);
    // Telegram start parameters allow A-Z, a-z, 0-9, _ and -, up to 64 characters.
    const code = randomToken(18).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    const expiresAt = new Date(Date.now() + LINK_MINUTES * 60_000);
    await this.db.query(`DELETE FROM chat_link_codes WHERE expires_at < now() - interval '1 day'`);
    await this.db.query(`INSERT INTO chat_link_codes (code_hash, member_id, channel, expires_at) VALUES ($1, $2, $3, $4)`, [sha256Hex(code), actor.id, channel, expiresAt]);
    return { code, expiresAt };
  }

  private async link(channel: ChatChannel, chatId: string, code: string): Promise<Member | null> {
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<{ member_id: string }>(
        `UPDATE chat_link_codes SET used_at = now() WHERE code_hash = $1 AND channel = $2 AND used_at IS NULL AND expires_at > now() RETURNING member_id`,
        [sha256Hex(code), channel],
      );
      if (!rows[0]) return null;
      const m = (await tx.query<{ id: string; handle: string; role: Member['role']; disabled: boolean }>(`SELECT id, handle, role, disabled FROM members WHERE id = $1`, [rows[0].member_id])).rows[0];
      if (!m || m.disabled) return null;
      // One person per chat: linking again replaces the earlier link.
      await tx.query(`UPDATE devices SET revoked_at = now() WHERE channel = $1 AND external_id = $2 AND revoked_at IS NULL`, [channel, chatId]);
      const device = await tx.query<{ id: string }>(
        `INSERT INTO devices (member_id, name, token_hash, expires_at, channel, external_id) VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6) RETURNING id`,
        // Chats never present a token; this one only fills the column.
        [m.id, NAMES[channel], sha256Hex(randomToken(32)), DEVICE_DAYS, channel, chatId],
      );
      await audit(tx, { actorId: m.id, action: `device.linked_${channel}`, subjectType: 'device', subjectId: device.rows[0]!.id, outcome: 'ok' });
      return { id: m.id, handle: m.handle, role: m.role };
    });
  }

  private async session(channel: ChatChannel, chatId: string): Promise<{ member: Member; deviceId: string } | null> {
    const { rows } = await this.db.query<{ device_id: string; id: string; handle: string; role: Member['role'] }>(
      `UPDATE devices d SET last_seen_at = now() FROM members m
       WHERE d.channel = $1 AND d.external_id = $2 AND d.revoked_at IS NULL AND d.expires_at > now() AND m.id = d.member_id AND NOT m.disabled
       RETURNING d.id AS device_id, m.id, m.handle, m.role`,
      [channel, chatId],
    );
    const r = rows[0];
    return r ? { deviceId: r.device_id, member: { id: r.id, handle: r.handle, role: r.role } } : null;
  }

  /** One message (or button press) from a chat: answer it through the channel's sender. */
  async handle(channel: ChatChannel, msg: Incoming): Promise<void> {
    const sender = this.senders.get(channel);
    if (!sender) return;
    const reply = await this.answer(channel, msg).catch((err) => {
      if (err instanceof AppError) return { say: err.code === 'rate_limited' ? 'Too many messages; wait a minute.' : `That did not work: ${err.message.replace(/_/g, ' ')}.` } as Reply;
      log.error('chat_command_failed', { action: channel });
      return { say: 'Something went wrong. Please try again.' } as Reply;
    });
    if (!reply) return;
    await sender.send(msg.chatId, reply.say, reply.confirm ? { id: reply.confirm.id } : undefined).catch(() => log.warn('chat_send_failed', { action: channel }));
  }

  private async answer(channel: ChatChannel, msg: Incoming): Promise<Reply | null> {
    if (!msg.private) return { say: 'Dittoly only answers in a private chat.' };
    const text = (msg.text ?? '').trim();
    const linkCode = /^(?:\/start|link)\s+([A-Za-z0-9_-]{8,64})$/i.exec(text)?.[1];
    if (linkCode) {
      const m = await this.link(channel, msg.chatId, linkCode);
      if (!m) return { say: 'This link has expired or was already used. In Dittoly, choose Connect again.' };
      return { say: `Linked to Dittoly as ${m.handle}. Tell me what you need, for example "what is waiting for me" or "run" and a Flow name. Anything that changes something waits for your Yes. Send "unlink" to disconnect.` };
    }
    const s = await this.session(channel, msg.chatId);
    if (!s) return { say: `This chat is not linked to Dittoly. In Dittoly, open My credentials → Phone, glasses & chat apps and choose Connect ${NAMES[channel]}.` };
    const cmd = this.commands();
    if (msg.button) {
      const m = /^([yn]):([0-9a-f-]{36})$/.exec(msg.button);
      if (!m) return null;
      return this.follow(s.deviceId, await cmd.confirm(s.member, s.deviceId, m[2]!, m[1] === 'y'));
    }
    if (!text) return null;
    if (/^(\/stop|unlink)$/i.test(text)) {
      await this.db.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [s.deviceId]);
      await audit(this.db, { actorId: s.member.id, action: `device.unlinked_${channel}`, subjectType: 'device', subjectId: s.deviceId, outcome: 'ok' });
      return { say: 'Unlinked. This chat can no longer give Dittoly commands.' };
    }
    if (YES.test(text) || NO.test(text)) {
      // A typed yes or no answers the latest open question from this chat.
      const pending = (await this.db.query<{ id: string }>(
        `SELECT id FROM device_actions WHERE device_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
        [s.deviceId],
      )).rows[0];
      if (pending) return this.follow(s.deviceId, await cmd.confirm(s.member, s.deviceId, pending.id, YES.test(text)));
    }
    if (text.length > 2000) throw badRequest('message_too_long');
    if (/^\/(start|help)$/i.test(text)) return { say: 'Tell me what you need, for example "what is waiting for me", "run release notes for 2.4", or "how did it go?".' };
    return this.follow(s.deviceId, await withAiContext({ memberId: s.member.id, purpose: 'command' }, () => cmd.command(s.member, s.deviceId, text)));
  }

  private async follow(deviceId: string, reply: Reply): Promise<Reply> {
    if (reply.runId) {
      await this.db.query(`INSERT INTO chat_follows (device_id, run_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [deviceId, reply.runId]);
    }
    return reply;
  }

  /** Tell chats about runs they follow that finished or need the person (called from maintenance and the Telegram poller). */
  async tick(): Promise<void> {
    const { rows } = await this.db.query<{ device_id: string; run_id: string; last_status: string; status: string; wait_reason: string | null; channel: ChatChannel; external_id: string; member_id: string; handle: string; role: Member['role'] }>(
      `SELECT f.device_id, f.run_id, f.last_status, r.status, r.wait_reason, d.channel, d.external_id, m.id AS member_id, m.handle, m.role
       FROM chat_follows f JOIN runs r ON r.id = f.run_id JOIN devices d ON d.id = f.device_id JOIN members m ON m.id = d.member_id
       WHERE r.status <> f.last_status AND d.revoked_at IS NULL AND d.expires_at > now() AND d.channel <> 'phone'`,
    );
    for (const r of rows) {
      await this.db.query(`UPDATE chat_follows SET last_status = $3 WHERE device_id = $1 AND run_id = $2`, [r.device_id, r.run_id, r.status]);
      // Waiting on the person (or someone else) is worth a message; retries and timers are not.
      if (FINAL.has(r.status) || (r.status === 'waiting' && ['approval', 'input_needed', 'delegation'].includes(r.wait_reason ?? ''))) {
        const sender = this.senders.get(r.channel);
        const reply = await this.commands().status({ id: r.member_id, handle: r.handle, role: r.role }, r.run_id);
        await sender?.send(r.external_id, reply.say).catch(() => log.warn('chat_send_failed', { action: r.channel }));
      }
      if (FINAL.has(r.status)) await this.db.query(`DELETE FROM chat_follows WHERE device_id = $1 AND run_id = $2`, [r.device_id, r.run_id]);
    }
  }
}

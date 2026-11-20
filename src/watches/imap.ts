import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { resolveChecked, type EgressPolicy } from '../runtime/egress.js';

/**
 * Reading new mail over IMAP, read-only: the mailbox is opened with EXAMINE, nothing is
 * marked read or moved. Messages are found by UID after the last one seen. The server's
 * address is checked against the same egress rules as module traffic before connecting.
 */

export interface MailboxConfig {
  host: string;
  port: number;
  /** TLS from the start (port 993). Otherwise STARTTLS is required. */
  secure: boolean;
  user: string;
  mailbox: string;
}

export interface Email {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  messageId: string;
  /** The plain-text body (HTML turned into text), at most 20,000 characters. */
  text: string;
}

export interface MailSource {
  /** Messages after `afterUid` (all of them when null: only their UIDs are needed to start from). */
  read(cfg: MailboxConfig, password: string, afterUid: number | null, max: number): Promise<{ uidValidity: string; uidNext: number; messages: Email[] }>;
}

const MAX_TEXT = 20_000;
const MAX_SOURCE = 2_000_000;

export class ImapSource implements MailSource {
  constructor(private readonly policy: EgressPolicy) {}

  async read(cfg: MailboxConfig, password: string, afterUid: number | null, max: number) {
    // Connect to the checked address; TLS still verifies the server's name.
    const { address } = await resolveChecked(cfg.host, [`${cfg.host}:${cfg.port}`, cfg.host], this.policy);
    const client = new ImapFlow({
      host: address,
      servername: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      doSTARTTLS: cfg.secure ? undefined : true,
      auth: { user: cfg.user, pass: password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    await client.connect();
    try {
      const box = await client.mailboxOpen(cfg.mailbox, { readOnly: true });
      const uidValidity = String(box.uidValidity);
      const messages: Email[] = [];
      if (afterUid !== null && box.uidNext > afterUid + 1) {
        for await (const m of client.fetch(`${afterUid + 1}:*`, { uid: true, envelope: true, source: true }, { uid: true })) {
          // "n:*" also returns the last message when none is newer than n.
          if (m.uid <= afterUid) continue;
          if (!m.source || m.source.length > MAX_SOURCE) continue;
          const parsed = await simpleParser(m.source);
          const addr = (a: unknown) => (a && typeof a === 'object' && 'text' in a ? String((a as { text: string }).text) : '');
          messages.push({
            uid: m.uid,
            from: addr(parsed.from),
            to: addr(parsed.to),
            subject: parsed.subject ?? '',
            date: (parsed.date ?? new Date()).toISOString(),
            messageId: parsed.messageId ?? '',
            text: (parsed.text ?? '').slice(0, MAX_TEXT),
          });
          if (messages.length >= max) break;
        }
      }
      return { uidValidity, uidNext: box.uidNext, messages };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}

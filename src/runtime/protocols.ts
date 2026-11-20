import type { FetchLike } from './broker.js';
import type { DbRequest, DbResult, MongoRequest } from './databases.js';
import type { EgressPolicy } from './egress.js';
import type { Dialect } from './sql.js';

/**
 * Network transports for module connections other than plain HTTPS requests:
 * SMTP send, AMQP and MQTT publish, WebSocket sessions, SSE reads and database queries. The
 * broker has already checked the manifest, the credential and the limits;
 * these only connect, with the same address rules as module HTTP traffic.
 * Every connection is opened for one call and closed after it. Each protocol is its own file
 * (transport-*.ts, db-*.ts), so an app carries only the ones its modules use.
 */

export interface Target {
  hostname: string;
  port: number;
  /** host and host:port: the forms an admin may list as internal or plain-text hosts. */
  hostKeys: string[];
}

export interface Login {
  username: string;
  password: string;
}

export interface MailMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string | undefined;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
}

export interface Transports {
  smtp(t: Target, tls: 'starttls' | 'implicit' | 'none', login: Login | null, msg: MailMessage, timeoutMs: number): Promise<{ accepted: string[]; rejected: string[] }>;
  amqp(
    t: Target,
    tls: boolean,
    login: Login | null,
    vhost: string,
    pub: { exchange: string; routingKey: string; body: Buffer; contentType: string; headers: Record<string, string>; persistent: boolean },
    timeoutMs: number,
  ): Promise<void>;
  mqtt(t: Target, tls: boolean, login: Login | null, pub: { topic: string; payload: Buffer; qos: 0 | 1; retain: boolean }, timeoutMs: number): Promise<void>;
  ws(
    url: string,
    t: Target,
    opts: { headers: Record<string, string>; protocols: string[]; send: string[]; maxMessages: number; maxMs: number; maxBytes: number },
  ): Promise<{ messages: string[]; closed: boolean }>;
  sse(url: string, t: Target, opts: { headers: Record<string, string>; maxEvents: number; maxMs: number; maxBytes: number }): Promise<{ status: number; events: SseEvent[] }>;
  /** One fixed, checked query with bound parameters (see databases.ts). */
  db(dialect: Dialect, t: Target, r: DbRequest): Promise<DbResult>;
  /** One fixed, checked MongoDB operation (see databases.ts). */
  mongo(t: Target, r: MongoRequest): Promise<DbResult>;
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class TransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

/** Parse an SSE stream (text/event-stream) incrementally. Returns the events completed so far and the rest. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (data.length) events.push({ event, data: data.join('\n'), ...(id !== undefined ? { id } : {}) });
  }
  return { events, rest };
}

export function within<T>(ms: number, p: Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new TransportError('upstream_timeout', true));
      }, ms);
    }),
  ]);
}

/** Makes one transport for an egress policy. */
export type TransportMaker<K extends keyof Transports> = (policy: EgressPolicy, fetchImpl?: FetchLike) => Transports[K];

/** The transports an app has: only those for the protocols its modules use. */
export type TransportMakers = { [K in keyof Transports]?: TransportMaker<K> };

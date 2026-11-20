import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { randomToken } from '../core/crypto.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { notifyRole } from '../core/notify.js';
import type { Queryable } from '../db/db.js';
import type { FetchLike } from '../sandbox/broker.js';
import { guardedLookup, resolveChecked, type EgressPolicy, type Resolver } from '../runtime/egress.js';
import { chainHash, GENESIS } from './audit-chain.js';

/**
 * Audit streaming: every sealed audit event goes, in order, to the SIEMs org admins set up
 * (Splunk, Datadog, any HTTPS collector, syslog over TLS, OpenTelemetry). Each stream keeps
 * the id of the last event delivered and starts after it, so nothing is skipped when a SIEM
 * is down: it is retried with backoff and admins are told once. A batch may be sent twice
 * after a crash (each event carries its id, so a SIEM can drop repeats).
 *
 * Only sealed events are sent, with their audit-chain hash and the one before, so the copy
 * in the SIEM can be checked on its own (verifyStreamed). Events are IDs, outcomes and
 * names (member handle, Flow, team and module names); never inputs, outputs or secrets.
 */

// ---------------------------------------------------------------- what is sent

export interface StreamEvent {
  schema: 'dittoly.audit/1';
  id: string;
  /** ISO time, and the exact microseconds the chain hash covers. */
  at: string;
  atUs: string;
  server: string;
  action: string;
  outcome: 'ok' | 'denied' | 'failed';
  errorType: string | null;
  actor: { id: string; name: string | null } | null;
  subject: { type: string; id: string; name: string | null };
  related: { id: string; name: string | null } | null;
  /** One line a person can read. */
  summary: string;
  chain: { hash: string; prevHash: string };
}

interface SealedRow {
  id: string;
  at_us: string;
  actor_id: string | null;
  action: string;
  subject_type: string;
  subject_id: string;
  outcome: string;
  error_type: string | null;
  related_id: string | null;
  hash: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Readable names for the ids in a batch, looked up in a few queries. */
async function namesFor(db: Queryable, rows: SealedRow[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const r of rows) {
    for (const v of [r.actor_id, r.related_id, r.subject_type === 'step' ? r.subject_id.split(':')[0] : r.subject_id]) if (v && UUID.test(v)) ids.add(v.toLowerCase());
  }
  const names = new Map<string, string>();
  if (!ids.size) return names;
  const list = [...ids];
  const lookups = [
    `SELECT id::text AS id, handle AS name FROM members WHERE id = ANY($1::uuid[])`,
    `SELECT id::text AS id, name FROM teams WHERE id = ANY($1::uuid[])`,
    `SELECT id::text AS id, name FROM flows WHERE id = ANY($1::uuid[])`,
    `SELECT v.id::text AS id, f.name || ' v' || v.version AS name FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE v.id = ANY($1::uuid[])`,
    `SELECT r.id::text AS id, f.name || ' run' AS name FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id WHERE r.id = ANY($1::uuid[])`,
    `SELECT id::text AS id, name || '@' || version AS name FROM module_versions WHERE id = ANY($1::uuid[])`,
  ];
  for (const q of lookups) for (const r of (await db.query<{ id: string; name: string }>(q, [list])).rows) names.set(r.id, r.name);
  return names;
}

/** Subjects that are not ids (a credential's service, an org setting, a module name) name themselves. */
const SELF_NAMED = new Set(['credential', 'org', 'module']);

export function toStreamEvent(r: SealedRow, prevHash: string, names: Map<string, string>, server: string): StreamEvent {
  const name = (id: string | null) => (id ? (names.get(id.toLowerCase()) ?? null) : null);
  const subjectKey = r.subject_type === 'step' ? r.subject_id.split(':')[0]! : r.subject_id;
  const subjectName = name(subjectKey) ?? (SELF_NAMED.has(r.subject_type) && !UUID.test(r.subject_id) ? r.subject_id : null);
  const actorName = name(r.actor_id);
  const outcome = r.outcome as StreamEvent['outcome'];
  const summary =
    `${actorName ?? (r.actor_id ? 'member ' + r.actor_id : 'Dittoly')} ${r.action} ${r.subject_type.replace('_', ' ')} ${subjectName ?? r.subject_id}` +
    (outcome === 'ok' ? '' : ` (${outcome}${r.error_type ? `: ${r.error_type}` : ''})`);
  return {
    schema: 'dittoly.audit/1',
    id: r.id,
    at: new Date(Number(BigInt(r.at_us) / 1000n)).toISOString(),
    atUs: r.at_us,
    server,
    action: r.action,
    outcome,
    errorType: r.error_type,
    actor: r.actor_id ? { id: r.actor_id, name: actorName } : null,
    subject: { type: r.subject_type, id: r.subject_id, name: subjectName },
    related: r.related_id ? { id: r.related_id, name: name(r.related_id) } : null,
    summary,
    chain: { hash: r.hash, prevHash },
  };
}

/**
 * Check a run of streamed events (as exported from a SIEM, oldest first): each hash must
 * follow from the one before and the event's own fields. Names are not covered by the hash.
 */
export function verifyStreamed(events: StreamEvent[]): { ok: boolean; checked: number; problems: string[] } {
  const problems: string[] = [];
  let prev: string | null = null;
  const seen = new Set<string>();
  for (const e of [...events].sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))) {
    if (seen.has(e.id)) continue; // a repeat after a resend
    seen.add(e.id);
    if (prev !== null && e.chain.prevHash !== prev) problems.push(`event ${e.id}: does not follow the event before it (a gap or a change)`);
    const expected = chainHash(e.chain.prevHash, {
      id: e.id, at_us: e.atUs, actor_id: e.actor?.id ?? null, action: e.action, subject_type: e.subject.type,
      subject_id: e.subject.id, outcome: e.outcome, error_type: e.errorType, related_id: e.related?.id ?? null,
    });
    if (expected !== e.chain.hash) problems.push(`event ${e.id}: its fields do not match its hash`);
    prev = e.chain.hash;
  }
  return { ok: problems.length === 0, checked: seen.size, problems };
}

// ---------------------------------------------------------------- destinations

export const DATADOG_SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ap2.datadoghq.com', 'uk1.datadoghq.com', 'ddog-gov.com', 'us2.ddog-gov.com'] as const;

const name = z.string().trim().min(1).max(80);
const url = z.string().url().max(500);
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const startFrom = z.enum(['now', 'all']).default('now');

export const streamBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('splunk'), name, url, token: z.string().min(1).max(200), index: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(), sourcetype: z.string().max(80).optional(), startFrom }).strict(),
  z.object({ kind: z.literal('datadog'), name, site: z.enum(DATADOG_SITES), apiKey: z.string().min(1).max(200), service: z.string().max(80).optional(), tags: z.string().max(300).optional(), startFrom }).strict(),
  z.object({ kind: z.literal('https'), name, url, headerName: headerName.optional(), headerValue: z.string().max(500).optional(), startFrom }).strict(),
  z.object({ kind: z.literal('syslog'), name, host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:]+\]$/), port: z.number().int().min(1).max(65535).default(6514), framing: z.enum(['octet', 'newline']).default('octet'), startFrom }).strict(),
  z.object({ kind: z.literal('otlp'), name, url, headerName: headerName.optional(), headerValue: z.string().max(500).optional(), startFrom }).strict(),
]);
export type StreamBody = z.infer<typeof streamBody>;

interface Settings {
  url?: string;
  index?: string;
  sourcetype?: string;
  site?: string;
  service?: string;
  tags?: string;
  headerName?: string;
  host?: string;
  port?: number;
  framing?: 'octet' | 'newline';
}
/** The secret part, stored encrypted. */
interface Secret {
  token?: string;
  apiKey?: string;
  headerValue?: string;
  signingKey?: string;
}

export interface StreamDeps {
  db: Queryable;
  cipher: Cipher;
  fetchImpl: FetchLike;
  publicUrl: string;
  insecureHttpHosts: string[];
  egress: EgressPolicy;
  /** Extra trusted CA for syslog (tests). In production, NODE_EXTRA_CA_CERTS covers every destination. */
  tlsCa?: string;
  /** Name lookup for syslog (tests); the system's otherwise. */
  resolve?: Resolver;
}

class SendError extends Error {}

const SEVERITY = { ok: { syslog: 6, otel: 9, text: 'INFO', dd: 'info' }, denied: { syslog: 4, otel: 13, text: 'WARN', dd: 'warn' }, failed: { syslog: 3, otel: 17, text: 'ERROR', dd: 'error' } } as const;

function withPath(raw: string, path: string): string {
  const u = new URL(raw);
  if (u.pathname === '/' || u.pathname === '') u.pathname = path;
  return u.toString();
}

async function post(d: StreamDeps, target: string, headers: Record<string, string>, body: string | Uint8Array): Promise<Response> {
  const res = await d.fetchImpl(target, { method: 'POST', headers, body: body as BodyInit, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (res.status >= 300) throw new SendError(`http_${res.status}`);
  return res;
}

const hostOf = (publicUrl: string) => new URL(publicUrl).hostname;

/** Batch limits: Datadog takes at most 1000 logs per request; the others are kept modest. */
const BATCH = { splunk: 500, datadog: 500, https: 500, syslog: 500, otlp: 500 } as const;

async function sendBatch(d: StreamDeps, kind: keyof typeof BATCH, s: Settings, secret: Secret, events: StreamEvent[]): Promise<void> {
  const host = hostOf(d.publicUrl);
  switch (kind) {
    case 'splunk': {
      // HTTP Event Collector: events one after another, each with its own metadata.
      const body = events
        .map((e) => JSON.stringify({ time: Number(BigInt(e.atUs) / 1000n) / 1000, host, source: 'dittoly', sourcetype: s.sourcetype || 'dittoly:audit', ...(s.index ? { index: s.index } : {}), event: e }))
        .join('\n');
      await post(d, withPath(s.url!, '/services/collector/event'), { authorization: `Splunk ${secret.token ?? ''}`, 'content-type': 'application/json' }, body);
      return;
    }
    case 'datadog': {
      // Logs API v2. Datadog takes timestamps up to 18 hours old; older events (a first send of
      // the whole history) keep their time in dittoly.at and are dated when received.
      const recent = Date.now() - 17 * 3600_000;
      const tags = ['source:dittoly', ...(s.tags ? s.tags.split(',').map((t) => t.trim()).filter(Boolean) : [])];
      const body = events.map((e) => {
        const ms = Number(BigInt(e.atUs) / 1000n);
        return {
          ddsource: 'dittoly',
          service: s.service || 'dittoly',
          hostname: host,
          ddtags: [...tags, `action:${e.action}`, `outcome:${e.outcome}`].join(','),
          message: e.summary,
          status: SEVERITY[e.outcome].dd,
          ...(ms >= recent ? { timestamp: ms } : {}),
          dittoly: e,
        };
      });
      const site = s.site!;
      await post(d, `https://http-intake.logs.${site}/api/v2/logs`, { 'dd-api-key': secret.apiKey ?? '', 'content-type': 'application/json', 'content-encoding': 'gzip' }, gzipSync(JSON.stringify(body)));
      return;
    }
    case 'https': {
      // One JSON event per line, signed like the other Dittoly webhooks.
      const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const headers: Record<string, string> = {
        'content-type': 'application/x-ndjson',
        'x-dittoly-signature': `sha256=${createHmac('sha256', secret.signingKey ?? '').update(body).digest('hex')}`,
        'x-dittoly-first-event': events[0]!.id,
        'x-dittoly-last-event': events[events.length - 1]!.id,
      };
      if (s.headerName && secret.headerValue) headers[s.headerName.toLowerCase()] = secret.headerValue;
      await post(d, s.url!, headers, body);
      return;
    }
    case 'otlp': {
      // OTLP/HTTP with JSON encoding: lowerCamelCase names, integer enums, 64-bit numbers as strings.
      const str = (key: string, value: string | null | undefined) => (value == null ? [] : [{ key, value: { stringValue: value } }]);
      const now = `${BigInt(Date.now()) * 1_000_000n}`;
      const logRecords = events.map((e) => ({
        timeUnixNano: `${BigInt(e.atUs) * 1000n}`,
        observedTimeUnixNano: now,
        severityNumber: SEVERITY[e.outcome].otel,
        severityText: SEVERITY[e.outcome].text,
        eventName: 'dittoly.audit',
        body: { stringValue: e.summary },
        attributes: [
          ...str('dittoly.event.id', e.id), ...str('dittoly.action', e.action), ...str('dittoly.outcome', e.outcome), ...str('dittoly.error_type', e.errorType),
          ...str('dittoly.actor.id', e.actor?.id), ...str('dittoly.actor.name', e.actor?.name), ...str('dittoly.subject.type', e.subject.type),
          ...str('dittoly.subject.id', e.subject.id), ...str('dittoly.subject.name', e.subject.name), ...str('dittoly.related.id', e.related?.id),
          ...str('dittoly.related.name', e.related?.name), ...str('dittoly.at_us', e.atUs), ...str('dittoly.chain.hash', e.chain.hash), ...str('dittoly.chain.prev_hash', e.chain.prevHash),
        ],
      }));
      const body = { resourceLogs: [{ resource: { attributes: [...str('service.name', 'dittoly'), ...str('host.name', host)] }, scopeLogs: [{ scope: { name: 'dittoly.audit', version: '1' }, logRecords }] }] };
      const headers: Record<string, string> = { 'content-type': 'application/json', 'content-encoding': 'gzip' };
      if (s.headerName && secret.headerValue) headers[s.headerName.toLowerCase()] = secret.headerValue;
      const res = await post(d, withPath(s.url!, '/v1/logs'), headers, gzipSync(JSON.stringify(body)));
      // A partial success must not be retried; it is logged so an admin can look at the collector.
      const reply = (await res.json().catch(() => null)) as { partialSuccess?: { rejectedLogRecords?: string | number } } | null;
      if (Number(reply?.partialSuccess?.rejectedLogRecords ?? 0) > 0) log.warn('audit_stream_partial', { errorType: 'otlp_rejected_records' });
      return;
    }
    case 'syslog':
      await sendSyslog(d, s, events, host);
  }
}

/** RFC 5424 messages (facility 13, "log audit") over TLS (RFC 5425); the JSON event is the message. */
export function syslogLine(e: StreamEvent, host: string): string {
  const pri = 13 * 8 + SEVERITY[e.outcome].syslog;
  const msgId = e.action.replace(/[^\x21-\x7e]/g, '').slice(0, 32) || '-';
  return `<${pri}>1 ${e.at} ${host.slice(0, 255)} dittoly - ${msgId} - ${JSON.stringify(e)}`;
}

async function sendSyslog(d: StreamDeps, s: Settings, events: StreamEvent[], host: string): Promise<void> {
  const hostname = s.host!.replace(/^\[|\]$/g, '');
  const port = s.port ?? 6514;
  const hostKeys = [`${hostname}:${port}`.toLowerCase(), hostname.toLowerCase()];
  const literal = isIP(hostname) !== 0;
  // An IP is checked here; a name is checked at connect time, every address it resolves to, and each
  // allowed address is tried in turn (a host with an unreachable IPv6 address still gets through).
  if (literal) await resolveChecked(hostname, hostKeys, d.egress);
  const payload = events
    .map((e) => {
      const line = syslogLine(e, host);
      return s.framing === 'newline' ? `${line}\n` : `${Buffer.byteLength(line)} ${line}`;
    })
    .join('');
  await new Promise<void>((resolve, reject) => {
    const options: ConnectionOptions = {
      host: hostname,
      port,
      ...(literal ? {} : { servername: hostname, lookup: d.resolve ? guardedLookup(hostKeys, d.egress, d.resolve) : guardedLookup(hostKeys, d.egress), autoSelectFamily: true }),
      ...(d.tlsCa ? { ca: d.tlsCa } : {}),
      timeout: 20_000,
    };
    const socket = tlsConnect(options);
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.once('secureConnect', () => {
      // TLS syslog has no acknowledgement: delivered means written, flushed and closed cleanly.
      socket.end(payload, () => finish());
    });
    socket.once('timeout', () => finish(new SendError('syslog_timeout')));
    socket.once('error', (err) => finish(new SendError((err as NodeJS.ErrnoException).code === 'EGRESS_DENIED_IP' ? 'address_not_allowed' : `syslog_${(err as NodeJS.ErrnoException).code ?? 'error'}`.toLowerCase())));
  });
}

// ---------------------------------------------------------------- admin

const aad = (id: string) => `audit-stream:${id}`;

function splitBody(body: StreamBody): { settings: Settings; secret: Secret } {
  switch (body.kind) {
    case 'splunk':
      return { settings: { url: body.url, ...(body.index ? { index: body.index } : {}), ...(body.sourcetype ? { sourcetype: body.sourcetype } : {}) }, secret: { token: body.token } };
    case 'datadog':
      return { settings: { site: body.site, ...(body.service ? { service: body.service } : {}), ...(body.tags ? { tags: body.tags } : {}) }, secret: { apiKey: body.apiKey } };
    case 'https':
      return { settings: { url: body.url, ...(body.headerName ? { headerName: body.headerName } : {}) }, secret: { signingKey: randomToken(32), ...(body.headerValue ? { headerValue: body.headerValue } : {}) } };
    case 'otlp':
      return { settings: { url: body.url, ...(body.headerName ? { headerName: body.headerName } : {}) }, secret: body.headerValue ? { headerValue: body.headerValue } : {} };
    case 'syslog':
      return { settings: { host: body.host, port: body.port, framing: body.framing }, secret: {} };
  }
}

/** Where a stream sends, for the admin list (no secrets). */
export function targetOf(kind: string, s: Settings): string {
  if (kind === 'datadog') return `Datadog (${s.site})`;
  if (kind === 'syslog') return `${s.host}:${s.port} (syslog over TLS)`;
  return s.url ?? '';
}

export async function createStream(d: StreamDeps, actor: Member, body: StreamBody): Promise<{ id: string; signingKey?: string }> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if ('url' in body) {
    const u = new URL(body.url);
    if (u.protocol !== 'https:' && !d.insecureHttpHosts.includes(u.host)) throw badRequest('stream_must_be_https', 'Audit events are sent over HTTPS only.');
  }
  if ((body.kind === 'https' || body.kind === 'otlp') && Boolean(body.headerName) !== Boolean(body.headerValue)) throw badRequest('header_incomplete', 'Give both the header name and its value, or neither.');
  const { settings, secret } = splitBody(body);
  // "now" starts after the newest sealed event; "all" sends the whole history first.
  const cursor = body.startFrom === 'all' ? '0' : ((await d.db.query<{ id: string | null }>(`SELECT max(event_id)::text AS id FROM audit_seals`)).rows[0]?.id ?? '0');
  const { rows } = await d.db.query<{ id: string }>(
    `INSERT INTO audit_streams (kind, name, settings, cursor, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [body.kind, body.name, JSON.stringify(settings), cursor, actor.id],
  );
  const id = rows[0]!.id;
  if (Object.keys(secret).length) await d.db.query(`UPDATE audit_streams SET secret_enc = $2 WHERE id = $1`, [id, d.cipher.encrypt(JSON.stringify(secret), aad(id))]);
  await audit(d.db, { actorId: actor.id, action: 'audit.stream_added', subjectType: 'org', subjectId: id, outcome: 'ok', relatedId: body.kind });
  return { id, ...(secret.signingKey ? { signingKey: secret.signingKey } : {}) };
}

interface StreamRow {
  id: string;
  kind: keyof typeof BATCH;
  name: string;
  settings: Settings;
  secret_enc: string | null;
  enabled: boolean;
  cursor: string;
  sent: string;
  last_sent_at: Date | null;
  last_error: string | null;
  failing_since: Date | null;
  failures: number;
  next_attempt_at: Date | null;
  created_at: Date;
}

export async function listStreams(db: Queryable, actor: Member) {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rows } = await db.query<StreamRow & { behind: string }>(
    `SELECT s.*, s.cursor::text AS cursor, s.sent::text AS sent,
            (SELECT count(*) FROM audit_seals a WHERE a.event_id > s.cursor)::text AS behind
     FROM audit_streams s ORDER BY s.created_at`,
  );
  return rows.map((r) => ({
    id: r.id, kind: r.kind, name: r.name, target: targetOf(r.kind, r.settings), enabled: r.enabled,
    lastEvent: r.cursor, sent: Number(r.sent), behind: Number(r.behind), lastSentAt: r.last_sent_at,
    lastError: r.last_error, failingSince: r.failing_since, nextAttemptAt: r.failures > 0 ? r.next_attempt_at : null, createdAt: r.created_at,
  }));
}

export async function setStreamEnabled(db: Queryable, actor: Member, id: string, enabled: boolean): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rowCount } = await db.query(`UPDATE audit_streams SET enabled = $2, next_attempt_at = NULL, failures = 0 WHERE id = $1`, [id, enabled]);
  if (!rowCount) throw notFound('stream');
  await audit(db, { actorId: actor.id, action: enabled ? 'audit.stream_resumed' : 'audit.stream_paused', subjectType: 'org', subjectId: id, outcome: 'ok' });
}

export async function deleteStream(db: Queryable, actor: Member, id: string): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rowCount } = await db.query(`DELETE FROM audit_streams WHERE id = $1`, [id]);
  if (!rowCount) throw notFound('stream');
  await audit(db, { actorId: actor.id, action: 'audit.stream_removed', subjectType: 'org', subjectId: id, outcome: 'ok' });
}

function secretOf(d: StreamDeps, r: Pick<StreamRow, 'id' | 'secret_enc'>): Secret {
  return r.secret_enc ? (JSON.parse(d.cipher.decrypt(r.secret_enc, aad(r.id))) as Secret) : {};
}

const errorText = (err: unknown) => (err instanceof SendError ? err.message : (err as { code?: string }).code === 'EGRESS_DENIED_IP' ? 'address_not_allowed' : err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'send_failed').slice(0, 80);

/** "Send a test event" from the admin page: one made-up event, outside the stream's position. */
export async function testStream(d: StreamDeps, actor: Member, id: string): Promise<{ ok: boolean; error?: string }> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const r = (await d.db.query<StreamRow>(`SELECT * FROM audit_streams WHERE id = $1`, [id])).rows[0];
  if (!r) throw notFound('stream');
  const us = `${BigInt(Date.now()) * 1000n}`;
  const event = toStreamEvent(
    { id: '0', at_us: us, actor_id: actor.id, action: 'audit.stream_test', subject_type: 'org', subject_id: id, outcome: 'ok', error_type: null, related_id: null, hash: '0'.repeat(64) },
    '0'.repeat(64),
    new Map([[actor.id, actor.handle]]),
    d.publicUrl,
  );
  try {
    await sendBatch(d, r.kind, r.settings, secretOf(d, r), [event]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

// ---------------------------------------------------------------- delivery

const LEASE_SECONDS = 120;
const backoffSeconds = (failures: number) => Math.min(30 * 2 ** Math.max(0, failures - 1), 15 * 60);

/** Next sealed events after `cursor`, with the hash of the event before the first. */
async function sealedAfter(db: Queryable, cursor: string, limit: number): Promise<{ rows: SealedRow[]; prev: string }> {
  const { rows } = await db.query<SealedRow>(
    `SELECT e.id::text AS id, (extract(epoch FROM e.at) * 1000000)::bigint::text AS at_us, e.actor_id::text AS actor_id, e.action, e.subject_type,
            e.subject_id, e.outcome, e.error_type, e.related_id, s.hash
     FROM audit_seals s JOIN audit_events e ON e.id = s.event_id
     WHERE s.event_id > $1 ORDER BY s.event_id LIMIT $2`,
    [cursor, limit],
  );
  if (!rows.length) return { rows, prev: '' };
  const before = (await db.query<{ hash: string }>(`SELECT hash FROM audit_seals WHERE event_id < $1 ORDER BY event_id DESC LIMIT 1`, [rows[0]!.id])).rows[0];
  return { rows, prev: before?.hash ?? GENESIS };
}

/**
 * Maintenance: send what each enabled stream has not had yet. A stream is leased while it
 * sends, so two passes never send the same batch; a failure keeps the position and waits
 * longer each time (30 seconds up to 15 minutes). Returns how many events were delivered.
 */
export async function pumpStreams(d: StreamDeps, maxBatches = 20): Promise<number> {
  const due = (await d.db.query<{ id: string }>(`SELECT id FROM audit_streams WHERE enabled AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY created_at`)).rows;
  let delivered = 0;
  for (const { id } of due) {
    const lease = await d.db.query<StreamRow>(
      `UPDATE audit_streams SET next_attempt_at = now() + make_interval(secs => $2)
       WHERE id = $1 AND enabled AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       RETURNING *, cursor::text AS cursor`,
      [id, LEASE_SECONDS],
    );
    const r = lease.rows[0];
    if (!r) continue;
    let cursor = r.cursor;
    let wasFailing = r.failures > 0;
    try {
      const secret = secretOf(d, r);
      for (let i = 0; i < maxBatches; i++) {
        const { rows, prev } = await sealedAfter(d.db, cursor, BATCH[r.kind]);
        if (!rows.length) break;
        const names = await namesFor(d.db, rows);
        let p = prev;
        const events = rows.map((row) => {
          const e = toStreamEvent(row, p, names, d.publicUrl);
          p = row.hash;
          return e;
        });
        await sendBatch(d, r.kind, r.settings, secret, events);
        cursor = rows[rows.length - 1]!.id;
        delivered += rows.length;
        await d.db.query(
          `UPDATE audit_streams SET cursor = $2, sent = sent + $3, last_sent_at = now(), last_error = NULL, failing_since = NULL, failures = 0 WHERE id = $1`,
          [id, cursor, rows.length],
        );
        if (wasFailing) {
          wasFailing = false;
          await audit(d.db, { actorId: null, action: 'audit.stream_recovered', subjectType: 'org', subjectId: id, outcome: 'ok' });
        }
        if (rows.length < BATCH[r.kind]) break;
      }
      await d.db.query(`UPDATE audit_streams SET next_attempt_at = NULL WHERE id = $1`, [id]);
    } catch (err) {
      const error = errorText(err);
      const failures = (await d.db.query<{ failures: number }>(`SELECT failures FROM audit_streams WHERE id = $1`, [id])).rows[0]?.failures ?? 0;
      const first = failures === 0;
      await d.db.query(
        `UPDATE audit_streams SET last_error = $2, failures = failures + 1, failing_since = coalesce(failing_since, now()), next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`,
        [id, error, backoffSeconds(failures + 1)],
      );
      log.warn('audit_stream_failed', { errorType: error });
      // Admins are told when a stream starts failing, not on every retry.
      if (first) {
        await audit(d.db, { actorId: null, action: 'audit.stream_failed', subjectType: 'org', subjectId: id, outcome: 'failed', errorType: error });
        await notifyRole(d.db, ['admin'], 'audit_stream_failed');
      }
    }
  }
  return delivered;
}


/**
 * Dittoly events from a SIEM export, one JSON object per line (or a JSON array): the event
 * itself (HTTPS, syslog message), Splunk's {"event": …} or {"result": {"_raw": …}}, or
 * Datadog's {"dittoly": …} / {"attributes": {"dittoly": …}}. Other lines are skipped.
 */
export function eventsFromExport(text: string): StreamEvent[] {
  const trimmed = text.trim();
  const items: unknown[] = trimmed.startsWith('[') ? (JSON.parse(trimmed) as unknown[]) : trimmed.split('\n').flatMap((l) => {
    const line = l.trim();
    if (!line) return [];
    const start = line.indexOf('{');
    try {
      return start < 0 ? [] : [JSON.parse(line.slice(start))];
    } catch {
      return [];
    }
  });
  const pick = (v: unknown): StreamEvent | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (o.schema === 'dittoly.audit/1') return o as unknown as StreamEvent;
    if (typeof o._raw === 'string') {
      try {
        return pick(JSON.parse(o._raw));
      } catch {
        return null;
      }
    }
    return pick(o.event) ?? pick(o.result) ?? pick(o.dittoly) ?? pick(o.attributes);
  };
  return items.map(pick).filter((e): e is StreamEvent => e !== null && e.id !== '0');
}

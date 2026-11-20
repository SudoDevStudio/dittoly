import { BLOCKED_HEADERS, placeCredential, type CallKind, type CallOutcome, type EndpointCaller } from './broker.js';
import { isEgressDenied } from './egress.js';
import { endpointPort, isDatabase, mqttTopicMatches } from './manifest.js';
import { checkMongoParams, fillTemplate } from './mongo.js';
import { TransportError, type Login, type Target, type TransportMakers, type Transports } from './protocols.js';
import { bindSql, checkParams } from './sql.js';
import type { Endpoint } from './types.js';

/**
 * SMTP, AMQP, MQTT, WebSocket, SSE and database calls made through the broker. The endpoint,
 * its protocol, the credential, the action's effect and the message limits are all checked
 * here; database calls run only the reviewed queries, with values as bound parameters.
 */

const CALL_PROTOCOL: Record<Exclude<CallKind, 'db.query'>, Endpoint['protocol']> = {
  'smtp.send': 'smtp',
  'amqp.publish': 'amqp',
  'mqtt.publish': 'mqtt',
  'ws.exchange': 'websocket',
  'sse.read': 'sse',
};

const EMAIL = /^[^\s@<>",;:\\]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const MAX_RECIPIENTS = 50;
const MAX_MESSAGE_BYTES = 1_000_000;
const bounded = (v: unknown, min: number, max: number, dflt: number) => (typeof v === 'number' && Number.isInteger(v) ? Math.min(Math.max(v, min), max) : dflt);
const asList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
/** A message body: strings as-is, anything else as JSON. */
function payload(v: unknown): { body: Buffer; contentType: string } | null {
  if (v === undefined) return null;
  if (typeof v === 'string') return { body: Buffer.from(v, 'utf8'), contentType: 'text/plain' };
  return { body: Buffer.from(JSON.stringify(v), 'utf8'), contentType: 'application/json' };
}

/** Calls through the transports given (one per protocol the app's modules use); `overrides` are test stand-ins. */
export function endpointCaller(makers: TransportMakers, overrides: Partial<Transports> = {}): EndpointCaller {
  return async (s, action, endpoint, kind, req) => {
    if (kind === 'db.query' ? !isDatabase(endpoint) : endpoint.protocol !== CALL_PROTOCOL[kind as Exclude<CallKind, 'db.query'>]) return s.deny('endpoint_protocol_mismatch');
    if (/^\{\{settings\./.test(endpoint.host)) return { ok: false, error: 'module_settings_missing', retryable: false, violation: false };
    const { manifest } = s.ctx;

    const port = endpointPort(endpoint);
    const hostname = endpoint.host.replace(/:\d+$/, '').toLowerCase();
    const target: Target = { hostname, port, hostKeys: [...new Set([endpoint.host.toLowerCase(), `${hostname}:${port}`])] };
    const encrypted = endpoint.protocol === 'smtp' ? endpoint.tls !== 'none' : endpoint.tls;
    // Plain text only for hosts an admin listed for local development, like plain http.
    if (!encrypted && !target.hostKeys.some((k) => (s.ctx.insecureHttpHosts ?? []).includes(k))) return s.deny('egress_denied_plaintext');

    let secret: string | null = null;
    const cred = endpoint.credential ? manifest.credentials.find((c) => c.id === endpoint.credential) : undefined;
    if (endpoint.credential) {
      if (!cred || !action.credentials.includes(cred.id)) return s.deny('credential_denied');
      if (!cred.hosts.includes(endpoint.host)) return s.deny('credential_denied_host');
      secret = await s.ctx.resolveSecret(cred.service);
      if (secret === null && !cred.optional) return { ok: false, error: 'credential_missing', retryable: false, violation: false };
    }
    const login = (): Login | null => {
      if (secret === null) return null;
      const i = secret.indexOf(':');
      return i === -1 ? { username: secret, password: '' } : { username: secret.slice(0, i), password: secret.slice(i + 1) };
    };
    const policy = { internalHosts: s.ctx.internalHosts ?? [], loopbackHosts: s.ctx.insecureHttpHosts ?? [] };
    const use = <K extends keyof Transports>(k: K): Transports[K] => {
      const made = overrides[k] ?? makers[k]?.(policy, s.ctx.fetchImpl);
      if (!made) throw new TransportError(`${endpoint.protocol}_unavailable`, false);
      return made as Transports[K];
    };
    const timeoutMs = s.ctx.timeoutMs ?? 15_000;
    const publishes = kind === 'smtp.send' || kind === 'amqp.publish' || kind === 'mqtt.publish';
    // Sending email or publishing a message changes something outside: only write actions may.
    if (publishes && action.effect !== 'write') return s.deny('effect_read_cannot_send');

    try {
      switch (endpoint.protocol) {
        case 'smtp': {
          const to = asList(req.to), cc = asList(req.cc), bcc = asList(req.bcc);
          const all = [...to, ...cc, ...bcc];
          if (to.length === 0 || all.length > MAX_RECIPIENTS || !all.every((a) => typeof a === 'string' && EMAIL.test(a))) return s.invalid('smtp_bad_recipients');
          if (req.replyTo !== undefined && !(typeof req.replyTo === 'string' && EMAIL.test(req.replyTo))) return s.invalid('smtp_bad_reply_to');
          if (typeof req.subject !== 'string' || req.subject.length > 998 || /[\r\n]/.test(req.subject)) return s.invalid('smtp_bad_subject');
          const text = typeof req.text === 'string' ? req.text : undefined;
          const html = typeof req.html === 'string' ? req.html : undefined;
          if (text === undefined && html === undefined) return s.invalid('smtp_no_body');
          if (Buffer.byteLength((text ?? '') + (html ?? '')) > MAX_MESSAGE_BYTES) return s.deny('request_too_large');
          if (/^\{\{settings\./.test(endpoint.from)) return { ok: false, error: 'module_settings_missing', retryable: false, violation: false };
          s.wrote();
          const r = await use('smtp')(target, endpoint.tls, login(), {
            from: endpoint.from,
            to: to as string[],
            cc: cc as string[],
            bcc: bcc as string[],
            replyTo: req.replyTo as string | undefined,
            subject: req.subject,
            text,
            html,
          }, Math.max(timeoutMs, 30_000));
          return { ok: true, result: { accepted: r.accepted, rejected: r.rejected } };
        }
        case 'amqp': {
          if (typeof req.exchange !== 'string' || !endpoint.exchanges.includes(req.exchange)) return s.deny('amqp_exchange_denied');
          const routingKey = typeof req.routingKey === 'string' ? req.routingKey : '';
          if (routingKey.length > 255) return s.invalid('amqp_bad_routing_key');
          const body = payload(req.message);
          if (!body) return s.invalid('amqp_no_message');
          if (body.body.length > MAX_MESSAGE_BYTES) return s.deny('request_too_large');
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries((req.headers as Record<string, unknown>) ?? {}).slice(0, 20)) if (typeof v === 'string' && k.length <= 64) headers[k] = v.slice(0, 1000);
          s.wrote();
          await use('amqp')(target, endpoint.tls, login(), endpoint.vhost, { exchange: req.exchange, routingKey, body: body.body, contentType: body.contentType, headers, persistent: req.persistent !== false }, timeoutMs);
          return { ok: true, result: { published: true } };
        }
        case 'mqtt': {
          const topic = req.topic;
          if (typeof topic !== 'string' || !topic || topic.length > 200 || /[+#\u0000]/.test(topic)) return s.invalid('mqtt_bad_topic');
          if (!endpoint.topics.some((f) => mqttTopicMatches(f, topic))) return s.deny('mqtt_topic_denied');
          const body = payload(req.message);
          if (!body) return s.invalid('mqtt_no_message');
          if (body.body.length > 256_000) return s.deny('request_too_large');
          const qos = req.qos === 0 ? 0 : 1;
          s.wrote();
          await use('mqtt')(target, endpoint.tls, login(), { topic, payload: body.body, qos, retain: req.retain === true }, timeoutMs);
          return { ok: true, result: { published: true } };
        }
        case 'mongodb': {
          const o = endpoint.operations.find((x) => x.id === req.query);
          if (!o) return s.deny('db_query_denied');
          if (o.effect === 'write' && action.effect !== 'write') return s.deny('effect_read_cannot_write');
          const params = checkMongoParams(o.params, req.params, o.op === 'aggregate');
          if (!params.ok) return s.invalid(params.error);
          if (/^\{\{settings\./.test(endpoint.database)) return { ok: false, error: 'module_settings_missing', retryable: false, violation: false };
          const who = login();
          if (!who) return { ok: false, error: 'credential_missing', retryable: false, violation: false };
          if (o.effect === 'write') s.wrote();
          const fill = <T>(x: T) => (x === undefined ? undefined : fillTemplate(x, params.values));
          const r = await use('mongo')(target, {
            queryId: o.id,
            srv: endpoint.srv,
            tls: endpoint.tls,
            ca: endpoint.ca && !/^\{\{settings\./.test(endpoint.ca) ? endpoint.ca : undefined,
            login: who,
            authSource: endpoint.authSource,
            database: endpoint.database,
            collection: o.collection,
            op: o.op,
            filter: fill(o.filter),
            projection: o.projection,
            sort: o.sort,
            pipeline: fill(o.pipeline),
            document: fill(o.document),
            update: fill(o.update),
            upsert: o.upsert,
            readOnly: o.effect === 'read',
            maxRows: o.maxRows,
            maxBytes: 2_000_000,
            timeoutMs,
          });
          return { ok: true, result: r };
        }
        case 'postgres':
        case 'mysql':
        case 'mssql': {
          // Only the queries an admin reviewed; values go to the database as bound parameters.
          const q = endpoint.queries.find((x) => x.id === req.query);
          if (!q) return s.deny('db_query_denied');
          if (q.effect === 'write' && action.effect !== 'write') return s.deny('effect_read_cannot_write');
          const params = checkParams(q.params, req.params);
          if (!params.ok) return s.invalid(params.error);
          if (/^\{\{settings\./.test(endpoint.database)) return { ok: false, error: 'module_settings_missing', retryable: false, violation: false };
          const who = login();
          if (!who) return { ok: false, error: 'credential_missing', retryable: false, violation: false };
          const bound = bindSql(q.sql, endpoint.protocol, params.values);
          if (q.effect === 'write') s.wrote();
          const r = await use('db')(endpoint.protocol, target, {
            queryId: q.id,
            tls: endpoint.tls,
            ca: endpoint.ca && !/^\{\{settings\./.test(endpoint.ca) ? endpoint.ca : undefined,
            login: who,
            database: endpoint.database,
            text: bound.text,
            values: bound.values,
            readOnly: q.effect === 'read',
            maxRows: q.maxRows,
            maxBytes: 2_000_000,
            timeoutMs,
          });
          return { ok: true, result: r };
        }
        case 'websocket':
        case 'sse': {
          const path = typeof req.path === 'string' ? req.path : '/';
          if (!path.startsWith('/') || path.length > 2000 || /[\s#]/.test(path)) return s.invalid('bad_path');
          const scheme = endpoint.protocol === 'websocket' ? (endpoint.tls ? 'wss' : 'ws') : endpoint.tls ? 'https' : 'http';
          const defaultPort = endpoint.tls ? 443 : 80;
          const url = `${scheme}://${hostname}${port === defaultPort ? '' : `:${port}`}${path}`;
          const headers = new Headers();
          for (const [k, v] of Object.entries((req.headers as Record<string, unknown>) ?? {})) {
            const name = k.toLowerCase();
            if (BLOCKED_HEADERS.has(name) || name.startsWith('sec-websocket') || typeof v !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) continue;
            headers.set(name, v);
          }
          if (cred && secret !== null) placeCredential(headers, cred.placement, secret);
          const maxMs = bounded(req.maxMs, 100, 30_000, 5_000);
          const maxBytes = 2_000_000;
          if (endpoint.protocol === 'sse') {
            const r = await use('sse')(url, target, { headers: Object.fromEntries(headers), maxEvents: bounded(req.maxEvents, 1, 100, 10), maxMs, maxBytes });
            return { ok: true, result: r };
          }
          const send = asList(req.send).map((m) => (typeof m === 'string' ? m : JSON.stringify(m)));
          if (send.length > 20 || send.some((m) => Buffer.byteLength(m) > 64_000)) return s.deny('request_too_large');
          const protocols = asList(req.protocols).filter((p): p is string => typeof p === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(p)).slice(0, 5);
          if (send.length > 0) s.wrote();
          const r = await use('ws')(url, target, { headers: Object.fromEntries(headers), protocols, send, maxMessages: bounded(req.maxMessages, 1, 100, 10), maxMs, maxBytes });
          return { ok: true, result: r };
        }
      }
    } catch (err) {
      if (isEgressDenied(err)) return s.deny('egress_denied_ip');
      if (err instanceof TransportError) return { ok: false, error: err.code, retryable: err.retryable, violation: false };
      return { ok: false, error: `${endpoint.protocol}_error`, retryable: true, violation: false };
    }
  };
}

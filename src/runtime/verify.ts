import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constantTimeEqual } from './crypto.js';

/**
 * Webhook signature checks.
 *
 * Standard Webhooks (also what GitLab signing tokens send):
 *   signed content  = `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   key             = base64-decode(secret without "whsec_")
 *   webhook-signature = space-separated "v1,<base64 HMAC-SHA256>"
 *
 * GitHub:
 *   X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256(secret, raw body)
 *   GitHub sends no timestamp, so replay protection relies on X-GitHub-Delivery dedupe.
 *
 * Token (senders that cannot sign: Datadog monitor webhooks, Grafana contact points, Vector,
 * Fluent Bit): the trigger's secret token in X-Dittoly-Token or "Authorization: Bearer",
 * compared in constant time. The token is the authentication, so replay protection comes from
 * dedupe: a webhook-id / idempotency-key header when the sender sets one, else the body's hash,
 * plus an optional webhook-timestamp header (and, in the service, a payload id and time).
 */

export type Provider = 'standard' | 'github' | 'gitlab' | 'token';

export type VerifyResult =
  | { ok: true; deliveryId: string; legacy?: boolean }
  | { ok: false; reason: 'unsigned' | 'bad_signature' | 'stale_timestamp' | 'missing_id' };

export function newStandardSecret(): string {
  return 'whsec_' + randomBytes(32).toString('base64');
}

export function newGithubSecret(): string {
  return randomBytes(32).toString('hex');
}

export function newTokenSecret(): string {
  return 'dtywt_' + randomBytes(32).toString('base64url');
}

function standardKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
}

export function signStandard(secret: string, id: string, timestamp: number, body: Buffer | string): string {
  const mac = createHmac('sha256', standardKey(secret)).update(`${id}.${timestamp}.`).update(body).digest('base64');
  return `v1,${mac}`;
}

export function signGithub(secret: string, body: Buffer | string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export function verifyStandard(
  headers: Headers,
  body: Buffer,
  secrets: string[],
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  const id = header(headers, 'webhook-id');
  const ts = header(headers, 'webhook-timestamp');
  const sig = header(headers, 'webhook-signature');
  if (!sig) return { ok: false, reason: 'unsigned' };
  if (!id || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return { ok: false, reason: 'missing_id' };
  const timestamp = Number(ts);
  if (!ts || !/^\d{1,12}$/.test(ts) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  const received = sig
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3));
  for (const secret of secrets) {
    const expected = signStandard(secret, id, timestamp, body).slice(3);
    // Check every candidate so timing does not depend on which one matched.
    let match = false;
    for (const r of received) match = constantTimeEqual(expected, r) || match;
    if (match) return { ok: true, deliveryId: id };
  }
  return { ok: false, reason: 'bad_signature' };
}

export function verifyGithub(headers: Headers, body: Buffer, secrets: string[]): VerifyResult {
  const sig = header(headers, 'x-hub-signature-256');
  if (!sig) return { ok: false, reason: 'unsigned' };
  const id = header(headers, 'x-github-delivery');
  if (!id || !/^[A-Za-z0-9-]{1,128}$/.test(id)) return { ok: false, reason: 'missing_id' };
  for (const secret of secrets) {
    if (constantTimeEqual(signGithub(secret, body), sig)) return { ok: true, deliveryId: id };
  }
  return { ok: false, reason: 'bad_signature' };
}

/**
 * GitLab: signing token (Standard Webhooks). The old X-Gitlab-Token is accepted
 * only when the trigger still has a legacy token configured for migration.
 */
export function verifyGitlab(
  headers: Headers,
  body: Buffer,
  secrets: string[],
  legacyToken: string | null,
  toleranceSeconds: number,
  nowSeconds?: number,
): VerifyResult {
  if (header(headers, 'webhook-signature')) return verifyStandard(headers, body, secrets, toleranceSeconds, nowSeconds);
  const token = header(headers, 'x-gitlab-token');
  if (!token || !legacyToken) return { ok: false, reason: 'unsigned' };
  if (!constantTimeEqual(token, legacyToken)) return { ok: false, reason: 'bad_signature' };
  const id = header(headers, 'webhook-id') ?? header(headers, 'idempotency-key') ?? header(headers, 'x-gitlab-event-uuid');
  if (!id || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return { ok: false, reason: 'missing_id' };
  const ts = header(headers, 'webhook-timestamp');
  if (ts) {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!/^\d{1,12}$/.test(ts) || Math.abs(now - Number(ts)) > toleranceSeconds) return { ok: false, reason: 'stale_timestamp' };
  }
  return { ok: true, deliveryId: id, legacy: true };
}

/**
 * Token senders. The id is the sender's delivery header when it sets one, else "sha256:<body hash>",
 * so an identical body is one delivery. A webhook-timestamp header, when present, must be fresh.
 */
export function verifyToken(
  headers: Headers,
  body: Buffer,
  secrets: string[],
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  const auth = header(headers, 'authorization');
  const bearer = auth && /^Bearer\s+\S/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : undefined;
  const token = header(headers, 'x-dittoly-token') ?? bearer;
  if (!token) return { ok: false, reason: 'unsigned' };
  // Check every candidate so timing does not depend on which one matched.
  let match = false;
  for (const secret of secrets) match = constantTimeEqual(secret, token) || match;
  if (!match) return { ok: false, reason: 'bad_signature' };
  const ts = header(headers, 'webhook-timestamp');
  if (ts !== undefined && (!/^\d{1,12}$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > toleranceSeconds)) return { ok: false, reason: 'stale_timestamp' };
  const id = header(headers, 'webhook-id') ?? header(headers, 'idempotency-key');
  if (id !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return { ok: false, reason: 'missing_id' };
  return { ok: true, deliveryId: id ?? `sha256:${createHash('sha256').update(body).digest('hex')}` };
}

/** Where a token trigger finds a delivery id and the time of the event in the payload (JSON Pointers). */
export interface TokenPayloadOptions {
  deliveryIdPointer?: string;
  timestampPointer?: string;
  /** How old the payload's time may be; the server's tolerance when not set. */
  maxAgeSeconds?: number;
}

function pointerValue(doc: unknown, ptr: string): unknown {
  if (ptr === '') return doc;
  let cur: unknown = doc;
  for (const raw of ptr.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Seconds since the epoch, from epoch seconds, epoch milliseconds or an ISO 8601 time. */
function epochSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v / 1000 : v;
  if (typeof v === 'string' && /^\d{1,13}$/.test(v)) return epochSeconds(Number(v));
  if (typeof v === 'string' && v.length <= 40) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t / 1000;
  }
  return null;
}

/**
 * The payload half of a token delivery's replay limits: its own id (e.g. Datadog's $ID) and its
 * time (e.g. Datadog's $DATE), which must be at most maxAgeSeconds old and not in the future.
 */
export function checkTokenPayload(
  payload: unknown,
  opts: TokenPayloadOptions,
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true; deliveryId?: string } | { ok: false; reason: 'stale_timestamp' | 'missing_id' } {
  if (opts.timestampPointer !== undefined) {
    const t = epochSeconds(pointerValue(payload, opts.timestampPointer));
    if (t === null || nowSeconds - t > (opts.maxAgeSeconds ?? toleranceSeconds) || t - nowSeconds > toleranceSeconds) return { ok: false, reason: 'stale_timestamp' };
  }
  if (opts.deliveryIdPointer === undefined) return { ok: true };
  const id = pointerValue(payload, opts.deliveryIdPointer);
  const text = typeof id === 'number' && Number.isFinite(id) ? String(id) : id;
  if (typeof text !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(text)) return { ok: false, reason: 'missing_id' };
  return { ok: true, deliveryId: `payload:${text}` };
}

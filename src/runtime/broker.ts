import { guardedFetch, isEgressDenied } from './egress.js';
import type { Endpoint, Manifest, ManifestAction, ManifestCredential } from './types.js';

/**
 * The network broker. Sandboxed modules have no network access of their own;
 * every request they make arrives here and is checked against the manifest:
 *
 * - the URL host must be one the manifest declares,
 * - a credential must be declared, used by this action, and meant for this host,
 * - the secret is attached here, so module code never sees it.
 *
 * Any denial is a manifest violation: the step fails.
 */

export interface BrokerRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  credential: string | null;
  body: string | null;
  json: boolean;
  /** A multipart/form-data body (file uploads): text parts, and files as base64 with a file name. */
  multipart?: MultipartPart[] | null;
}

export interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  /** File content, base64. */
  data?: string;
}

const MAX_MULTIPART_BYTES = 10_000_000;

/** Build a form from the module's parts; null when a part is malformed or the whole is too large. */
function multipartForm(parts: unknown): FormData | null {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 20) return null;
  const form = new FormData();
  let total = 0;
  for (const p of parts as MultipartPart[]) {
    if (!p || typeof p.name !== 'string' || !/^[A-Za-z0-9_.[\]-]{1,100}$/.test(p.name)) return null;
    if (typeof p.data === 'string') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)) return null;
      const bytes = Buffer.from(p.data, 'base64');
      total += bytes.length;
      const type = typeof p.contentType === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(p.contentType) ? p.contentType : 'application/octet-stream';
      const filename = typeof p.filename === 'string' ? p.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file' : 'file';
      form.append(p.name, new Blob([bytes], { type }), filename);
    } else if (typeof p.value === 'string') {
      total += p.value.length;
      form.append(p.name, p.value);
    } else return null;
    if (total > MAX_MULTIPART_BYTES) return null;
  }
  return form;
}

export interface BrokerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type BrokerOutcome =
  | { ok: true; response: BrokerResponse }
  | { ok: false; error: string; retryable: boolean; violation: boolean };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BrokerContext {
  manifest: Manifest;
  action: string;
  /** Returns the secret for a service, for the identity this step runs as. */
  resolveSecret: (service: string) => Promise<string | null>;
  insecureHttpHosts?: readonly string[];
  /** host[:port] values allowed to resolve to private network addresses (self-hosted internal systems). */
  internalHosts?: readonly string[];
  /** Test hook: replaces the network entirely (the egress guard is then the test's responsibility). */
  fetchImpl?: FetchLike;
  /** Told each HTTP call and how it answered ("GET api.github.com/search/issues → 422: Validation Failed"): never a header; for a refused call also the app's short reason and what was sent (query and body). */
  onCall?: (line: string) => void;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequests?: number;
  /** Turns a Google service account key into an access token; without it such credentials are refused. */
  googleToken?: (secret: string, scopes: readonly string[]) => Promise<string>;
  /** SMTP, AMQP, MQTT, WebSocket, SSE and database calls (endpoint-calls.ts); without it every such call is refused. */
  calls?: EndpointCaller;
}

/** Calls other than plain HTTP requests, made through ctx.<protocol> in module code. */
export const CALL_KINDS = ['smtp.send', 'amqp.publish', 'mqtt.publish', 'ws.exchange', 'sse.read', 'db.query'] as const;
export type CallKind = (typeof CALL_KINDS)[number];
export type CallOutcome = { ok: true; result: unknown } | { ok: false; error: string; retryable: boolean; violation: boolean };


/** What an endpoint call may do to the broker it runs in. */
export interface CallSession {
  readonly ctx: BrokerContext;
  /** A manifest violation. */
  deny(error: string): CallOutcome;
  /** A malformed call from the module: its own bug, not a policy violation. */
  invalid(error: string): CallOutcome;
  /** Something may have been sent that changes data elsewhere. */
  wrote(): void;
}

export type EndpointCaller = (s: CallSession, action: ManifestAction, endpoint: Endpoint, kind: CallKind, req: Record<string, unknown>) => Promise<CallOutcome>;

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** The only headers sent with a read-only public-web request. */
const PUBLIC_READ_HEADERS = new Set(['accept', 'accept-language', 'user-agent', 'range']);

/** Headers a module may not set itself. */
export const BLOCKED_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'cookie',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
]);
const RESPONSE_HEADERS = [
  'content-type',
  'location',
  'link',
  'retry-after',
  'x-total',
  'x-next-page',
  'etag',
  // MCP Streamable HTTP
  'mcp-session-id',
  'mcp-protocol-version',
];

export class Broker {
  private requestCount = 0;
  /** True once a non-GET/HEAD request may have reached the target app. */
  writeSent = false;
  violations: string[] = [];
  private readonly session: CallSession;

  constructor(protected readonly ctx: BrokerContext) {
    this.session = {
      ctx,
      deny: (e) => this.deny(e),
      invalid: (e) => this.invalid(e),
      wrote: () => {
        this.writeSent = true;
      },
    };
  }

  /** Denials are the same shape for every kind of call. */
  protected deny(error: string): BrokerOutcome & CallOutcome {
    this.violations.push(error);
    return { ok: false, error, retryable: false, violation: true };
  }

  protected invalid(error: string): CallOutcome {
    return { ok: false, error, retryable: false, violation: false };
  }

  /** Counts every request and call; past the limit each one is a violation. */
  protected overLimit(): boolean {
    this.requestCount += 1;
    return this.requestCount > (this.ctx.maxRequests ?? 50);
  }

  async handle(req: BrokerRequest): Promise<BrokerOutcome> {
    const { manifest } = this.ctx;
    const action = manifest.actions.find((a) => a.name === this.ctx.action);
    if (!action) return this.deny('unknown_action');

    if (this.overLimit()) return this.deny('too_many_requests');

    const method = String(req.method).toUpperCase();
    if (!METHODS.has(method)) return this.deny('egress_denied_method');

    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return this.deny('egress_denied_url');
    }
    if (url.username || url.password) return this.deny('egress_denied_url');
    const host = url.host.toLowerCase();
    const insecureOk = (this.ctx.insecureHttpHosts ?? []).includes(host);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && insecureOk))) {
      return this.deny('egress_denied_scheme');
    }
    // Read-only public web: any public https page, but nothing that sends data or credentials.
    const publicRead = !manifest.hosts.includes(host) && manifest.publicWeb === 'read';
    if (!manifest.hosts.includes(host) && !publicRead) return this.deny('egress_denied_host');
    if (publicRead) {
      if (url.protocol !== 'https:') return this.deny('egress_denied_scheme');
      if (method !== 'GET' && method !== 'HEAD') return this.deny('public_web_read_only');
      if (req.credential !== null && req.credential !== undefined) return this.deny('credential_denied_host');
      if (req.body) return this.deny('public_web_read_only');
      if (url.href.length > 2048) return this.deny('public_web_url_too_long');
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const name = k.toLowerCase();
      if (BLOCKED_HEADERS.has(name) || typeof v !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) continue;
      // To sites it was not approved for, a module sends only plain content negotiation, never its own data.
      if (publicRead && !PUBLIC_READ_HEADERS.has(name)) continue;
      headers.set(name, v);
    }
    if (req.json && !headers.has('content-type')) headers.set('content-type', 'application/json');

    if (req.credential !== null && req.credential !== undefined) {
      const cred = manifest.credentials.find((c) => c.id === req.credential);
      if (!cred || !action.credentials.includes(cred.id)) return this.deny('credential_denied');
      if (!cred.hosts.includes(host)) return this.deny('credential_denied_host');
      if (cred.placement.type === 'env') return this.deny('credential_placement_unsupported');
      const secret = await this.ctx.resolveSecret(cred.service);
      // An optional credential that is not set: the request goes out without it (public data).
      if (secret === null && !cred.optional) return { ok: false, error: 'credential_missing', retryable: false, violation: false };
      if (secret !== null && cred.placement.type === 'google_service_account') {
        if (!this.ctx.googleToken) return { ok: false, error: 'google_token_unavailable', retryable: false, violation: false };
        try {
          const token = await this.ctx.googleToken(secret, cred.placement.scopes);
          headers.set('authorization', `Bearer ${token}`);
        } catch (err) {
          const e = err as { code?: unknown; retryable?: unknown };
          if (typeof e?.code === 'string' && typeof e.retryable === 'boolean') return { ok: false, error: e.code, retryable: e.retryable, violation: false };
          return { ok: false, error: 'google_token_unavailable', retryable: true, violation: false };
        }
      } else if (secret !== null) placeCredential(headers, cred.placement, secret);
    }

    let body: string | Uint8Array<ArrayBuffer> | undefined = method === 'GET' || method === 'HEAD' ? undefined : (req.body ?? undefined);
    if (typeof body === 'string' && body.length > 1_000_000) return this.deny('request_too_large');
    if (req.multipart) {
      if (publicRead || (method !== 'POST' && method !== 'PUT')) return this.deny('egress_denied_method');
      const form = multipartForm(req.multipart);
      if (!form) return this.deny('request_too_large');
      // Encoded here, with its boundary, so every fetch implementation sends the same bytes.
      const encoded = new Response(form);
      headers.set('content-type', encoded.headers.get('content-type') ?? 'multipart/form-data');
      body = new Uint8Array(await encoded.arrayBuffer());
    }

    const fetchImpl =
      this.ctx.fetchImpl ??
      // Public-web reads never get the private-address allowances admins grant for declared hosts.
      (publicRead ? guardedFetch({ internalHosts: [], loopbackHosts: [] }) : guardedFetch({ internalHosts: this.ctx.internalHosts ?? [], loopbackHosts: this.ctx.insecureHttpHosts ?? [] }));
    if (method !== 'GET' && method !== 'HEAD') this.writeSent = true;
    let res: Response;
    const called = `${method} ${url.host}${url.pathname}`.slice(0, 300);
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers,
        body,
        // Redirects are returned to the module; following one is a new, re-checked request.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.ctx.timeoutMs ?? 15_000),
      });
    } catch (err) {
      this.ctx.onCall?.(`${called} → no answer`);
      if (isEgressDenied(err)) return this.deny('egress_denied_ip');
      const timeout = (err as { name?: string })?.name === 'TimeoutError';
      return { ok: false, error: timeout ? 'upstream_timeout' : 'network_error', retryable: true, violation: false };
    }

    const limit = this.ctx.maxResponseBytes ?? 2_000_000;
    let buf: Buffer | null;
    try {
      buf = await readLimited(res, limit);
    } catch (err) {
      this.ctx.onCall?.(`${called} → ${res.status}`);
      const timeout = (err as { name?: string })?.name === 'TimeoutError';
      return { ok: false, error: timeout ? 'upstream_timeout' : 'network_error', retryable: true, violation: false };
    }
    // A refused call also tells the app's own short reason ("Validation Failed: …"), never the rest of the body.
    const why = res.status >= 400 && buf ? appMessage(buf) : '';
    // A refused call also says what was sent (the query and the body the module built; credentials are only ever in
    // headers, which are never shown), so the person can see what the app refused.
    const sent = res.status >= 400 ? sentOf(url, body) : '';
    this.ctx.onCall?.(`${called} → ${res.status}${why ? `: ${why}` : ''}${sent}`);
    if (!buf) return { ok: false, error: 'response_too_large', retryable: false, violation: false };
    const outHeaders: Record<string, string> = {};
    for (const h of RESPONSE_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) outHeaders[h] = v;
    }
    return { ok: true, response: { status: res.status, headers: outHeaders, body: buf.toString('utf8') } };
  }

  /**
   * SMTP, AMQP, MQTT, WebSocket, SSE and database calls. The module names an endpoint of its
   * manifest, never a raw address or a secret; the rest is checked by the endpoint caller.
   */
  async call(kind: string, req: Record<string, unknown>): Promise<CallOutcome> {
    const { manifest } = this.ctx;
    const action = manifest.actions.find((a) => a.name === this.ctx.action);
    if (!action) return this.deny('unknown_action');
    if (!(CALL_KINDS as readonly string[]).includes(kind)) return this.deny('unknown_call');
    if (this.overLimit()) return this.deny('too_many_requests');
    const endpoint = (manifest.endpoints ?? []).find((e) => e.id === req?.endpoint);
    if (!endpoint || !this.ctx.calls) return this.deny('endpoint_denied');
    return this.ctx.calls(this.session, action, endpoint, kind as CallKind, req);
  }

  /** Release what the invocation holds. Always call after the action finishes. */
  async close(): Promise<void> {}
}

/** What a refused call sent: its query and body, shortened (" · sent query: …", " · sent body: …"). */
export function sentOf(url: URL, body: string | Uint8Array | undefined): string {
  let query = url.search.slice(1);
  try {
    query = decodeURIComponent(query.replace(/\+/g, ' '));
  } catch {
    // Shown as sent.
  }
  const parts: string[] = [];
  if (query) parts.push(`sent query: ${query.slice(0, 500)}${query.length > 500 ? '…' : ''}`);
  if (typeof body === 'string' && body) parts.push(`sent body: ${body.slice(0, 1000)}${body.length > 1000 ? '…' : ''}`);
  else if (body && body.length) parts.push(`sent body: (${body.length} bytes)`);
  return parts.map((p) => ` · ${p}`).join('');
}

/**
 * An app's short reason for refusing a call, from a JSON error body: its `message` (or `error`, `error_description`,
 * `detail`, `title`) and the messages of its `errors` list, at most 200 characters. Nothing for any other body.
 */
export function appMessage(buf: Buffer): string {
  let body: unknown;
  try {
    body = JSON.parse(buf.subarray(0, 64_000).toString('utf8'));
  } catch {
    return '';
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const o = body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string' ? (v as { message: string }).message : '');
  const head = [o.message, o.error_description, o.error, o.detail, o.title].map(text).find(Boolean) ?? '';
  const list = Array.isArray(o.errors) ? o.errors.slice(0, 5).map(text).filter(Boolean) : [];
  const parts = [head, ...list.filter((m) => m !== head)].filter(Boolean);
  return parts.join(' — ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * The response body, or null once it is over `limit` bytes. A body announced as too large is
 * refused unread; otherwise it is read in chunks and the read is cancelled at the limit, so a
 * huge response never sits in memory whole.
 */
export async function readLimited(res: Response, limit: number): Promise<Buffer | null> {
  const announced = Number(res.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > limit) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, bytes);
}

export function placeCredential(headers: Headers, p: ManifestCredential['placement'], secret: string): void {
  if (p.type === 'bearer') headers.set('authorization', `Bearer ${secret}`);
  else if (p.type === 'basic') headers.set('authorization', `Basic ${Buffer.from(secret).toString('base64')}`);
  else if (p.type === 'header') headers.set(p.name.toLowerCase(), `${p.prefix}${secret}`);
}

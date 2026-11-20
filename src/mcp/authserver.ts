import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import { constantTimeEqual, randomToken, sha256Hex } from '../core/crypto.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import type { Member } from '../core/members.js';
import type { Db, Queryable } from '../db/db.js';
import type { FetchLike } from '../runtime/broker.js';
import { guardedFetch } from '../runtime/egress.js';
import { takeToken } from '../webhooks/service.js';
import { ACCESS_PREFIX, type McpServer } from './server.js';
import { OLD_MCP_CLIENT_PREFIX } from '../core/old-prefixes.js';

/**
 * Dittoly as the OAuth authorization server for its own MCP server (/mcp), so a person adds
 * Dittoly to Claude, ChatGPT or Copilot Studio by signing in instead of pasting a token.
 * (oauth.ts is the other direction: Dittoly as a client of MCP servers it imports.)
 *
 * - Discovery: protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414).
 * - Clients: a client id that is an https URL is read from its metadata document (CIMD), or the
 *   app registers itself (RFC 7591). Public clients only. Either way an admin must have allowed
 *   the app (by where it sends people back, or by its metadata URL); nothing is allowed until then.
 * - Authorization code with PKCE (S256 only), exact redirect URIs (loopback: any port),
 *   resource indicators (RFC 8707) bound to <public url>/mcp.
 * - On the consent page the person picks what the app may use; approving makes an agent exactly
 *   like the Agents page does, so its scopes, expiry and revocation apply unchanged.
 * - Codes live 60 seconds and work once; access tokens an hour; refresh tokens rotate on every
 *   use, and a used one presented again revokes the whole grant (and its agent).
 * Only hashes of codes and tokens are stored, and none is ever logged.
 */

const CODE_PREFIX = 'dty_oac_';
const REFRESH_PREFIX = 'dty_ort_';
const CLIENT_PREFIX = 'dty_client_';
const ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const DOC_MAX_BYTES = 10_000;
const DOC_TIMEOUT_MS = 5_000;
const DOC_CACHE_MS = 10 * 60_000;
export const SCOPES = ['mcp', 'offline_access'] as const;

// ------------------------------------------------------------------ allowed apps (org setting)

/** Hosted Claude apps (claude.ai, Desktop, mobile, Cowork) send people back here. */
export const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
/** Claude Code identifies itself with this metadata document and a loopback redirect. */
export const CLAUDE_CODE_CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata';

export const PRESETS = {
  claude: 'Claude (claude.ai, Desktop, mobile, Cowork and Claude Code)',
  chatgpt: 'ChatGPT',
  copilot: 'Microsoft Copilot Studio',
} as const;
type Preset = keyof typeof PRESETS;

export interface AllowedApps {
  presets: Record<Preset, boolean>;
  /** An app's metadata URL (its client id), or a host it sends people back to ("*.example.com" for subdomains). */
  custom: { kind: 'client_id' | 'redirect_host'; value: string }[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export const allowedAppsBody = z
  .object({
    presets: z.object({ claude: z.boolean(), chatgpt: z.boolean(), copilot: z.boolean() }).strict(),
    custom: z.array(z.object({ kind: z.enum(['client_id', 'redirect_host']), value: z.string().trim().min(1).max(300) }).strict()).max(50),
  })
  .strict();

const KEY = 'mcp_oauth_apps';

export async function getAllowedApps(db: Queryable): Promise<AllowedApps> {
  const row = (
    await db.query<{ value: Partial<AllowedApps>; updated_at: Date; handle: string | null }>(
      `SELECT s.value, s.updated_at, m.handle FROM org_settings s LEFT JOIN members m ON m.id = s.updated_by WHERE s.key = $1`,
      [KEY],
    )
  ).rows[0];
  // Nothing is allowed until an admin switches it on.
  return {
    presets: { claude: false, chatgpt: false, copilot: false, ...row?.value.presets },
    custom: row?.value.custom ?? [],
    updatedAt: row ? row.updated_at.toISOString() : null,
    updatedBy: row?.handle ?? null,
  };
}

const HOST_RULE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export async function setAllowedApps(db: Queryable, actor: Member, body: z.infer<typeof allowedAppsBody>, insecureHttpHosts: readonly string[]): Promise<AllowedApps> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const custom = body.custom.map((c) => ({ kind: c.kind, value: c.kind === 'redirect_host' ? c.value.toLowerCase() : c.value }));
  for (const c of custom) {
    if (c.kind === 'client_id' && !metadataUrl(c.value, insecureHttpHosts)) throw badRequest('invalid_client_id', `${c.value}: an app's metadata URL is an https address with a path`);
    if (c.kind === 'redirect_host' && !HOST_RULE.test(c.value)) throw badRequest('invalid_redirect_host', `${c.value}: a host name such as app.example.com or *.example.com`);
  }
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify({ presets: body.presets, custom }), actor.id],
  );
  await audit(db, { actorId: actor.id, action: 'org.mcp_oauth_apps_updated', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
  return getAllowedApps(db);
}

const hostMatches = (rule: string, host: string) => (rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule);

/**
 * Which allowed entry lets this app send a person's code to this address, or null. What counts is
 * where the code goes, so an app cannot pass by giving itself an allowed name.
 */
export function allowedBy(apps: AllowedApps, clientId: string, redirectUri: string): string | null {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return null;
  }
  const https = u.protocol === 'https:';
  if (apps.presets.claude && CLAUDE_CALLBACKS.includes(redirectUri)) return 'Claude';
  if (apps.presets.claude && clientId === CLAUDE_CODE_CLIENT && isLoopback(u)) return 'Claude Code';
  if (apps.presets.chatgpt && https && u.hostname === 'chatgpt.com') return 'ChatGPT';
  if (apps.presets.copilot && https && (u.hostname === 'global.consent.azure-apim.net' || u.hostname.endsWith('.consent.azure-apim.net'))) return 'Copilot Studio';
  for (const c of apps.custom) {
    if (c.kind === 'client_id' && c.value === clientId) return c.value;
    if (c.kind === 'redirect_host' && (https || isLoopback(u)) && hostMatches(c.value, u.hostname.replace(/^\[|\]$/g, ''))) return c.value;
  }
  return null;
}

// ------------------------------------------------------------------ redirect URIs

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const isLoopback = (u: URL) => u.protocol === 'http:' && LOOPBACK.has(u.hostname);

/** An address an app may be sent back to: https, or http on this machine (native apps, RFC 8252). */
function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  try {
    const u = new URL(uri);
    return !u.hash && !u.username && !u.password && (u.protocol === 'https:' || isLoopback(u));
  } catch {
    return false;
  }
}

/** Exact match, except loopback addresses, whose port is picked when the app starts (RFC 8252 section 7.3). */
export function redirectMatches(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    const r = new URL(registered);
    const a = new URL(asked);
    return isLoopback(r) && isLoopback(a) && r.hostname === a.hostname && r.pathname === a.pathname && r.search === a.search && !a.hash;
  } catch {
    return false;
  }
}

/** A client id that names a metadata document: https (or a development host), with a path. */
function metadataUrl(clientId: string, insecureHttpHosts: readonly string[]): URL | null {
  if (!/^https?:\/\//.test(clientId) || clientId.length > 300) return null;
  try {
    const u = new URL(clientId);
    if (u.hash || u.username || u.password || u.pathname === '/' || u.href !== clientId) return null;
    return u.protocol === 'https:' || insecureHttpHosts.includes(u.host) ? u : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the server

interface Client {
  id: string;
  name: string;
  kind: 'metadata' | 'registered';
  redirectUris: string[];
}

/** A problem shown to the person in the browser instead of sending them back to the app. */
export class AuthPageError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail: string) {
    super(code);
  }
}

export type AuthorizeOutcome = { redirect: string } | { page: AuthPageError };
export interface OAuthReply { status: number; body: Record<string, unknown> }

export interface ConsentRequest {
  id: string;
  client: { id: string; name: string; kind: 'metadata' | 'registered' };
  redirectUri: string;
  redirectHost: string;
  /** Only an app on this machine can receive the answer, and any local program can claim to be it. */
  loopback: boolean;
  /** The allowed entry that lets it connect. */
  allowedAs: string;
  expiresAt: Date;
}

const oauthError = (error: string, description: string, status = 400): OAuthReply => ({ status, body: { error, error_description: description } });

export class McpAuthServer {
  private readonly fetchFn: FetchLike;
  private readonly documents = new Map<string, { client: Client; until: number }>();

  constructor(
    private readonly db: Db,
    private readonly mcp: McpServer,
    private readonly opts: { publicUrl: string; insecureHttpHosts: readonly string[]; internalHosts: readonly string[]; fetchImpl?: FetchLike | undefined },
  ) {
    // Metadata documents are fetched like module traffic: never from private or local addresses.
    this.fetchFn = opts.fetchImpl ?? guardedFetch({ internalHosts: opts.internalHosts, loopbackHosts: opts.insecureHttpHosts });
  }

  get issuer(): string {
    return this.opts.publicUrl;
  }

  get resource(): string {
    return `${this.opts.publicUrl}/mcp`;
  }

  /** RFC 9728: what /mcp is and who signs people in for it. */
  protectedResource() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_name: 'Dittoly',
      resource_documentation: `${this.opts.publicUrl}/agents`,
    };
  }

  /** RFC 8414. */
  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      scopes_supported: [...SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ---------------------------------------------------------------- clients

  /** RFC 7591: an app registers itself as a public client. The allowed apps still decide whether it may connect. */
  async register(body: unknown): Promise<OAuthReply> {
    if (!(await takeToken(this.db, 'mcp-oauth:register', 30))) return oauthError('temporarily_unavailable', 'too many registrations; try again in a minute', 429);
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirect)) {
      return oauthError('invalid_redirect_uri', 'redirect_uris: 1 to 10 https addresses (or http on 127.0.0.1 or localhost), without a #fragment');
    }
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') {
      return oauthError('invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none") can register');
    }
    if (b.grant_types !== undefined && !(Array.isArray(b.grant_types) && b.grant_types.every((g) => g === 'authorization_code' || g === 'refresh_token'))) {
      return oauthError('invalid_client_metadata', 'grant_types: authorization_code and refresh_token only');
    }
    if (b.response_types !== undefined && !(Array.isArray(b.response_types) && b.response_types.every((t) => t === 'code'))) {
      return oauthError('invalid_client_metadata', 'response_types: code only');
    }
    const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : new URL(uris[0] as string).hostname;
    const clientId = `${CLIENT_PREFIX}${randomToken(18)}`;
    await this.db.query(`INSERT INTO mcp_oauth_clients (client_id, name, redirect_uris) VALUES ($1, $2, $3)`, [clientId, name, uris]);
    return {
      status: 201,
      body: {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    };
  }

  private async client(clientId: string): Promise<Client> {
    if (clientId.startsWith(CLIENT_PREFIX) || clientId.startsWith(OLD_MCP_CLIENT_PREFIX)) {
      const r = (await this.db.query<{ name: string; redirect_uris: string[] }>(`SELECT name, redirect_uris FROM mcp_oauth_clients WHERE client_id = $1`, [clientId])).rows[0];
      if (!r) throw new AuthPageError(400, 'client_unknown', 'This app is not registered here. Remove the connection in the app and add it again.');
      return { id: clientId, name: r.name, kind: 'registered', redirectUris: r.redirect_uris };
    }
    const url = metadataUrl(clientId, this.opts.insecureHttpHosts);
    if (!url) throw new AuthPageError(400, 'client_unknown', 'The app did not identify itself with a client id Dittoly knows.');
    return this.metadataClient(clientId);
  }

  /** A client id metadata document: fetched through the egress guard, small, quick, cached for a while. */
  private async metadataClient(url: string): Promise<Client> {
    const hit = this.documents.get(url);
    if (hit && hit.until > Date.now()) return hit.client;
    const bad = (detail: string) => new AuthPageError(400, 'client_document_invalid', `The app's metadata document (${url}) cannot be used: ${detail}.`);
    let text: string;
    try {
      const res = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(DOC_TIMEOUT_MS) });
      if (res.status !== 200) throw bad(`it answered ${res.status}`);
      text = await readCapped(res, DOC_MAX_BYTES);
    } catch (err) {
      if (err instanceof AuthPageError) throw err;
      log.warn('mcp_oauth_document_failed', { errorType: errorType(err) });
      throw bad(err instanceof DocumentTooLarge ? `it is larger than ${DOC_MAX_BYTES / 1000} KB` : 'it could not be fetched');
    }
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw bad('it is not JSON');
    }
    if (!doc || typeof doc !== 'object' || doc.client_id !== url) throw bad('its client_id is not its own address');
    if ((doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') || 'client_secret' in doc) throw bad('it asks for a client secret or key; only public clients can connect');
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirect)) throw bad('its redirect_uris are missing or not https');
    if (doc.client_name !== undefined && (typeof doc.client_name !== 'string' || doc.client_name.length > 100)) throw bad('its client_name is not a short text');
    const client: Client = { id: url, name: (doc.client_name as string | undefined)?.trim() || new URL(url).hostname, kind: 'metadata', redirectUris: uris };
    if (this.documents.size >= 500) this.documents.delete(this.documents.keys().next().value!);
    this.documents.set(url, { client, until: Date.now() + DOC_CACHE_MS });
    return client;
  }

  // ---------------------------------------------------------------- authorization endpoint

  /**
   * GET /oauth/authorize. Problems with the app or its address are shown to the person (never
   * redirected to an address that is not the app's); the rest go back to the app as errors.
   * A good request waits on the consent page, as /connect/<id>.
   */
  async authorize(q: Record<string, string | undefined>): Promise<AuthorizeOutcome> {
    try {
      const clientId = q.client_id;
      const redirectUri = q.redirect_uri;
      if (!clientId) throw new AuthPageError(400, 'client_id_missing', 'The app did not say who it is (client_id).');
      if (!redirectUri) throw new AuthPageError(400, 'redirect_uri_missing', 'The app did not say where to send you back (redirect_uri).');
      const apps = await getAllowedApps(this.db);
      if (!allowedBy(apps, clientId, redirectUri)) {
        await audit(this.db, { actorId: null, action: 'mcp.oauth_app_refused', subjectType: 'org', subjectId: KEY, outcome: 'denied', errorType: 'app_not_allowed' });
        throw new AuthPageError(403, 'app_not_allowed', `Your organization has not allowed this app to connect to Dittoly (it would send you back to ${hostOf(redirectUri)}). An admin can allow it under Members & Access, "Apps that may connect".`);
      }
      if (!(await takeToken(this.db, `mcp-oauth:authorize:${sha256Hex(clientId).slice(0, 32)}`, 30))) {
        throw new AuthPageError(429, 'too_many_requests', 'Too many sign-in attempts from this app. Try again in a minute.');
      }
      const client = await this.client(clientId);
      if (!client.redirectUris.some((r) => redirectMatches(r, redirectUri))) {
        throw new AuthPageError(400, 'redirect_uri_mismatch', `The app asked to send you back to ${hostOf(redirectUri)}, which is not one of its registered addresses.`);
      }
      const back = (error: string, description: string): AuthorizeOutcome => ({ redirect: this.back(redirectUri, { error, error_description: description, state: q.state }) });
      if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
      if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE is required: code_challenge with code_challenge_method S256');
      if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return back('invalid_request', 'code_challenge must be an S256 challenge');
      if (!q.state) return back('invalid_request', 'state is required');
      if (q.state.length > 500) return back('invalid_request', 'state is too long');
      if (q.resource !== undefined && q.resource !== this.resource) return back('invalid_target', `resource must be ${this.resource}`);
      // Scopes Dittoly does not know are left out; what the app may do is picked on the consent page.
      const scope = ['mcp', ...(q.scope?.split(' ').includes('offline_access') ? ['offline_access'] : [])].join(' ');
      await this.db.query(`DELETE FROM mcp_oauth_requests WHERE expires_at < now()`);
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO mcp_oauth_requests (client_id, client_name, client_kind, redirect_uri, state, code_challenge, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [client.id, client.name, client.kind, redirectUri, q.state, q.code_challenge, scope, new Date(Date.now() + REQUEST_TTL_MS)],
      );
      return { redirect: `/connect/${rows[0]!.id}` };
    } catch (err) {
      if (err instanceof AuthPageError) return { page: err };
      throw err;
    }
  }

  private back(redirectUri: string, params: Record<string, string | undefined>): string {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    // RFC 9207: the app checks who answered.
    u.searchParams.set('iss', this.issuer);
    return u.href;
  }

  // ---------------------------------------------------------------- consent page

  /** The request as the consent page shows it. The first person who opens it is the only one who can answer it. */
  async request(actor: Member, id: string): Promise<ConsentRequest> {
    const r = await this.claim(actor, id);
    const allowedAs = allowedBy(await getAllowedApps(this.db), r.client_id, r.redirect_uri);
    if (!allowedAs) throw forbidden('app_not_allowed');
    const u = new URL(r.redirect_uri);
    return {
      id: r.id,
      client: { id: r.client_id, name: r.client_name, kind: r.client_kind },
      redirectUri: r.redirect_uri,
      redirectHost: u.host,
      loopback: isLoopback(u),
      allowedAs,
      expiresAt: r.expires_at,
    };
  }

  /**
   * The person approves: an agent with what they picked (made exactly like on the Agents page),
   * the grant, and a code the app exchanges within a minute.
   */
  async approve(actor: Member, id: string, input: { name: string; scopes: { tools: Record<string, 'run' | 'ask'>; drafting: boolean }; expiresInDays: number }): Promise<{ redirectTo: string }> {
    const r = await this.claim(actor, id);
    if (!allowedBy(await getAllowedApps(this.db), r.client_id, r.redirect_uri)) throw forbidden('app_not_allowed');
    const { id: tokenId } = await this.mcp.createToken(actor, input, { clientId: r.client_id, clientName: r.client_name });
    const grant = (
      await this.db.query<{ id: string }>(
        `INSERT INTO mcp_oauth_grants (token_id, client_id, redirect_uri, resource, scope) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tokenId, r.client_id, r.redirect_uri, this.resource, r.scope],
      )
    ).rows[0]!.id;
    const code = `${CODE_PREFIX}${randomToken(32)}`;
    await this.db.query(
      `INSERT INTO mcp_oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [sha256Hex(code), grant, r.client_id, r.redirect_uri, r.code_challenge, new Date(Date.now() + CODE_TTL_MS)],
    );
    await this.db.query(`DELETE FROM mcp_oauth_requests WHERE id = $1`, [id]);
    await audit(this.db, { actorId: actor.id, action: 'mcp.oauth_granted', subjectType: 'member', subjectId: actor.id, outcome: 'ok', relatedId: tokenId });
    return { redirectTo: this.back(r.redirect_uri, { code, state: r.state }) };
  }

  /** The person says no: the app hears access_denied. */
  async deny(actor: Member, id: string): Promise<{ redirectTo: string }> {
    const r = await this.claim(actor, id);
    await this.db.query(`DELETE FROM mcp_oauth_requests WHERE id = $1`, [id]);
    await audit(this.db, { actorId: actor.id, action: 'mcp.oauth_denied', subjectType: 'member', subjectId: actor.id, outcome: 'ok' });
    return { redirectTo: this.back(r.redirect_uri, { error: 'access_denied', error_description: 'the person did not allow it', state: r.state }) };
  }

  private async claim(actor: Member, id: string) {
    const r = (
      await this.db.query<{ id: string; client_id: string; client_name: string; client_kind: 'metadata' | 'registered'; redirect_uri: string; state: string; code_challenge: string; scope: string; expires_at: Date }>(
        `UPDATE mcp_oauth_requests SET member_id = $2 WHERE id = $1 AND expires_at > now() AND (member_id IS NULL OR member_id = $2) RETURNING *`,
        [id, actor.id],
      )
    ).rows[0];
    // Expired, answered, or someone else's: it reads as missing.
    if (!r) throw notFound('oauth_request');
    return r;
  }

  // ---------------------------------------------------------------- token endpoint

  /** POST /oauth/token (form-encoded): authorization_code and refresh_token, for public clients. */
  async token(p: Record<string, unknown>): Promise<OAuthReply> {
    const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
    const clientId = s('client_id');
    if (!clientId) return oauthError('invalid_client', 'client_id is required', 401);
    if (s('resource') !== undefined && s('resource') !== this.resource) return oauthError('invalid_target', `resource must be ${this.resource}`);
    if (s('grant_type') === 'authorization_code') return this.exchangeCode(clientId, s('code'), s('redirect_uri'), s('code_verifier'));
    if (s('grant_type') === 'refresh_token') return this.refresh(clientId, s('refresh_token'));
    return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  private async exchangeCode(clientId: string, code: string | undefined, redirectUri: string | undefined, verifier: string | undefined): Promise<OAuthReply> {
    if (!code || !redirectUri || !verifier) return oauthError('invalid_request', 'code, redirect_uri and code_verifier are required');
    const hash = sha256Hex(code);
    // Used up by the first try, whatever its outcome: a code cannot be guessed against.
    const c = (
      await this.db.query<{ grant_id: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: Date }>(
        `UPDATE mcp_oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL RETURNING grant_id, client_id, redirect_uri, code_challenge, expires_at`,
        [hash],
      )
    ).rows[0];
    if (!c) {
      const used = (await this.db.query<{ grant_id: string }>(`SELECT grant_id FROM mcp_oauth_codes WHERE code_hash = $1`, [hash])).rows[0];
      // A code presented twice may have been stolen: what it gave is revoked (OAuth 2.1).
      if (used) await this.revokeGrant(used.grant_id, 'code_reused');
      return oauthError('invalid_grant', 'the code is unknown or was already used');
    }
    if (c.expires_at.getTime() < Date.now()) return oauthError('invalid_grant', 'the code expired');
    if (c.client_id !== clientId) return oauthError('invalid_grant', 'the code was issued to another client');
    if (c.redirect_uri !== redirectUri) return oauthError('invalid_grant', 'redirect_uri differs from the one in the authorization request');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !constantTimeEqual(createHash('sha256').update(verifier).digest('base64url'), c.code_challenge)) {
      return oauthError('invalid_grant', 'code_verifier does not match the code_challenge');
    }
    const g = await this.activeGrant(c.grant_id);
    if (!g) return oauthError('invalid_grant', 'the connection was revoked');
    return this.issue(g);
  }

  private async refresh(clientId: string, token: string | undefined): Promise<OAuthReply> {
    if (!token) return oauthError('invalid_request', 'refresh_token is required');
    const hash = sha256Hex(token);
    const t = (
      await this.db.query<{ grant_id: string; expires_at: Date }>(
        `UPDATE mcp_oauth_tokens o SET used_at = now() FROM mcp_oauth_grants g
         WHERE o.token_hash = $1 AND o.kind = 'refresh' AND o.used_at IS NULL AND g.id = o.grant_id AND g.client_id = $2
         RETURNING o.grant_id, o.expires_at`,
        [hash, clientId],
      )
    ).rows[0];
    if (!t) {
      const known = (await this.db.query<{ grant_id: string; used_at: Date | null }>(`SELECT grant_id, used_at FROM mcp_oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'`, [hash])).rows[0];
      // A refresh token used before: someone holds a copy. The whole grant and its agent stop.
      if (known?.used_at) await this.revokeGrant(known.grant_id, 'refresh_token_reused');
      return oauthError('invalid_grant', 'the refresh token is unknown, was already used, or belongs to another client');
    }
    if (t.expires_at.getTime() < Date.now()) return oauthError('invalid_grant', 'the refresh token expired');
    const g = await this.activeGrant(t.grant_id);
    if (!g) return oauthError('invalid_grant', 'the connection was revoked or has expired');
    // An app an admin no longer allows cannot keep going.
    if (!allowedBy(await getAllowedApps(this.db), g.client_id, g.redirect_uri)) return oauthError('invalid_grant', 'your organization no longer allows this app');
    return this.issue(g);
  }

  private async activeGrant(id: string) {
    return (
      await this.db.query<{ id: string; client_id: string; redirect_uri: string; scope: string; expires_at: Date | null }>(
        `SELECT g.id, g.client_id, g.redirect_uri, g.scope, t.expires_at
         FROM mcp_oauth_grants g JOIN mcp_tokens t ON t.id = g.token_id JOIN members m ON m.id = t.member_id
         WHERE g.id = $1 AND g.revoked_at IS NULL AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND NOT m.disabled`,
        [id],
      )
    ).rows[0];
  }

  /** A new access token (an hour, never past the agent's expiry) and a new refresh token (until the agent expires). */
  private async issue(g: { id: string; scope: string; expires_at: Date | null }): Promise<OAuthReply> {
    const access = `${ACCESS_PREFIX}${randomToken(32)}`;
    const refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
    const now = Date.now();
    const until = g.expires_at?.getTime() ?? now + 90 * 86_400_000;
    const accessUntil = Math.min(now + ACCESS_TTL_S * 1000, until);
    await this.db.query(
      `INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1, $3, 'access', $4), ($2, $3, 'refresh', $5)`,
      [sha256Hex(access), sha256Hex(refresh), g.id, new Date(accessUntil), new Date(until)],
    );
    return {
      status: 200,
      body: { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((accessUntil - now) / 1000)), refresh_token: refresh, scope: g.scope },
    };
  }

  // ---------------------------------------------------------------- revocation

  /** RFC 7009: a refresh token ends the whole connection (and its agent); an access token only itself. Always 200. */
  async revoke(p: Record<string, unknown>): Promise<OAuthReply> {
    const token = typeof p.token === 'string' ? p.token : '';
    const t = token
      ? (await this.db.query<{ grant_id: string; kind: string; client_id: string }>(
          `SELECT o.grant_id, o.kind, g.client_id FROM mcp_oauth_tokens o JOIN mcp_oauth_grants g ON g.id = o.grant_id WHERE o.token_hash = $1`,
          [sha256Hex(token)],
        )).rows[0]
      : undefined;
    if (t && (typeof p.client_id !== 'string' || p.client_id === t.client_id)) {
      if (t.kind === 'refresh') await this.revokeGrant(t.grant_id, 'revoked_by_app');
      else await this.db.query(`DELETE FROM mcp_oauth_tokens WHERE token_hash = $1`, [sha256Hex(token)]);
    }
    return { status: 200, body: {} };
  }

  /** Stop a grant and its agent, and say why in the audit log. */
  private async revokeGrant(grantId: string, reason: 'code_reused' | 'refresh_token_reused' | 'revoked_by_app'): Promise<void> {
    const g = (await this.db.query<{ token_id: string; member_id: string }>(
      `SELECT g.token_id, t.member_id FROM mcp_oauth_grants g JOIN mcp_tokens t ON t.id = g.token_id WHERE g.id = $1`,
      [grantId],
    )).rows[0];
    if (!g) return;
    await this.mcp.agents.stop(g.token_id);
    if (reason !== 'revoked_by_app') {
      await audit(this.db, { actorId: null, action: 'mcp.oauth_token_reused', subjectType: 'member', subjectId: g.member_id, outcome: 'denied', errorType: reason, relatedId: g.token_id });
    }
    await audit(this.db, { actorId: null, action: 'mcp.oauth_grant_revoked', subjectType: 'member', subjectId: g.member_id, outcome: 'ok', errorType: reason, relatedId: g.token_id });
  }

  /** Housekeeping: expired requests, codes and tokens, and registrations nobody used within a day. */
  async prune(): Promise<void> {
    await this.db.query(`DELETE FROM mcp_oauth_requests WHERE expires_at < now()`);
    await this.db.query(`DELETE FROM mcp_oauth_codes WHERE expires_at < now() - interval '1 day'`);
    await this.db.query(`DELETE FROM mcp_oauth_tokens WHERE expires_at < now()`);
    await this.db.query(
      `DELETE FROM mcp_oauth_clients c WHERE c.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = c.client_id)`,
    );
  }
}

class DocumentTooLarge extends Error {}

async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new DocumentTooLarge();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new DocumentTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host || uri.slice(0, 80);
  } catch {
    return 'an address that is not valid';
  }
}

import {
  auth,
  type FetchLike as McpFetch,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { audit } from '../core/audit.js';
import { randomToken, type Cipher } from '../core/crypto.js';
import { safeReturnTo } from '../core/oidc.js';
import { AppError, badRequest } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import type { Member } from '../core/members.js';
import type { Vault } from '../core/vault.js';
import type { Db } from '../db/db.js';
import { guardedFetch } from '../runtime/egress.js';
import type { FetchLike } from '../sandbox/broker.js';

/**
 * OAuth for MCP servers (MCP authorization: protected-resource metadata,
 * authorization-server discovery, client registration, PKCE, resource
 * indicators, issuer checks; all done by the official SDK's `auth()`).
 *
 * Each member connects with their own account; the resulting tokens are stored
 * in that member's vault under the service name, like any other credential, so
 * isolation and delegation work unchanged. One client registration per
 * authorization server is shared by all members.
 */

export interface OAuthSecret {
  kind: 'oauth';
  serverUrl: string;
  issuer: string | null;
  tokens: StoredOAuthTokens;
  savedAt: number;
}

export function parseOAuthSecret(secret: string): OAuthSecret | null {
  if (!secret.startsWith('{')) return null;
  try {
    const v = JSON.parse(secret) as Partial<OAuthSecret>;
    return v.kind === 'oauth' && v.tokens && typeof v.serverUrl === 'string' ? (v as OAuthSecret) : null;
  } catch {
    return null;
  }
}

/** Stores client registrations in the database and keeps everything else for one flow in memory. */
class FlowProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private verifier: string | undefined;
  private issuer: string | undefined;
  private current: StoredOAuthTokens | undefined;
  private readonly stateValue: string;

  constructor(
    private readonly s: {
      db: Db;
      cipher: Cipher;
      redirectUrl: string;
      tokens?: StoredOAuthTokens | undefined;
      verifier?: string | undefined;
      issuer?: string | undefined;
      state?: string | undefined;
    },
  ) {
    this.current = s.tokens;
    this.verifier = s.verifier;
    this.issuer = s.issuer;
    this.stateValue = s.state ?? randomToken(24);
  }

  get redirectUrl() {
    return this.s.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Dittoly',
      redirect_uris: [this.s.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    } as OAuthClientMetadata;
  }

  state() {
    return this.stateValue;
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    if (!ctx?.issuer) return undefined;
    const row = (await this.s.db.query<{ client_info_enc: string }>(`SELECT client_info_enc FROM oauth_clients WHERE issuer = $1`, [ctx.issuer])).rows[0];
    return row ? this.s.cipher.decryptJson<StoredOAuthClientInformation>(row.client_info_enc, `oauth-client:${ctx.issuer}`) : undefined;
  }

  async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    if (!ctx?.issuer) return;
    await this.s.db.query(
      `INSERT INTO oauth_clients (issuer, client_info_enc) VALUES ($1, $2)
       ON CONFLICT (issuer) DO UPDATE SET client_info_enc = EXCLUDED.client_info_enc`,
      [ctx.issuer, this.s.cipher.encryptJson(info, `oauth-client:${ctx.issuer}`)],
    );
  }

  tokens() {
    return this.current;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.current = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    if (!this.verifier) throw new AppError('oauth_state_invalid', 400);
    return this.verifier;
  }
  saveAuthorizationServerUrl(u: string) {
    this.issuer = u;
  }
  authorizationServerUrl() {
    return this.issuer;
  }
}

export class McpOAuth {
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly vault: Vault,
    private readonly opts: {
      publicUrl: string;
      insecureHttpHosts: readonly string[];
      internalHosts: readonly string[];
      fetchImpl?: FetchLike | undefined;
    },
  ) {
    // Discovery and token requests go through the same egress guard as module traffic.
    this.fetchFn = opts.fetchImpl ?? guardedFetch({ internalHosts: opts.internalHosts, loopbackHosts: opts.insecureHttpHosts });
  }

  private get redirectUrl() {
    return `${this.opts.publicUrl}/auth/mcp/callback`;
  }

  private checkUrl(url: string): void {
    const u = new URL(url);
    if (u.username || u.password) throw badRequest('invalid_mcp_url');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.opts.insecureHttpHosts.includes(u.host))) throw badRequest('mcp_requires_https');
  }

  /** Begin connecting the member's own account to an MCP server. Returns where to send the browser. */
  async start(member: Member, body: { url: string; service: string; returnTo?: string | undefined }): Promise<{ authorizationUrl: string }> {
    this.checkUrl(body.url);
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(body.service)) throw badRequest('invalid_service');
    const provider = new FlowProvider({ db: this.db, cipher: this.cipher, redirectUrl: this.redirectUrl });
    let result;
    try {
      result = await auth(provider, { serverUrl: body.url, fetchFn: this.fetchFn as McpFetch });
    } catch (err) {
      log.warn('mcp_oauth_start_failed', { errorType: errorType(err) });
      throw new AppError('mcp_oauth_unavailable', 502);
    }
    if (result !== 'REDIRECT' || !provider.authorizationUrl) throw new AppError('mcp_oauth_unexpected', 502);
    await this.db.query(
      `INSERT INTO oauth_pending (state, member_id, server_url, service, verifier_enc, issuer, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '10 minutes')`,
      [
        provider.state(),
        member.id,
        body.url,
        body.service,
        this.cipher.encrypt(provider.codeVerifier(), `oauth-pending:${member.id}`),
        provider.authorizationServerUrl() ?? null,
        safeReturnTo(body.returnTo, '/credentials'),
      ],
    );
    return { authorizationUrl: provider.authorizationUrl.href };
  }

  /** Finish the connection from the authorization server's redirect. Only the member who started it can finish it. */
  async finish(member: Member, params: { state?: string | undefined; code?: string | undefined; iss?: string | undefined }): Promise<string> {
    if (!params.state || !params.code) throw new AppError('oauth_state_invalid', 400);
    const pending = (
      await this.db.query<{ member_id: string; server_url: string; service: string; verifier_enc: string; issuer: string | null; return_to: string; expires_at: Date }>(
        `DELETE FROM oauth_pending WHERE state = $1 AND member_id = $2 RETURNING *`,
        [params.state, member.id],
      )
    ).rows[0];
    // Someone else's state is left alone: it reads as unknown, and their connection can still finish.
    if (!pending || pending.expires_at < new Date()) throw new AppError('oauth_state_invalid', 400);
    const provider = new FlowProvider({
      db: this.db,
      cipher: this.cipher,
      redirectUrl: this.redirectUrl,
      verifier: this.cipher.decrypt(pending.verifier_enc, `oauth-pending:${member.id}`),
      issuer: pending.issuer ?? undefined,
      state: params.state,
    });
    try {
      await auth(provider, { serverUrl: pending.server_url, authorizationCode: params.code, iss: params.iss, fetchFn: this.fetchFn as McpFetch });
    } catch (err) {
      log.warn('mcp_oauth_finish_failed', { errorType: errorType(err) });
      throw new AppError('mcp_oauth_failed', 401);
    }
    const tokens = provider.tokens();
    if (!tokens) throw new AppError('mcp_oauth_failed', 401);
    await this.save(member.id, pending.service, { kind: 'oauth', serverUrl: pending.server_url, issuer: provider.authorizationServerUrl() ?? null, tokens, savedAt: Date.now() });
    await audit(this.db, { actorId: member.id, action: 'mcp.oauth_connected', subjectType: 'credential', subjectId: pending.service, outcome: 'ok' });
    return pending.return_to;
  }

  private async save(memberId: string, service: string, secret: OAuthSecret) {
    await this.vault.put(memberId, service, JSON.stringify(secret));
  }

  /**
   * The value to send for a credential: a plain secret as stored, or the access
   * token of an OAuth connection, refreshed when it is about to expire. A
   * connection that can no longer refresh counts as a missing credential.
   */
  async resolve(memberId: string, service: string): Promise<string | null> {
    const raw = await this.vault.reveal(memberId, service);
    if (raw === null) return null;
    const secret = parseOAuthSecret(raw);
    if (!secret) return raw;
    const expiresIn = Number((secret.tokens as { expires_in?: number }).expires_in ?? 0);
    const fresh = !expiresIn || secret.savedAt + (expiresIn - 60) * 1000 > Date.now();
    if (fresh) return String((secret.tokens as { access_token: string }).access_token);
    if (!(secret.tokens as { refresh_token?: string }).refresh_token) return null;
    const provider = new FlowProvider({
      db: this.db,
      cipher: this.cipher,
      redirectUrl: this.redirectUrl,
      tokens: secret.tokens,
      issuer: secret.issuer ?? undefined,
    });
    try {
      const result = await auth(provider, { serverUrl: secret.serverUrl, fetchFn: this.fetchFn as McpFetch });
      if (result !== 'AUTHORIZED' || !provider.tokens()) return null;
    } catch (err) {
      log.warn('mcp_oauth_refresh_failed', { errorType: errorType(err) });
      return null;
    }
    const tokens = provider.tokens()!;
    await this.save(memberId, service, { ...secret, tokens, savedAt: Date.now() });
    return String((tokens as { access_token: string }).access_token);
  }

  /** Which of the member's credentials are OAuth connections (service names only). */
  async connections(memberId: string): Promise<{ service: string; serverUrl: string }[]> {
    const out: { service: string; serverUrl: string }[] = [];
    for (const { service } of await this.vault.list(memberId)) {
      const raw = await this.vault.reveal(memberId, service);
      const s = raw ? parseOAuthSecret(raw) : null;
      if (s) out.push({ service, serverUrl: s.serverUrl });
    }
    return out;
  }
}

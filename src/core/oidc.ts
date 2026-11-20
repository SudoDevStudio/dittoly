import * as client from 'openid-client';
import type { Cipher } from './crypto.js';
import { AppError } from './errors.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  /** Where the identity provider sends members back: <public url>/auth/callback */
  redirectUri: string;
  /** Optional allow-list of email domains for first sign-in. */
  allowedDomains: string[];
  /** Development only: allow an http:// issuer. */
  allowInsecureIssuer?: boolean;
}

/** State kept in an encrypted, short-lived cookie between /auth/login and /auth/callback. */
interface PendingLogin {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  exp: number;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string | undefined;
  name: string | undefined;
  /** Entra ID's object id (the `oid` claim), the same in every app, unlike its per-app `sub`. */
  objectId?: string | undefined;
}

const AAD = 'oidc:pending-login';

/**
 * OpenID Connect sign-in with the authorization code flow, PKCE, state and
 * nonce. Discovery runs once, lazily.
 */
export class OidcAuth {
  private configuration: Promise<client.Configuration> | null = null;

  constructor(
    private readonly cfg: OidcConfig,
    private readonly cipher: Cipher,
  ) {}

  private config(): Promise<client.Configuration> {
    if (!this.configuration) {
      this.configuration = client
        .discovery(
          new URL(this.cfg.issuer),
          this.cfg.clientId,
          this.cfg.clientSecret,
          undefined,
          this.cfg.allowInsecureIssuer ? { execute: [client.allowInsecureRequests] } : undefined,
        )
        .catch((err) => {
          this.configuration = null; // try discovery again next time
          throw err;
        });
    }
    return this.configuration;
  }

  /** Start a sign-in: returns the identity provider URL and the sealed state for a cookie. */
  async begin(returnTo: string): Promise<{ url: string; sealed: string }> {
    const config = await this.config().catch(() => {
      throw new AppError('sso_unavailable', 503);
    });
    const verifier = client.randomPKCECodeVerifier();
    const pending: PendingLogin = {
      verifier,
      state: client.randomState(),
      nonce: client.randomNonce(),
      returnTo: safeReturnTo(returnTo),
      exp: Date.now() + 10 * 60_000,
    };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.cfg.redirectUri,
      scope: 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: pending.state,
      nonce: pending.nonce,
    });
    return { url: url.href, sealed: this.cipher.encryptJson(pending, AAD) };
  }

  /** Finish a sign-in from the callback URL. Throws AppError on any failure. */
  async finish(callbackUrl: URL, sealed: string | undefined): Promise<{ identity: OidcIdentity; returnTo: string }> {
    if (!sealed) throw new AppError('sso_state_missing', 400);
    let pending: PendingLogin;
    try {
      pending = this.cipher.decryptJson<PendingLogin>(sealed, AAD);
    } catch {
      throw new AppError('sso_state_invalid', 400);
    }
    if (pending.exp < Date.now()) throw new AppError('sso_state_expired', 400);
    const config = await this.config();
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch {
      throw new AppError('sso_failed', 401);
    }
    if (!claims) throw new AppError('sso_failed', 401);
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined;
    // Only an explicit "verified" counts: a provider that omits the claim proves nothing about the address.
    const emailVerified = claims.email_verified === true;
    if (this.cfg.allowedDomains.length > 0) {
      const domain = email?.split('@')[1];
      if (!email || !emailVerified || !domain || !this.cfg.allowedDomains.includes(domain)) {
        throw new AppError('sso_domain_not_allowed', 403);
      }
    }
    return {
      identity: {
        issuer: claims.iss,
        subject: claims.sub,
        email: emailVerified ? email : undefined,
        name: typeof claims.name === 'string' ? claims.name.slice(0, 120) : undefined,
        objectId: typeof claims.oid === 'string' ? claims.oid : undefined,
      },
      returnTo: pending.returnTo,
    };
  }
}

/** Only same-site relative paths, so the login flow cannot be used as an open redirect. */
export function safeReturnTo(value: string | undefined, fallback = '/'): string {
  if (!value || value.length > 500) return fallback;
  // Browsers drop tabs and newlines from URLs and read a backslash as a slash, so "/\t/evil.com" means "//evil.com".
  if (!value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  const base = new URL('https://dittoly.invalid');
  const resolved = new URL(value, base);
  if (resolved.origin !== base.origin) return fallback;
  // Dot segments are removed while resolving ("/.//evil.com" becomes "//evil.com"), so check what comes out too.
  const out = resolved.pathname + resolved.search + resolved.hash;
  return out.startsWith('//') ? fallback : out;
}

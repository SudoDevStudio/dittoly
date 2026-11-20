import { createHash, createSign } from 'node:crypto';
import { readLimited, type FetchLike } from './broker.js';

/**
 * Google service account credentials ("google_service_account" placement), for Firebase
 * (Firestore, Realtime Database) and other Google APIs.
 *
 * The member stores the service account's JSON key. The broker signs a short JWT with its
 * private key and trades it at Google's token endpoint for an access token that lasts about an
 * hour and carries only the scopes the manifest declares; the request gets that token. The
 * module never sees the key or the token, and the key file cannot point the exchange anywhere
 * else: the token endpoint is fixed.
 *
 * The exchange is the OAuth 2.0 JWT bearer grant (RFC 7523), as Google's own libraries do it:
 * an RS256 JWT with iss = the service account, scope, aud = the token endpoint, iat and
 * exp = iat + 3600, posted as grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GoogleAuthError extends Error {
  constructor(readonly code: 'credential_invalid' | 'credential_rejected' | 'google_token_unavailable', readonly retryable = false) {
    super(code);
  }
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export function parseServiceAccountKey(secret: string): ServiceAccountKey {
  let key: unknown;
  try {
    key = JSON.parse(secret);
  } catch {
    throw new GoogleAuthError('credential_invalid');
  }
  const k = key as Partial<ServiceAccountKey> & { type?: unknown };
  if (
    k?.type !== 'service_account' ||
    typeof k.client_email !== 'string' ||
    !/^[^\s@]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/i.test(k.client_email) ||
    typeof k.private_key !== 'string' ||
    !k.private_key.includes('PRIVATE KEY-----')
  ) {
    throw new GoogleAuthError('credential_invalid');
  }
  return { client_email: k.client_email, private_key: k.private_key };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** The signed JWT assertion for the token exchange. */
export function signAssertion(key: ServiceAccountKey, scopes: readonly string[], now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: scopes.join(' '), aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 }));
  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  } catch {
    throw new GoogleAuthError('credential_invalid');
  }
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Access tokens by key and scopes, kept in memory only, until a minute before they expire. */
const cache = new Map<string, { token: string; expiresAt: number }>();
const MAX_CACHED = 500;

export async function googleAccessToken(secret: string, scopes: readonly string[], fetchImpl: FetchLike, now = Date.now()): Promise<string> {
  const cacheKey = createHash('sha256').update(secret).update('\0').update([...scopes].sort().join(' ')).digest('hex');
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt - 60_000 > now) return hit.token;
  const key = parseServiceAccountKey(secret);
  const assertion = signAssertion(key, scopes, Math.floor(now / 1000));
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GoogleAuthError('google_token_unavailable', true);
  }
  // A token response is small; anything larger is not read whole.
  const raw = await readLimited(res, 64_000).catch(() => null);
  const body = parseJson(raw) as { access_token?: unknown; expires_in?: unknown } | null;
  // 400/401: a revoked or deleted key, or a scope the account may not use.
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new GoogleAuthError('credential_rejected');
  if (!res.ok || typeof body?.access_token !== 'string') throw new GoogleAuthError('google_token_unavailable', res.status >= 500 || res.status === 429);
  const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? Math.min(body.expires_in, 3600) : 3600;
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { token: body.access_token, expiresAt: now + lifetime * 1000 });
  return body.access_token;
}

function parseJson(raw: Buffer | null): unknown {
  try {
    return raw ? JSON.parse(raw.toString('utf8')) : null;
  } catch {
    return null;
  }
}

/** Tests only. */
export function clearGoogleTokenCache(): void {
  cache.clear();
}

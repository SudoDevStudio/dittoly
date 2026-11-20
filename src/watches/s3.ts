import { createHash, createHmac } from 'node:crypto';
import type { FetchLike } from '../sandbox/broker.js';

/**
 * A small S3 client for watching a bucket: list objects (ListObjectsV2) and read a small
 * one, signed with AWS Signature Version 4. Works with AWS S3 and S3-compatible stores
 * (MinIO, Cloudflare R2, Backblaze B2, ...) given their endpoint.
 */

export interface S3Location {
  /** e.g. https://s3.eu-central-1.amazonaws.com, or https://minio.acme.com */
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
}
export interface S3Keys {
  accessKeyId: string;
  secretAccessKey: string;
}
export interface S3Object {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Sign a request (AWS Signature Version 4, header form). `service` is "s3" for S3; for
 * S3 the payload hash is also sent as x-amz-content-sha256 and signed.
 */
export function signV4(
  req: { method: string; url: string; headers?: Record<string, string>; body?: string },
  keys: S3Keys,
  region: string,
  service: string,
  now = new Date(),
  /** Send and sign the payload hash header (always for S3). */
  signBody = service === 's3',
): Record<string, string> {
  const u = new URL(req.url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(req.body ?? '');
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: u.host, 'x-amz-date': amzDate };
  if (signBody) headers['x-amz-content-sha256'] = payloadHash;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // S3 paths are encoded once, segment by segment; other services normalize first.
  const path = u.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const canonicalRequest = [req.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${keys.secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const out: Record<string, string> = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  delete out.host; // fetch sets it
  return out;
}

/** AWS endpoints use virtual-hosted addresses (bucket.s3.region.amazonaws.com); others the bucket in the path. */
function bucketUrl(loc: S3Location): URL {
  const base = new URL(loc.endpoint);
  if (/(^|\.)amazonaws\.com$/.test(base.hostname)) return new URL(`${base.protocol}//${loc.bucket}.${base.host}/`);
  return new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(loc.bucket)}/`);
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unxml(m[1]!) : null;
};

export class S3Error extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Objects under the prefix, oldest key order, up to `max` (several pages if needed). */
export async function listObjects(fetchImpl: FetchLike, loc: S3Location, keys: S3Keys, max = 5000): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let token: string | null = null;
  for (let page = 0; page < 10 && out.length < max; page++) {
    const u = bucketUrl(loc);
    u.searchParams.set('list-type', '2');
    if (loc.prefix) u.searchParams.set('prefix', loc.prefix);
    u.searchParams.set('max-keys', '1000');
    if (token) u.searchParams.set('continuation-token', token);
    const headers = signV4({ method: 'GET', url: u.toString() }, keys, loc.region, 's3');
    const res = await fetchImpl(u.toString(), { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (!res.ok) throw new S3Error(tag(body, 'Code') ? `s3_${tag(body, 'Code')!.replace(/[^A-Za-z]/g, '').slice(0, 40)}` : `s3_http_${res.status}`);
    for (const m of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const c = m[1]!;
      out.push({ key: tag(c, 'Key') ?? '', size: Number(tag(c, 'Size') ?? 0), etag: (tag(c, 'ETag') ?? '').replace(/"/g, ''), lastModified: tag(c, 'LastModified') ?? '' });
    }
    token = tag(body, 'IsTruncated') === 'true' ? tag(body, 'NextContinuationToken') : null;
    if (!token) break;
  }
  return out.slice(0, max);
}

/** A small object's content as text, or null when it is larger than `limit` bytes or not text. */
export async function readText(fetchImpl: FetchLike, loc: S3Location, keys: S3Keys, key: string, limit = 256 * 1024): Promise<string | null> {
  const u = new URL(key.split('/').map(enc).join('/'), bucketUrl(loc));
  const headers = signV4({ method: 'GET', url: u.toString() }, keys, loc.region, 's3');
  const res = await fetchImpl(u.toString(), { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new S3Error(`s3_http_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) return null;
  const text = buf.toString('utf8');
  // Binary content (replacement characters or NULs) is not offered as text.
  if (text.includes('\u0000') || text.includes('�')) return null;
  return text;
}

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AppError, badRequest } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import type { FetchLike } from '../sandbox/broker.js';

/**
 * What a member tells the AI about the API to build against: an OpenAPI (Swagger)
 * spec, a documentation page, or pasted docs, plus the base URL and auth style.
 * URLs are fetched by the server through the egress guard. Whatever comes back
 * is reference data for the AI, never instructions, and is condensed to the parts
 * that matter for the request.
 */
export const apiSourceSchema = z
  .object({
    specUrl: z.string().url().optional(),
    docsUrl: z.string().url().optional(),
    docs: z.string().max(200_000).optional(),
    baseUrl: z.string().url().optional(),
    auth: z.enum(['bearer', 'header', 'basic', 'oauth', 'none']).optional(),
    authHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  })
  .strict();
export type ApiSourceInput = z.infer<typeof apiSourceSchema>;

export interface ApiReference {
  /** Condensed text handed to the AI. */
  text: string;
  /** What reviewers see: where it came from and how much was used. */
  origin: {
    kind: 'openapi' | 'docs' | 'pasted' | 'hints';
    url: string | null;
    sha256: string | null;
    bytes: number;
    fetchedAt: string | null;
    operations?: { total: number; included: number };
    baseUrl: string | null;
    auth: string | null;
  };
}

const MAX_DOWNLOAD = 5 * 1024 * 1024;
const MAX_REFERENCE = 60_000;
const TIMEOUT_MS = 15_000;

/** GET with the egress guard, following at most 3 redirects (each hop guarded again), with a size cap. */
export async function fetchSource(fetchFn: FetchLike, url: string): Promise<{ body: string; contentType: string; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (u.username || u.password) throw badRequest('api_source_url_invalid');
    let res: Response;
    try {
      res = await fetchFn(current, { method: 'GET', headers: { accept: 'application/json, application/yaml, text/yaml, text/html, text/plain;q=0.8, */*;q=0.5' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      log.warn('api_source_fetch_failed', { errorType: errorType(err) });
      throw new AppError('api_source_unreachable', 502);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).href;
      continue;
    }
    if (!res.ok) throw new AppError(`api_source_http_${res.status}`, 502);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_DOWNLOAD) {
          await reader.cancel();
          throw new AppError('api_source_too_large', 413);
        }
        chunks.push(value);
      }
    }
    return { body: Buffer.concat(chunks).toString('utf8'), contentType: res.headers.get('content-type') ?? '', finalUrl: current };
  }
  throw new AppError('api_source_too_many_redirects', 502);
}

// ---------------------------------------------------------------- OpenAPI condensing

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function resolve(spec: Json, node: unknown, depth = 0): unknown {
  if (!isObj(node)) return node;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/') && depth < 8) {
    let target: unknown = spec;
    for (const part of ref.slice(2).split('/')) target = isObj(target) ? target[part.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
    return resolve(spec, target, depth + 1);
  }
  return node;
}

/** A compact one-line shape of a schema: {id:integer, title:string, tags:[string]}. */
function shape(spec: Json, schema: unknown, depth = 0): string {
  const s = resolve(spec, schema);
  if (!isObj(s)) return 'any';
  if (depth > 3) return 'object';
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    if (Array.isArray(s[key])) return (s[key] as unknown[]).map((x) => shape(spec, x, depth + 1)).join(key === 'allOf' ? ' & ' : ' | ');
  }
  if (s.type === 'array') return `[${shape(spec, s.items, depth + 1)}]`;
  if (isObj(s.properties)) {
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const props = Object.entries(s.properties).slice(0, 25).map(([k, v]) => `${k}${required.has(k) ? '' : '?'}:${shape(spec, v, depth + 1)}`);
    return `{${props.join(', ')}${Object.keys(s.properties).length > 25 ? ', …' : ''}}`;
  }
  if (Array.isArray(s.enum)) return (s.enum as unknown[]).slice(0, 8).map((e) => JSON.stringify(e)).join('|');
  return typeof s.type === 'string' ? s.type + (typeof s.format === 'string' ? `(${s.format})` : '') : 'object';
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []);

function condenseOpenApi(spec: Json, request: string): { text: string; total: number; included: number } {
  const info = isObj(spec.info) ? spec.info : {};
  const lines: string[] = [`OpenAPI: ${String(info.title ?? 'API')} ${String(info.version ?? '')}`.trim()];
  const servers = Array.isArray(spec.servers) ? (spec.servers as Json[]).map((s) => String(s.url)) : spec.host ? [`https://${String(spec.host)}${String(spec.basePath ?? '')}`] : [];
  if (servers.length) lines.push(`Servers: ${servers.join(', ')}`);
  const schemes = isObj(spec.components) && isObj(spec.components.securitySchemes) ? spec.components.securitySchemes : isObj(spec.securityDefinitions) ? spec.securityDefinitions : {};
  for (const [name, raw] of Object.entries(schemes)) {
    const s = resolve(spec, raw) as Json;
    lines.push(`Auth "${name}": ${[s.type, s.scheme, s.in, s.name, s.bearerFormat].filter(Boolean).join(' ')}`);
  }

  const wanted = words(request);
  const ops: { score: number; text: string }[] = [];
  for (const [path, item] of Object.entries(isObj(spec.paths) ? spec.paths : {})) {
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const summary = String(op.summary ?? op.description ?? '').split('\n')[0]!.slice(0, 160);
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => resolve(spec, p) as Json)
        .filter((p) => isObj(p) && p.in !== 'header')
        .map((p) => `${String(p.name)}(${String(p.in)}${p.required ? ',required' : ''}${p.schema ? `,${shape(spec, p.schema)}` : p.type ? `,${String(p.type)}` : ''})`);
      const body = resolve(spec, op.requestBody) as Json | undefined;
      const bodySchema = isObj(body?.content) ? (Object.values(body.content)[0] as Json | undefined)?.schema : undefined;
      const responses = isObj(op.responses) ? op.responses : {};
      const okKey = Object.keys(responses).find((k) => /^2/.test(k));
      const ok = okKey ? (resolve(spec, responses[okKey]) as Json) : undefined;
      const okSchema = isObj(ok?.content) ? (Object.values(ok.content)[0] as Json | undefined)?.schema : ok?.schema;
      const text = [
        `${method.toUpperCase()} ${path}${summary ? ` — ${summary}` : ''}`,
        params.length ? `  params: ${params.join(', ')}` : '',
        bodySchema ? `  body: ${shape(spec, bodySchema)}` : '',
        okKey ? `  ${okKey}: ${okSchema ? shape(spec, okSchema) : '(no body)'}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const score = [...words(`${path} ${summary} ${String(op.operationId ?? '')} ${(Array.isArray(op.tags) ? op.tags : []).join(' ')}`)].filter((w) => wanted.has(w)).length;
      ops.push({ score, text });
    }
  }
  // Most relevant operations first, until the budget is used.
  ops.sort((a, b) => b.score - a.score);
  let used = lines.join('\n').length;
  let included = 0;
  lines.push('Operations (most relevant to the request first):');
  for (const op of ops) {
    if (used + op.text.length + 1 > MAX_REFERENCE) break;
    lines.push(op.text);
    used += op.text.length + 1;
    included++;
  }
  if (included < ops.length) lines.push(`(${ops.length - included} less relevant operations omitted)`);
  return { text: lines.join('\n'), total: ops.length, included };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function parseSpec(body: string): Json | null {
  const trimmed = body.trimStart();
  try {
    const value = trimmed.startsWith('{') ? JSON.parse(trimmed) : /^(openapi|swagger)\s*:/m.test(trimmed.slice(0, 2000)) ? parseYaml(trimmed, { maxAliasCount: 100 }) : null;
    return isObj(value) && (value.openapi || value.swagger) && isObj(value.paths) ? value : null;
  } catch {
    return null;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Build the reference for one generation request. Returns null when the member gave nothing. */
export async function buildApiReference(fetchFn: FetchLike, input: ApiSourceInput | undefined, request: string): Promise<ApiReference | null> {
  if (!input || Object.values(input).every((v) => v === undefined || v === '')) return null;
  const hints = [input.baseUrl ? `Base URL: ${input.baseUrl}` : '', input.auth ? `Authentication: ${input.auth}${input.authHeader ? ` (header ${input.authHeader})` : ''}` : '']
    .filter(Boolean)
    .join('\n');
  const origin: ApiReference['origin'] = {
    kind: 'hints',
    url: null,
    sha256: null,
    bytes: 0,
    fetchedAt: null,
    baseUrl: input.baseUrl ?? null,
    auth: input.auth ?? null,
  };
  let body: string | null = null;
  let contentType = '';
  if (input.specUrl || input.docsUrl) {
    const url = (input.specUrl ?? input.docsUrl)!;
    const got = await fetchSource(fetchFn, url);
    body = got.body;
    contentType = got.contentType;
    Object.assign(origin, { url: got.finalUrl, fetchedAt: new Date().toISOString(), kind: 'docs' });
  } else if (input.docs) {
    body = input.docs;
    origin.kind = 'pasted';
  }
  let text = '';
  if (body !== null) {
    origin.sha256 = sha(body);
    origin.bytes = Buffer.byteLength(body);
    const spec = parseSpec(body);
    if (spec) {
      const c = condenseOpenApi(spec, request);
      text = c.text;
      origin.kind = 'openapi';
      origin.operations = { total: c.total, included: c.included };
    } else {
      if (input.specUrl) throw badRequest('api_source_not_openapi');
      text = (/html/i.test(contentType) || /^\s*</.test(body) ? htmlToText(body) : body).slice(0, MAX_REFERENCE);
    }
  }
  return { text: [hints, text].filter(Boolean).join('\n\n'), origin };
}

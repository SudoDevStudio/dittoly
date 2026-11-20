/**
 * The Dittoly base: TypeScript every module starts with, so every module of a kind is built the same way. Dittoly
 * puts it at the top of module.ts (between markers); the AI, or a person, writes the module's own TypeScript under
 * it, calling the base for what is common (requests, credentials, paging, errors, queries, email, publishing,
 * streams) and writing its own code where an action needs something else. Anything the base does can be replaced
 * by writing that part by hand: the base is plain functions, not a framework.
 *
 * The base is part of the module's source, so it is reviewed, approved and frozen with each version like the rest;
 * a revision gets the current base again and keeps the module's own code. It adds no power: every call still goes
 * through ctx and the broker, within what the manifest declares.
 */

/** Bumped when the base changes; a module keeps the base it was approved with until its next version. */
export const BASE_VERSION = 1;

const START = '// <dittoly-base>';
const END = '// </dittoly-base>';

/** What each kind can do, in a few words (MODULE.md, the skill and docs/module-types.md say the same). */
export const CAPABILITIES: Record<string, { calls: string; can: string[] }> = {
  http: {
    calls: 'base.http.client({ baseUrl, headers?, credential? }) then .get / .post / .put / .patch / .delete / .list',
    can: [
      'any HTTPS JSON API: GET, POST, PUT, PATCH, DELETE',
      '{field} path placeholders from the input, URL-encoded; query parameters from the input (empty ones left out)',
      'a JSON body, or multipart (files as data URLs)',
      "the manifest's credential attached by the runtime (or none)",
      'answers that are errors inside a 200 (okWhen)',
      'status codes mapped to error codes; 429 and 5xx retryable',
      'listing across pages: Link header, page number or cursor, at most 10 pages',
      'a host per organization ({{settings.site}} in baseUrl)',
      'the raw answer (status, headers, text) for anything else: XML, HTML, CSV',
    ],
  },
  db: {
    calls: 'base.db.rows / base.db.first / base.db.count',
    can: ['run a query (SQL) or operation (MongoDB) the manifest declares, by id, with bound parameters', 'all rows, the first row (or an error when none), or the row count'],
  },
  smtp: { calls: 'base.mail.send', can: ['send one email through an smtp endpoint: to, cc, bcc, reply-to, subject, text or html; the sender is fixed by the manifest'] },
  amqp: { calls: 'base.amqp.publish', can: ['publish one message to an exchange the endpoint declares, with a routing key'] },
  mqtt: { calls: 'base.mqtt.publish', can: ['publish one message to a topic within the endpoint\'s topics, QoS 0 or 1, retained or not'] },
  ws: { calls: 'base.ws.exchange', can: ['open a WebSocket, send messages, collect a bounded number of replies (JSON parsed)'] },
  sse: { calls: 'base.sse.read', can: ['read a bounded number of Server-Sent Events (JSON data parsed)'] },
};

/** The kinds a module's own code uses, from its calls into the base. */
export function kindsUsed(source: string | null | undefined): string[] {
  const own = ownCode(source ?? '');
  const out: string[] = [];
  if (/\bbase\.http\b/.test(own)) out.push('http');
  if (/\bbase\.db\b/.test(own)) out.push('db');
  if (/\bbase\.mail\b/.test(own)) out.push('smtp');
  if (/\bbase\.amqp\b/.test(own)) out.push('amqp');
  if (/\bbase\.mqtt\b/.test(own)) out.push('mqtt');
  if (/\bbase\.ws\b/.test(own)) out.push('ws');
  if (/\bbase\.sse\b/.test(own)) out.push('sse');
  return out;
}

/** Whether the source starts with a Dittoly base. */
export function hasBase(source: string | null | undefined): boolean {
  return !!source && source.includes(START) && source.includes(END);
}

/** The module's own code: the source without the base (all of it for a module without one). */
export function ownCode(source: string): string {
  const a = source.indexOf(START);
  const b = source.indexOf(END);
  if (a < 0 || b < a) return source;
  return (source.slice(0, a) + source.slice(b + END.length)).replace(/^\s+/, '');
}

/** module.ts: the current base, then the module's own code (an old base in it is replaced, never doubled). */
export function withBase(code: string): string {
  return `${BASE_SOURCE}\n${ownCode(code).trimStart()}`;
}

/**
 * The base itself. It only uses the runtime's global types (ModuleContext, HttpResponse, DbResult), so it compiles
 * in the sandbox, in git (types/dittoly-module.d.ts) and under tsc --strict.
 */
export const BASE_SOURCE = `${START}
/**
 * Dittoly base v${BASE_VERSION}: the same in every module (written by Dittoly, src/modules/module-base.ts). Write the
 * module's own code below it, calling \`base\`; to do something differently, write that part yourself. A new version
 * of the module gets the current base again and keeps the code below.
 */
type BaseJson = string | number | boolean | null | BaseJson[] | { [key: string]: BaseJson };
type BaseQuery = Record<string, string | number | boolean | null | undefined | (string | number)[]>;
interface BaseRequest {
  /** {name} placeholders are filled from \`vars\`, URL-encoded. */
  vars?: Record<string, unknown>;
  query?: BaseQuery;
  json?: unknown;
  multipart?: MultipartPart[];
  headers?: Record<string, string>;
  /** The manifest's credential id; "" for none. Default: the client's. */
  credential?: string;
  /** Status code -> error code, e.g. { 404: 'not_found' }. */
  errors?: Record<number, string>;
  /** For apps that answer 200 with an error inside: the answer counts only when this dot path equals the value. */
  okWhen?: { path: string; equals: unknown; error?: string };
  /** Return the raw answer (status, headers, body) instead of its JSON; nothing is checked. */
  raw?: boolean;
}
interface BaseList extends BaseRequest {
  /** Where the items are in each page's answer ("" = the answer is the list). */
  items?: string;
  paginate?: { style: 'link' } | { style: 'page'; param: string } | { style: 'cursor'; param: string; next: string };
  /** At most this many pages (1-10, default 3). */
  maxPages?: number;
}
interface BaseClient {
  get(ctx: ModuleContext, path: string, req?: BaseRequest): Promise<unknown>;
  post(ctx: ModuleContext, path: string, req?: BaseRequest): Promise<unknown>;
  put(ctx: ModuleContext, path: string, req?: BaseRequest): Promise<unknown>;
  patch(ctx: ModuleContext, path: string, req?: BaseRequest): Promise<unknown>;
  delete(ctx: ModuleContext, path: string, req?: BaseRequest): Promise<unknown>;
  /** GET a listing, following pages; returns the items of every page. */
  list(ctx: ModuleContext, path: string, req?: BaseList): Promise<unknown[]>;
  /** One request with any method; the others call it. */
  request(ctx: ModuleContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, req?: BaseRequest): Promise<unknown>;
}

/** The value at a dot path ("" is the value itself). */
function baseAt(value: unknown, path: string): unknown {
  if (!path) return value;
  let v: unknown = value;
  for (const part of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

/** { outKey: 'dot.path' } of one object, or of each in a list. Missing values are left out. */
function basePick(value: unknown, fields: Record<string, string>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(fields)) {
    const v = baseAt(value, path);
    if (v !== undefined) o[key] = v;
  }
  return o;
}

function baseFail(ctx: ModuleContext, code: string, retryable = false): never {
  throw new ctx.ActionError(code, { retryable });
}

/** {name} placeholders filled from vars: URL-encoded for a path, or (\`level\`) a single topic or key level. */
function baseFill(ctx: ModuleContext, text: string, vars: Record<string, unknown> | undefined, mode: 'url' | 'level'): string {
  return text.replace(/\\{([A-Za-z_][\\w.]*)\\}/g, (_m: string, name: string) => {
    const v = baseAt(vars ?? {}, name);
    if (v === undefined || v === null || v === '') baseFail(ctx, 'missing_input');
    const s = String(v);
    if (mode === 'url') return encodeURIComponent(s);
    if (/[\\s/#+*>]/.test(s)) baseFail(ctx, 'invalid_input');
    return s;
  });
}

function baseQuery(query: BaseQuery | undefined, extra: Record<string, string> = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    for (const one of Array.isArray(v) ? v : [v]) parts.push(\`\${encodeURIComponent(k)}=\${encodeURIComponent(String(one))}\`);
  }
  for (const [k, v] of Object.entries(extra)) parts.push(\`\${encodeURIComponent(k)}=\${encodeURIComponent(v)}\`);
  return parts.length ? \`?\${parts.join('&')}\` : '';
}

function baseCheck(ctx: ModuleContext, res: HttpResponse, req: BaseRequest): unknown {
  if (!res.ok) {
    const code = req.errors?.[res.status] ?? (res.status === 401 || res.status === 403 ? 'not_allowed' : res.status === 404 ? 'not_found' : res.status === 429 ? 'rate_limited' : \`http_\${res.status}\`);
    baseFail(ctx, code, res.status === 429 || res.status >= 500);
  }
  const data: unknown = res.body ? res.json() : null;
  if (req.okWhen && baseAt(data, req.okWhen.path) !== req.okWhen.equals) baseFail(ctx, req.okWhen.error ?? 'app_rejected');
  return data;
}

function baseParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const base = {
  at: baseAt,
  pick: basePick,
  /** Each item of a list picked with \`fields\`. */
  pickAll: (list: unknown, fields: Record<string, string>): Record<string, unknown>[] => (Array.isArray(list) ? list.map((v) => basePick(v, fields)) : []),
  fail: baseFail,

  http: {
    /** A client for one API: its base URL (a {{settings.<id>}} host is filled in), headers and credential. */
    client(opts: { baseUrl: string; headers?: Record<string, string>; credential?: string }): BaseClient {
      const urlOf = (ctx: ModuleContext, path: string, req: BaseRequest, extra?: Record<string, string>) => {
        const root = opts.baseUrl.replace(/\\{\\{settings\\.([a-z][a-z0-9_]*)\\}\\}/g, (_m: string, id: string) => ctx.settings[id] || baseFail(ctx, 'setting_missing'));
        return \`\${root}\${baseFill(ctx, path, req.vars, 'url')}\${baseQuery(req.query, extra)}\`;
      };
      const send = (ctx: ModuleContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, req: BaseRequest) => {
        const credential = req.credential === '' ? undefined : (req.credential ?? opts.credential);
        return ctx.http.request({
          method,
          url,
          headers: { ...(opts.headers ?? {}), ...(req.headers ?? {}) },
          ...(req.json !== undefined ? { json: req.json } : {}),
          ...(req.multipart ? { multipart: req.multipart } : {}),
          ...(credential ? { credential } : {}),
        });
      };
      const client: BaseClient = {
        async request(ctx, method, path, req = {}) {
          const res = await send(ctx, method, urlOf(ctx, path, req), req);
          return req.raw ? res : baseCheck(ctx, res, req);
        },
        get: (ctx, path, req) => client.request(ctx, 'GET', path, req),
        post: (ctx, path, req) => client.request(ctx, 'POST', path, req),
        put: (ctx, path, req) => client.request(ctx, 'PUT', path, req),
        patch: (ctx, path, req) => client.request(ctx, 'PATCH', path, req),
        delete: (ctx, path, req) => client.request(ctx, 'DELETE', path, req),
        async list(ctx, path, req = {}) {
          const max = Math.min(10, Math.max(1, req.maxPages ?? 3));
          const all: unknown[] = [];
          let url = urlOf(ctx, path, req);
          for (let page = 1; page <= max; page++) {
            const res = await send(ctx, 'GET', url, req);
            const data = baseCheck(ctx, res, req);
            const items = baseAt(data, req.items ?? '');
            if (!Array.isArray(items) || !items.length) break;
            all.push(...items);
            const p = req.paginate;
            let next: string | null = null;
            if (p?.style === 'link') {
              const m = /<([^>]+)>;\\s*rel="next"/.exec(res.headers['link'] ?? '');
              next = m ? m[1]! : null;
            } else if (p?.style === 'page') next = urlOf(ctx, path, req, { [p.param]: String(page + 1) });
            else if (p?.style === 'cursor') {
              const cursor = baseAt(data, p.next);
              if (typeof cursor === 'string' && cursor) next = urlOf(ctx, path, req, { [p.param]: cursor });
            }
            if (!next || next === url) break;
            url = next;
          }
          return all;
        },
      };
      return client;
    },
  },

  db: {
    /** All rows of a query (or MongoDB operation) the manifest's endpoint declares. */
    async rows(ctx: ModuleContext, endpoint: string, query: string, params: Record<string, unknown> = {}): Promise<DbResult> {
      return ctx.db.query({ endpoint, query, params });
    },
    /** The first row, or the error \`notFound\` when there is none. */
    async first(ctx: ModuleContext, endpoint: string, query: string, params: Record<string, unknown> = {}, notFound = 'not_found'): Promise<Record<string, unknown>> {
      const res = await ctx.db.query({ endpoint, query, params });
      return res.rows[0] ?? baseFail(ctx, notFound);
    },
    /** How many rows the query read or changed. */
    async count(ctx: ModuleContext, endpoint: string, query: string, params: Record<string, unknown> = {}): Promise<number> {
      return (await ctx.db.query({ endpoint, query, params })).rowCount;
    },
  },

  mail: {
    /** One email through an smtp endpoint; the sender is the manifest's. */
    send(ctx: ModuleContext, endpoint: string, m: { to: string | string[]; subject: string; text?: string; html?: string; cc?: string | string[]; bcc?: string | string[]; replyTo?: string }) {
      if (!m.text && !m.html) baseFail(ctx, 'missing_input');
      return ctx.smtp.send({ endpoint, ...m });
    },
  },

  amqp: {
    /** One message to an exchange the endpoint declares; {name} in the routing key is one level from vars. */
    async publish(ctx: ModuleContext, endpoint: string, m: { exchange: string; routingKey: string; message: unknown; vars?: Record<string, unknown>; persistent?: boolean }) {
      await ctx.amqp.publish({ endpoint, exchange: m.exchange, routingKey: baseFill(ctx, m.routingKey, m.vars, 'level'), message: m.message, ...(m.persistent !== undefined ? { persistent: m.persistent } : {}) });
      return { published: true };
    },
  },

  mqtt: {
    /** One message to a topic within the endpoint's topics; {name} fills one topic level from vars. */
    async publish(ctx: ModuleContext, endpoint: string, m: { topic: string; message: unknown; vars?: Record<string, unknown>; qos?: 0 | 1; retain?: boolean }) {
      const topic = baseFill(ctx, m.topic, m.vars, 'level');
      await ctx.mqtt.publish({ endpoint, topic, message: m.message, ...(m.qos !== undefined ? { qos: m.qos } : {}), ...(m.retain !== undefined ? { retain: m.retain } : {}) });
      return { published: true, topic };
    },
  },

  ws: {
    /** A bounded WebSocket exchange; replies that are JSON are parsed. */
    async exchange(ctx: ModuleContext, endpoint: string, m: { path: string; vars?: Record<string, unknown>; send?: unknown[]; maxMessages?: number; maxMs?: number }) {
      const res = await ctx.ws.exchange({ endpoint, path: baseFill(ctx, m.path, m.vars, 'url'), ...(m.send ? { send: m.send } : {}), maxMessages: m.maxMessages ?? 10, maxMs: m.maxMs ?? 5000 });
      return { messages: res.messages.map(baseParse), closed: res.closed };
    },
  },

  sse: {
    /** A bounded number of Server-Sent Events; data that is JSON is parsed. */
    async read(ctx: ModuleContext, endpoint: string, m: { path: string; vars?: Record<string, unknown>; maxEvents?: number; maxMs?: number }) {
      const res = await ctx.sse.read({ endpoint, path: baseFill(ctx, m.path, m.vars, 'url'), maxEvents: m.maxEvents ?? 10, maxMs: m.maxMs ?? 5000 });
      if (res.status === 401 || res.status === 403) baseFail(ctx, 'not_allowed');
      if (res.status >= 400) baseFail(ctx, \`http_\${res.status}\`, res.status === 429 || res.status >= 500);
      return { events: res.events.map((e) => ({ event: e.event, data: baseParse(e.data), ...(e.id ? { id: e.id } : {}) })) };
    },
  },
};
${END}
`;

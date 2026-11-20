import { z } from 'zod';
import {
  ajv,
  endpointPort,
  hostMatches,
  hostPattern,
  hostPlaceholder,
  isDatabase,
  isDbEndpoint,
  mqttTopicMatches,
  optionalServicesFor,
  resolveManifest,
  servicesFor,
  settingRef,
  type DbEndpoint,
  type MongoEndpoint,
} from '../runtime/manifest.js';
import type * as Runtime from '../runtime/types.js';
import { checkMongoOperation, MONGO_READ_OPS, MONGO_WRITE_OPS } from './mongo.js';
import { checkSql, type Dialect } from './sql.js';

/**
 * The Super-Module manifest: everything a module may do. The runtime enforces
 * it; admins review this, not code.
 */

export { ajv, endpointPort, hostMatches, isDatabase, isDbEndpoint, mqttTopicMatches, optionalServicesFor, resolveManifest, servicesFor, type DbEndpoint, type MongoEndpoint };

/** What an admin may set a host setting to: an exact host, "*.example.com" for any one label in front, or "**.mongodb.net" for one or more. */
const hostGlob = /^(\*\*?\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
const manifestHost = z.string().refine((h) => hostPattern.test(h) || hostPlaceholder.test(h), 'must be host[:port] or {{settings.<id>}}');

const identifier = /^[a-z][a-z0-9_]{0,63}$/;

const jsonSchema = z.record(z.string(), z.unknown());

const credentialPlacement = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer') }),
  z.object({
    type: z.literal('header'),
    name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    prefix: z.string().max(32).default(''),
  }),
  /** Secret stored as "username:password"; sent as HTTP Basic. */
  z.object({ type: z.literal('basic') }),
  /**
   * A Google service account's JSON key (Firebase, other Google APIs). The broker trades it for a
   * short-lived access token with only these scopes and sends that as a bearer token.
   */
  z.object({
    type: z.literal('google_service_account'),
    scopes: z.array(z.string().regex(/^https:\/\/www\.googleapis\.com\/auth\/[a-z0-9._-]{1,80}$/)).min(1).max(10),
  }),
  /**
   * Local MCP servers only: the secret is handed to the server process as this
   * environment variable. Unlike the other placements, the server sees the secret.
   */
  z.object({ type: z.literal('env'), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/) }),
]);

/** Connections other than plain HTTPS requests. Each is reviewed and enforced by the broker. */
const emailAddress = /^[^\s@<>",;:\\]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
/** MQTT topic filter: levels separated by "/", "+" for one level, "#" last for the rest. */
const mqttFilter = z
  .string()
  .min(1)
  .max(200)
  .refine((f) => !/[\u0000]/.test(f) && f.split('/').every((l, i, all) => (l.includes('+') ? l === '+' : true) && (l.includes('#') ? l === '#' && i === all.length - 1 : true)), 'invalid MQTT topic filter');
const endpointBase = { id: z.string().regex(identifier), host: manifestHost };

/**
 * A fixed query a database endpoint can run. The code picks it by id and passes values for its
 * ":name" parameters, which are always sent as bound parameters (see sql.ts).
 */
const sqlParamName = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_DB_ROWS = 1000;
const dbQuery = z.object({
  id: z.string().regex(identifier),
  /** "read" queries run in a read-only transaction that is always rolled back. */
  effect: z.enum(['read', 'write']),
  sql: z.string().min(1).max(10_000),
  params: z
    .record(z.string().regex(sqlParamName), z.object({ type: z.enum(['string', 'integer', 'number', 'boolean', 'timestamp']), nullable: z.boolean().optional() }).strict())
    .default({}),
  /** Rows returned at most; the result says when there were more. */
  maxRows: z.number().int().min(1).max(MAX_DB_ROWS).default(100),
});
export type DbQuery = z.infer<typeof dbQuery>;
const dbName = /^[A-Za-z0-9_.$-]{1,128}$/;
const jsonObject = z.record(z.string(), z.unknown());
/** A fixed MongoDB operation (see mongo.ts); values go only where the template has { "$param": "name" }. */
const mongoOperation = z
  .object({
    id: z.string().regex(identifier),
    effect: z.enum(['read', 'write']),
    collection: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/).refine((c) => !c.startsWith('system.'), 'system collections are not allowed'),
    op: z.enum([...MONGO_READ_OPS, ...MONGO_WRITE_OPS]),
    filter: jsonObject.optional(),
    projection: jsonObject.optional(),
    sort: jsonObject.optional(),
    pipeline: z.array(jsonObject).max(20).optional(),
    document: jsonObject.optional(),
    update: jsonObject.optional(),
    upsert: z.boolean().optional(),
    params: z
      .record(z.string().regex(sqlParamName), z.object({ type: z.enum(['string', 'integer', 'number', 'boolean', 'timestamp', 'objectId']), nullable: z.boolean().optional() }).strict())
      .default({}),
    maxRows: z.number().int().min(1).max(MAX_DB_ROWS).default(100),
  })
  .strict()
  .refine((o) => JSON.stringify(o).length <= 20_000, 'operation is too large');
export type MongoOperationDecl = z.infer<typeof mongoOperation>;
const dbEndpoint = <P extends 'postgres' | 'mysql' | 'mssql'>(protocol: P) =>
  z.object({
    ...endpointBase,
    protocol: z.literal(protocol),
    /** The database name, or {{settings.<id>}} (a text setting). */
    database: z.string().refine((d) => dbName.test(d) || settingRef.test(d), 'must be a database name or {{settings.<id>}}'),
    /** TLS with the certificate and host name verified. Plain text only for admin-listed local hosts. */
    tls: z.boolean().default(true),
    /** A CA certificate to trust for this server, as {{settings.<id>}} (a certificate setting), e.g. Supabase's. */
    ca: z.string().regex(settingRef).optional(),
    /** username:password (placement basic). */
    credential: z.string().regex(identifier),
    queries: z.array(dbQuery).min(1).max(30),
  });
export const endpointSchema = z.discriminatedUnion('protocol', [
  z.object({
    ...endpointBase,
    protocol: z.literal('smtp'),
    /** "starttls" (usually port 587) or "implicit" TLS (usually 465). Plain text only for admin-listed local hosts. */
    tls: z.enum(['starttls', 'implicit', 'none']).default('starttls'),
    credential: z.string().regex(identifier).optional(),
    /** The sender, fixed at review: an address or {{settings.<id>}} (a text setting). */
    from: z.string().refine((f) => emailAddress.test(f) || settingRef.test(f), 'must be an email address or {{settings.<id>}}'),
  }),
  z.object({
    ...endpointBase,
    protocol: z.literal('amqp'),
    tls: z.boolean().default(true),
    vhost: z.string().min(1).max(100).default('/'),
    /** The only exchanges messages may be published to. */
    exchanges: z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,127}$/)).min(1).max(20),
    credential: z.string().regex(identifier).optional(),
  }),
  z.object({
    ...endpointBase,
    protocol: z.literal('mqtt'),
    tls: z.boolean().default(true),
    /** The only topics messages may be published to, as MQTT filters. */
    topics: z.array(mqttFilter).min(1).max(20),
    credential: z.string().regex(identifier).optional(),
  }),
  z.object({ ...endpointBase, protocol: z.literal('websocket'), tls: z.boolean().default(true), credential: z.string().regex(identifier).optional() }),
  z.object({ ...endpointBase, protocol: z.literal('sse'), tls: z.boolean().default(true), credential: z.string().regex(identifier).optional() }),
  dbEndpoint('postgres'),
  dbEndpoint('mysql'),
  dbEndpoint('mssql'),
  z.object({
    ...endpointBase,
    protocol: z.literal('mongodb'),
    /** mongodb+srv:// (e.g. Atlas: cluster0.abcde.mongodb.net): the servers come from DNS. */
    srv: z.boolean().default(false),
    database: z.string().refine((d) => /^[A-Za-z0-9_-]{1,64}$/.test(d) || settingRef.test(d), 'must be a database name or {{settings.<id>}}'),
    tls: z.boolean().default(true),
    ca: z.string().regex(settingRef).optional(),
    /** username:password (placement basic). */
    credential: z.string().regex(identifier),
    /** The database the user is defined in. */
    authSource: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('admin'),
    operations: z.array(mongoOperation).min(1).max(30),
  }),
]);
export type Endpoint = z.infer<typeof endpointSchema>;

export const manifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    hosts: z.array(manifestHost).max(10),
    /**
     * Values an admin sets once per organization and the code reads as ctx.settings.<id>.
     * A "host" setting can stand in for a host ("{{settings.<id>}}"): the reviewed pattern bounds
     * what it may be set to, and the default is only used for sandbox tests.
     */
    settings: z
      .array(
        z.discriminatedUnion('type', [
          z.object({
            id: z.string().regex(identifier),
            type: z.literal('host'),
            label: z.string().min(1).max(80),
            /** What it is, in plain words, shown behind an "i" next to the field. */
            help: z.string().max(300).optional(),
            /** A short example value, shown with the help. */
            example: z.string().max(120).optional(),
            pattern: z.string().regex(hostGlob),
            default: z.string().regex(hostPattern),
          }),
          z.object({
            id: z.string().regex(identifier),
            type: z.literal('text'),
            label: z.string().min(1).max(80),
            /** What it is, in plain words, shown behind an "i" next to the field. */
            help: z.string().max(300).optional(),
            /** A short example value, shown with the help. */
            example: z.string().max(120).optional(),
            default: z.string().max(200).optional(),
          }),
          /** A PEM CA certificate an admin pastes, e.g. for a database server signed by its own CA. */
          z.object({
            id: z.string().regex(identifier),
            type: z.literal('certificate'),
            label: z.string().min(1).max(80),
            /** What it is, in plain words, shown behind an "i" next to the field. */
            help: z.string().max(300).optional(),
            /** A short example value, shown with the help. */
            example: z.string().max(120).optional(),
          }),
        ]),
      )
      .max(10)
      .default([]),
    credentials: z
      .array(
        z.object({
          id: z.string().regex(identifier),
          service: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
          label: z.string().min(1).max(80),
          /** The credential is attached only to requests for these hosts. */
          hosts: z.array(manifestHost).min(1),
          placement: credentialPlacement,
          /**
           * The action also works without it (public data). The member's secret is
           * attached when they have stored one (higher limits, private data); a run
           * never stops for a missing optional credential.
           */
          optional: z.boolean().optional(),
          /**
           * The token scopes the module needs (as the service names them, e.g. GitLab "api",
           * GitHub "repo"). Stored tokens are compared against them: broader tokens are flagged.
           */
          scopes: z.array(z.string().regex(/^[a-z0-9_:.-]{1,60}$/i)).max(20).optional(),
        }),
      )
      .max(5),
    /**
     * "read": besides its declared hosts, the module may READ any public website: https GET
     * and HEAD only, no credentials, no request body, a few plain headers, and private
     * addresses refused. For modules that take links from anywhere (analyse this article).
     */
    publicWeb: z.literal('read').optional(),
    /**
     * A headless browser the code drives through ctx.page (browser scripts). It may load
     * only these sites: exact host[:port], "*.example.com" for subdomains, or a host setting.
     * Everything else the page asks for is blocked.
     */
    browser: z
      .object({
        hosts: z
          .array(z.string().refine((h) => hostPattern.test(h) || (hostGlob.test(h) && !h.startsWith('**.')) || hostPlaceholder.test(h), 'must be host[:port], *.domain or {{settings.<id>}}'))
          .min(1)
          .max(20),
      })
      .optional(),
    /** SMTP, AMQP, MQTT, WebSocket, SSE and database connections (see endpointSchema). */
    endpoints: z.array(endpointSchema).max(10).default([]),
    actions: z
      .array(
        z.object({
          name: z.string().regex(identifier),
          title: z.string().min(1).max(80),
          description: z.string().min(1).max(300),
          /** 'write' actions change data in the target app; they are never retried when the outcome is uncertain. */
          effect: z.enum(['read', 'write']),
          /**
           * For write actions: repeating it with the same input changes nothing more than the first call and answers the
           * same (it finds what an earlier call made and returns that). When its answer is lost, Dittoly repeats it instead
           * of stopping with uncertain_outcome. Reviewed with the module.
           */
          idempotent: z.boolean().optional(),
          credentials: z.array(z.string().regex(identifier)).max(5),
          input: jsonSchema,
          output: jsonSchema,
          /**
           * For write actions: the action of this module that reverses it, and its input, built from
           * what this action sent and got back ({{ input.x }}, {{ output.y }}). Reviewed with the module.
           */
          undo: z
            .object({ action: z.string().regex(identifier), input: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.unknown()) })
            .strict()
            .optional(),
        }),
      )
      .min(1)
      .max(30),
  })
  .superRefine((m, ctx) => {
    const hosts = new Set(m.hosts);
    const settingIds = new Set<string>();
    for (const st of m.settings) {
      if (settingIds.has(st.id)) ctx.addIssue({ code: 'custom', message: `duplicate setting ${st.id}` });
      settingIds.add(st.id);
      if (st.type === 'host' && !hostMatches(st.pattern, st.default)) {
        ctx.addIssue({ code: 'custom', message: `setting ${st.id} default ${st.default} does not match ${st.pattern}` });
      }
    }
    for (const h of [...m.hosts, ...m.endpoints.map((e) => e.host), ...m.credentials.flatMap((c) => c.hosts), ...(m.browser?.hosts ?? [])]) {
      const ref = hostPlaceholder.exec(h)?.[1];
      if (ref && m.settings.find((st) => st.id === ref)?.type !== 'host') {
        ctx.addIssue({ code: 'custom', message: `host ${h} needs a declared host setting "${ref}"` });
      }
    }
    for (const e of m.endpoints) hosts.add(e.host);
    // A credential may be typed into a browser page on one of the browser's hosts.
    for (const h of m.browser?.hosts ?? []) hosts.add(h);
    const credIds = new Set<string>();
    for (const c of m.credentials) {
      if (credIds.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate credential ${c.id}` });
      credIds.add(c.id);
      for (const h of c.hosts) {
        if (!hosts.has(h)) ctx.addIssue({ code: 'custom', message: `credential ${c.id} host ${h} is not declared` });
      }
    }
    const endpointIds = new Set<string>();
    for (const e of m.endpoints) {
      if (endpointIds.has(e.id)) ctx.addIssue({ code: 'custom', message: `duplicate endpoint ${e.id}` });
      endpointIds.add(e.id);
      if (e.credential) {
        const c = m.credentials.find((x) => x.id === e.credential);
        if (!c) ctx.addIssue({ code: 'custom', message: `endpoint ${e.id} uses undeclared credential ${e.credential}` });
        else {
          if (!c.hosts.includes(e.host)) ctx.addIssue({ code: 'custom', message: `credential ${c.id} is not meant for endpoint ${e.id} host ${e.host}` });
          const login = e.protocol === 'smtp' || e.protocol === 'amqp' || e.protocol === 'mqtt' || isDatabase(e);
          if (login && c.placement.type !== 'basic') ctx.addIssue({ code: 'custom', message: `endpoint ${e.id} (${e.protocol}) needs a "basic" (username:password) credential` });
          if (!login && (c.placement.type === 'env' || c.placement.type === 'google_service_account')) ctx.addIssue({ code: 'custom', message: `endpoint ${e.id} cannot use a ${c.placement.type} credential` });
        }
      }
      if (e.protocol === 'smtp') {
        const ref = settingRef.exec(e.from)?.[1];
        if (ref && m.settings.find((st) => st.id === ref)?.type !== 'text') ctx.addIssue({ code: 'custom', message: `endpoint ${e.id} from needs a declared text setting "${ref}"` });
      }
      if (isDatabase(e)) {
        const db = settingRef.exec(e.database)?.[1];
        if (db && m.settings.find((st) => st.id === db)?.type !== 'text') ctx.addIssue({ code: 'custom', message: `endpoint ${e.id} database needs a declared text setting "${db}"` });
        const ca = e.ca ? settingRef.exec(e.ca)?.[1] : undefined;
        if (ca && m.settings.find((st) => st.id === ca)?.type !== 'certificate') ctx.addIssue({ code: 'custom', message: `endpoint ${e.id} ca needs a declared certificate setting "${ca}"` });
        if (e.protocol === 'mongodb' && e.srv && /:\d+$/.test(e.host)) ctx.addIssue({ code: 'custom', message: `endpoint ${e.id}: an srv host has no port` });
        const queryIds = new Set<string>();
        if (e.protocol === 'mongodb') {
          for (const o of e.operations) {
            if (queryIds.has(o.id)) ctx.addIssue({ code: 'custom', message: `endpoint ${e.id} has duplicate operation ${o.id}` });
            queryIds.add(o.id);
            const r = checkMongoOperation(o);
            for (const p of r.problems) ctx.addIssue({ code: 'custom', message: `operation ${o.id}: ${p}` });
            const used = new Set(r.params);
            for (const p of used) if (!(p in o.params)) ctx.addIssue({ code: 'custom', message: `operation ${o.id}: parameter ${p} is not declared in params` });
            for (const p of Object.keys(o.params)) if (!used.has(p)) ctx.addIssue({ code: 'custom', message: `operation ${o.id}: param ${p} is not used` });
          }
        }
        for (const q of isDbEndpoint(e) ? e.queries : []) {
          if (queryIds.has(q.id)) ctx.addIssue({ code: 'custom', message: `endpoint ${e.id} has duplicate query ${q.id}` });
          queryIds.add(q.id);
          const r = checkSql(q.sql, e.protocol as Dialect, q.effect);
          for (const p of r.problems) ctx.addIssue({ code: 'custom', path: ['endpoints', e.id, 'queries', q.id], message: `query ${q.id}: ${p}` });
          const used = new Set(r.params);
          for (const p of used) if (!(p in q.params)) ctx.addIssue({ code: 'custom', message: `query ${q.id}: parameter :${p} is not declared in params` });
          for (const p of Object.keys(q.params)) if (!used.has(p)) ctx.addIssue({ code: 'custom', message: `query ${q.id}: param ${p} is not used in the SQL` });
        }
      }
    }
    const names = new Set<string>();
    for (const a of m.actions) {
      if (names.has(a.name)) ctx.addIssue({ code: 'custom', message: `duplicate action ${a.name}` });
      names.add(a.name);
      for (const c of a.credentials) {
        if (!credIds.has(c)) ctx.addIssue({ code: 'custom', message: `action ${a.name} uses undeclared credential ${c}` });
      }
      if (a.idempotent && a.effect !== 'write') ctx.addIssue({ code: 'custom', message: `action ${a.name}: only write actions are marked idempotent` });
      if (a.undo) for (const issue of undoIssues(a, m.actions)) ctx.addIssue({ code: 'custom', message: `action ${a.name} undo: ${issue}` });
    }
  });

const undoInputs = (input: Record<string, unknown>) =>
  Object.keys(input).sort().map((k) => `${k} = ${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`).join(', ');

/** An undo names another write action of the module and fills only its inputs, from this action's input and output. */
function undoIssues(a: { name: string; effect: string; undo?: { action: string; input: Record<string, unknown> } }, actions: { name: string; effect: string; input: Record<string, unknown> }[]): string[] {
  const out: string[] = [];
  const u = a.undo!;
  if (a.effect !== 'write') out.push('only write actions can be undone');
  const target = actions.find((x) => x.name === u.action);
  if (!target) return [...out, `no action ${u.action}`];
  if (target.name === a.name) out.push('an action cannot undo itself');
  if (target.effect !== 'write') out.push(`${u.action} must be a write action`);
  const props = (target.input as { properties?: Record<string, unknown> }).properties;
  if (props) for (const k of Object.keys(u.input)) if (!Object.hasOwn(props, k)) out.push(`${u.action} has no input ${k}`);
  for (const m of JSON.stringify(u.input).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (!/^(input|output)(\.[A-Za-z0-9_]+)*$/.test(m[1]!)) out.push(`{{ ${m[1]} }}: use only {{ input.<field> }} and {{ output.<field> }}`);
  }
  return out;
}

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestAction = Manifest['actions'][number];
export type ManifestCredential = Manifest['credentials'][number];
export type ManifestSetting = Manifest['settings'][number];

// What this schema accepts is what the runtime (src/runtime) is written for.
const sameShape: [Manifest] extends [Runtime.Manifest] ? true : never = true;
void sameShape;

const PEM = /^(-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/;
export const isCertificate = (v: string) => v.length <= 20_000 && PEM.test(v.trim() + '\n');

/** Check values an admin wants to set against the settings a manifest declares. */
export function checkSettingValues(m: Manifest, values: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [id, v] of Object.entries(values)) {
    const st = (m.settings ?? []).find((x) => x.id === id);
    if (!st) problems.push(`${id}: not a setting of this module`);
    else if (st.type === 'host' && !hostMatches(st.pattern, v)) problems.push(`${id}: ${v} does not match ${st.pattern}`);
    else if (st.type === 'text' && v.length > 200) problems.push(`${id}: longer than 200 characters`);
    else if (st.type === 'certificate' && !isCertificate(v)) problems.push(`${id}: must be one or more PEM certificates (-----BEGIN CERTIFICATE-----), at most 20 KB`);
  }
  return problems;
}

export function parseManifest(value: unknown): { ok: true; manifest: Manifest } | { ok: false; issues: string[] } {
  // Modules keep no data: what must last between runs, the Flow keeps with table steps and passes in as input.
  if (value && typeof value === 'object' && 'tables' in value) {
    return { ok: false, issues: ['tables: a module keeps no data; take what it needs as action input, and let the Flow keep what must last (table steps)'] };
  }
  const r = manifestSchema.safeParse(value);
  if (r.success) return { ok: true, manifest: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

export function compileSchemas(manifest: Manifest): string[] {
  const issues: string[] = [];
  for (const a of manifest.actions) {
    for (const [kind, schema] of [
      ['input', a.input],
      ['output', a.output],
    ] as const) {
      try {
        ajv.compile(schema);
      } catch (err) {
        // The reason, for the AI to fix it: most often a `pattern` RE2 cannot read (lookarounds, backreferences).
        const why = (err as Error).message?.slice(0, 200) ?? '';
        issues.push(`actions.${a.name}.${kind}: not a valid JSON Schema${why ? ` (${why})` : ''}. Patterns are checked with RE2: no lookahead, lookbehind or backreferences; write a code point as \\x{0041}.`);
      }
    }
  }
  return issues;
}


function endpointSentence(e: Endpoint, m: Manifest): string {
  // A setting placeholder stands for a host:port an admin sets, so no default port is added to it.
  const where = e.host.includes(':') || settingRef.test(e.host) ? e.host : `${e.host}:${endpointPort(e)}`;
  const tls = e.protocol === 'smtp' ? (e.tls === 'none' ? 'WITHOUT encryption' : `over TLS (${e.tls})`) : e.tls ? 'over TLS' : 'WITHOUT encryption';
  const cred = e.credential ? `, signing in with the running member's own "${m.credentials.find((c) => c.id === e.credential)?.label ?? e.credential}"` : '';
  switch (e.protocol) {
    case 'smtp':
      return `It can SEND EMAIL through the SMTP server ${where} ${tls}${cred}, always from ${e.from}, to recipients chosen when it runs.`;
    case 'amqp':
      return `It can PUBLISH messages over AMQP to ${where} (vhost ${e.vhost}) ${tls}${cred}, only to the exchanges: ${e.exchanges.join(', ')}.`;
    case 'mqtt':
      return `It can PUBLISH messages over MQTT to ${where} ${tls}${cred}, only to topics matching: ${e.topics.join(', ')}.`;
    case 'websocket':
      return `It can open WebSocket sessions to ${where} ${tls}${cred}, send messages and read the replies, for a limited time.`;
    case 'sse':
      return `It can read Server-Sent Event streams from ${where} ${tls}${cred}, for a limited time.`;
    case 'mongodb': {
      const ca = e.ca ? `, trusting the CA certificate in ${e.ca}` : '';
      const at = e.srv ? `the ${e.host} deployment (mongodb+srv; its servers must be in the same domain)` : where;
      const lines = [`It can run ONLY these ${e.operations.length} fixed operations on the MongoDB database "${e.database}" at ${at} ${tls}${ca}${cred}. Values are only placed where a template says { "$param": ... }, and only as single values:`];
      for (const o of e.operations) {
        const params = Object.entries(o.params).map(([k, p]) => `${k} ${p.type}${p.nullable ? ' or null' : ''}`).join(', ');
        const body = { filter: o.filter, projection: o.projection, sort: o.sort, pipeline: o.pipeline, document: o.document, update: o.update, upsert: o.upsert };
        const shown = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
        lines.push(`  - ${o.id} (${o.effect === 'write' ? 'CHANGES data' : 'reads'}, up to ${o.maxRows} documents${params ? `; ${params}` : ''}): ${o.collection}.${o.op}(${shown})`);
      }
      return lines.join('\n');
    }
    case 'postgres':
    case 'mysql':
    case 'mssql': {
      const kind = { postgres: 'PostgreSQL', mysql: 'MySQL/MariaDB', mssql: 'SQL Server' }[e.protocol];
      const ca = e.ca ? `, trusting the CA certificate in ${e.ca}` : '';
      const lines = [`It can run ONLY these ${e.queries.length} fixed queries on the ${kind} database "${e.database}" at ${where} ${tls}${ca}${cred}. Values are always sent as bound parameters, never pasted into the SQL:`];
      for (const q of e.queries) {
        const params = Object.entries(q.params).map(([k, p]) => `:${k} ${p.type}${p.nullable ? ' or null' : ''}`).join(', ');
        lines.push(`  - ${q.id} (${q.effect === 'write' ? 'CHANGES data' : 'reads, in a read-only transaction'}, up to ${q.maxRows} rows${params ? `; ${params}` : ''}): ${q.sql.replace(/\s+/g, ' ').trim()}`);
      }
      return lines.join('\n');
    }
  }
}

/** The plain-language summary an admin reviews instead of code. */
export function reviewSummary(m: Manifest): string {
  const lines: string[] = [];
  lines.push(`${m.title} (${m.name} ${m.version})`);
  lines.push(m.description);
  lines.push('');
  const endpoints = m.endpoints ?? [];
  lines.push(
    m.hosts.length
      ? `It can only connect to: ${m.hosts.join(', ')}.`
      : endpoints.length
        ? 'It makes no plain HTTPS requests.'
        : 'It cannot connect to any host.',
  );
  for (const st of m.settings ?? []) {
    lines.push(
      st.type === 'host'
        ? `{{settings.${st.id}}} is "${st.label}", given by each Flow that uses this module; it can only be a host matching ${st.pattern}.`
        : st.type === 'certificate'
          ? `Setting "${st.label}" (${st.id}) is a CA certificate the Flow gives it.`
          : `Setting "${st.label}" (${st.id}) is given by the Flow and passed to the code.`,
    );
  }
  if (m.credentials.length === 0) {
    lines.push('It uses no credentials.');
  } else {
    for (const c of m.credentials) {
      lines.push(
        c.placement.type === 'env'
          ? `It is given the running member's own "${c.label}" (service "${c.service}") as the environment variable ${c.placement.name}. ` +
              `The server program CAN read this secret; its network traffic can only reach ${c.hosts.join(', ') || 'no host'}.`
          : c.placement.type === 'google_service_account'
            ? `It uses the running member's own Google service account key "${c.label}" (service "${c.service}"). Dittoly keeps the key and sends only short-lived access tokens, ` +
              `limited to ${c.placement.scopes.map((x) => x.replace('https://www.googleapis.com/auth/', '')).join(', ')}, and only to ${c.hosts.join(', ')}. The module code never sees the key or the tokens.` +
              (c.optional ? ' It is OPTIONAL: without it the module works with public data only.' : '')
          : `It uses the running member's own "${c.label}" (service "${c.service}"), sent only to ${c.hosts.join(', ')}. ` +
              'The module code never sees the secret; the runtime attaches it.' +
              (c.optional ? ' It is OPTIONAL: without it the module works with public data only.' : ''),
      );
    }
  }
  if (m.publicWeb === 'read') {
    lines.push(
      'It may also READ ANY PUBLIC WEBSITE: download pages and files over https (GET only), with no credentials, ' +
        'no request body and no form submissions; internal and private network addresses stay blocked. ' +
        'The web address itself can still carry a little data (e.g. ?q=...), at most 2,048 characters.',
    );
  }
  for (const e of endpoints) lines.push(endpointSentence(e, m));
  if (m.browser) {
    lines.push(
      `It drives a headless BROWSER that may load pages only from: ${m.browser.hosts.join(', ')}; anything else the pages ask for is blocked. ` +
        'It can click, type, read page text and take screenshots there. It cannot run its own JavaScript in the page, save files or upload them.',
    );
    for (const c of m.credentials.filter((c) => c.hosts.some((h) => m.browser!.hosts.includes(h)))) {
      lines.push(`It can type the running member's own "${c.label}" into pages on ${c.hosts.filter((h) => m.browser!.hosts.includes(h)).join(', ')}; the code never sees it.`);
    }
  }
  lines.push('It cannot read or write files or start other programs.');
  lines.push('');
  lines.push('Actions:');
  for (const a of m.actions) {
    const effect = a.effect === 'write' ? 'CHANGES data' : 'reads data';
    const undo = a.effect !== 'write' ? '' : a.undo ? ` It can be undone with ${a.undo.action} (${undoInputs(a.undo.input)}).` : ' It cannot be undone by Dittoly.';
    const repeat = a.idempotent ? ' The module says repeating it changes nothing more, so Dittoly repeats it when its answer is lost.' : '';
    lines.push(`- ${a.title} (${a.name}): ${effect}. ${a.description}${undo}${repeat}`);
  }
  return lines.join('\n');
}

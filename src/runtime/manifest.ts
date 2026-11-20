import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { RegExpEngine } from 'ajv/dist/types/index.js';
import { RE2JS } from 're2js';
import { canonicalJson, sha256Hex } from './crypto.js';
import type { Endpoint, Manifest, ManifestCredential } from './types.js';

/** Reading a reviewed manifest at run time: hosts from settings, credentials per action, schemas. */

export const hostPattern = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
/** A host that an admin sets per organization, e.g. "{{settings.site}}" for the organization's own Jira site. */
export const hostPlaceholder = /^\{\{settings\.([a-z][a-z0-9_]{0,63})\}\}$/;
export const settingRef = /^\{\{settings\.([a-z][a-z0-9_]{0,63})\}\}$/;
/** Whether a host setting value is allowed by the pattern the manifest declares (reviewed by an admin). */
export function hostMatches(pattern: string, host: string): boolean {
  if (!hostPattern.test(host)) return false;
  if (!pattern.startsWith('*.') && !pattern.startsWith('**.')) return host === pattern;
  const deep = pattern.startsWith('**.');
  const suffix = pattern.slice(deep ? 2 : 1); // ".atlassian.net"
  const label = host.slice(0, -suffix.length);
  const one = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  return host.endsWith(suffix) && (deep ? label.split('.').every((l) => one.test(l)) : one.test(label));
}

export type DbEndpoint = Extract<Endpoint, { protocol: 'postgres' | 'mysql' | 'mssql' }>;
export type MongoEndpoint = Extract<Endpoint, { protocol: 'mongodb' }>;
export const isDbEndpoint = (e: Endpoint): e is DbEndpoint => e.protocol === 'postgres' || e.protocol === 'mysql' || e.protocol === 'mssql';
/** SQL or MongoDB: endpoints whose calls are ctx.db.query. */
export const isDatabase = (e: Endpoint): e is DbEndpoint | MongoEndpoint => isDbEndpoint(e) || e.protocol === 'mongodb';

/** Default port of an endpoint when its host names none. */
export function endpointPort(e: Endpoint): number {
  const explicit = /:(\d{1,5})$/.exec(e.host)?.[1];
  if (explicit) return Number(explicit);
  switch (e.protocol) {
    case 'smtp':
      return e.tls === 'implicit' ? 465 : e.tls === 'starttls' ? 587 : 25;
    case 'amqp':
      return e.tls ? 5671 : 5672;
    case 'mqtt':
      return e.tls ? 8883 : 1883;
    case 'postgres':
      return 5432;
    case 'mysql':
      return 3306;
    case 'mssql':
      return 1433;
    case 'mongodb':
      return 27017;
    default:
      return e.tls ? 443 : 80;
  }
}

/** Whether a concrete MQTT topic matches a filter. */
export function mqttTopicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/**
 * Substitute setting values into the manifest's hosts. `values` are what an admin
 * set; with `useDefaults` (sandbox tests only) missing values fall back to defaults.
 * Returns the settings the code sees, and the host settings that have no value.
 */
export function resolveManifest<M extends Manifest>(
  m: M,
  values: Record<string, string>,
  opts: { useDefaults?: boolean } = {},
): { manifest: M; settings: Record<string, string>; missing: string[] } {
  const settings: Record<string, string> = {};
  const missing: string[] = [];
  for (const st of m.settings ?? []) {
    const v = values[st.id];
    if (v !== undefined && (st.type !== 'host' || hostMatches(st.pattern, v))) settings[st.id] = v;
    else if (st.type !== 'certificate' && st.default !== undefined && (st.type === 'text' || opts.useDefaults)) settings[st.id] = st.default;
    else if (st.type === 'host') missing.push(st.id);
  }
  const sub = (h: string) => {
    const ref = hostPlaceholder.exec(h)?.[1];
    return ref ? (settings[ref] ?? h) : h;
  };
  const manifest = {
    ...m,
    hosts: [...new Set(m.hosts.map(sub))],
    credentials: m.credentials.map((c) => ({ ...c, hosts: [...new Set(c.hosts.map(sub))] })),
    ...(m.browser ? { browser: { hosts: [...new Set(m.browser.hosts.map(sub))] } } : {}),
    endpoints: (m.endpoints ?? []).map((e) => {
      const host = sub(e.host);
      const text = (v: string) => {
        const ref = settingRef.exec(v)?.[1];
        return ref ? (settings[ref] ?? v) : v;
      };
      if (e.protocol === 'smtp') return { ...e, host, from: text(e.from) };
      if (isDatabase(e)) {
        // The CA certificate itself replaces its setting; without one the system's CAs are used.
        const ca = e.ca ? settings[settingRef.exec(e.ca)![1]!] : undefined;
        return { ...e, host, database: text(e.database), ca };
      }
      return { ...e, host };
    }),
  } as M;
  return { manifest, settings, missing };
}

/**
 * Schemas come from modules, forms and webhook configuration, and the data
 * they check often comes from outside. So:
 * - `pattern` runs on RE2 (linear time), so no input can stall the server
 *   (a pattern RE2 cannot express, such as a lookahead, makes the schema invalid);
 * - a schema's `$id` is never registered, so one schema cannot claim or break another's;
 * - compiled validators are cached by content, with a bound, instead of per object.
 */
const re2: RegExpEngine = Object.assign((pattern: string) => RE2JS.compile(pattern), { code: 'RE2JS.compile' });
const options = { allErrors: true, strict: false, addUsedSchema: false, code: { regExp: re2 } };
const draft07 = new Ajv(options);
const draft2020 = new Ajv2020(options);

/** Draft-07 by default; JSON Schema 2020-12 (what Zod v4 and MCP tools emit) when a schema declares it. */
function pick(schema: unknown) {
  const dialect = (schema as { $schema?: unknown } | null)?.$schema;
  return typeof dialect === 'string' && /2020-12|2019-09/.test(dialect) ? draft2020 : draft07;
}

const CACHE_MAX = 1000;
const compiled = new Map<string, ValidateFunction>();

function compile(schema: object): ValidateFunction {
  const key = sha256Hex(canonicalJson(schema));
  const hit = compiled.get(key);
  if (hit) {
    compiled.delete(key);
    compiled.set(key, hit);
    return hit;
  }
  const instance = pick(schema);
  try {
    const fn = instance.compile(schema);
    compiled.set(key, fn);
    if (compiled.size > CACHE_MAX) compiled.delete(compiled.keys().next().value!);
    return fn;
  } finally {
    // Ajv also caches by object identity; schemas parsed from the database are new objects every time.
    instance.removeSchema(schema);
  }
}

export const ajv = {
  compile,
  validate: (schema: unknown, data: unknown): boolean => compile(schema as object)(data) as boolean,
  /**
   * Why data does not match, one short line per problem ("repo: must match pattern ..."), or [] when it does.
   * Lines name the field and the rule, never the value, so they are safe to show and log. `what` is whose shape
   * this is, for the one line that has to say it ("this Flow", "this action", "the answer"): a step's input
   * refused by its action is not a Flow input, and a message that says so sends a person to the wrong page.
   */
  explain(schema: unknown, data: unknown, what = 'this Flow'): string[] {
    const fn = compile(schema as object);
    if (fn(data)) return [];
    const lines = (fn.errors ?? []).map((e) => {
      const path = e.instancePath ? `${e.instancePath.slice(1).replaceAll('/', '.')}.` : '';
      const field = e.instancePath ? e.instancePath.slice(1).replaceAll('/', '.') : (e.params as { missingProperty?: string }).missingProperty ?? 'input';
      // The path matters most where it is deepest: "files.0.action", not a bare "action" that could be anywhere.
      if (e.keyword === 'required') return `${path}${(e.params as { missingProperty: string }).missingProperty}: is required`;
      if (e.keyword === 'additionalProperties') return `${path}${(e.params as { additionalProperty: string }).additionalProperty}: is not an input of ${what}`;
      if (e.keyword === 'enum') return `${field}: must be one of ${((e.params as { allowedValues: unknown[] }).allowedValues ?? []).map(String).join(', ')}`;
      return `${field}: ${e.message ?? 'is not valid'}`;
    });
    return [...new Set(lines)].slice(0, 10);
  },
};

function actionCredentials(manifest: Manifest, actionName: string): ManifestCredential[] {
  const action = manifest.actions.find((a) => a.name === actionName);
  return (action?.credentials ?? []).map((id) => manifest.credentials.find((c) => c.id === id)!);
}

/** Services a run needs credentials for to run one action (optional ones excluded). */
export function servicesFor(manifest: Manifest, actionName: string): string[] {
  return [...new Set(actionCredentials(manifest, actionName).filter((c) => !c.optional).map((c) => c.service))];
}

/** Services an action uses when they are set, and works without. */
export function optionalServicesFor(manifest: Manifest, actionName: string): string[] {
  const required = new Set(servicesFor(manifest, actionName));
  return [...new Set(actionCredentials(manifest, actionName).filter((c) => c.optional && !required.has(c.service)).map((c) => c.service))];
}

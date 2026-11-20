import { z } from 'zod';
import { kindsUsed, ownCode } from './module-base.js';

/**
 * A module's config: what each action is and does, in a form people and the next AI read at a glance. It describes
 * the module; it does not run it (the module's TypeScript does, on the Dittoly base, src/modules/module-base.ts).
 * The AI writes it with the code; Dittoly checks it against the manifest and the code, keeps it with the version,
 * shows it in MODULE.md and on review, and gives it to the AI that revises the module or builds a Flow with it.
 */

export const KINDS = ['http', 'db', 'smtp', 'amqp', 'mqtt', 'ws', 'sse', 'browser', 'code'] as const;
export type Kind = (typeof KINDS)[number];

const actionConfig = z
  .object({
    /** The kind of call it makes; "code" for logic only (no call), "browser" for a browser script. */
    kind: z.enum(KINDS),
    /** The call in a few words: "GET /repos/{owner}/{repo}/issues", "query find_order", "publish to packing/{station}/commands". */
    call: z.string().trim().min(1).max(200),
    /** For db, smtp, amqp, mqtt, ws and sse: the manifest endpoint it uses. */
    endpoint: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    /** For db: the declared query (SQL) or operation (MongoDB) id. */
    query: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    /** Follows pages (a listing). */
    pages: z.boolean().optional(),
    /** Where it differs from the base's usual behaviour (own error mapping, parsing, several calls), in a sentence. */
    custom: z.string().trim().max(300).optional(),
  })
  .strict();

export const moduleConfigSchema = z
  .object({
    /** For http actions: the API's base URL as the code uses it, e.g. "https://api.github.com". */
    baseUrl: z.string().max(300).optional(),
    actions: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), actionConfig).refine((a) => Object.keys(a).length >= 1 && Object.keys(a).length <= 30, 'one to 30 actions'),
  })
  .strict();

export type ModuleConfig = z.infer<typeof moduleConfigSchema>;
export type ConfigAction = ModuleConfig['actions'][string];

/** The endpoint protocols each kind runs on. */
const PROTOCOLS: Partial<Record<Kind, string[]>> = {
  db: ['postgres', 'mysql', 'mssql', 'mongodb'],
  smtp: ['smtp'],
  amqp: ['amqp'],
  mqtt: ['mqtt'],
  ws: ['websocket'],
  sse: ['sse'],
};

interface ManifestShape {
  actions?: { name?: string; effect?: string }[];
  hosts?: string[];
  publicWeb?: string;
  browser?: unknown;
  endpoints?: { id?: string; protocol?: string; queries?: { id?: string; effect?: string }[]; operations?: { id?: string; effect?: string }[] }[];
}

/**
 * The config, checked against the manifest and, when given, the module's code: the problems in plain words, for the
 * AI to fix. It must say what the module really does: every action, the endpoints and queries the manifest declares,
 * and kinds the code really calls.
 */
export function checkModuleConfig(value: unknown, manifest: unknown, source?: string): { config: ModuleConfig } | { issues: string[] } {
  const parsed = moduleConfigSchema.safeParse(value);
  if (!parsed.success) return { issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'config'}: ${i.message}`) };
  const config = parsed.data;
  const issues: string[] = [];
  const m = (manifest && typeof manifest === 'object' ? manifest : {}) as ManifestShape;
  const declared = new Set((m.actions ?? []).map((a) => a.name));
  const endpoints = new Map((m.endpoints ?? []).map((e) => [e.id, e]));
  for (const name of declared) if (name && !(name in config.actions)) issues.push(`actions.${name}: the manifest declares it but the config does not describe it`);
  for (const [name, a] of Object.entries(config.actions)) {
    const at = `actions.${name}`;
    if (!declared.has(name)) issues.push(`${at}: not an action of the manifest`);
    const effect = (m.actions ?? []).find((x) => x.name === name)?.effect;
    const protocols = PROTOCOLS[a.kind];
    if (protocols) {
      const e = a.endpoint ? endpoints.get(a.endpoint) : undefined;
      if (!a.endpoint) issues.push(`${at}.endpoint: a ${a.kind} action names the manifest endpoint it uses`);
      else if (!e) issues.push(`${at}.endpoint: "${a.endpoint}" is not an endpoint of the manifest`);
      else if (!protocols.includes(e.protocol ?? '')) issues.push(`${at}.endpoint: "${a.endpoint}" is ${e.protocol}; a ${a.kind} action needs ${protocols.join(' or ')}`);
      if (a.kind === 'db' && e) {
        const q = [...(e.queries ?? []), ...(e.operations ?? [])].find((x) => x.id === a.query);
        if (!a.query) issues.push(`${at}.query: a db action names the declared query it runs`);
        else if (!q) issues.push(`${at}.query: "${a.query}" is not a query of endpoint "${a.endpoint}"`);
        else if (q.effect === 'write' && effect === 'read') issues.push(`${at}.query: "${a.query}" writes, but the action is a "read"`);
      }
    }
    if ((a.kind === 'smtp' || a.kind === 'amqp' || a.kind === 'mqtt') && effect === 'read') issues.push(`${at}: ${a.kind} sends or publishes, so the action's effect must be "write"`);
    if (a.kind === 'http' && !(m.hosts ?? []).length && m.publicWeb !== 'read') issues.push(`${at}: an http action needs the manifest's "hosts"`);
    if (a.kind === 'browser' && !m.browser) issues.push(`${at}: a browser action needs the manifest's "browser" section`);
  }
  // The config says what the code does: a kind it names that the code never calls through the base is checked.
  if (source !== undefined) {
    // The module's own code only: the base above it has every kind in it.
    const own = ownCode(source);
    const used = new Set(kindsUsed(source));
    for (const [name, a] of Object.entries(config.actions)) {
      if (PROTOCOLS[a.kind] || a.kind === 'http') {
        if (!used.has(a.kind) && !new RegExp(`ctx\\.(${a.kind === 'smtp' ? 'smtp' : a.kind === 'http' ? 'http' : a.kind})\\b`).test(own)) {
          issues.push(`actions.${name}: the config says ${a.kind}, but the code makes no ${a.kind} call`);
        }
      }
    }
  }
  return issues.length ? { issues } : { config };
}

/** What an action does, in a few words, for MODULE.md and reviewers. */
export function describeConfigAction(a: ConfigAction): string {
  const where = a.endpoint ? ` on ${a.endpoint}` : '';
  return `${a.kind}: ${a.call}${where}${a.pages ? ', follows pages' : ''}${a.custom ? `. ${a.custom}` : ''}`;
}

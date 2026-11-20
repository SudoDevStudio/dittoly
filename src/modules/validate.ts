import { z } from 'zod';
import { Broker, type FetchLike } from '../sandbox/broker.js';
import type { BrowserLauncher } from '../sandbox/browser.js';
import { TransportError, type Transports } from '../runtime/protocols.js';
import type { SandboxRunner } from '../sandbox/runner.js';
import { activityReporter } from '../core/progress.js';
import { ajv, compileSchemas, parseManifest, resolveManifest, type Manifest } from './manifest.js';

/** A schema that does not compile (its own check says why) fails the test instead of stopping the whole check. */
function safeValidate(schema: object, data: unknown): boolean {
  try {
    return ajv.validate(schema, data);
  } catch {
    return false;
  }
}

/**
 * Sandbox tests shipped with a generated module. Each test runs one action in
 * the real sandbox with the real broker policy, but the network is replaced by
 * canned responses, and a dummy credential is used.
 */
export const moduleTestSchema = z.object({
  name: z.string().min(1).max(80),
  action: z.string(),
  input: z.unknown(),
  http: z
    .array(
      z.object({
        method: z.string().default('GET'),
        /** Matches when the request URL starts with this prefix. */
        urlPrefix: z.string().url(),
        status: z.number().int().default(200),
        json: z.unknown().optional(),
        /** A body that is not JSON (an XML or RSS/Atom feed, HTML, CSV, plain text), returned as is. */
        body: z.string().max(200_000).optional(),
        /** With body: its content type (default text/plain). */
        contentType: z.string().max(100).optional(),
      }).refine((h) => h.json === undefined || h.body === undefined, { message: 'a canned answer has json or body, not both' }),
    )
    .max(20)
    .default([]),
  /**
   * Canned answers for SMTP, AMQP, MQTT, WebSocket, SSE and database calls, used in order per
   * protocol (database answers can name the query they answer). Without one, sends and publishes
   * succeed, streams return nothing and queries return no rows.
   */
  calls: z
    .array(
      z.object({
        protocol: z.enum(['smtp', 'amqp', 'mqtt', 'websocket', 'sse', 'postgres', 'mysql', 'mssql', 'mongodb']),
        /** Databases: the query (or MongoDB operation) id this answers (any of the protocol when left out). */
        query: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
        /** Databases: the rows (or documents) returned, made-up values, and for writes the number changed. */
        rows: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
        rowCount: z.number().int().min(0).optional(),
        /** websocket: messages received; sse: events received. */
        messages: z.array(z.string()).max(100).optional(),
        events: z.array(z.object({ event: z.string().default('message'), data: z.string(), id: z.string().optional() })).max(100).optional(),
        /** smtp: addresses the server refused. */
        rejected: z.array(z.string()).max(50).optional(),
        /** Make the call fail with this error code. */
        error: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
      }),
    )
    .max(20)
    .default([]),
  expectOk: z.boolean().default(true),
  /**
   * Browser scripts: the pages the browser is answered with, by URL prefix. Nothing else
   * loads (no network at all), so tests are repeatable.
   */
  pages: z
    .array(
      z.object({
        urlPrefix: z.string().url(),
        status: z.number().int().default(200),
        contentType: z.string().max(100).default('text/html; charset=utf-8'),
        body: z.string().max(200_000).default(''),
      }),
    )
    .max(20)
    .optional(),
  /**
   * Browser scripts, read actions only: run against the real declared sites (through the
   * egress proxy, with no credentials) instead of canned pages, like a Playwright test run.
   */
  live: z.boolean().optional(),
  /** Run as a member who has stored no credentials (checks that optional ones are really optional). */
  withoutCredentials: z.boolean().optional(),
});
export type ModuleTest = z.infer<typeof moduleTestSchema>;

export interface ValidationCheck {
  name: string;
  passed: boolean;
  details?: string[];
  /** A warning for the reviewer: shown, but it does not stop the module from being submitted. */
  advisory?: boolean;
}

/** What a draft is worth, in the terms a reviewer and a benchmark both use. */
export interface DraftQuality {
  /** OWASP findings the checks named (the blocking ones first). */
  security: string[];
  /** Performance findings: a call per item in a loop, unbounded parallel calls, no cap on pages... */
  performance: string[];
  /** Sandbox tests the draft came with, and how many of them pass. */
  tests: { total: number; passed: number };
  /** Every setting has the help and example a person needs to fill it in. */
  explained: boolean;
  /** Nothing unsafe, nothing slow, every setting explained, and its tests pass. */
  clean: boolean;
}

/** Reads a stored validation report: no AI, no sandbox, so it costs nothing to show or to count. */
export function draftQuality(report: ValidationReport | null): DraftQuality | null {
  if (!report) return null;
  const failed = (test: (name: string) => boolean) => report.checks.filter((c) => !c.passed && test(c.name)).map((c) => c.name);
  const security = failed((n) => n.startsWith('OWASP') || n === 'static scan');
  const performance = failed((n) => n.startsWith('Performance'));
  const explained = !report.checks.some((c) => !c.passed && c.name.startsWith('settings explained'));
  const tests = { total: report.tests.length, passed: report.tests.filter((t) => t.passed).length };
  return { security, performance, tests, explained, clean: !security.length && !performance.length && explained && tests.total > 0 && tests.passed === tests.total };
}

export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheck[];
  /** requests: "METHOD url → status" (or "→ no canned answer"); expectOk: what the test expected, to explain a failure. */
  tests: { name: string; passed: boolean; errorType?: string; requests: string[]; expectOk?: boolean; live?: boolean; blocked?: string[] }[];
}

/**
 * Advisory static checks. They help the admin; they are not the security
 * control. The sandbox and broker are.
 */
const SUSPICIOUS: [RegExp, string][] = [
  [/\brequire\s*\(/, 'uses require()'],
  [/\bimport\s*\(/, 'uses dynamic import()'],
  [/^\s*import\s/m, 'imports other modules (modules must be self-contained)'],
  [/\bprocess\./, 'touches the process object'],
  [/\beval\s*\(|\bnew\s+Function\b/, 'generates code from strings'],
  [/\bglobalThis\b/, 'uses globalThis'],
  [/\bfetch\s*\(/, 'calls fetch directly instead of ctx.http.request'],
];

/**
 * Hard-coded secrets (OWASP A04). These block: a secret in module code is readable by anyone who
 * can see the module, and the runtime attaches the member's own credential instead.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'a GitLab token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bsk-(ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/, 'an API secret key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/['"`]Bearer\s+[A-Za-z0-9._~+/-]{20,}=*['"`]/, 'a bearer token'],
  [/\b(password|passwd|secret|api_?key|access_?token|auth_?token|client_?secret)['"]?\s*[:=]\s*['"`](?=[^'"`\s]*[0-9])(?=[^'"`\s]*[A-Za-z])[^'"`\s$]{12,}['"`]/i, 'a password or key in a variable'],
  [/:\/\/[^/\s'"`:@]+:[^/\s'"`@]+@/, 'a user name and password in a URL'],
];

/**
 * Checks against the OWASP Top 10 (2025). The sandbox and broker already enforce the hard
 * limits (declared hosts, credentials attached outside the code, bound SQL parameters); these
 * point the reviewer at code that is likely to be wrong. Only hard-coded secrets block.
 */
export function owaspChecks(manifest: Manifest, code: string, tests: { action: string; expectOk?: boolean }[]): ValidationCheck[] {
  const found = (list: [RegExp, string][]) => list.filter(([re]) => re.test(code)).map(([, why]) => why);
  const checks: ValidationCheck[] = [];
  const advisory = (name: string, details: string[]) => checks.push({ name, passed: details.length === 0, details, advisory: true });

  advisory('OWASP A01: Broken Access Control', found([
    [/['"`]https?:\/\/['"`]?\s*\+\s*input\b|https?:\/\/\$\{\s*input\b/, 'the host of a request comes from the input (the broker still only allows declared hosts)'],
    [/\.\.\//, 'contains "../" (path traversal in a URL path)'],
  ]));
  advisory('OWASP A02: Security Misconfiguration', [
    ...found([[/['"`]http:\/\/(?!localhost|127\.0\.0\.1)/, 'uses a plain http:// address']]),
    ...(manifest.endpoints ?? []).filter((e) => (e.protocol === 'smtp' ? e.tls === 'none' : !e.tls)).map((e) => `endpoint ${e.id} is not encrypted (works only for hosts an admin allowed for development)`),
  ]);
  checks.push({
    name: 'OWASP A03: Software Supply Chain Failures',
    passed: !/\brequire\s*\(|\bimport\s*\(|^\s*import\s/m.test(code),
    details: /\brequire\s*\(|\bimport\s*\(|^\s*import\s/m.test(code) ? ['loads other code (modules must be self-contained)'] : [],
  });
  checks.push({ name: 'OWASP A04: Cryptographic Failures (hard-coded secrets)', passed: found(SECRET_PATTERNS).length === 0, details: found(SECRET_PATTERNS).map((w) => `contains ${w}; use a declared credential`) });
  advisory('OWASP A04: Cryptographic Failures (weak randomness)', found([[/\bMath\.random\s*\(/, 'Math.random() is not safe for tokens or ids others could guess']]));
  advisory('OWASP A05: Injection', found([
    [/['"`/]\s*\+\s*input(\.[A-Za-z_$][\w$]*|\[[^\]]+\])+\s*(\+|\)|,|;|$)(?![^\n]*encodeURIComponent)/m, 'input is added to a text (URL, query or body) without encodeURIComponent; check the input schema limits it'],
    [/html\s*:\s*`[^`]*\$\{\s*input/, 'input is put into email HTML without escaping'],
    [/\$where|\$function|\$accumulator/, 'uses a database operator that runs code'],
  ]));
  const writes = manifest.actions.filter((a) => a.effect === 'write').map((a) => a.name);
  advisory('OWASP A06: Insecure Design', writes.filter((a) => !tests.some((t) => t.action === a && t.expectOk === false)).map((a) => `write action ${a} has no test that expects bad input to be refused`));
  advisory('OWASP A07: Authentication Failures', found([
    [/['"`]authorization['"`]\s*:/i, 'sets an Authorization header itself (the broker drops it; declare a credential)'],
    [/[?&](api_?key|token|access_token|password)=/i, 'puts a key or password in a URL (URLs are logged); use a credential placement'],
  ]));
  checks.push({ name: 'OWASP A08: Software or Data Integrity Failures', passed: !/\beval\s*\(|\bnew\s+Function\b/.test(code), details: /\beval\s*\(|\bnew\s+Function\b/.test(code) ? ['runs code built from text'] : [] });
  advisory('OWASP A09: Security Logging and Alerting Failures', found([[/\bconsole\.(log|info|debug|warn|error)\s*\(/, 'writes to the console (may log personal data or secrets); return errors with ActionError codes instead']]));
  advisory('OWASP A10: Mishandling of Exceptional Conditions', [
    ...found([
      [/catch\s*(\([^)]*\))?\s*\{\s*\}/, 'an empty catch block hides failures'],
      [/\.catch\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/, '.catch(() => ...) hides failures'],
    ]),
    ...(/ctx\.http\.request/.test(code) && !/\.(ok|status)\b/.test(code) ? ['never checks res.ok or res.status after a request'] : []),
  ]);
  return checks;
}

/** A sandbox test making more calls than this for one action is flagged (P9). */
const CALLS_PER_TEST = 10;

/** Array inputs, anywhere in a schema, that set no maxItems. */
function unboundedArrays(schema: unknown, at: string, out: string[]): string[] {
  if (!schema || typeof schema !== 'object') return out;
  const s = schema as { type?: unknown; maxItems?: unknown; properties?: Record<string, unknown>; items?: unknown };
  if ((s.type === 'array' || (Array.isArray(s.type) && s.type.includes('array'))) && s.maxItems === undefined) out.push(at);
  for (const [k, v] of Object.entries(s.properties ?? {})) unboundedArrays(v, at ? `${at}.${k}` : k, out);
  if (s.items) unboundedArrays(s.items, `${at}[]`, out);
  return out;
}

/**
 * Performance checks (skills/performant-modules). Warnings for the reviewer: a slow module still
 * works, the sandbox caps calls and time, but it costs every run and the app's shared rate limits.
 */
export function performanceChecks(manifest: Manifest, code: string): ValidationCheck[] {
  const found = (list: [RegExp, string][]) => list.filter(([re]) => re.test(code)).map(([, why]) => why);
  const checks: ValidationCheck[] = [];
  const advisory = (name: string, details: string[]) => checks.push({ name, passed: details.length === 0, details, advisory: true });
  const call = String.raw`await\s+ctx\.(http\.request|smtp|amqp|mqtt|ws|sse|db)\b`;

  advisory('Performance P1: one call at a time in a loop', found([
    [new RegExp(String.raw`\b(for|while)\s*\([^)]*\)\s*\{[^{}]*` + call), "awaits a request inside a loop, one item at a time; use the app's bulk or search endpoint, or small parallel batches"],
    [/\.forEach\s*\(\s*async\b/, 'uses forEach(async ...): the calls are not awaited and run unbounded'],
  ]));
  advisory('Performance P2: unbounded parallel calls', found([
    [/Promise\.all\s*\(\s*input(\.[A-Za-z_$][\w$]*)+\s*\.map\s*\(/, 'starts one call per input item all at once; run at most 5 at a time'],
  ]));
  advisory('Performance P3: pagination without a cap', found([
    [/\bwhile\s*\(\s*(true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/, 'loops until the app runs out of pages; stop after a fixed number of pages and report "truncated"'],
  ]));
  advisory('Performance P4: waiting inside the module', found([
    [/\bset(Timeout|Interval)\s*\(/, 'waits with a timer; throw a retryable ActionError and let Dittoly retry later'],
  ]));
  advisory('Performance P5: returns the whole answer', found([
    [/\breturn\s+(await\s+)?[A-Za-z_$][\w$]*\.json\(\)\s*;/, "returns the app's whole answer; return only the fields the Flow needs"],
    [/\breturn\s+[A-Za-z_$][\w$]*\.body\s*;/, 'returns the raw response body; return only the fields the Flow needs'],
  ]));
  advisory('Performance P6: wasted work', found([[/JSON\.parse\s*\(\s*JSON\.stringify\s*\(/, 'deep-copies with JSON.parse(JSON.stringify(...))']]));
  const queries = (manifest.endpoints ?? []).flatMap((e) => ('queries' in e && Array.isArray(e.queries) ? (e.queries as { id: string; sql: string; effect: string }[]) : []));
  advisory('Performance P7: database queries', queries.flatMap((q) => {
    const sql = q.sql.replace(/\s+/g, ' ');
    return [
      ...(/\bselect\s+(\w+\.)?\*/i.test(sql) ? [`query ${q.id} selects every column; name the columns the action returns`] : []),
      // A lookup by key (WHERE, no ORDER BY) returns few rows anyway; a scan or a sort needs a limit.
      ...(q.effect === 'read' && /^\s*(select|with)\b/i.test(sql) && (!/\bwhere\b/i.test(sql) || /\border\s+by\b/i.test(sql)) && !/\b(limit|top|fetch\s+first|fetch\s+next)\b/i.test(sql)
        ? [`query ${q.id} scans or sorts with no LIMIT, TOP or FETCH FIRST: the database does all the work before maxRows cuts the rows`]
        : []),
    ];
  }));
  advisory('Performance P8: unbounded list inputs', manifest.actions.flatMap((a) => unboundedArrays(a.input, '', []).map((f) => `${a.name}: input ${f || '(the input)'} has no maxItems`)));
  return checks;
}

/** Fake SMTP, AMQP, MQTT, WebSocket, SSE and database servers for a sandbox test: record the call, answer from the test. */
export function cannedTransports(t: { calls?: ModuleTest['calls'] }, requests: string[]): Transports {
  const calls = t.calls ?? [];
  const used = new Set<number>();
  const next = (protocol: ModuleTest['calls'][number]['protocol'], query?: string) => {
    const i = calls.findIndex((c, idx) => c.protocol === protocol && !used.has(idx) && (c.query === undefined || c.query === query));
    if (i === -1) return undefined;
    used.add(i);
    const c = calls[i]!;
    if (c.error) throw new TransportError(c.error, false);
    return c;
  };
  return {
    async smtp(target, _tls, _login, msg) {
      requests.push(`SMTP ${target.hostname} to ${msg.to.length + msg.cc.length + msg.bcc.length} recipient(s)`);
      const rejected = next('smtp')?.rejected ?? [];
      return { accepted: [...msg.to, ...msg.cc, ...msg.bcc].filter((a) => !rejected.includes(a)), rejected };
    },
    async amqp(target, _tls, _login, _vhost, pub) {
      requests.push(`AMQP ${target.hostname} ${pub.exchange} ${pub.routingKey}`);
      next('amqp');
    },
    async mqtt(target, _tls, _login, pub) {
      requests.push(`MQTT ${target.hostname} ${pub.topic}`);
      next('mqtt');
    },
    async ws(url, _target, o) {
      requests.push(`WS ${url.split('?')[0]}`);
      return { messages: (next('websocket')?.messages ?? []).slice(0, o.maxMessages), closed: true };
    },
    async sse(url, _target, o) {
      requests.push(`SSE ${url.split('?')[0]}`);
      return { status: 200, events: (next('sse')?.events ?? []).slice(0, o.maxEvents) };
    },
    async db(dialect, target, r) {
      requests.push(`SQL ${dialect} ${target.hostname}/${r.database} ${r.queryId} (${r.values.length} bound value${r.values.length === 1 ? '' : 's'})`);
      const c = next(dialect, r.queryId);
      const rows = c?.rows ?? [];
      return { rows: rows.slice(0, r.maxRows), rowCount: c?.rowCount ?? (r.readOnly ? Math.min(rows.length, r.maxRows) : rows.length), truncated: rows.length > r.maxRows };
    },
    async mongo(target, r) {
      requests.push(`MONGODB ${target.hostname}/${r.database} ${r.collection}.${r.op} ${r.queryId}`);
      const c = next('mongodb', r.queryId);
      const rows = c?.rows ?? [];
      return { rows: rows.slice(0, r.maxRows), rowCount: c?.rowCount ?? Math.min(rows.length, r.maxRows), truncated: rows.length > r.maxRows };
    },
  };
}

export async function validateModule(
  runner: SandboxRunner,
  manifestValue: unknown,
  code: string,
  tests: (Omit<ModuleTest, 'calls'> & { calls?: ModuleTest['calls'] })[],
  /** The same plain-http and private-host allowances the engine applies at run time. */
  opts: { insecureHttpHosts?: readonly string[]; internalHosts?: readonly string[]; browser?: BrowserLauncher | undefined } = {},
): Promise<{ report: ValidationReport; manifest: Manifest | null }> {
  const checks: ValidationCheck[] = [];
  const parsed = parseManifest(manifestValue);
  checks.push(parsed.ok ? { name: 'manifest is valid', passed: true } : { name: 'manifest is valid', passed: false, details: parsed.issues });
  if (!parsed.ok) return { report: { passed: false, checks, tests: [] }, manifest: null };
  const manifest = parsed.manifest;
  // Sandbox tests run against each setting's default (e.g. example.atlassian.net).
  const testing = resolveManifest(manifest, {}, { useDefaults: true });

  const schemaIssues = compileSchemas(manifest);
  checks.push({ name: 'action input/output schemas compile', passed: schemaIssues.length === 0, details: schemaIssues });

  checks.push({ name: 'code size under 200 KB', passed: code.length <= 200_000 });
  const findings = SUSPICIOUS.filter(([re]) => re.test(code)).map(([, why]) => why);
  checks.push({ name: 'static scan', passed: findings.length === 0, details: findings });
  checks.push(...owaspChecks(manifest, code, tests));
  checks.push(...performanceChecks(manifest, code));
  // Admins read a setting's help and example behind the "i" next to it; without them a setting is easy to set wrong.
  const unexplained = (manifest.settings ?? []).filter((st) => !st.help || !st.example).map((st) => `setting ${st.id} has no ${!st.help ? 'help' : 'example'} for the admin`);
  checks.push({ name: 'settings explained (help and example)', passed: unexplained.length === 0, details: unexplained, advisory: true });

  const describe = await runner.invoke({
    code,
    action: '__describe',
    input: null,
    broker: { handle: async () => ({ ok: false, error: 'no_network_during_load', retryable: false, violation: true }) },
    timeoutMs: 10_000,
  });
  if (!describe.ok) {
    checks.push({ name: 'module loads in sandbox', passed: false, details: [describe.errorType] });
  } else {
    const exported = new Set((describe.output as { actions?: string[] }).actions ?? []);
    const declared = manifest.actions.map((a) => a.name);
    const missing = declared.filter((a) => !exported.has(a));
    const extra = [...exported].filter((a) => !declared.includes(a));
    checks.push({ name: 'module loads in sandbox', passed: true });
    checks.push({
      name: 'exported actions match the manifest',
      passed: missing.length === 0 && extra.length === 0,
      details: [...missing.map((a) => `missing: ${a}`), ...extra.map((a) => `undeclared: ${a}`)],
    });
  }

  const testResults: ValidationReport['tests'] = [];
  const note = activityReporter();
  for (const t of tests) {
    const action = manifest.actions.find((a) => a.name === t.action);
    const requests: string[] = [];
    if (!action) {
      testResults.push({ name: t.name, passed: false, errorType: 'unknown_action', requests });
      continue;
    }
    const inputOk = safeValidate(action.input, t.input);
    // A test that expects a refusal is met by the input schema itself: a real run checks the input
    // against it first, so such input never reaches the code. Shown as refused by the schema.
    if (!inputOk && !t.expectOk) {
      testResults.push({ name: t.name, passed: true, errorType: 'refused_by_input_schema', requests });
      continue;
    }
    // A live test reaches real sites, so it may only read, and only browser modules have one.
    if (t.live && (!manifest.browser || action.effect !== 'read')) {
      testResults.push({ name: t.name, passed: false, errorType: manifest.browser ? 'live_test_must_read' : 'live_test_needs_browser', requests });
      continue;
    }
    const fetchImpl: FetchLike = async (url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const match = t.http.find((h) => h.method.toUpperCase() === method && url.startsWith(h.urlPrefix));
      requests.push(`${method} ${url.split('?')[0]} → ${match ? match.status : 'no canned answer'}`);
      if (!match) return new Response('{"error":"no canned response"}', { status: 599 });
      // 204, 205 and 304 carry no body (e.g. Jira answers a transition with 204).
      const noBody = match.status === 204 || match.status === 205 || match.status === 304;
      if (noBody) return new Response(null, { status: match.status });
      if (match.body !== undefined) return new Response(match.body, { status: match.status, headers: { 'content-type': match.contentType ?? 'text/plain; charset=utf-8' } });
      return new Response(JSON.stringify(match.json ?? null), { status: match.status, headers: { 'content-type': 'application/json' } });
    };
    const broker = new Broker({
      manifest: testing.manifest,
      action: t.action,
      resolveSecret: async () => (t.withoutCredentials || t.live ? null : 'test-credential'),
      fetchImpl,
      transports: cannedTransports(t, requests),
      // A Google service account credential becomes a dummy access token; nothing reaches Google.
      googleToken: async () => 'test-access-token',
      insecureHttpHosts: opts.insecureHttpHosts,
      internalHosts: t.live ? opts.internalHosts : [],
      browser: opts.browser,
      cannedPages: t.live ? undefined : (t.pages ?? []),
    });
    const r = await runner
      .invoke({ code, action: t.action, input: t.input, broker, timeoutMs: testing.manifest.browser ? 45_000 : 15_000, settings: testing.settings })
      .finally(() => broker.close());
    const outputOk = r.ok ? safeValidate(action.output, r.output) : true;
    const passed = inputOk && broker.violations.length === 0 && r.ok === t.expectOk && outputOk;
    const errorType = !inputOk
      ? 'test_input_invalid'
      : broker.violations[0] ?? (r.ok ? (outputOk ? undefined : 'output_schema_mismatch') : r.errorType);
    testResults.push({ name: t.name, passed, errorType, requests, expectOk: t.expectOk, ...(t.live ? { live: true } : {}), ...(broker.browserBlocked.length ? { blocked: broker.browserBlocked } : {}) });
    // Shown live while a draft is being built (a no-op elsewhere).
    note(`sandbox test ${testResults.length}/${tests.length} ${passed ? 'passed' : 'FAILED'}: ${t.name}`);
  }
  const writeActions = manifest.actions.filter((a) => a.effect === 'write').map((a) => a.name);
  const untested = manifest.actions.filter((a) => !tests.some((t) => t.action === a.name)).map((a) => a.name);
  checks.push({
    name: 'every action has a sandbox test',
    passed: untested.length === 0,
    details: untested.map((a) => `${a}${writeActions.includes(a) ? ' (changes data)' : ''}`),
  });
  checks.push({
    name: `Performance P9: calls per test (at most ${CALLS_PER_TEST})`,
    passed: testResults.every((t) => t.requests.length <= CALLS_PER_TEST),
    details: testResults.filter((t) => t.requests.length > CALLS_PER_TEST).map((t) => `test "${t.name}" made ${t.requests.length} calls for one action`),
    advisory: true,
  });

  const passed = checks.every((c) => c.passed || c.advisory) && testResults.every((t) => t.passed);
  return { report: { passed, checks, tests: testResults }, manifest };
}

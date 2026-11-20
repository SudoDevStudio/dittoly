import { Client, StreamableHTTPClientTransport, type FetchLike as McpFetch, type Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import { canonicalJson, sha256Hex } from '../core/crypto.js';
import { AppError, badRequest } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Vault } from '../core/vault.js';
import type { Db } from '../db/db.js';
import { compileSchemas, parseManifest, type Manifest } from '../modules/manifest.js';
import type { ModuleRegistry, ModuleVersion } from '../modules/registry.js';
import type { ValidationReport } from '../modules/validate.js';
import { Broker, type FetchLike } from '../sandbox/broker.js';
import type { StdioSandbox } from './stdio.js';
import type { InvokeResult } from '../sandbox/runner.js';

/**
 * MCP import (import only). A remote MCP server (Streamable HTTP)
 * becomes a module version whose actions are a snapshot of its tools. An admin
 * reviews and approves it like any module, Flows pin it, and every call goes
 * through the same broker: only the approved host, only the declared credential,
 * taken from the vault of the member the step runs as.
 *
 * The remote server can change after approval, so before each call the tool's
 * current schemas are compared with the approved snapshot; a changed tool is
 * refused until an admin approves a re-import.
 */

export interface McpConfig {
  kind: 'mcp';
  /** Remote (Streamable HTTP) unless "stdio". */
  transport?: 'http' | 'stdio';
  url: string;
  /** Local servers: the pinned package and where it is installed. */
  stdio?: { spec: string; name: string; version: string; integrity: string | null; volume: string; entry: string; image: string };
  /** action name -> remote tool name and the hashes of its approved schemas */
  tools: Record<string, { tool: string; inputSha256: string; outputSha256: string | null }>;
}

export const stdioImportSchema = z
  .object({
    transport: z.literal('stdio'),
    /** npm package, "name@version" (pin a version), or an absolute path to a .tgz on this machine. */
    package: z.string().regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@[\w.-]+$|^\/[\w./-]+\.tgz$/),
    name: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    title: z.string().min(1).max(80).optional(),
    /** The only hosts the server may reach, host[:port] (port 443 when omitted). */
    hosts: z.array(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/)).max(10),
    credentialService: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional(),
    /** Environment variable the server reads its token from, e.g. GITHUB_PERSONAL_ACCESS_TOKEN. */
    credentialEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).optional(),
  })
  .strict()
  .refine((b) => !b.credentialService === !b.credentialEnv, 'credentialService and credentialEnv go together')
  .refine((b) => !b.credentialService || b.hosts.length > 0, 'a server with a credential needs at least one host to send it to');

export const importSchema = z
  .object({
    url: z.string().url(),
    name: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    title: z.string().min(1).max(80).optional(),
    /** Vault service holding the bearer token for this server, if it needs one. */
    credentialService: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional(),
  })
  .strict();

const TEXT_OUTPUT = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

/** A tool's title and description as stored in the manifest, and compared on every call. */
const toolTitle = (t: Tool) => (t.title ?? t.annotations?.title ?? t.name).slice(0, 80);
const toolDescription = (t: Tool) => (t.description ?? 'MCP tool').replace(/\s+/g, ' ').slice(0, 300);
const schemaHash = (s: unknown) => sha256Hex(canonicalJson(s ?? null));

/** A fetch for the MCP client that sends every request through the broker. */
function brokeredFetch(broker: Broker, credentialId: string | null): McpFetch {
  return async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    // No standalone server-to-client stream: tool calls need none, and it would hold the broker open.
    if (method === 'GET') return new Response(null, { status: 405 });
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init.body === 'string' ? init.body : init.body ? await new Response(init.body as BodyInit).text() : null;
    const out = await broker.handle({ method, url: String(url), headers, credential: credentialId, body, json: false });
    if (!out.ok) throw new McpBrokerError(out.error, out.retryable);
    return new Response(out.response.status === 204 || out.response.status === 202 ? null : out.response.body, {
      status: out.response.status,
      headers: out.response.headers,
    });
  };
}

class McpBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

async function withClient<T>(url: string, fetch: McpFetch, timeoutMs: number, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'dittoly', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        return fn(client);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpBrokerError('action_timeout', true)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

async function allTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...res.tools);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

function actionName(tool: string, taken: Set<string>): string {
  let base = tool.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `t_${base}`;
  base = base.slice(0, 60) || 'tool';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 58)}_${i}`;
  taken.add(name);
  return name;
}

export class McpService {
  constructor(
    private readonly db: Db,
    private readonly registry: ModuleRegistry,
    private readonly vault: Vault,
    private readonly secrets: (memberId: string, service: string) => Promise<string | null>,
    private readonly opts: {
      insecureHttpHosts: readonly string[];
      internalHosts?: readonly string[];
      fetchImpl?: FetchLike | undefined;
      timeoutMs?: number;
      mode?: 'local' | 'shared';
      /** Runs local (stdio) servers; local mode only. */
      stdio?: StdioSandbox;
    },
  ) {}

  /** host[:port] → the host:port pairs the egress proxy allows. */
  private static proxyAllow(hosts: readonly string[]): string[] {
    return hosts.map((h) => (/:\d+$/.test(h) ? h : `${h}:443`));
  }

  /** Import a local (stdio) MCP server: install the pinned package, list its tools in the sandbox, store a draft. */
  private async importStdio(body: unknown, actor: Member): Promise<ModuleVersion> {
    const p = stdioImportSchema.safeParse(body);
    if (!p.success) throw badRequest('invalid_mcp_import', p.error.issues.map((i) => i.message).join('; '));
    if (this.opts.mode !== 'local') throw badRequest('stdio_mcp_local_only');
    const sandbox = this.opts.stdio;
    if (!sandbox || !(await sandbox.available())) throw new AppError('stdio_mcp_needs_docker', 409);
    const { name, hosts, credentialService, credentialEnv } = p.data;
    const title = p.data.title ?? name;
    const pkg = await sandbox.install(p.data.package);
    const secret = credentialService ? await this.secrets(actor.id, credentialService) : null;
    if (credentialService && secret === null) throw new AppError('credential_missing', 409);
    let tools: Tool[];
    try {
      tools = await sandbox.withServer(
        { image: sandbox.image, volume: pkg.volume, entry: pkg.entry, allow: McpService.proxyAllow(hosts), credentialEnv: credentialEnv ?? null },
        secret,
        this.opts.timeoutMs ?? 60_000,
        allTools,
      );
    } catch (err) {
      throw err instanceof AppError ? err : new AppError('mcp_unreachable', 502);
    }
    const credentials =
      credentialService && credentialEnv
        ? [{ id: 'mcp_token', service: credentialService, label: `${title} token`, hosts, placement: { type: 'env' as const, name: credentialEnv } }]
        : [];
    const config: McpConfig = {
      kind: 'mcp',
      transport: 'stdio',
      url: `stdio:${pkg.name}@${pkg.version}`,
      stdio: { spec: p.data.package, name: pkg.name, version: pkg.version, integrity: pkg.integrity, volume: pkg.volume, entry: pkg.entry, image: sandbox.image },
      tools: {},
    };
    return this.storeImport(actor, name, title, `Tools of the local MCP server ${pkg.name}@${pkg.version}, run in a sandbox.`, hosts, credentials, tools, config, [
      { name: `installed ${pkg.name}@${pkg.version} (install scripts disabled)${pkg.integrity ? `, integrity ${pkg.integrity.slice(0, 20)}…` : ''}`, passed: true },
      { name: `started in the sandbox and listed ${tools.length} tools`, passed: true },
    ]);
  }

  private broker(manifest: Manifest, action: string, memberId: string): Broker {
    return new Broker({
      manifest,
      action,
      resolveSecret: (service) => this.secrets(memberId, service),
      insecureHttpHosts: this.opts.insecureHttpHosts,
      internalHosts: this.opts.internalHosts ?? [],
      fetchImpl: this.opts.fetchImpl,
    });
  }

  /** Connect with the importer's own credential, snapshot the tools, and store a draft module version for review. */
  async import(body: unknown, actor: Member): Promise<ModuleVersion> {
    if ((body as { transport?: unknown } | null)?.transport === 'stdio') return this.importStdio(body, actor);
    const p = importSchema.safeParse(body);
    if (!p.success) throw badRequest('invalid_mcp_import');
    const { url, name, credentialService } = p.data;
    const u = new URL(url);
    const host = u.host.toLowerCase();
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.opts.insecureHttpHosts.includes(host))) {
      throw badRequest('mcp_requires_https');
    }
    if (u.username || u.password) throw badRequest('invalid_mcp_import');
    const title = p.data.title ?? name;
    const credentials = credentialService
      ? [{ id: 'mcp_token', service: credentialService, label: `${title} token`, hosts: [host], placement: { type: 'bearer' as const } }]
      : [];
    // A provisional manifest so the import itself goes through the broker.
    const probe = {
      name,
      version: '0.0.0',
      title,
      description: 'probe',
      hosts: [host],
      credentials,
      actions: [{ name: 'list_tools', title: 'List tools', description: 'probe', effect: 'read', credentials: credentials.map((c) => c.id), input: {}, output: {} }],
    } as Manifest;

    let tools: Tool[];
    try {
      tools = await withClient(url, brokeredFetch(this.broker(probe, 'list_tools', actor.id), credentials[0]?.id ?? null), this.opts.timeoutMs ?? 30_000, allTools);
    } catch (err) {
      throw new AppError(err instanceof McpBrokerError ? `mcp_${err.code}` : 'mcp_unreachable', 502);
    }
    const config: McpConfig = { kind: 'mcp', url, tools: {} };
    return this.storeImport(actor, name, title, `Tools imported from the MCP server at ${host}.`, [host], credentials, tools, config, [
      { name: `connected to ${host} and listed ${tools.length} tools`, passed: true },
    ]);
  }

  /** Snapshot the tools into a manifest and store a draft module version for admin review. */
  private async storeImport(
    actor: Member,
    name: string,
    title: string,
    description: string,
    hosts: string[],
    credentials: Manifest['credentials'],
    tools: Tool[],
    config: McpConfig,
    extraChecks: ValidationReport['checks'],
  ): Promise<ModuleVersion> {
    if (tools.length === 0) throw new AppError('mcp_no_tools', 422);
    if (tools.length > 30) throw new AppError('mcp_too_many_tools', 422);
    const taken = new Set<string>();
    const actions = tools.map((t) => {
      const action = actionName(t.name, taken);
      config.tools[action] = { tool: t.name, inputSha256: schemaHash(t.inputSchema), outputSha256: t.outputSchema ? schemaHash(t.outputSchema) : null };
      return {
        name: action,
        title: toolTitle(t),
        description: toolDescription(t),
        // The server's read-only hint is only a hint; anything not marked read-only is treated as changing data.
        effect: t.annotations?.readOnlyHint === true ? ('read' as const) : ('write' as const),
        credentials: credentials.map((c) => c.id),
        input: t.inputSchema as Record<string, unknown>,
        output: (t.outputSchema as Record<string, unknown> | undefined) ?? { ...TEXT_OUTPUT },
      };
    });
    const manifestValue = {
      name,
      version: await this.nextVersion(name),
      title,
      description,
      hosts,
      credentials,
      actions,
    };
    const parsed = parseManifest(manifestValue);
    if (!parsed.ok) throw badRequest('invalid_manifest', parsed.issues.join('; '));
    const schemaIssues = compileSchemas(parsed.manifest);
    const report: ValidationReport = {
      passed: schemaIssues.length === 0,
      checks: [
        { name: 'manifest is valid', passed: true },
        { name: 'action input/output schemas compile', passed: schemaIssues.length === 0, details: schemaIssues },
        ...extraChecks,
      ],
      tests: [],
    };
    const mv = await this.registry.createImported(parsed.manifest, JSON.stringify(config), report, actor);
    await audit(this.db, { actorId: actor.id, action: 'mcp.imported', subjectType: 'module', subjectId: mv.id, outcome: 'ok' });
    return mv;
  }

  private async nextVersion(name: string): Promise<string> {
    const { rows } = await this.db.query<{ version: string }>(`SELECT version FROM module_versions WHERE name = $1`, [name]);
    if (rows.length === 0) return '1.0.0';
    const latest = rows
      .map((r) => r.version.split('.').map(Number) as [number, number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
      .at(-1)!;
    return `${latest[0]}.${latest[1] + 1}.0`;
  }

  /** Call one tool of an approved MCP module version. Same result shape as the sandbox runner. */
  async invoke(params: {
    module: ModuleVersion;
    action: string;
    input: unknown;
    broker: Broker;
    timeoutMs?: number | undefined;
    /** Local servers: the hosts the proxy allows (settings resolved) and the runner's secret. */
    hosts?: readonly string[];
    resolveSecret?: (service: string) => Promise<string | null>;
  }): Promise<InvokeResult> {
    const { module, action, input, broker } = params;
    let config: McpConfig;
    try {
      config = JSON.parse(module.code) as McpConfig;
    } catch {
      return { ok: false, errorType: 'mcp_config_invalid', retryable: false };
    }
    const entry = config.tools[action];
    if (config.kind !== 'mcp' || !entry) return { ok: false, errorType: 'unknown_action', retryable: false };
    const credentialId = module.manifest.credentials[0]?.id ?? null;
    const call = async (client: Client): Promise<InvokeResult> => {
        const current = (await allTools(client)).find((t) => t.name === entry.tool);
        if (!current) return { ok: false, errorType: 'mcp_tool_missing', retryable: false };
        const outputSha = current.outputSchema ? schemaHash(current.outputSchema) : null;
        // Pinned at import: the schemas, and the name and description the reviewer approved (a server
        // that rewrites a tool's description to steer the AI using it is a changed tool).
        const approved = module.manifest.actions.find((a) => a.name === action);
        const described = approved && (toolTitle(current) !== approved.title || toolDescription(current) !== approved.description);
        if (schemaHash(current.inputSchema) !== entry.inputSha256 || outputSha !== entry.outputSha256 || described) {
          return { ok: false, errorType: 'mcp_tool_changed', retryable: false };
        }
        const res = await client.callTool({ name: entry.tool, arguments: (input ?? {}) as Record<string, unknown> });
        if (res.isError) return { ok: false, errorType: 'mcp_tool_error', retryable: false };
        if (res.structuredContent && typeof res.structuredContent === 'object') return { ok: true, output: res.structuredContent };
        const text = (res.content ?? [])
          .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
          .map((c) => c.text)
          .join('\n');
        return { ok: true, output: { text } };
    };
    const timeoutMs = params.timeoutMs ?? this.opts.timeoutMs ?? 60_000;
    try {
      if (config.transport === 'stdio') {
        if (this.opts.mode !== 'local' || !this.opts.stdio || !config.stdio) return { ok: false, errorType: 'stdio_mcp_local_only', retryable: false };
        const cred = module.manifest.credentials[0];
        const secret = cred ? ((await params.resolveSecret?.(cred.service)) ?? null) : null;
        if (cred && secret === null) return { ok: false, errorType: 'credential_missing', retryable: false };
        return await this.opts.stdio.withServer(
          {
            image: config.stdio.image,
            volume: config.stdio.volume,
            entry: config.stdio.entry,
            allow: McpService.proxyAllow(params.hosts ?? module.manifest.hosts),
            credentialEnv: cred?.placement.type === 'env' ? cred.placement.name : null,
          },
          secret,
          timeoutMs,
          call,
        );
      }
      return await withClient(config.url, brokeredFetch(broker, credentialId), timeoutMs, call);
    } catch (err) {
      if (err instanceof McpBrokerError) return { ok: false, errorType: err.code, retryable: err.retryable };
      if (err instanceof AppError && err.code === 'action_timeout') return { ok: false, errorType: 'action_timeout', retryable: true };
      return { ok: false, errorType: 'mcp_error', retryable: true };
    }
  }
}


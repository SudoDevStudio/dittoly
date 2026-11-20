import { audit } from '../core/audit.js';
import { randomToken, sha256Hex, type Cipher } from '../core/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import type { Db, Queryable } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import type { FlowDefinition } from '../flows/definition.js';
import type { FlowService } from '../flows/service.js';
import { agentBody, Agents, checkScopeTools, grantFor, type AgentCall, type AgentScopes, type Grant } from './agents.js';
import { flowGuide, guideArgs, saveAsFlow, type CaptureDeps } from './capture.js';
import type { Gateway, GatewayTool } from './gateway.js';
import { agentStopped, isStopped, noteBlockedCall } from '../governance/auto-stop.js';
import { ViolationError } from '../runtime/errors.js';
import { OLD_MCP_ACCESS_PREFIX, OLD_MCP_TOKEN_PREFIX } from '../core/old-prefixes.js';

/**
 * Dittoly as an MCP server (Streamable HTTP, JSON responses, no sessions): AI assistants
 * such as Claude or Cursor run approved Flows as tools. Only Flows whose owner switched on
 * "Available to AI assistants" are offered, each runs as the person whose MCP token it is,
 * with their access, and sign-offs still wait for a human. Nothing here can change a Flow.
 * Each token is an agent (see agents.ts): it sees only the tools its person picked for it.
 *
 * Protocol versions: 2025-11-25 and the two before it, with the initialize handshake. A client
 * on 2026-07-28 that asks server/discover gets "method not found", the answer of a server
 * on an earlier version, and falls back to initialize.
 */

export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const TOKEN_PREFIX = 'dty_mcp_';
/** Access tokens issued by OAuth sign-in (see authserver.ts). */
export const ACCESS_PREFIX = 'dty_oat_';
const MAX_RESULT = 20_000;

interface JsonRpc { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

export interface McpToken { id: string; name: string; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; scoped: boolean }

export interface McpTool {
  name: string;
  /** The key an agent's scopes name it by. */
  key: string;
  /** How this agent may use it. */
  grant: Grant;
  flowId: string;
  versionId: string;
  title: string;
  description: string;
  inputSchema: unknown;
  changesData: boolean;
}

export class McpServer {
  readonly agents: Agents;

  constructor(
    private readonly db: Db,
    private readonly flows: FlowService,
    private readonly engine: Engine,
    cipher: Cipher,
    private readonly opts: { publicUrl: string; waitMs?: number },
    /** Saving AI work as Flows (get_flow_guide, save_as_flow); without it only Flows are offered. */
    private readonly capture?: CaptureDeps,
    /** Approved module actions an admin offered to agents as tools. */
    readonly gateway?: Gateway,
  ) {
    this.agents = new Agents(db, cipher);
  }

  // ------------------------------------------------------------ tokens

  /**
   * A new agent: it may use only the tools picked here (none if none are), until it expires.
   * With `oauth`, an app the person approved on the consent page; its token is never handed out.
   */
  async createToken(
    member: Member,
    input: { name: string; scopes?: AgentScopes; expiresInDays?: number },
    oauth?: { clientId: string; clientName: string },
  ): Promise<{ token: string; id: string }> {
    const parsed = agentBody.safeParse({ ...input, scopes: input.scopes ?? { tools: {}, drafting: false } });
    if (!parsed.success) throw badRequest('invalid_agent', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const { name, scopes, expiresInDays } = parsed.data;
    await checkScopeTools(this.db, scopes);
    const count = (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_tokens WHERE member_id = $1 AND revoked_at IS NULL`, [member.id])).rows[0]!.n;
    if (count >= 20) throw badRequest('too_many_tokens', 'at most 20 MCP tokens; remove one first');
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO mcp_tokens (member_id, name, token_hash, scopes, expires_at, oauth_client_id, oauth_client_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [member.id, name, sha256Hex(token), JSON.stringify(scopes), new Date(Date.now() + expiresInDays * 86_400_000), oauth?.clientId ?? null, oauth?.clientName ?? null],
    );
    await audit(this.db, { actorId: member.id, action: oauth ? 'mcp.oauth_agent_created' : 'mcp.token_created', subjectType: 'member', subjectId: member.id, outcome: 'ok', relatedId: rows[0]!.id });
    return { token, id: rows[0]!.id };
  }

  async listTokens(member: Member): Promise<McpToken[]> {
    const { rows } = await this.db.query<{ id: string; name: string; created_at: Date; last_used_at: Date | null; expires_at: Date | null; scoped: boolean }>(
      `SELECT id, name, created_at, last_used_at, expires_at, scopes IS NOT NULL AS scoped FROM mcp_tokens WHERE member_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
      [member.id],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at, scoped: r.scoped }));
  }

  async revokeToken(member: Member, id: string): Promise<void> {
    const r = await this.db.query(`SELECT 1 FROM mcp_tokens WHERE id = $1 AND member_id = $2 AND revoked_at IS NULL`, [id, member.id]);
    if (!r.rowCount) throw notFound('mcp_token');
    await this.agents.revoke(member, id);
  }

  /**
   * A personal MCP token, or an access token from OAuth sign-in: both resolve to the agent, so its
   * scopes, expiry and revocation apply the same way. An access token is only good for this
   * server (its audience), for an hour, while its grant and agent stand.
   */
  private async authenticate(authorization: string | undefined): Promise<Auth | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    // Tokens issued with the old prefixes (src/core/old-prefixes.ts) are still accepted.
    const oauth = !!m && (m[1]!.startsWith(ACCESS_PREFIX) || m[1]!.startsWith(OLD_MCP_ACCESS_PREFIX));
    if (!m || !(oauth || m[1]!.startsWith(TOKEN_PREFIX) || m[1]!.startsWith(OLD_MCP_TOKEN_PREFIX))) return null;
    const { rows } = await this.db.query<Member & { token_id: string; token_name: string; scopes: AgentScopes | null }>(
      `SELECT m.id, m.handle, m.role, t.id AS token_id, t.name AS token_name, t.scopes
       FROM mcp_tokens t JOIN members m ON m.id = t.member_id
       WHERE ${
         oauth
           ? `t.id = (SELECT g.token_id FROM mcp_oauth_tokens o JOIN mcp_oauth_grants g ON g.id = o.grant_id
                      WHERE o.token_hash = $1 AND o.kind = 'access' AND o.expires_at > now() AND g.revoked_at IS NULL AND g.resource = $2)`
           : 't.token_hash = $1'
       } AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND NOT m.disabled`,
      oauth ? [sha256Hex(m[1]!), `${this.opts.publicUrl}/mcp`] : [sha256Hex(m[1]!)],
    );
    const r = rows[0];
    if (!r) return null;
    await this.db.query(`UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [r.token_id]);
    const { token_id: tokenId, token_name: tokenName, scopes, ...member } = r;
    return { member: member as Member, tokenId, tokenName, scopes };
  }

  // ------------------------------------------------------------ which Flows

  /**
   * Flows offered to AI assistants: switched on, approved, and runnable by this member; with an
   * agent's scopes, only those it was given (scopes null: a token made before scopes, all of them).
   */
  async tools(member: Member, scopes: AgentScopes | null = null): Promise<McpTool[]> {
    const { rows } = await this.db.query<{ flow_id: string; name: string; version_id: string; definition: FlowDefinition }>(
      `SELECT f.id AS flow_id, f.name, v.id AS version_id, v.definition
       FROM flows f JOIN flow_versions v ON v.flow_id = f.id AND v.status = 'approved'
       WHERE f.mcp_enabled AND f.archived_at IS NULL AND ($2 OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = f.team_id AND tm.member_id = $1))
       ORDER BY f.created_at`,
      [member.id, member.role === 'admin'],
    );
    const out: McpTool[] = [];
    for (const r of rows) {
      const key = `flow:${r.flow_id}`;
      const grant = grantFor(scopes, key);
      if (!grant) continue;
      let changesData = false;
      try {
        const modules = await this.flows.pinnedModules(this.db, r.definition);
        changesData = r.definition.steps.some(
          (s) => s.type === 'flow' || (s.type === 'action' && modules.get(s.module)?.manifest.actions.find((a) => a.name === s.action)?.effect === 'write'),
        );
      } catch {
        continue;
      }
      const signoffs = r.definition.steps.some((s) => s.type === 'approval' || s.type === 'input');
      out.push({
        name: toolName(r.name, r.flow_id),
        key,
        grant,
        flowId: r.flow_id,
        versionId: r.version_id,
        title: r.name,
        description: [
          r.definition.description || `Runs the approved Dittoly Flow "${r.name}".`,
          changesData ? 'It changes data in the connected apps.' : 'It only reads data.',
          signoffs ? 'It may wait for a person to sign off or fill in a form; check it later with get_run.' : '',
          changesData && grant === 'ask' ? 'Your person confirms each call in Dittoly first; check it with get_call.' : '',
          'It runs as you, with your own access.',
        ].filter(Boolean).join(' '),
        inputSchema: objectSchema(r.definition.inputs),
        changesData,
      });
    }
    return out;
  }

  // ------------------------------------------------------------ HTTP

  async handle(req: { method: string; headers: Record<string, string | string[] | undefined>; body: unknown }): Promise<Reply> {
    // Browsers may not reach it from other sites (DNS rebinding): no Origin, or our own.
    const origin = header(req.headers, 'origin');
    if (origin && origin !== new URL(this.opts.publicUrl).origin) return { status: 403, body: { error: 'origin_not_allowed' } };
    if (req.method !== 'POST') return { status: 405, headers: { allow: 'POST' }, body: { error: 'method_not_allowed' } };
    const authorization = header(req.headers, 'authorization');
    const auth = await this.authenticate(authorization);
    if (!auth) {
      // The pointer that starts OAuth sign-in (RFC 9728): clients read where to sign in from it.
      const challenge = `Bearer resource_metadata="${this.opts.publicUrl}/.well-known/oauth-protected-resource/mcp"${authorization ? ', error="invalid_token"' : ''}`;
      return { status: 401, headers: { 'www-authenticate': challenge }, body: { error: 'unauthorized' } };
    }
    const version = header(req.headers, 'mcp-protocol-version');
    if (version && !(MCP_VERSIONS as readonly string[]).includes(version)) {
      return { status: 400, body: rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${version}`, { supported: MCP_VERSIONS }) };
    }
    const msg = req.body as JsonRpc;
    if (Array.isArray(req.body) || !msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { status: 400, body: rpcError(null, -32600, 'Invalid request: send one JSON-RPC 2.0 message') };
    }
    // Notifications and responses get no reply.
    if (msg.id === undefined || msg.id === null) return { status: 202 };
    try {
      return { status: 200, body: { jsonrpc: '2.0', id: msg.id, result: await this.call(auth, msg.method, (msg.params ?? {}) as Record<string, unknown>) } };
    } catch (err) {
      if (err instanceof RpcError) return { status: 200, body: rpcError(msg.id, err.code, err.message, err.data) };
      log.error('mcp_error', { memberId: auth.member.id, errorType: err instanceof AppError ? err.code : 'internal' });
      return { status: 200, body: rpcError(msg.id, -32603, 'Internal error') };
    }
  }

  private async call(auth: Auth, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return {
          protocolVersion: (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dittoly', title: 'Dittoly', version: '1' },
          instructions:
            'Each run_ tool runs one approved Dittoly Flow as the signed-in person. Runs that need a sign-off or a form wait for a person in Dittoly; use get_run to check on a run.' +
            (this.drafts(auth)
              ? ' When you have done a task the person will want again, offer to save it as a Flow: call get_flow_guide, then save_as_flow. It then repeats without an AI, after people approve it.'
              : ''),
        };
      }
      case 'ping':
        return {};
      case 'tools/list': {
        const tools = await this.tools(auth.member, auth.scopes);
        return {
          tools: [
            ...tools.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { title: t.title, readOnlyHint: !t.changesData, destructiveHint: t.changesData, idempotentHint: false, openWorldHint: true },
            })),
            {
              name: 'get_run',
              title: 'Check a run',
              description: "The status and step results of a Dittoly run you started (or one you may see), by its run id.",
              inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'The run id a Flow tool returned' } }, required: ['runId'] },
              annotations: { title: 'Check a run', readOnlyHint: true, openWorldHint: false },
            },
            ...(await this.gatewayTools(auth.member, auth.scopes)).map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description + (t.changesData && t.grant === 'ask' ? ' Your person confirms each call in Dittoly first; check it with get_call.' : ''),
              inputSchema: t.inputSchema,
              annotations: { title: t.title, readOnlyHint: !t.changesData, destructiveHint: t.changesData, idempotentHint: false, openWorldHint: true },
            })),
            GET_CALL_TOOL,
            ...(this.drafts(auth) ? CAPTURE_TOOLS : []),
          ],
        };
      }
      case 'tools/call':
        return this.callTool(auth, params);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  /** Whether this agent may draft Flows and modules: tokens made before scopes may. */
  private drafts(auth: Auth): boolean {
    return !!this.capture && (!auth.scopes || auth.scopes.drafting);
  }

  /** Every tool call is recorded on the agent, whatever it answers. */
  private async callTool(auth: Auth, params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string') throw new RpcError(-32602, 'Missing tool name');
    if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object');
    const record = (tool: string, status: string, extra: { error?: string; runId?: string } = {}) => this.agents.record(auth.tokenId, auth.member.id, tool, status, extra);
    // A stopped agent still lists its tools, but every call is refused until its person or an admin resumes it.
    if (await isStopped(this.db, 'agent', auth.tokenId)) {
      const err = agentStopped();
      await record(name, 'failed', { error: err.code });
      return toolError(`${err.code}: ${err.message}`);
    }
    if (name === 'get_run') {
      if (typeof args.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(args.runId)) return toolError('runId must be a run id');
      try {
        // An agent reads the runs it started, or runs of Flows it was given; not every run its person can see.
        if (auth.scopes && !(await this.mayRead(auth, args.runId))) throw new AppError('run_not_found', 404);
        const out = toolResult(summarize(await this.engine.runView(args.runId, auth.member)));
        await record(name, 'done');
        return out;
      } catch (err) {
        await record(name, 'failed', { error: err instanceof AppError ? err.code : 'internal' });
        return toolError(err instanceof AppError ? `${err.code}` : 'could not read the run');
      }
    }
    if (name === 'get_call') {
      const c = typeof args.callId === 'string' && /^[0-9a-f-]{36}$/.test(args.callId) ? await this.agents.callFor(auth.tokenId, args.callId) : null;
      if (!c) return toolError('callId must be the id of a call you made');
      return toolResult({ callId: args.callId, status: c.status, ...(c.error ? { error: c.error } : {}), ...(c.runId ? { runId: c.runId, note: 'Check the run with get_run.' } : {}) });
    }
    if (this.capture && (name === 'get_flow_guide' || name === 'save_as_flow')) {
      if (!this.drafts(auth)) {
        await record(name, 'denied');
        throw new RpcError(-32602, `Unknown tool: ${name}`);
      }
      if (name === 'get_flow_guide') {
        const a = guideArgs.safeParse(args);
        if (!a.success) return toolError(a.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '));
        try {
          const guide = await flowGuide(this.capture, auth.member, a.data);
          await record(name, 'done');
          return toolResult(guide, false, GUIDE_MAX);
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          await record(name, 'failed', { error: err.code });
          return toolError(err.code);
        }
      }
      const r = await saveAsFlow(this.capture, auth.member, { id: auth.tokenId, name: auth.tokenName }, args);
      await record(name, r.saved ? 'done' : 'failed', r.saved ? {} : { error: 'not_saved' });
      return toolResult(r, !r.saved);
    }
    const action = (await this.gatewayTools(auth.member, auth.scopes)).find((t) => t.name === name);
    if (action) return this.callAction(auth, action, args);
    const tool = (await this.tools(auth.member, auth.scopes)).find((t) => t.name === name);
    if (!tool) {
      // A tool its person can use but did not give this agent: recorded, so they see it tried.
      const outside = auth.scopes
        ? ((await this.tools(auth.member)).find((t) => t.name === name) ?? (await this.gateway?.eligible(auth.member))?.find((t) => t.name === name))
        : undefined;
      if (outside) await record(outside.key, 'denied');
      throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
    if (tool.changesData && tool.grant === 'ask') {
      const callId = await this.agents.ask(auth.tokenId, auth.member, tool.key, { args, versionId: tool.versionId });
      return toolResult({
        callId,
        status: 'awaiting_confirmation',
        note: `This tool changes data, so ${auth.member.handle} confirms the call in Dittoly (Agents) first. Check on it with get_call; it lapses if nobody decides within a day.`,
      });
    }
    let runId: string;
    try {
      runId = await this.engine.startRun(tool.versionId, auth.member.id, args, { actorId: auth.member.id, mcpTokenId: auth.tokenId });
    } catch (err) {
      // Policies, missing inputs and access problems are answers the assistant can act on.
      if (err instanceof AppError) {
        await record(tool.key, 'failed', { error: err.code });
        return toolError(err.message !== err.code ? `${err.code}: ${err.message}` : err.code);
      }
      throw err;
    }
    await record(tool.key, 'done', { runId });
    // Short Flows finish while the assistant waits; long ones are checked with get_run.
    const deadline = Date.now() + (this.opts.waitMs ?? 20_000);
    let view = await this.engine.runView(runId, auth.member);
    while (view.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      view = await this.engine.runView(runId, auth.member);
    }
    return toolResult(summarize(view), view.status === 'failed');
  }

  private async linkUndo(undoId: string, callId: string): Promise<void> {
    await this.db.query(`UPDATE undo_records SET agent_call_id = $2 WHERE id = $1`, [undoId, callId]);
  }

  /** Module actions offered to agents that this agent was given. */
  private async gatewayTools(member: Member, scopes: AgentScopes | null): Promise<(GatewayTool & { grant: Grant })[]> {
    if (!this.gateway) return [];
    return (await this.gateway.eligible(member)).flatMap((t) => {
      const grant = grantFor(scopes, t.key);
      return grant ? [{ ...t, grant }] : [];
    });
  }

  private async callAction(auth: Auth, tool: GatewayTool & { grant: Grant }, args: Record<string, unknown>): Promise<unknown> {
    if (tool.changesData && tool.grant === 'ask') {
      const callId = await this.agents.ask(auth.tokenId, auth.member, tool.key, { args, pin: tool.pin });
      return toolResult({
        callId,
        status: 'awaiting_confirmation',
        note: `This tool changes data, so ${auth.member.handle} confirms the call in Dittoly (Agents) first. Check on it with get_call; it lapses if nobody decides within a day.`,
      });
    }
    try {
      const { output, undoId } = await this.gateway!.invoke(auth.member, tool.key, args);
      const callId = await this.agents.record(auth.tokenId, auth.member.id, tool.key, 'done');
      if (undoId) await this.linkUndo(undoId, callId);
      return toolResult(output ?? null);
    } catch (err) {
      // Every call is recorded, also one that broke.
      await this.agents.record(auth.tokenId, auth.member.id, tool.key, 'failed', { error: err instanceof AppError ? err.code : 'internal' });
      // The broker refused what the app tool tried: counted toward stopping this agent.
      if (err instanceof ViolationError) await noteBlockedCall(this.db, { agentId: auth.tokenId, code: err.code, kind: 'violation' });
      if (!(err instanceof AppError)) throw err;
      return toolError(err.message !== err.code ? `${err.code}: ${err.message}` : err.code);
    }
  }

  private async mayRead(auth: Auth, runId: string): Promise<boolean> {
    const r = (await this.db.query<{ mcp_token_id: string | null; flow_id: string }>(
      `SELECT r.mcp_token_id, v.flow_id FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE r.id = $1`,
      [runId],
    )).rows[0];
    return !!r && (r.mcp_token_id === auth.tokenId || grantFor(auth.scopes, `flow:${r.flow_id}`) !== null);
  }

  /**
   * The person confirms or rejects a call their agent asked about. Confirmed, it runs as the agent
   * would have: the same approved version, with the agent still active and still given the tool.
   */
  async decideCall(actor: Member, callId: string, decision: 'confirmed' | 'rejected'): Promise<AgentCall> {
    // While its agent is stopped, a waiting call stays waiting: it can be rejected, not confirmed.
    if (decision === 'confirmed') {
      const c = (await this.db.query<{ token_id: string }>(`SELECT token_id FROM agent_calls WHERE id = $1 AND member_id = $2`, [callId, actor.id])).rows[0];
      if (c && (await isStopped(this.db, 'agent', c.token_id))) throw agentStopped();
    }
    return this.agents.decide(actor, callId, decision, async (key, saved, tokenId) => {
      const { args, versionId, pin } = saved as { args: Record<string, unknown>; versionId?: string; pin?: string };
      const t = (await this.db.query<{ scopes: AgentScopes | null }>(`SELECT scopes FROM mcp_tokens WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [tokenId])).rows[0];
      if (!t) return { error: 'agent_not_active' };
      if (key.startsWith('action:')) {
        if (!(await this.gatewayTools(actor, t.scopes)).some((x) => x.key === key)) return { error: 'tool_no_longer_given' };
        try {
          const { undoId } = await this.gateway!.invoke(actor, key, args, pin);
          if (undoId) await this.linkUndo(undoId, callId);
          return {};
        } catch (err) {
          if (err instanceof AppError) return { error: err.code };
          throw err;
        }
      }
      const tool = (await this.tools(actor, t.scopes)).find((x) => x.key === key);
      if (!tool) return { error: 'tool_no_longer_given' };
      if (tool.versionId !== versionId) return { error: 'flow_changed_since_asked' };
      try {
        return { runId: await this.engine.startRun(versionId, actor.id, args, { actorId: actor.id, mcpTokenId: tokenId }) };
      } catch (err) {
        if (err instanceof AppError) return { error: err.code };
        throw err;
      }
    });
  }
}

interface Auth { member: Member; tokenId: string; tokenName: string; scopes: AgentScopes | null }

const GET_CALL_TOOL = {
  name: 'get_call',
  title: 'Check a call that waits for confirmation',
  description: 'Whether your person confirmed or rejected a call that changes data, by the callId a tool returned; once confirmed, the run id to check with get_run.',
  inputSchema: { type: 'object', properties: { callId: { type: 'string', description: 'The callId a tool returned' } }, required: ['callId'] },
  annotations: { title: 'Check a call', readOnlyHint: true, openWorldHint: false },
};

/** The guide carries the drafting rules and the catalog, so it may be long. */
const GUIDE_MAX = 400_000;

const CAPTURE_TOOLS = [
  {
    name: 'get_flow_guide',
    title: 'How to save work as a Flow',
    description:
      "Dittoly's rules for drafting a Flow, plus the person's teams and what a Flow can use: approved app actions (with their input and output schemas), approved Flows and the team's data tables. Call it before save_as_flow. Set newModules to also get the rules for drafting a module for an app no approved module covers.",
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: "The team the Flow will belong to (default: the person's default team)" },
        newModules: { type: 'boolean', description: 'Also return the rules for drafting new modules' },
      },
    },
    annotations: { title: 'How to save work as a Flow', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'save_as_flow',
    title: 'Save this task as a Flow',
    description:
      'Save a task you just did as a draft Dittoly Flow, so it can run again without an AI. New modules and tests may be included. Dittoly checks everything; if something is wrong nothing is saved and you get the problems to fix. A saved Flow waits for people to approve it (and an admin to approve new modules) before it can run. Follow the rules from get_flow_guide.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short Flow name' },
        explanation: { type: 'string', description: 'For the approver: what it does, what it changes, what it will not do' },
        definition: { type: 'object', description: 'The Flow definition, as in the rules from get_flow_guide' },
        teamId: { type: 'string', description: 'The team it belongs to (default: the person\'s default team)' },
        flowId: { type: 'string', description: 'Save as a new version of this Flow (one the person owns) instead of a new Flow' },
        modules: { type: 'array', description: 'New modules: [{ manifest, code, tests }]; code is the module in TypeScript', items: { type: 'object' } },
        tests: { type: 'array', description: 'Tests from what the apps answered: [{ name, case }]', items: { type: 'object' } },
        aiUsage: {
          type: 'object',
          description: 'What doing the task cost you this time, if you know (the baseline for savings)',
          properties: { inputTokens: { type: 'integer' }, outputTokens: { type: 'integer' }, provider: { type: 'string' }, model: { type: 'string' } },
          required: ['inputTokens', 'outputTokens'],
        },
        assistant: { type: 'string', description: 'Your product name, e.g. "Claude Code"' },
      },
      required: ['name', 'explanation', 'definition'],
    },
    annotations: { title: 'Save this task as a Flow', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function header(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** run_<flow name>_<6 characters of its id>: readable, and stable while the Flow exists. */
export function toolName(flowName: string, flowId: string): string {
  const slug = flowName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'flow';
  return `run_${slug}_${flowId.replace(/-/g, '').slice(0, 6)}`;
}

function objectSchema(inputs: unknown): unknown {
  const s = (inputs ?? {}) as Record<string, unknown>;
  return s.type === 'object' ? s : { type: 'object', properties: {} };
}

type RunView = Awaited<ReturnType<Engine['runView']>>;

function summarize(view: RunView) {
  const waiting = view.status === 'waiting' ? (view.waitReason === 'approval' ? 'It waits for a person to sign off in Dittoly.' : view.waitReason === 'input_needed' ? 'It waits for you to fill in a form in Dittoly.' : `It waits: ${view.waitReason}.`) : null;
  return {
    runId: view.id,
    flow: view.flowName,
    status: view.status,
    ...(waiting ? { note: waiting } : {}),
    // A paused run: what happened and how to get it going, in the same words as the run page.
    ...(view.nextSteps ? { stopped: { step: view.nextSteps.stepTitle, what: view.nextSteps.what, why: view.nextSteps.why, fixes: view.nextSteps.fixes.map((f) => f.label + (f.detail ? ` (${f.detail})` : '')) } } : {}),
    steps: view.steps.map((s) => ({ id: s.id, title: s.title, status: s.status, ...(s.errorType ? { error: s.errorType } : {}), ...(s.output !== undefined ? { output: s.output } : {}) })),
  };
}

function toolResult(data: unknown, isError = false, max = MAX_RESULT) {
  let text = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
  if (text.length > max) text = `${text.slice(0, max)}\n… (cut; open the run in Dittoly for everything)`;
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Owners and team admins (and org admins) switch a Flow on or off for AI assistants. */
export async function setFlowMcp(db: Queryable, actor: Member, flowId: string, enabled: boolean): Promise<void> {
  const { rows } = await db.query<{ created_by: string; team_id: string }>(`SELECT created_by, team_id FROM flows WHERE id = $1`, [flowId]);
  const f = rows[0];
  if (!f) throw notFound('flow');
  if (actor.role !== 'admin' && f.created_by !== actor.id) {
    const admin = await db.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2 AND role = 'admin'`, [f.team_id, actor.id]);
    if (!admin.rowCount) throw forbidden('owner_only');
  }
  await db.query(`UPDATE flows SET mcp_enabled = $2 WHERE id = $1`, [flowId, enabled]);
  await audit(db, { actorId: actor.id, action: enabled ? 'flow.mcp_enabled' : 'flow.mcp_disabled', subjectType: 'flow', subjectId: flowId, outcome: 'ok' });
}

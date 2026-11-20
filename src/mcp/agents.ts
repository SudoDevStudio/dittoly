import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { notify } from '../core/notify.js';
import type { Db, Queryable } from '../db/db.js';
import { noteBlockedCall, TRIGGER_NAMES, type Trigger } from '../governance/auto-stop.js';

/**
 * AI agents as identities. Each MCP token is an agent acting for one person: it may use only
 * the tools its person picked, each either directly or "ask me first", and only until it
 * expires. Every call it makes is recorded, and a call that waits for its person is kept,
 * encrypted, until they confirm or reject it in Dittoly. Admins see every agent in the
 * organization and can revoke any of them.
 */

/** "run": the agent uses the tool directly. "ask": a call that changes data waits for the person to confirm it. */
export type Grant = 'run' | 'ask';

export interface AgentScopes {
  /** Tool keys ("flow:<flow id>", "action:<module>/<action>") and how the agent may use them. */
  tools: Record<string, Grant>;
  /** May draft Flows and modules for review (get_flow_guide, save_as_flow). */
  drafting: boolean;
}

export const scopesBody = z
  .object({
    tools: z.record(z.string().regex(/^(flow:[0-9a-f-]{36}|action:[a-z][a-z0-9-]{1,39}\/[a-z][a-z0-9_]{0,63})$/), z.enum(['run', 'ask'])).refine((t) => Object.keys(t).length <= 200, 'at most 200 tools'),
    drafting: z.boolean().default(false),
  })
  .strict();

export const agentBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: scopesBody,
    /** Days until it stops working: 1-365. */
    expiresInDays: z.number().int().min(1).max(365).default(90),
  })
  .strict();

export const agentUpdateBody = z
  .object({ scopes: scopesBody.optional(), expiresInDays: z.number().int().min(1).max(365).optional() })
  .strict()
  .refine((b) => b.scopes || b.expiresInDays, 'scopes or expiresInDays');

export interface Agent {
  id: string;
  name: string;
  owner: { id: string; handle: string };
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** null: made before agent scopes; it can use everything its person can until restricted. */
  scopes: AgentScopes | null;
  state: 'active' | 'expired' | 'revoked';
  /** The app's name, for agents made by OAuth sign-in (Claude, ChatGPT, ...); null for token agents. */
  oauthApp: string | null;
  calls: { total: number; last7Days: number; waiting: number };
  /** Set while it is stopped automatically: its tool calls are refused until its person or an admin resumes it. */
  autoStop: { id: string; trigger: Trigger; triggerName: string; summary: string; trippedAt: Date } | null;
}

export interface AgentCall {
  id: string;
  agent: { id: string; name: string };
  tool: string;
  /** The Flow's name, for Flow tools. */
  title: string | null;
  /** What the agent asked to send, while the call waits for its person (shown only to them). */
  args?: unknown;
  status: string;
  error: string | null;
  runId: string | null;
  /** Whether what it changed can be reversed: ready, reversed, expired, ... (null: nothing to reverse). */
  undo: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/** How long a call may wait for its person before it lapses. */
export const CONFIRM_WITHIN_MS = 24 * 3600_000;
const aad = (id: string) => `agent-call:${id}:args`;

export class Agents {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  /** The person's agents; with all (admins only), every agent in the organization. */
  async list(actor: Member, all = false): Promise<Agent[]> {
    if (all && actor.role !== 'admin') throw forbidden('admin_only');
    const { rows } = await this.db.query<{
      id: string; name: string; member_id: string; handle: string; created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null;
      scopes: AgentScopes | null; oauth_client_name: string | null; total: number; recent: number; waiting: number;
    }>(
      `SELECT t.id, t.name, t.member_id, m.handle, t.created_at, t.last_used_at, t.expires_at, t.revoked_at, t.scopes, t.oauth_client_name,
              (SELECT count(*)::int FROM agent_calls c WHERE c.token_id = t.id) AS total,
              (SELECT count(*)::int FROM agent_calls c WHERE c.token_id = t.id AND c.created_at > now() - interval '7 days') AS recent,
              (SELECT count(*)::int FROM agent_calls c WHERE c.token_id = t.id AND c.status = 'awaiting_confirmation') AS waiting
       FROM mcp_tokens t JOIN members m ON m.id = t.member_id
       WHERE ($1 OR t.member_id = $2) AND (t.revoked_at IS NULL OR t.revoked_at > now() - interval '30 days')
       ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`,
      [all, actor.id],
    );
    const now = Date.now();
    const stops = new Map(
      (await this.db.query<{ id: string; subject_id: string; trigger: Trigger; summary: string; tripped_at: Date }>(
        `SELECT id, subject_id, trigger, evidence->>'summary' AS summary, tripped_at FROM autostops WHERE subject_type = 'agent' AND subject_id = ANY($1) AND resumed_at IS NULL`,
        [rows.map((r) => r.id)],
      )).rows.map((x) => [x.subject_id, { id: x.id, trigger: x.trigger, triggerName: TRIGGER_NAMES[x.trigger], summary: x.summary, trippedAt: x.tripped_at }]),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      owner: { id: r.member_id, handle: r.handle },
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      scopes: r.scopes,
      state: r.revoked_at ? 'revoked' : r.expires_at && r.expires_at.getTime() <= now ? 'expired' : 'active',
      oauthApp: r.oauth_client_name,
      calls: { total: r.total, last7Days: r.recent, waiting: r.waiting },
      autoStop: stops.get(r.id) ?? null,
    }));
  }

  /** Change what an agent may use, or extend it: its person only (admins revoke). */
  async update(actor: Member, id: string, body: z.infer<typeof agentUpdateBody>): Promise<void> {
    const t = await this.owned(actor, id, false);
    if (t.revoked_at) throw conflict('agent_revoked');
    if (body.scopes) await checkScopeTools(this.db, body.scopes);
    await this.db.query(
      `UPDATE mcp_tokens SET scopes = COALESCE($2, scopes), expires_at = COALESCE($3, expires_at) WHERE id = $1`,
      [id, body.scopes ? JSON.stringify(body.scopes) : null, body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null],
    );
    await audit(this.db, { actorId: actor.id, action: 'agent.updated', subjectType: 'member', subjectId: t.member_id, outcome: 'ok', relatedId: id });
  }

  /** Its person or an admin stops an agent at once. */
  async revoke(actor: Member, id: string): Promise<void> {
    const t = await this.owned(actor, id, true);
    await this.stop(id);
    await audit(this.db, { actorId: actor.id, action: 'mcp.token_revoked', subjectType: 'member', subjectId: t.member_id, outcome: 'ok', relatedId: id });
  }

  /** An agent's calls, newest first; or (no id) the person's calls that wait for them. */
  async calls(actor: Member, opts: { agentId?: string; waiting?: boolean }): Promise<AgentCall[]> {
    if (opts.agentId) await this.owned(actor, opts.agentId, true);
    await this.lapse();
    const { rows } = await this.db.query<{
      id: string; token_id: string; member_id: string; name: string; tool: string; title: string | null; status: string; error: string | null; run_id: string | null;
      args_enc: string | null; undo: string | null; created_at: Date; decided_at: Date | null;
    }>(
      `SELECT c.id, c.token_id, c.member_id, t.name, c.tool, f.name AS title, c.status, c.error, c.run_id, c.args_enc, c.created_at, c.decided_at,
              (SELECT u.status FROM undo_records u WHERE u.agent_call_id = c.id LIMIT 1) AS undo
       FROM agent_calls c JOIN mcp_tokens t ON t.id = c.token_id LEFT JOIN flows f ON c.tool = 'flow:' || f.id::text
       WHERE ${opts.agentId ? 'c.token_id = $1' : `c.member_id = $1 AND c.status = 'awaiting_confirmation'`}
       ORDER BY c.created_at DESC LIMIT 100`,
      [opts.agentId ?? actor.id],
    );
    return rows.map((r) => ({
      id: r.id,
      agent: { id: r.token_id, name: r.name },
      tool: r.tool,
      title: r.title,
      ...(r.args_enc && r.member_id === actor.id ? { args: (this.cipher.decryptJson(r.args_enc, aad(r.id)) as { args: unknown }).args } : {}),
      status: r.status,
      error: r.error,
      runId: r.run_id,
      undo: r.undo,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    }));
  }

  /**
   * Stop an agent: its token, its OAuth sign-in (access and refresh tokens die with it) and the
   * calls waiting for its person. The caller audits why.
   */
  async stop(id: string): Promise<void> {
    await this.db.query(`UPDATE mcp_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
    await this.db.query(`UPDATE mcp_oauth_grants SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL`, [id]);
    await this.db.query(`DELETE FROM mcp_oauth_tokens o USING mcp_oauth_grants g WHERE g.id = o.grant_id AND g.token_id = $1`, [id]);
    await this.db.query(`UPDATE agent_calls SET status = 'rejected', args_enc = NULL, decided_at = now() WHERE token_id = $1 AND status = 'awaiting_confirmation'`, [id]);
  }

  // ------------------------------------------------------------ for the MCP server

  /** Record a call the agent made. */
  async record(tokenId: string, memberId: string, tool: string, status: string, extra: { error?: string; runId?: string } = {}): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO agent_calls (token_id, member_id, tool, status, error, run_id, decided_at) VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
      [tokenId, memberId, tool, status, extra.error ?? null, extra.runId ?? null],
    );
    // A tool outside its scopes, again and again, stops the agent (src/governance/auto-stop.ts).
    if (status === 'denied') await noteBlockedCall(this.db, { agentId: tokenId, code: tool.slice(0, 80), kind: 'scope_denied' });
    return rows[0]!.id;
  }

  /** A call that waits for its person: kept with its arguments (encrypted) until they decide. */
  async ask(tokenId: string, member: Member, tool: string, args: unknown): Promise<string> {
    return this.db.query<{ id: string }>(`INSERT INTO agent_calls (token_id, member_id, tool, status) VALUES ($1, $2, $3, 'awaiting_confirmation') RETURNING id`, [tokenId, member.id, tool]).then(async (r) => {
      const id = r.rows[0]!.id;
      await this.db.query(`UPDATE agent_calls SET args_enc = $2 WHERE id = $1`, [id, this.cipher.encryptJson(args, aad(id))]);
      await notify(this.db, member.id, 'agent_confirmation_needed');
      return id;
    });
  }

  /**
   * The person decides a waiting call. On confirm, `run` makes the call as the agent would have
   * (with its arguments) and the outcome is recorded on it.
   */
  async decide(actor: Member, callId: string, decision: 'confirmed' | 'rejected', run: (tool: string, args: unknown, tokenId: string) => Promise<{ runId?: string; error?: string }>): Promise<AgentCall> {
    await this.lapse();
    const c = (await this.db.query<{ id: string; token_id: string; member_id: string; tool: string; status: string; args_enc: string | null }>(`SELECT * FROM agent_calls WHERE id = $1`, [callId])).rows[0];
    // Only the person the agent acts for decides; someone else's call reads as missing.
    if (!c || c.member_id !== actor.id) throw notFound('agent_call');
    if (c.status !== 'awaiting_confirmation') throw conflict('agent_call_not_waiting');
    const claimed = await this.db.query(`UPDATE agent_calls SET status = 'deciding' WHERE id = $1 AND status = 'awaiting_confirmation'`, [callId]);
    if (!claimed.rowCount) throw conflict('agent_call_not_waiting');
    let out: { runId?: string; error?: string } = {};
    try {
      if (decision === 'confirmed') out = await run(c.tool, this.cipher.decryptJson(c.args_enc!, aad(callId)), c.token_id);
    } catch {
      // Never left "deciding" with its arguments kept.
      out = { error: 'internal' };
    }
    const status = decision === 'rejected' ? 'rejected' : out.error ? 'failed' : 'done';
    await this.db.query(`UPDATE agent_calls SET status = $2, error = $3, run_id = $4, args_enc = NULL, decided_at = now() WHERE id = $1`, [callId, status, out.error ?? null, out.runId ?? null]);
    await audit(this.db, { actorId: actor.id, action: `agent.call_${decision}`, subjectType: 'member', subjectId: actor.id, outcome: 'ok', relatedId: callId });
    return (await this.calls(actor, { agentId: c.token_id })).find((x) => x.id === callId)!;
  }

  /** A call the agent asks about (get_call): its own calls only. */
  async callFor(tokenId: string, callId: string): Promise<{ status: string; error: string | null; runId: string | null } | null> {
    await this.lapse();
    const r = (await this.db.query<{ status: string; error: string | null; run_id: string | null }>(`SELECT status, error, run_id FROM agent_calls WHERE id = $1 AND token_id = $2`, [callId, tokenId])).rows[0];
    return r ? { status: r.status, error: r.error, runId: r.run_id } : null;
  }

  /** Calls nobody decided within a day lapse; their arguments are dropped. */
  private async lapse(): Promise<void> {
    await this.db.query(
      `UPDATE agent_calls SET status = 'expired', args_enc = NULL, decided_at = now() WHERE status = 'awaiting_confirmation' AND created_at < $1`,
      [new Date(Date.now() - CONFIRM_WITHIN_MS)],
    );
  }

  private async owned(actor: Member, id: string, adminToo: boolean): Promise<{ member_id: string; revoked_at: Date | null }> {
    const t = (await this.db.query<{ member_id: string; revoked_at: Date | null }>(`SELECT member_id, revoked_at FROM mcp_tokens WHERE id = $1`, [id])).rows[0];
    if (!t || (t.member_id !== actor.id && !(adminToo && actor.role === 'admin'))) throw notFound('agent');
    return t;
  }
}

/** Offboarding: stop every agent of a person at once. Returns the agents stopped; the caller audits them. */
export async function revokeAgentsOf(db: Queryable, memberId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`UPDATE mcp_tokens SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL RETURNING id`, [memberId]);
  // Connections an AI app signed in for (OAuth) end with their agents.
  await db.query(`UPDATE mcp_oauth_grants g SET revoked_at = now() FROM mcp_tokens t WHERE t.id = g.token_id AND t.member_id = $1 AND g.revoked_at IS NULL`, [memberId]);
  await db.query(`DELETE FROM mcp_oauth_tokens o USING mcp_oauth_grants g, mcp_tokens t WHERE g.id = o.grant_id AND t.id = g.token_id AND t.member_id = $1`, [memberId]);
  await db.query(`UPDATE agent_calls SET status = 'rejected', args_enc = NULL, decided_at = now() WHERE member_id = $1 AND status = 'awaiting_confirmation'`, [memberId]);
  return rows.map((r) => r.id);
}

/** Whether an agent may use a tool, and how. Tokens made before scopes may use everything (`run`). */
export function grantFor(scopes: AgentScopes | null, key: string): Grant | null {
  // Older tokens keep what they could use before: Flows, not module actions.
  if (!scopes) return key.startsWith('flow:') ? 'run' : null;
  return scopes.tools[key] ?? null;
}

export async function checkScopeTools(db: Queryable, scopes: AgentScopes): Promise<void> {
  const keys = Object.keys(scopes.tools);
  const flows = keys.filter((k) => k.startsWith('flow:')).map((k) => k.slice(5));
  const actions = keys.filter((k) => k.startsWith('action:')).map((k) => k.slice(7));
  const known = new Set<string>();
  if (flows.length) for (const r of (await db.query<{ id: string }>(`SELECT id FROM flows WHERE id = ANY($1)`, [flows])).rows) known.add(`flow:${r.id}`);
  if (actions.length) for (const r of (await db.query<{ k: string }>(`SELECT module_name || '/' || action AS k FROM gateway_tools WHERE module_name || '/' || action = ANY($1)`, [actions])).rows) known.add(`action:${r.k}`);
  const missing = keys.filter((k) => !known.has(k));
  if (missing.length) throw badRequest('unknown_tool', `not offered: ${missing.join(', ')}`);
}

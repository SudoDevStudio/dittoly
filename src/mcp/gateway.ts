import { z } from 'zod';
import { audit } from '../core/audit.js';
import { sha256Hex, type Cipher } from '../core/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { notifyRole } from '../core/notify.js';
import { canUseTeam } from '../core/teams.js';
import type { Db } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import { recordUndo } from '../engine/undo.js';
import type { FlowDefinition } from '../flows/definition.js';
import { checkRunStart } from '../governance/policies.js';
import { hostMatches } from '../modules/manifest.js';
import { moduleRef, type ModuleRegistry, type ModuleVersion } from '../modules/registry.js';
import { canonicalJson } from '../runtime/crypto.js';
import type { ManifestAction } from '../runtime/types.js';

/**
 * The MCP gateway: an admin offers single actions of approved modules (including modules
 * imported from MCP servers) to AI agents as tools. Each tool is pinned to one approved module
 * version and to the name, description and schemas that were approved; if any of that changes
 * (a tampered row, or an imported MCP server that rewrites its tool) the tool is blocked until an
 * admin offers it again. A call runs as the agent's person, through the broker, with that
 * person's access (or the team's shared account, where the team set one), like a Flow step.
 */

export const offerBody = z
  .object({
    moduleVersionId: z.string().uuid(),
    action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    teamId: z.string().uuid(),
    /** What the module needs to know here (its declared settings): a module keeps no configuration of its own. */
    settings: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(300)).optional(),
  })
  .strict();

export interface GatewayTool {
  id: string;
  /** The key an agent's scopes name it by: action:<module>/<action>. */
  key: string;
  /** The MCP tool name. */
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  changesData: boolean;
  module: { name: string; version: string; title: string };
  action: string;
  teamId: string;
  /** What the module is configured with here (a module keeps no configuration of its own). */
  settings: Record<string, string>;
  pin: string;
  status: 'active' | 'changed';
  changedReason: string | null;
}

interface Row {
  id: string; module_name: string; action: string; module_version_id: string; team_id: string; settings: Record<string, string> | null; pin_sha256: string; status: 'active' | 'changed'; changed_reason: string | null;
}

/** What is pinned: everything the agent is shown and the call is checked against. */
export function pinOf(m: ModuleVersion, a: ManifestAction): string {
  return sha256Hex(
    canonicalJson({ module: moduleRef(m), manifest: m.manifestSha256, name: a.name, title: a.title, description: a.description, effect: a.effect, input: a.input, output: a.output, ...(a.undo ? { undo: a.undo } : {}) }),
  );
}

const toolNameOf = (module: string, action: string) => `app_${module.replace(/-/g, '_')}_${action}`.slice(0, 128);
/** Errors meaning the app's tool is no longer the one approved. */
const CHANGED = new Set(['mcp_tool_changed', 'mcp_tool_missing']);

export class Gateway {
  constructor(
    private readonly db: Db,
    private readonly modules: ModuleRegistry,
    private readonly engine: Engine,
    private readonly cipher: Cipher,
  ) {}

  /** Every offered tool, for admins: including blocked ones. */
  async list(actor: Member): Promise<GatewayTool[]> {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    return this.load();
  }

  /** Tools this member may give their agents: offered to a team they are in, still as approved. */
  async eligible(member: Member): Promise<GatewayTool[]> {
    const out: GatewayTool[] = [];
    for (const t of await this.load()) if (t.status === 'active' && (await canUseTeam(this.db, t.teamId, member))) out.push(t);
    return out;
  }

  async offer(actor: Member, body: z.infer<typeof offerBody>): Promise<GatewayTool> {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const m = await this.modules.get(this.db, body.moduleVersionId);
    if (!m) throw notFound('module');
    if (m.status !== 'approved') throw conflict('module_not_approved');
    const a = m.manifest.actions.find((x) => x.name === body.action);
    if (!a) throw badRequest('unknown_action', `${m.name} has no action ${body.action}`);
    if (!(await this.db.query(`SELECT 1 FROM teams WHERE id = $1`, [body.teamId])).rowCount) throw notFound('team');
    // The module keeps no configuration: an offered tool carries its own (a host must match the declared pattern).
    const settings = body.settings ?? {};
    for (const st of m.manifest.settings ?? []) {
      if (st.type === 'host' && !(settings[st.id] && hostMatches(st.pattern, settings[st.id]!.toLowerCase()))) {
        throw badRequest('setting_required', `settings.${st.id} (${st.label}): a host matching ${st.pattern}`);
      }
    }
    for (const id of Object.keys(settings)) if (!(m.manifest.settings ?? []).some((st) => st.id === id)) throw badRequest('unknown_setting', id);
    // "foo-bar/baz" and "foo/bar_baz" would both be app_foo_bar_baz: an agent must never get one while reading the other.
    const clash = (await this.load()).find((t) => t.name === toolNameOf(m.name, a.name) && !(t.module.name === m.name && t.action === a.name));
    if (clash) throw conflict('tool_name_taken');
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO gateway_tools (module_name, action, module_version_id, team_id, settings, pin_sha256, offered_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (module_name, action) DO UPDATE SET module_version_id = $3, team_id = $4, settings = $5, pin_sha256 = $6, offered_by = $7, offered_at = now(), status = 'active', changed_reason = NULL
       RETURNING id`,
      [m.name, a.name, m.id, body.teamId, JSON.stringify(settings), pinOf(m, a), actor.id],
    );
    await audit(this.db, { actorId: actor.id, action: 'gateway.tool_offered', subjectType: 'module', subjectId: m.id, outcome: 'ok', relatedId: rows[0]!.id });
    return (await this.load()).find((t) => t.id === rows[0]!.id)!;
  }

  async remove(actor: Member, id: string): Promise<void> {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const r = await this.db.query<{ module_version_id: string }>(`DELETE FROM gateway_tools WHERE id = $1 RETURNING module_version_id`, [id]);
    if (!r.rowCount) throw notFound('gateway_tool');
    await audit(this.db, { actorId: actor.id, action: 'gateway.tool_removed', subjectType: 'module', subjectId: r.rows[0]!.module_version_id, outcome: 'ok', relatedId: id });
  }

  /**
   * Run a tool as `member`. `pin` (from when an agent asked) must still match: a call confirmed
   * later runs only what the person saw.
   */
  async invoke(member: Member, key: string, args: unknown, pin?: string): Promise<{ output: unknown; undoId: string | null }> {
    const t = (await this.load()).find((x) => x.key === key);
    if (!t) throw notFound('gateway_tool');
    if (t.status !== 'active') throw conflict('tool_changed_since_approved');
    if (pin && pin !== t.pin) throw conflict('tool_changed_since_asked');
    if (!(await canUseTeam(this.db, t.teamId, member))) throw forbidden('not_in_team');
    const m = (await this.modules.get(this.db, (await this.row(t.id)).module_version_id))!;
    // The organization's run rules (hours, daily limits) apply as to a one-step Flow.
    const ref = moduleRef(m);
    const def = { inputs: { type: 'object', properties: {} }, steps: [{ id: 'call', type: 'action', module: ref, action: t.action, input: {} }] } as unknown as FlowDefinition;
    await checkRunStart(this.db, member.id, def, new Map([[ref, m]]));
    try {
      const output = await this.engine.invokeOutsideRun(m, t.action, args, t.teamId, await this.engine.secretResolver(t.teamId, m.name, member.id), { settings: t.settings });
      await audit(this.db, { actorId: member.id, action: 'gateway.tool_called', subjectType: 'module', subjectId: m.id, outcome: 'ok', relatedId: t.id });
      const action = m.manifest.actions.find((a) => a.name === t.action)!;
      const undoId = await recordUndo(this.db, this.cipher, { module: m, action, input: args, output, memberId: member.id, teamId: t.teamId });
      return { output, undoId };
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'internal';
      await audit(this.db, { actorId: member.id, action: 'gateway.tool_called', subjectType: 'module', subjectId: m.id, outcome: 'failed', errorType: code, relatedId: t.id });
      if (CHANGED.has(code)) await this.block(t.id, code);
      throw err;
    }
  }

  /** The app's tool changed after approval: nobody uses it until an admin offers it again. */
  private async block(id: string, reason: string): Promise<void> {
    const r = await this.db.query(`UPDATE gateway_tools SET status = 'changed', changed_reason = $2 WHERE id = $1 AND status = 'active'`, [id, reason]);
    if (r.rowCount) {
      await audit(this.db, { actorId: null, action: 'gateway.tool_blocked', subjectType: 'module', subjectId: id, outcome: 'denied', errorType: reason });
      await notifyRole(this.db, ['admin'], 'gateway_tool_blocked');
    }
  }

  private async row(id: string): Promise<Row> {
    return (await this.db.query<Row>(`SELECT * FROM gateway_tools WHERE id = $1`, [id])).rows[0]!;
  }

  private async load(): Promise<GatewayTool[]> {
    const { rows } = await this.db.query<Row>(`SELECT * FROM gateway_tools ORDER BY module_name, action`);
    const out: GatewayTool[] = [];
    for (const r of rows) {
      const m = await this.modules.get(this.db, r.module_version_id);
      const a = m?.manifest.actions.find((x) => x.name === r.action);
      let status = r.status;
      let reason = r.changed_reason;
      // The module version must still be approved and still be exactly what was pinned.
      if (!m || !a || m.status !== 'approved') (status = 'changed'), (reason = 'module_not_approved');
      else if (pinOf(m, a) !== r.pin_sha256) (status = 'changed'), (reason = 'pin_mismatch');
      const write = a?.effect === 'write';
      out.push({
        id: r.id,
        key: `action:${r.module_name}/${r.action}`,
        name: toolNameOf(r.module_name, r.action),
        title: a ? `${m!.manifest.title}: ${a.title}` : r.action,
        description: a
          ? [a.description, `An action of the approved Dittoly module ${m!.manifest.title} (${moduleRef(m!)}).`, write ? 'It changes data in the app.' : 'It only reads data.', 'It runs as you, with your own access.'].join(' ')
          : '',
        inputSchema: a?.input ?? { type: 'object', properties: {} },
        changesData: write,
        module: { name: r.module_name, version: m?.version ?? '', title: m?.manifest.title ?? r.module_name },
        action: r.action,
        teamId: r.team_id,
        settings: r.settings ?? {},
        pin: r.pin_sha256,
        status,
        changedReason: reason,
      });
    }
    return out;
  }
}

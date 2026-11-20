import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { assertTeamMember } from '../core/teams.js';
import type { Db } from '../db/db.js';
import type { FlowService } from '../flows/service.js';

/**
 * Follow-up Flows: "when my run of Flow A finishes, run Flow B". The engine
 * starts them when a run finishes (Engine.startFollowups). Like a schedule, a
 * follow-up is pinned to one approved version, runs only as the member who set
 * it up, and only after that member's own runs, so it never sees anyone else's
 * run data.
 */

export const followupAad = (id: string) => `followup:${id}:inputs`;

const TEMPLATE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

const createSchema = z
  .object({
    sourceFlowId: z.string().uuid(),
    targetVersionId: z.string().uuid(),
    on: z.enum(['succeeded', 'failed', 'finished']).default('succeeded'),
    /** Target inputs: fixed values or {{ inputs.x }} / {{ steps.<id>.output.y }} from the finished run. */
    inputs: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

function templatePaths(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') for (const m of v.matchAll(TEMPLATE)) out.push(m[1]!);
  else if (Array.isArray(v)) v.forEach((x) => templatePaths(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => templatePaths(x, out));
  return out;
}

interface Row {
  id: string;
  source_flow_id: string;
  target_version_id: string;
  run_as: string;
  on_status: 'succeeded' | 'failed' | 'finished';
  enabled: boolean;
  disabled_reason: string | null;
  last_run_id: string | null;
  created_at: Date;
  source_name: string;
  target_name: string;
  target_version: number;
}

export class Followups {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly flows: FlowService,
  ) {}

  async create(body: unknown, actor: Member): Promise<{ id: string }> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw badRequest('invalid_followup', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const f = parsed.data;
    await this.flows.assertCanSee(this.db, actor, { flowId: f.sourceFlowId });
    // It runs as its creator, who must be able to run the target.
    await assertTeamMember(this.db, await this.flows.teamOfVersion(this.db, f.targetVersionId), actor);
    const { version } = await this.flows.assertRunnable(this.db, f.targetVersionId);
    if (version.flowId === f.sourceFlowId) throw badRequest('invalid_followup', 'a Flow cannot follow itself');
    const bad = templatePaths(f.inputs).filter((p) => !/^inputs\.[A-Za-z0-9_]+/.test(p) && !/^steps\.[a-z][a-z0-9_]*\.output(\.|$)/.test(p));
    if (bad.length) throw badRequest('invalid_followup', `inputs: use {{ inputs.<name> }} or {{ steps.<id>.output.<field> }} of the finished run, not ${bad.join(', ')}`);
    const schema = version.definition.inputs as { required?: string[]; properties?: Record<string, unknown> };
    const missing = (schema.required ?? []).filter((k) => !(k in f.inputs));
    if (missing.length) throw badRequest('invalid_followup', `inputs: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required by the Flow`);
    const unknown = Object.keys(f.inputs).filter((k) => schema.properties && !(k in schema.properties));
    if (unknown.length) throw badRequest('invalid_followup', `inputs: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not inputs of the Flow`);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO flow_followups (id, source_flow_id, target_version_id, run_as, on_status, inputs_enc) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, f.sourceFlowId, f.targetVersionId, actor.id, f.on, this.cipher.encryptJson(f.inputs, followupAad(id))],
    );
    await audit(this.db, { actorId: actor.id, action: 'followup.created', subjectType: 'trigger', subjectId: id, outcome: 'ok', relatedId: f.sourceFlowId });
    return { id };
  }

  /** The member's own follow-ups (admins see all), optionally for one source Flow. */
  async list(actor: Member, sourceFlowId?: string) {
    const { rows } = await this.db.query<Row>(
      `SELECT f.*, s.name AS source_name, t.name AS target_name, v.version AS target_version
       FROM flow_followups f JOIN flows s ON s.id = f.source_flow_id
       JOIN flow_versions v ON v.id = f.target_version_id JOIN flows t ON t.id = v.flow_id
       WHERE (f.run_as = $1 OR $2) AND ($3::uuid IS NULL OR f.source_flow_id = $3)
       ORDER BY f.created_at`,
      [actor.id, actor.role === 'admin', sourceFlowId ?? null],
    );
    return Promise.all(rows.map(async (r) => ({
      id: r.id,
      source: { flowId: r.source_flow_id, name: r.source_name },
      target: { versionId: r.target_version_id, name: r.target_name, version: r.target_version },
      on: r.on_status,
      runAs: r.run_as,
      mine: r.run_as === actor.id,
      // The input mapping is shown only to its owner (it can hold fixed values).
      inputs: r.run_as === actor.id ? await this.inputsOf(r.id) : null,
      enabled: r.enabled,
      disabledReason: r.disabled_reason,
      lastRunId: r.run_as === actor.id ? r.last_run_id : null,
    })));
  }

  private async inputsOf(id: string): Promise<unknown> {
    const r = await this.db.query<{ inputs_enc: string }>(`SELECT inputs_enc FROM flow_followups WHERE id = $1`, [id]);
    return r.rows[0] ? this.cipher.decryptJson(r.rows[0].inputs_enc, followupAad(id)) : null;
  }

  private async own(id: string, actor: Member): Promise<Row> {
    const row = (await this.db.query<Row>(`SELECT * FROM flow_followups WHERE id = $1`, [id])).rows[0];
    if (!row) throw notFound('followup');
    if (row.run_as !== actor.id && actor.role !== 'admin') throw forbidden();
    return row;
  }

  async setEnabled(id: string, actor: Member, enabled: boolean): Promise<void> {
    const row = await this.own(id, actor);
    if (enabled) await this.flows.assertRunnable(this.db, row.target_version_id);
    await this.db.query(`UPDATE flow_followups SET enabled = $2, disabled_reason = NULL WHERE id = $1`, [id, enabled]);
    await audit(this.db, { actorId: actor.id, action: enabled ? 'followup.enabled' : 'followup.disabled', subjectType: 'trigger', subjectId: id, outcome: 'ok' });
  }

  async remove(id: string, actor: Member): Promise<void> {
    await this.own(id, actor);
    await this.db.query(`DELETE FROM flow_followups WHERE id = $1`, [id]);
    await audit(this.db, { actorId: actor.id, action: 'followup.deleted', subjectType: 'trigger', subjectId: id, outcome: 'ok' });
  }
}

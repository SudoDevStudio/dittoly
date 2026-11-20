import { z } from 'zod';
import { audit } from '../core/audit.js';
import { constantTimeEqual, randomToken, sha256Hex } from '../core/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import { getMember, type Member } from '../core/members.js';
import { canUseTeam } from '../core/teams.js';
import type { Db, Queryable } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import type { FlowService } from '../flows/service.js';
import { pointer, takeToken } from '../webhooks/service.js';

/** The header callers send the token in. */
export const TOKEN_HEADER = 'x-sflow-token';
const DEFAULT_RATE = 60;
const MAX_OVERLAP_SECONDS = 7 * 86_400;

/**
 * Flow input name -> JSON Pointer into the posted body ("" for the whole body). With it, only these values
 * reach the Flow, so a sender's own payload can start it; without it, the body is the Flow's inputs.
 */
/**
 * The name of a Flow's only input when it takes any JSON (no "type"), e.g. { "payload": {} }: a Flow
 * URL then passes the whole body there, so senders post whatever they have, with no mapping.
 */
export function anyJsonInput(inputs: unknown): string | null {
  const props = (inputs as { properties?: Record<string, unknown> } | null | undefined)?.properties ?? {};
  const names = Object.keys(props);
  if (names.length !== 1) return null;
  const schema = props[names[0]!];
  return schema && typeof schema === 'object' && !('type' in schema) && !('enum' in schema) && !('const' in schema) && !('$ref' in schema) ? names[0]! : null;
}

type Schema = { type?: unknown; properties?: Record<string, Schema> } & Record<string, unknown>;

/** A value found under this name anywhere in the body (breadth-first, the exact name before any casing). */
function findByName(body: unknown, name: string): unknown {
  const lower = name.toLowerCase();
  let level: unknown[] = [body];
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next: unknown[] = [];
    let loose: unknown;
    for (const v of level) {
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { next.push(...v.slice(0, 50)); continue; }
      const o = v as Record<string, unknown>;
      if (Object.hasOwn(o, name)) return o[name];
      if (loose === undefined) loose = Object.entries(o).find(([k]) => k.toLowerCase() === lower)?.[1];
      next.push(...Object.values(o));
    }
    if (loose !== undefined) return loose;
    level = next;
  }
  return undefined;
}

/** A value shaped for an input's declared type, where that is plain: JSON as text for a text input, one item as a list. */
function shaped(schema: Schema | undefined, v: unknown): unknown {
  const type = Array.isArray(schema?.type) ? schema?.type[0] : schema?.type;
  if (type === 'string' && typeof v !== 'string') return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (type === 'array' && !Array.isArray(v)) return [v];
  return v;
}

/**
 * A sender's JSON as the Flow's inputs, whatever its shape, when it is not already exactly them (and no
 * body mapping is set):
 * - a Flow with one input gets the whole body there (as text, for a text input);
 * - otherwise each input takes the field of the same name, wherever it is in the body (e.g. "stack" from
 *   error.stack); other fields are ignored, and a required input found nowhere is still reported.
 * Returns null when the body already fits.
 */
export function fitBody(inputs: unknown, body: unknown): Record<string, unknown> | null {
  const props = ((inputs ?? {}) as Schema).properties ?? {};
  const names = Object.keys(props);
  const plain = body !== null && typeof body === 'object' && !Array.isArray(body);
  if (plain && Object.keys(body as object).every((k) => names.includes(k))) return null;
  if (names.length === 1) return { [names[0]!]: shaped(props[names[0]!], body) };
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const v = findByName(body, name);
    if (v !== undefined) out[name] = shaped(props[name], v);
  }
  return out;
}

export const inputMapSchema = z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), z.string().max(200).regex(/^(\/[^/]*)*$/)).refine((m) => Object.keys(m).length <= 50, 'at most 50 inputs');

export const createEndpointSchema = z
  .object({
    inputMap: inputMapSchema.optional(),
    name: z.string().trim().min(1).max(80),
    /** Pin this approved version; leave out to follow the latest approved version. */
    versionId: z.string().uuid().optional(),
    followLatest: z.boolean().default(false),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
  })
  .strict();

interface Row {
  id: string;
  flow_id: string;
  flow_version_id: string | null;
  run_as: string;
  name: string;
  token_hash: string;
  prev_token_hash: string | null;
  prev_expires_at: Date | null;
  expires_at: Date | null;
  enabled: boolean;
  rate_limit_per_minute: number;
  input_map: Record<string, string> | null;
  last_used_at: Date | null;
  created_at: Date;
}

/** An error the caller of a Flow URL gets, as `{ error }` with this HTTP status. */
export class EndpointError extends AppError {}

const newToken = () => `sflow_${randomToken(32)}`;
const hash = (token: string) => sha256Hex(token);

/**
 * Flow URLs: each one starts runs of one Flow for any caller that
 * presents its token in the x-sflow-token header. Runs are the creator's, with
 * their own access, so a URL is as powerful as the creator's run button for
 * that Flow, and no more: the version must be approved, the creator must
 * still be in its team, and inputs are checked against the Flow's schema.
 */
export class FlowEndpoints {
  constructor(
    private readonly db: Db,
    private readonly flows: FlowService,
    private readonly engine: Engine,
    private readonly publicUrl: string,
  ) {}

  // ------------------------------------------------------------------ members

  async create(flowId: string, body: unknown, actor: Member) {
    const r = createEndpointSchema.safeParse(body);
    if (!r.success) throw badRequest('invalid_request', r.error.issues.map((i) => i.path.join('.') || '(root)').join(', '));
    const input = r.data;
    await this.flows.assertCanSee(this.db, actor, { flowId });
    const team = (await this.db.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [flowId])).rows[0];
    if (!team) throw notFound('flow');
    // A URL runs as you, so you must be able to run the Flow yourself.
    if (!(await canUseTeam(this.db, team.team_id, actor))) throw forbidden('not_in_team');
    if (input.followLatest === Boolean(input.versionId)) throw badRequest('choose_version_or_latest', 'Pin one approved version, or follow the latest approved version.');
    if (input.versionId) {
      const v = await this.flows.getVersion(this.db, input.versionId);
      if (!v || v.flowId !== flowId) throw notFound('flow_version');
      if (v.status !== 'approved') throw conflict('flow_version_not_approved');
    }
    if (input.expiresAt && new Date(input.expiresAt) <= new Date()) throw badRequest('expiry_in_the_past');
    if (input.inputMap) await this.checkInputMap(flowId, input.versionId ?? null, input.inputMap);
    const token = newToken();
    const { rows } = await this.db.query<Row>(
      `INSERT INTO flow_endpoints (flow_id, flow_version_id, run_as, name, token_hash, expires_at, rate_limit_per_minute, input_map)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [flowId, input.versionId ?? null, actor.id, input.name, hash(token), input.expiresAt ?? null, input.rateLimitPerMinute ?? DEFAULT_RATE, input.inputMap ? JSON.stringify(input.inputMap) : null],
    );
    await audit(this.db, { actorId: actor.id, action: 'endpoint.created', subjectType: 'endpoint', subjectId: rows[0]!.id, outcome: 'ok', relatedId: flowId });
    // The token is shown this once; only its hash is kept.
    return { ...(await this.view(rows[0]!)), token };
  }

  /** The URLs of a Flow: your own; admins see everyone's. */
  async list(flowId: string, actor: Member) {
    await this.flows.assertCanSee(this.db, actor, { flowId });
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM flow_endpoints WHERE flow_id = $1 AND (run_as = $2 OR $3) ORDER BY created_at`,
      [flowId, actor.id, actor.role === 'admin'],
    );
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** A new token. With an overlap, the old one keeps working that long (for switching callers over). */
  async rotate(id: string, actor: Member, overlapSeconds = 0) {
    if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > MAX_OVERLAP_SECONDS) throw badRequest('invalid_overlap');
    const row = await this.own(id, actor);
    const token = newToken();
    const { rows } = await this.db.query<Row>(
      `UPDATE flow_endpoints SET token_hash = $2, prev_token_hash = $3, prev_expires_at = $4 WHERE id = $1 RETURNING *`,
      [id, hash(token), overlapSeconds ? row.token_hash : null, overlapSeconds ? new Date(Date.now() + overlapSeconds * 1000) : null],
    );
    await audit(this.db, { actorId: actor.id, action: 'endpoint.rotated', subjectType: 'endpoint', subjectId: id, outcome: 'ok' });
    return { ...(await this.view(rows[0]!)), token };
  }

  async update(id: string, actor: Member, patch: { enabled?: boolean | undefined; expiresAt?: string | null | undefined; inputMap?: Record<string, string> | null | undefined }) {
    const row = await this.own(id, actor);
    if (patch.expiresAt && new Date(patch.expiresAt) <= new Date()) throw badRequest('expiry_in_the_past');
    if (patch.inputMap) await this.checkInputMap(row.flow_id, row.flow_version_id, patch.inputMap);
    const { rows } = await this.db.query<Row>(
      `UPDATE flow_endpoints SET enabled = COALESCE($2, enabled), expires_at = CASE WHEN $3 THEN $4::timestamptz ELSE expires_at END,
              input_map = CASE WHEN $5 THEN $6::jsonb ELSE input_map END WHERE id = $1 RETURNING *`,
      [id, patch.enabled ?? null, patch.expiresAt !== undefined, patch.expiresAt ?? null, patch.inputMap !== undefined, patch.inputMap ? JSON.stringify(patch.inputMap) : null],
    );
    if (patch.inputMap !== undefined) {
      await audit(this.db, { actorId: actor.id, action: 'endpoint.input_map_changed', subjectType: 'endpoint', subjectId: id, outcome: 'ok' });
    }
    if (patch.enabled !== undefined) {
      await audit(this.db, { actorId: actor.id, action: patch.enabled ? 'endpoint.enabled' : 'endpoint.disabled', subjectType: 'endpoint', subjectId: id, outcome: 'ok' });
    }
    return this.view(rows[0]!);
  }

  async remove(id: string, actor: Member): Promise<void> {
    await this.own(id, actor);
    await this.db.query(`DELETE FROM flow_endpoints WHERE id = $1`, [id]);
    await audit(this.db, { actorId: actor.id, action: 'endpoint.deleted', subjectType: 'endpoint', subjectId: id, outcome: 'ok' });
  }

  // ------------------------------------------------------------------ callers

  /** Start a run. Answers with the run id and where to poll for its status. */
  async call(id: string, token: string | undefined, inputs: unknown): Promise<{ runId: string; status: string; statusUrl: string }> {
    const row = await this.authenticate(id, token);
    if (!(await takeToken(this.db, `sflow:${row.id}`, row.rate_limit_per_minute))) throw new EndpointError('rate_limited', 429);
    const versionId = row.flow_version_id ?? (await this.latestApproved(row.flow_id));
    if (!versionId) throw new EndpointError('no_approved_version', 409);
    await this.db.query(`UPDATE flow_endpoints SET last_used_at = now() WHERE id = $1`, [row.id]);
    // With an input map, only the mapped values reach the Flow (missing ones are left out, as for webhooks).
    let given = inputs ?? {};
    // Without a body mapping, any JSON is accepted: it is fitted to the Flow's inputs (fitBody).
    const fitted = row.input_map ? null : fitBody((await this.flows.getVersion(this.db, versionId))?.definition.inputs, given);
    if (fitted) given = fitted;
    else if (row.input_map) {
      const mapped: Record<string, unknown> = {};
      for (const [name, ptr] of Object.entries(row.input_map)) {
        const v = pointer(given, ptr);
        if (v !== undefined) mapped[name] = v;
      }
      given = mapped;
    }
    const runId = await this.engine.startRun(versionId, row.run_as, given, { actorId: row.run_as, endpointId: row.id });
    log.info('endpoint_run_started', { runId, memberId: row.run_as });
    return { runId, status: 'running', statusUrl: `${this.publicUrl}/sflow/${row.id}/runs/${runId}` };
  }

  /** A run this URL started: status, and each step's status and output. */
  async status(id: string, token: string | undefined, runId: string) {
    const row = await this.authenticate(id, token, { allowDisabled: true });
    const owned = (await this.db.query(`SELECT 1 FROM runs WHERE id = $1 AND endpoint_id = $2`, [runId, row.id])).rowCount;
    if (!owned) throw new EndpointError('run_not_found', 404);
    const member = await getMember(this.db, row.run_as);
    if (!member) throw new EndpointError('run_not_found', 404);
    const run = await this.engine.runView(runId, member);
    return {
      runId: run.id,
      flow: run.flowName,
      version: run.version,
      status: run.status,
      waitReason: run.waitReason,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      steps: run.steps.map((s) => ({ id: s.id, status: s.status, errorType: s.errorType, output: s.output })),
    };
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Unknown URL and wrong token look the same to the caller. Disabled and
   * expired URLs say so, but only to someone holding the right token.
   */
  private async authenticate(id: string, token: string | undefined, opts: { allowDisabled?: boolean } = {}): Promise<Row> {
    const row = /^[0-9a-f-]{36}$/i.test(id) ? (await this.db.query<Row>(`SELECT * FROM flow_endpoints WHERE id = $1`, [id])).rows[0] : undefined;
    const given = token ? hash(token) : '';
    const current = !!row && constantTimeEqual(given, row.token_hash);
    const previous = !!row?.prev_token_hash && !!row.prev_expires_at && row.prev_expires_at > new Date() && constantTimeEqual(given, row.prev_token_hash);
    if (!row || !token || (!current && !previous)) {
      log.warn('endpoint_unauthorized', {});
      throw new EndpointError('invalid_token', 401);
    }
    if (row.expires_at && row.expires_at <= new Date()) throw new EndpointError('endpoint_expired', 410);
    if (!row.enabled && !opts.allowDisabled) throw new EndpointError('endpoint_disabled', 403);
    return row;
  }

  /** Every mapped name must be an input of the Flow version the URL runs (the pinned one, else the latest approved). */
  private async checkInputMap(flowId: string, versionId: string | null, map: Record<string, string>): Promise<void> {
    const id = versionId ?? (await this.latestApproved(flowId));
    const v = id ? await this.flows.getVersion(this.db, id) : null;
    const known = Object.keys((v?.definition.inputs as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
    const unknown = Object.keys(map).filter((n) => !known.includes(n));
    if (v && unknown.length) throw badRequest('unknown_flow_input', `${unknown.join(', ')}: not an input of this Flow (its inputs: ${known.join(', ') || 'none'})`);
  }

  private async latestApproved(flowId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM flow_versions WHERE flow_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1`,
      [flowId],
    );
    return rows[0]?.id ?? null;
  }

  private async own(id: string, actor: Member): Promise<Row> {
    const row = (await this.db.query<Row>(`SELECT * FROM flow_endpoints WHERE id = $1`, [id])).rows[0];
    if (!row || (row.run_as !== actor.id && actor.role !== 'admin')) throw notFound('endpoint');
    return row;
  }

  private async view(r: Row, db: Queryable = this.db) {
    const version = r.flow_version_id ? (await db.query<{ version: number; status: string }>(`SELECT version, status FROM flow_versions WHERE id = $1`, [r.flow_version_id])).rows[0] : null;
    const handle = (await db.query<{ handle: string }>(`SELECT handle FROM members WHERE id = $1`, [r.run_as])).rows[0]?.handle ?? null;
    const expired = !!r.expires_at && r.expires_at <= new Date();
    return {
      id: r.id,
      name: r.name,
      url: `${this.publicUrl}/sflow/${r.id}`,
      runAs: handle,
      followsLatest: r.flow_version_id === null,
      version: version?.version ?? null,
      versionStatus: version?.status ?? null,
      enabled: r.enabled,
      expiresAt: r.expires_at,
      expired,
      previousTokenValidUntil: r.prev_token_hash && r.prev_expires_at && r.prev_expires_at > new Date() ? r.prev_expires_at : null,
      rateLimitPerMinute: r.rate_limit_per_minute,
      inputMap: r.input_map,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
    };
  }
}

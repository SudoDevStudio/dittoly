import { assertTeamMember } from '../core/teams.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { audit } from '../core/audit.js';
import { sha256Hex, type Cipher } from '../core/crypto.js';
import { badRequest, forbidden, notFound, AppError } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import type { Member } from '../core/members.js';
import type { Db } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import type { FlowService } from '../flows/service.js';
import { ajv } from '../modules/manifest.js';
import type { WebhookQueue } from './queue.js';
import {
  checkTokenPayload,
  newGithubSecret,
  newStandardSecret,
  newTokenSecret,
  verifyGithub,
  verifyGitlab,
  verifyStandard,
  verifyToken,
  type Provider,
  type TokenPayloadOptions,
} from '../runtime/verify.js';

const jsonPointer = z.string().max(200).regex(/^(\/[^/]*)*$/);

export const createTriggerSchema = z
  .object({
    flowVersionId: z.string().uuid(),
    /** "token": for senders that cannot sign (Datadog, Grafana, Vector, Fluent Bit); a secret token in a header. */
    provider: z.enum(['standard', 'github', 'gitlab', 'token']),
    /** JSON Schema the raw payload must match. */
    payloadSchema: z.record(z.string(), z.unknown()),
    /** Flow input name -> JSON Pointer into the payload. Only these values reach the Flow. */
    inputMap: z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), z.string().regex(/^(\/[^/]*)*$/)),
    rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
    /** GitLab only: old X-Gitlab-Token accepted until this many days from now, while migrating. */
    legacyGitlabToken: z.string().min(16).max(256).optional(),
    legacyGitlabTokenDays: z.number().int().min(1).max(90).optional(),
    /** Token only: the payload's own delivery id (e.g. Datadog's $ID), so a resend is one delivery. */
    deliveryIdPointer: jsonPointer.optional(),
    /** Token only: the payload's event time (epoch seconds or ms, or ISO 8601); older deliveries are refused. */
    timestampPointer: jsonPointer.optional(),
    /** Token only: how old that time may be (default: the server's webhook tolerance). */
    maxAgeSeconds: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

interface TriggerRow {
  id: string;
  flow_version_id: string;
  run_as: string;
  provider: Provider;
  secret_enc: string;
  prev_secret_enc: string | null;
  prev_secret_expires_at: Date | null;
  legacy_token_enc: string | null;
  legacy_token_expires_at: Date | null;
  payload_schema: Record<string, unknown>;
  input_map: Record<string, string>;
  rate_limit_per_minute: number;
  enabled: boolean;
  token_options: TokenPayloadOptions | null;
}

/** The value at a JSON Pointer ("" is the whole document), or undefined. */
export function pointer(doc: unknown, ptr: string): unknown {
  if (ptr === '') return doc;
  let cur: unknown = doc;
  for (const raw of ptr.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const UNVERIFIED_AUDITS_PER_MINUTE = 10;

const newSecret = (provider: Provider) => (provider === 'github' ? newGithubSecret() : provider === 'token' ? newTokenSecret() : newStandardSecret());

/**
 * Token bucket per trigger, kept in Postgres so every server process shares it.
 * One statement refills by elapsed time, takes a token, and reports what is left.
 */
export async function takeToken(db: Db, key: string, perMinute: number): Promise<boolean> {
  const { rows } = await db.query<{ tokens: number }>(
    `INSERT INTO rate_buckets (key, tokens, updated_at) VALUES ($1, $2 - 1, now())
     ON CONFLICT (key) DO UPDATE SET
       tokens = GREATEST(-1, LEAST($2, rate_buckets.tokens + EXTRACT(EPOCH FROM (now() - rate_buckets.updated_at)) * $2 / 60.0) - 1),
       updated_at = now()
     RETURNING tokens`,
    [key, perMinute],
  );
  return rows[0]!.tokens >= 0;
}

/** Retention: delivery IDs are kept as long as they can still be replayed usefully. */
export async function pruneWebhookState(db: Db): Promise<void> {
  // Signed providers reject anything older than the 5-minute window, so a day is ample.
  await db.query(
    `DELETE FROM webhook_deliveries d USING triggers t
     WHERE d.trigger_id = t.id AND t.provider <> 'github' AND d.received_at < now() - interval '1 day'`,
  );
  // GitHub sends no timestamp; dedupe (delivery id and body hash) is its only replay protection, so keep these longer.
  await db.query(
    `DELETE FROM webhook_deliveries d USING triggers t
     WHERE d.trigger_id = t.id AND t.provider = 'github' AND d.received_at < now() - interval '90 days'`,
  );
  await db.query(`DELETE FROM rate_buckets WHERE updated_at < now() - interval '1 day'`);
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
}

export class WebhookService {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly flows: FlowService,
    private readonly engine: Engine,
    private readonly config: Pick<Config, 'webhook'>,
    /** RabbitMQ on a shared server; absent, deliveries are processed in the request. */
    private readonly queue?: WebhookQueue,
  ) {}

  private aad = (triggerId: string, which: 'secret' | 'prev' | 'legacy') => `trigger:${triggerId}:${which}`;
  private aadBody = (triggerId: string, deliveryId: string) => `webhook-body:${triggerId}:${deliveryId}`;

  /** Portal metadata for the owner's triggers. Secret material never leaves the vault. */
  async list(actor: Member) {
    const { rows } = await this.db.query<{
      id: string; provider: Provider; enabled: boolean; flowName: string; version: number;
      flowVersionId: string; rateLimitPerMinute: number; versionStatus: string;
    }>(
      `SELECT t.id, t.provider, t.enabled, f.name AS "flowName", v.version,
              t.flow_version_id AS "flowVersionId", t.rate_limit_per_minute AS "rateLimitPerMinute",
              v.status AS "versionStatus"
       FROM triggers t JOIN flow_versions v ON v.id = t.flow_version_id JOIN flows f ON f.id = v.flow_id
       WHERE t.run_as = $1 ORDER BY f.name, v.version, t.id`,
      [actor.id],
    );
    return rows.map(row => ({ ...row, url: `/hooks/${row.id}` }));
  }

  /**
   * Who the Flow runs as and which version are fixed here, at configuration
   * time: always the member creating the trigger, and one exact approved version.
   */
  async create(body: unknown, actor: Member): Promise<{ id: string; secret: string; url: string }> {
    const parsed = createTriggerSchema.safeParse(body);
    if (!parsed.success) throw badRequest('invalid_trigger');
    const t = parsed.data;
    // It runs as its creator, who must be in the Flow's team.
    await assertTeamMember(this.db, await this.flows.teamOfVersion(this.db, t.flowVersionId), actor);
    if (t.legacyGitlabToken && t.provider !== 'gitlab') throw badRequest('legacy_token_gitlab_only');
    const tokenOptions: TokenPayloadOptions = {
      ...(t.deliveryIdPointer !== undefined ? { deliveryIdPointer: t.deliveryIdPointer } : {}),
      ...(t.timestampPointer !== undefined ? { timestampPointer: t.timestampPointer } : {}),
      ...(t.maxAgeSeconds !== undefined ? { maxAgeSeconds: t.maxAgeSeconds } : {}),
    };
    if (Object.keys(tokenOptions).length && t.provider !== 'token') throw badRequest('token_options_token_only');
    if (t.maxAgeSeconds !== undefined && t.timestampPointer === undefined) throw badRequest('max_age_needs_timestamp_pointer');
    try {
      ajv.compile(t.payloadSchema);
    } catch {
      throw badRequest('invalid_payload_schema');
    }
    const { version } = await this.flows.assertRunnable(this.db, t.flowVersionId);
    const flowInputs = Object.keys((version.definition.inputs as { properties?: object }).properties ?? {});
    for (const name of Object.keys(t.inputMap)) if (!flowInputs.includes(name)) throw badRequest('unknown_flow_input', name);

    const id = randomUUID();
    const secret = newSecret(t.provider);
    const legacyExpires = t.legacyGitlabToken ? new Date(Date.now() + (t.legacyGitlabTokenDays ?? 30) * 86_400_000) : null;
    await this.db.query(
      `INSERT INTO triggers (id, flow_version_id, run_as, provider, secret_enc, legacy_token_enc, legacy_token_expires_at,
                             payload_schema, input_map, rate_limit_per_minute, token_options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        t.flowVersionId,
        actor.id,
        t.provider,
        this.cipher.encrypt(secret, this.aad(id, 'secret')),
        t.legacyGitlabToken ? this.cipher.encrypt(t.legacyGitlabToken, this.aad(id, 'legacy')) : null,
        legacyExpires,
        JSON.stringify(t.payloadSchema),
        JSON.stringify(t.inputMap),
        t.rateLimitPerMinute ?? this.config.webhook.rateLimitPerMinute,
        t.provider === 'token' ? JSON.stringify(tokenOptions) : null,
      ],
    );
    await audit(this.db, { actorId: actor.id, action: 'trigger.created', subjectType: 'trigger', subjectId: id, outcome: 'ok' });
    // The secret is shown once and never returned again.
    return { id, secret, url: `/hooks/${id}` };
  }

  /** Exported apps: the signing secret comes from the environment, so it is set (and replaced) as given. */
  async setSecret(triggerId: string, secret: string): Promise<void> {
    if (secret.length < 16) throw badRequest('webhook_secret_too_short');
    await this.db.query(`UPDATE triggers SET secret_enc = $2, prev_secret_enc = NULL, prev_secret_expires_at = NULL WHERE id = $1`, [triggerId, this.cipher.encrypt(secret, this.aad(triggerId, 'secret'))]);
  }

  /** New secret; the previous one keeps working for the overlap period. The trigger's owner or an admin. */
  async rotate(triggerId: string, actor: Member, overlapSeconds: number): Promise<{ secret: string; previousValidUntil: Date }> {
    const row = await this.get(triggerId);
    if (row.run_as !== actor.id && actor.role !== 'admin') throw forbidden();
    if (overlapSeconds < 0 || overlapSeconds > 7 * 86_400) throw badRequest('invalid_overlap');
    const current = this.cipher.decrypt(row.secret_enc, this.aad(row.id, 'secret'));
    const secret = newSecret(row.provider);
    const until = new Date(Date.now() + overlapSeconds * 1000);
    await this.db.query(
      `UPDATE triggers SET secret_enc = $2, prev_secret_enc = $3, prev_secret_expires_at = $4 WHERE id = $1`,
      [row.id, this.cipher.encrypt(secret, this.aad(row.id, 'secret')), this.cipher.encrypt(current, this.aad(row.id, 'prev')), until],
    );
    await audit(this.db, { actorId: actor.id, action: 'trigger.secret_rotated', subjectType: 'trigger', subjectId: row.id, outcome: 'ok' });
    return { secret, previousValidUntil: until };
  }

  private async get(id: string): Promise<TriggerRow> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('trigger');
    const row = (await this.db.query<TriggerRow>(`SELECT * FROM triggers WHERE id = $1`, [id])).rows[0];
    if (!row) throw notFound('trigger');
    return row;
  }

  /**
   * Rejections are audited. Before the signature is verified anyone can send
   * requests, so those are audited at most UNVERIFIED_AUDITS_PER_MINUTE times a
   * minute per trigger instead of once per request.
   */
  private async reject(row: TriggerRow, reason: string, status: number, verified = true): Promise<never> {
    if (verified || (await takeToken(this.db, `webhook-unverified:${row.id}`, UNVERIFIED_AUDITS_PER_MINUTE))) {
      await audit(this.db, { actorId: null, action: 'webhook.rejected', subjectType: 'trigger', subjectId: row.id, outcome: 'denied', errorType: reason });
    }
    throw new AppError(`webhook_${reason}`, status);
  }

  /** Handle one delivery. Payloads are untrusted: they never choose the member, the Flow or the version. */
  async receive(triggerId: string, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<{ runId?: string; duplicate?: boolean; queued?: boolean }> {
    const row = await this.get(triggerId);
    if (!row.enabled) await this.reject(row, 'disabled', 404, false);

    const secrets = [this.cipher.decrypt(row.secret_enc, this.aad(row.id, 'secret'))];
    if (row.prev_secret_enc && row.prev_secret_expires_at && row.prev_secret_expires_at > new Date()) {
      secrets.push(this.cipher.decrypt(row.prev_secret_enc, this.aad(row.id, 'prev')));
    }
    const tolerance = this.config.webhook.toleranceSeconds;
    let result;
    if (row.provider === 'github') result = verifyGithub(headers, rawBody, secrets);
    else if (row.provider === 'gitlab') {
      const legacy =
        row.legacy_token_enc && row.legacy_token_expires_at && row.legacy_token_expires_at > new Date()
          ? this.cipher.decrypt(row.legacy_token_enc, this.aad(row.id, 'legacy'))
          : null;
      result = verifyGitlab(headers, rawBody, secrets, legacy, tolerance);
    } else if (row.provider === 'token') result = verifyToken(headers, rawBody, secrets, tolerance);
    else result = verifyStandard(headers, rawBody, secrets, tolerance);
    if (!result.ok) await this.reject(row, result.reason, 401, false);
    // Only signed deliveries count against the limit, so strangers cannot use up the sender's budget.
    if (!(await takeToken(this.db, `webhook:${row.id}`, row.rate_limit_per_minute))) await this.reject(row, 'rate_limited', 429);
    let deliveryId = (result as { deliveryId: string }).deliveryId;

    // A token covers no timestamp or id: the payload's own (when configured) limit replays.
    const opts = row.provider === 'token' ? row.token_options : null;
    if (opts && (opts.timestampPointer !== undefined || opts.deliveryIdPointer !== undefined)) {
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return this.reject(row, 'invalid_json', 400);
      }
      const checked = checkTokenPayload(payload, opts, tolerance);
      if (!checked.ok) return this.reject(row, checked.reason, checked.reason === 'stale_timestamp' ? 401 : 422);
      if (checked.deliveryId) deliveryId = checked.deliveryId;
    }

    // Replay protection: each delivery id is processed once. GitHub's signature and a token do not
    // cover the delivery id, so those bodies are deduplicated too: a resend under a new id is still a duplicate.
    const bodySha = row.provider === 'github' || row.provider === 'token' ? sha256Hex(rawBody) : null;
    const inserted = await this.db.query(
      `INSERT INTO webhook_deliveries (trigger_id, delivery_id, body_sha256) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [row.id, deliveryId, bodySha],
    );
    if (!inserted.rowCount) {
      const sameId = await this.db.query(`SELECT 1 FROM webhook_deliveries WHERE trigger_id = $1 AND delivery_id = $2`, [row.id, deliveryId]);
      if (sameId.rowCount) log.info('webhook_duplicate', { triggerId: row.id });
      else {
        log.warn('webhook_replayed_body', { triggerId: row.id });
        await audit(this.db, { actorId: null, action: 'webhook.replay_refused', subjectType: 'trigger', subjectId: row.id, outcome: 'denied', errorType: 'replayed_body' });
      }
      return { duplicate: true };
    }

    if (this.queue) {
      // Shared server: answer now, a worker does the rest.
      const message = { t: row.id, d: deliveryId, b: this.cipher.encrypt(rawBody.toString('base64'), this.aadBody(row.id, deliveryId)) };
      try {
        await this.queue.publish(Buffer.from(JSON.stringify(message)));
      } catch (err) {
        // Not accepted, so the sender's retry must not count as a replay.
        await this.db.query(`DELETE FROM webhook_deliveries WHERE trigger_id = $1 AND delivery_id = $2`, [row.id, deliveryId]);
        throw err;
      }
      return { queued: true };
    }
    return { runId: await this.process(row, deliveryId, rawBody) };
  }

  /** Consume one queued delivery. Anything the sender caused is rejected and done; only server-side failures are retried. */
  async handleQueued(content: Buffer): Promise<'done' | 'retry'> {
    let msg: { t: string; d: string; b: string };
    let row: TriggerRow;
    let body: Buffer;
    try {
      msg = JSON.parse(content.toString('utf8')) as typeof msg;
      row = await this.get(msg.t);
      body = Buffer.from(this.cipher.decrypt(msg.b, this.aadBody(msg.t, msg.d)), 'base64');
    } catch (err) {
      log.error('webhook_queue_bad_message', { errorType: errorType(err) });
      return 'done';
    }
    try {
      await this.process(row, msg.d, body);
      return 'done';
    } catch (err) {
      if (err instanceof AppError && err.httpStatus < 500) return 'done'; // rejected and audited
      log.error('webhook_processing_failed', { triggerId: row.id, errorType: errorType(err) });
      return 'retry';
    }
  }

  /** Parse, check the payload schema and start the run. At most one run per delivery, however often this is called. */
  private async process(row: TriggerRow, deliveryId: string, rawBody: Buffer): Promise<string> {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return this.reject(row, 'invalid_json', 400);
    }
    if (!ajv.validate(row.payload_schema, payload)) await this.reject(row, 'payload_schema', 422);
    const inputs: Record<string, unknown> = {};
    for (const [name, ptr] of Object.entries(row.input_map)) {
      const v = pointer(payload, ptr);
      if (v !== undefined) inputs[name] = v;
    }
    try {
      return await this.engine.startRun(row.flow_version_id, row.run_as, inputs, {
        actorId: row.run_as,
        triggerId: row.id,
        deliveryId,
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'webhook_already_processed') throw err;
      if (err instanceof AppError && err.httpStatus === 409) await this.reject(row, err.code, 409);
      if (err instanceof AppError && err.code === 'invalid_inputs') await this.reject(row, 'invalid_inputs', 422);
      throw err;
    }
  }
}


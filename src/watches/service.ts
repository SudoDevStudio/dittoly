import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { notify } from '../core/notify.js';
import { assertTeamMember } from '../core/teams.js';
import type { Db } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import { resolve, lookup, type TemplateScope } from '../flows/template.js';
import type { FlowService } from '../flows/service.js';
import type { ModuleRegistry } from '../modules/registry.js';
import { ajv, hostMatches } from '../modules/manifest.js';
import type { FetchLike } from '../sandbox/broker.js';
import type { MailSource } from './imap.js';
import { listObjects, readText, S3Error } from './s3.js';

/**
 * Watches start a Flow for each new thing somewhere:
 * - app: a new item in what an approved READ action returns (new Jira issues, new merge
 *   requests), checked with the owner's own access;
 * - email: a new message in a mailbox (IMAP, read-only);
 * - files: a new object in an S3-compatible bucket.
 *
 * The first look only remembers what is already there; later looks start one run per
 * new item, at most 20 per look. Runs go as the watch's owner, like schedules.
 */

const MAX_NEW_PER_CHECK = 20;
const templates = z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), z.unknown());
const interval = z.number().int().min(60).max(7 * 86_400).default(300);
const common = { name: z.string().trim().min(1).max(80), flowVersionId: z.string().uuid(), inputs: templates, intervalSeconds: interval };

export const createWatchSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('app'),
      ...common,
      /** Pinned approved module "name@x.y.z" and one of its read actions. */
      module: z.string().regex(/^[a-z][a-z0-9-]{1,39}@\d+\.\d+\.\d+$/),
      action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      actionInput: z.record(z.string(), z.unknown()).default({}),
      /** What the module needs to know (its declared settings): a module keeps no configuration of its own. */
      settings: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(300)).default({}),
      /** Where the list is in the action's output ("" for the output itself), and what tells items apart. */
      itemsPath: z.string().regex(/^([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*)?$/).default(''),
      keyField: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('email'),
      ...common,
      host: z.string().regex(/^[a-z0-9.-]+$/i).max(253),
      port: z.number().int().min(1).max(65535).default(993),
      secure: z.boolean().default(true),
      user: z.string().min(1).max(254),
      password: z.string().min(1).max(1000),
      mailbox: z.string().min(1).max(200).default('INBOX'),
      /** Only messages whose sender or subject contain these (case-insensitive). */
      fromContains: z.string().max(200).optional(),
      subjectContains: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('files'),
      ...common,
      endpoint: z.string().url().max(300),
      region: z.string().regex(/^[a-z0-9-]{2,40}$/).default('us-east-1'),
      bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
      prefix: z.string().max(500).default(''),
      accessKeyId: z.string().min(3).max(200),
      secretAccessKey: z.string().min(8).max(500),
      /** Also give the Flow the text of small text files (up to 256 KB) as {{ file.text }}. */
      includeText: z.boolean().default(false),
    })
    .strict(),
]);
export type CreateWatch = z.infer<typeof createWatchSchema>;

interface WatchRow {
  id: string;
  flow_version_id: string;
  run_as: string;
  kind: 'app' | 'email' | 'files';
  name: string;
  config: Record<string, unknown>;
  secret_enc: string | null;
  input_map: Record<string, unknown>;
  interval_seconds: number;
  enabled: boolean;
  disabled_reason: string | null;
  primed: boolean;
  cursor: { uidValidity?: string; lastUid?: number } | null;
  next_check_at: Date;
  last_checked_at: Date | null;
  last_error: string | null;
  runs_started: number;
  created_at: Date;
}

/** One new thing: a key that tells it apart, and what Flow inputs may use. */
interface Found {
  key: string;
  scope: Record<string, unknown>;
}

const secretAad = (id: string) => `watch:${id}:secret`;

export interface WatchDeps {
  db: Db;
  cipher: Cipher;
  flows: FlowService;
  modules: ModuleRegistry;
  engine: Engine;
  mail: MailSource;
  fetchImpl: FetchLike;
  /** Secrets for an app watch: the owner's own, as for a step they run. */
  secretsFor: (memberId: string, teamId: string, moduleName: string) => Promise<(service: string) => Promise<string | null>>;
}

export class Watches {
  constructor(private readonly d: WatchDeps) {}

  async create(body: unknown, actor: Member) {
    const parsed = createWatchSchema.safeParse(body);
    if (!parsed.success) throw badRequest('invalid_watch', parsed.error.issues.map((i) => `${i.path.join('.') || 'watch'}: ${i.message}`).join('; '));
    const w = parsed.data;
    await assertTeamMember(this.d.db, await this.d.flows.teamOfVersion(this.d.db, w.flowVersionId), actor);
    const { version } = await this.d.flows.assertRunnable(this.d.db, w.flowVersionId);
    const props = Object.keys(((version.definition.inputs ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
    const unknown = Object.keys(w.inputs).filter((k) => !props.includes(k));
    if (unknown.length) throw badRequest('invalid_inputs', `not inputs of this Flow: ${unknown.join(', ')}`);
    let config: Record<string, unknown>;
    let secret: string | null = null;
    if (w.kind === 'app') {
      const [name, ver] = w.module.split('@');
      const mv = await this.d.modules.findByRef(this.d.db, name!, ver!);
      if (!mv || mv.status !== 'approved') throw badRequest('module_not_approved');
      const action = mv.manifest.actions.find((a) => a.name === w.action);
      if (!action) throw badRequest('unknown_action');
      // Watching reads, again and again: an action that changes data could never be watched safely.
      if (action.effect !== 'read') throw badRequest('watch_needs_read_action', 'Only actions that only read can be watched.');
      if (!ajv.validate(action.input, w.actionInput)) throw badRequest('invalid_action_input');
      for (const st of mv.manifest.settings ?? []) {
        const v = w.settings[st.id];
        if (st.type === 'host' && !(v && hostMatches(st.pattern, v.toLowerCase()))) throw badRequest('setting_required', `settings.${st.id} (${st.label}): a host matching ${st.pattern}`);
      }
      for (const id of Object.keys(w.settings)) if (!(mv.manifest.settings ?? []).some((st) => st.id === id)) throw badRequest('unknown_setting', id);
      config = { module: w.module, action: w.action, actionInput: w.actionInput, settings: w.settings, itemsPath: w.itemsPath, keyField: w.keyField };
    } else if (w.kind === 'email') {
      config = { host: w.host.toLowerCase(), port: w.port, secure: w.secure, user: w.user, mailbox: w.mailbox, fromContains: w.fromContains ?? null, subjectContains: w.subjectContains ?? null };
      secret = w.password;
    } else {
      const u = new URL(w.endpoint);
      if (u.protocol !== 'https:') throw badRequest('endpoint_must_be_https');
      config = { endpoint: u.origin + u.pathname.replace(/\/$/, ''), region: w.region, bucket: w.bucket, prefix: w.prefix, accessKeyId: w.accessKeyId, includeText: w.includeText };
      secret = w.secretAccessKey;
    }
    const id = randomUUID();
    await this.d.db.query(
      `INSERT INTO watches (id, flow_version_id, run_as, kind, name, config, secret_enc, input_map, interval_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, w.flowVersionId, actor.id, w.kind, w.name, JSON.stringify(config), secret ? this.d.cipher.encrypt(secret, secretAad(id)) : null, JSON.stringify(w.inputs), w.intervalSeconds],
    );
    await audit(this.d.db, { actorId: actor.id, action: 'watch.created', subjectType: 'trigger', subjectId: id, outcome: 'ok' });
    return (await this.list(actor)).find((x) => x.id === id)!;
  }

  async list(actor: Member) {
    const { rows } = await this.d.db.query<WatchRow & { flow_name: string; version: number }>(
      `SELECT w.*, f.name AS flow_name, v.version FROM watches w JOIN flow_versions v ON v.id = w.flow_version_id JOIN flows f ON f.id = v.flow_id
       WHERE w.run_as = $1 OR $2 ORDER BY w.created_at`,
      [actor.id, actor.role === 'admin'],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      flowVersionId: r.flow_version_id,
      flow: `${r.flow_name} v${r.version}`,
      // Never the password or secret key.
      config: Object.fromEntries(Object.entries(r.config).filter(([k]) => k !== 'password' && k !== 'secretAccessKey')),
      inputs: r.input_map,
      intervalSeconds: r.interval_seconds,
      enabled: r.enabled,
      disabledReason: r.disabled_reason,
      primed: r.primed,
      nextCheckAt: r.next_check_at,
      lastCheckedAt: r.last_checked_at,
      lastError: r.last_error,
      runsStarted: r.runs_started,
    }));
  }

  private async own(id: string, actor: Member): Promise<WatchRow> {
    const row = (await this.d.db.query<WatchRow>(`SELECT * FROM watches WHERE id = $1`, [id])).rows[0];
    if (!row) throw notFound('watch');
    if (row.run_as !== actor.id && actor.role !== 'admin') throw forbidden();
    return row;
  }

  async setEnabled(id: string, actor: Member, enabled: boolean): Promise<void> {
    const row = await this.own(id, actor);
    if (enabled) await this.d.flows.assertRunnable(this.d.db, row.flow_version_id);
    await this.d.db.query(`UPDATE watches SET enabled = $2, disabled_reason = NULL, last_error = NULL, next_check_at = now() WHERE id = $1`, [id, enabled]);
    await audit(this.d.db, { actorId: actor.id, action: enabled ? 'watch.enabled' : 'watch.disabled', subjectType: 'trigger', subjectId: id, outcome: 'ok' });
  }

  async remove(id: string, actor: Member): Promise<void> {
    await this.own(id, actor);
    await this.d.db.query(`DELETE FROM watches WHERE id = $1`, [id]);
    await audit(this.d.db, { actorId: actor.id, action: 'watch.removed', subjectType: 'trigger', subjectId: id, outcome: 'ok' });
  }

  /** "Check now": look once, right away. */
  async checkNow(id: string, actor: Member) {
    const row = await this.own(id, actor);
    await this.check(row);
    return (await this.list(actor)).find((x) => x.id === id)!;
  }

  /** Maintenance: look at every watch that is due. */
  async tick(now = new Date()): Promise<number> {
    let started = 0;
    for (let i = 0; i < 50; i++) {
      const row = (await this.d.db.query<WatchRow>(`SELECT * FROM watches WHERE enabled AND next_check_at <= $1 ORDER BY next_check_at LIMIT 1`, [now])).rows[0];
      if (!row) break;
      // Claim this look, so only one worker makes it.
      const claimed = await this.d.db.query(
        `UPDATE watches SET next_check_at = $2::timestamptz + make_interval(secs => interval_seconds) WHERE id = $1 AND enabled AND next_check_at <= $2`,
        [row.id, now],
      );
      if (!claimed.rowCount) continue;
      started += await this.check(row);
    }
    return started;
  }

  private async check(row: WatchRow): Promise<number> {
    let found: Found[];
    let cursor = row.cursor;
    try {
      ({ found, cursor } = await this.look(row));
    } catch (err) {
      const code = err instanceof AppError || err instanceof S3Error ? err.code : errorType(err);
      const first = row.last_error === null;
      await this.d.db.query(`UPDATE watches SET last_checked_at = now(), last_error = $2 WHERE id = $1`, [row.id, code]);
      await audit(this.d.db, { actorId: null, action: 'watch.check_failed', subjectType: 'trigger', subjectId: row.id, outcome: 'failed', errorType: code });
      // The owner is told when it starts failing, not on every look.
      if (first) await notify(this.d.db, row.run_as, 'watch_failed');
      log.warn('watch_failed', { triggerId: row.id, errorType: code });
      return 0;
    }
    if (!row.primed) {
      // The first look remembers what is there; nothing old starts a run.
      for (const f of found) await this.d.db.query(`INSERT INTO watch_seen (watch_id, item_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [row.id, f.key]);
      await this.d.db.query(`UPDATE watches SET primed = true, cursor = $2, last_checked_at = now(), last_error = NULL WHERE id = $1`, [row.id, cursor ? JSON.stringify(cursor) : null]);
      return 0;
    }
    let started = 0;
    for (const f of found) {
      if (started >= MAX_NEW_PER_CHECK) break;
      const fresh = await this.d.db.query(`INSERT INTO watch_seen (watch_id, item_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [row.id, f.key]);
      if (!fresh.rowCount) continue;
      try {
        const inputs = resolve(row.input_map, { inputs: {}, steps: {}, ...f.scope } as TemplateScope);
        const runId = await this.d.engine.startRun(row.flow_version_id, row.run_as, inputs, { actorId: row.run_as, watchId: row.id });
        await this.d.db.query(`UPDATE watches SET runs_started = runs_started + 1 WHERE id = $1`, [row.id]);
        started++;
        void runId;
      } catch (err) {
        const code = err instanceof AppError ? err.code : errorType(err);
        // A Flow stopped automatically: the item is not lost, the watch finds it again once the Flow is resumed.
        if (code === 'flow_stopped') {
          await this.d.db.query(`DELETE FROM watch_seen WHERE watch_id = $1 AND item_key = $2`, [row.id, f.key]);
          await audit(this.d.db, { actorId: null, action: 'watch.start_failed', subjectType: 'trigger', subjectId: row.id, outcome: 'failed', errorType: code });
          await this.d.db.query(`UPDATE watches SET last_checked_at = now() WHERE id = $1`, [row.id]);
          return started;
        }
        // A Flow that can no longer run (rejected, superseded) turns the watch off.
        if (code === 'flow_version_not_approved' || code === 'approval_hash_mismatch') {
          await this.d.db.query(`UPDATE watches SET enabled = false, disabled_reason = $2 WHERE id = $1`, [row.id, code]);
          await notify(this.d.db, row.run_as, 'watch_failed');
          break;
        }
        await audit(this.d.db, { actorId: null, action: 'watch.start_failed', subjectType: 'trigger', subjectId: row.id, outcome: 'failed', errorType: code });
      }
    }
    await this.d.db.query(`UPDATE watches SET cursor = $2, last_checked_at = now(), last_error = NULL WHERE id = $1`, [row.id, cursor ? JSON.stringify(cursor) : null]);
    return started;
  }

  private async look(row: WatchRow): Promise<{ found: Found[]; cursor: WatchRow['cursor'] }> {
    const secret = row.secret_enc ? this.d.cipher.decrypt(row.secret_enc, secretAad(row.id)) : '';
    if (row.kind === 'app') {
      const c = row.config as { module: string; action: string; actionInput: Record<string, unknown>; settings?: Record<string, string>; itemsPath: string; keyField: string };
      const [name, ver] = c.module.split('@');
      const mv = await this.d.modules.findByRef(this.d.db, name!, ver!);
      if (!mv || mv.status !== 'approved') throw new AppError('module_not_approved', 409);
      const teamId = await this.d.flows.teamOfVersion(this.d.db, row.flow_version_id);
      const out = await this.d.engine.invokeOutsideRun(mv, c.action, c.actionInput, teamId, await this.d.secretsFor(row.run_as, teamId, mv.name), { settings: c.settings ?? {} });
      const list = c.itemsPath ? lookup(out as TemplateScope, c.itemsPath) : out;
      if (!Array.isArray(list)) throw new AppError('watch_items_not_a_list', 409);
      const found: Found[] = [];
      for (const item of list) {
        const key = lookup(item as TemplateScope, c.keyField);
        if (key === undefined || key === null) continue;
        found.push({ key: `app:${String(key).slice(0, 400)}`, scope: { item } });
      }
      return { found, cursor: null };
    }
    if (row.kind === 'email') {
      const c = row.config as { host: string; port: number; secure: boolean; user: string; mailbox: string; fromContains: string | null; subjectContains: string | null };
      const prev = row.cursor ?? {};
      // Not primed, or the mailbox was rebuilt (new UIDVALIDITY): start from now.
      const r = await this.d.mail.read(c, secret, row.primed ? (prev.lastUid ?? null) : null, MAX_NEW_PER_CHECK);
      if (row.primed && prev.uidValidity && prev.uidValidity !== r.uidValidity) return { found: [], cursor: { uidValidity: r.uidValidity, lastUid: r.uidNext - 1 } };
      const match = (s: string, needle: string | null) => !needle || s.toLowerCase().includes(needle.toLowerCase());
      const found = r.messages
        .filter((m) => match(m.from, c.fromContains) && match(m.subject, c.subjectContains))
        .map((m) => ({ key: `email:${r.uidValidity}:${m.uid}`, scope: { email: m } }));
      const lastUid = r.messages.length ? Math.max(...r.messages.map((m) => m.uid)) : row.primed ? (prev.lastUid ?? r.uidNext - 1) : r.uidNext - 1;
      return { found, cursor: { uidValidity: r.uidValidity, lastUid } };
    }
    const c = row.config as { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; includeText: boolean };
    const loc = { endpoint: c.endpoint, region: c.region, bucket: c.bucket, prefix: c.prefix };
    const keys = { accessKeyId: c.accessKeyId, secretAccessKey: secret };
    const objects = await listObjects(this.d.fetchImpl, loc, keys);
    const found: Found[] = [];
    for (const o of objects) {
      if (o.key.endsWith('/')) continue; // folder markers
      found.push({ key: `file:${o.key}:${o.etag}`.slice(0, 900), scope: { file: { ...o, text: null as string | null } } });
    }
    if (c.includeText && row.primed) {
      // Only new files are read, and only small text ones.
      const seen = new Set(
        (await this.d.db.query<{ item_key: string }>(`SELECT item_key FROM watch_seen WHERE watch_id = $1 AND item_key = ANY($2)`, [row.id, found.map((f) => f.key)])).rows.map((r) => r.item_key),
      );
      let read = 0;
      for (const f of found) {
        if (seen.has(f.key) || read >= MAX_NEW_PER_CHECK) continue;
        const file = f.scope.file as { key: string; size: number; text: string | null };
        if (file.size <= 256 * 1024) file.text = await readText(this.d.fetchImpl, loc, keys, file.key);
        read++;
      }
    }
    return { found, cursor: null };
  }
}

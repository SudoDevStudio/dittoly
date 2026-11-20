import { z } from 'zod';
import { audit } from '../core/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { notifyRole } from '../core/notify.js';
import type { Queryable } from '../db/db.js';
import type { FetchLike } from '../sandbox/broker.js';
import { moduleTestSchema, type ModuleTest } from './validate.js';

/**
 * Module safety after approval:
 * - Recorded tests: a member runs a READ action once against the real app; the
 *   requests and answers (their own secrets masked) become a test every later
 *   version of the module must pass in the sandbox.
 * - Drift: every action call's outcome is counted (no data). When an app starts
 *   answering differently (not found, bad request, a changed response shape)
 *   admins are told, and can ask the AI to propose a fixed version.
 */

const MAX_BODY = 200_000;

/** Wraps a fetch so each request and its JSON answer are kept, with the given secrets replaced. */
export function recordingFetch(inner: FetchLike, secrets: () => string[]): { fetch: FetchLike; http: ModuleTest['http']; problem: () => string | null } {
  const http: ModuleTest['http'] = [];
  let problem: string | null = null;
  const fetch: FetchLike = async (url, init) => {
    const res = await inner(url, init);
    const method = (init.method ?? 'GET').toUpperCase();
    let text = await res.text();
    for (const s of secrets()) if (s.length >= 4) text = text.split(s).join('test-credential');
    const noBody = res.status === 204 || res.status === 205 || res.status === 304 || text === '';
    // JSON is kept as JSON; anything else (an XML feed, HTML, CSV) as the text with its content type.
    let answer: { json?: unknown; body?: string; contentType?: string } = {};
    if (!noBody) {
      if (text.length > MAX_BODY) problem = 'response_too_large_to_record';
      try {
        answer = { json: JSON.parse(text) };
      } catch {
        answer = { body: text, contentType: res.headers.get('content-type')?.slice(0, 100) ?? 'text/plain; charset=utf-8' };
      }
    }
    if (http.length >= 20) problem = 'too_many_requests_to_record';
    else http.push({ method, urlPrefix: maskUrl(url, secrets()), status: res.status, ...answer });
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(noBody ? null : text, { status: res.status, headers });
  };
  return { fetch, http, problem: () => problem };
}

function maskUrl(url: string, secrets: string[]): string {
  let u = url;
  for (const s of secrets) if (s.length >= 4) u = u.split(encodeURIComponent(s)).join('test-credential').split(s).join('test-credential');
  return u;
}

export const recordingBody = z.object({ test: moduleTestSchema }).strict();

export async function saveRecording(db: Queryable, actor: Member, moduleVersion: { id: string; name: string; version: string; status: string }, test: ModuleTest) {
  if (moduleVersion.status !== 'approved') throw conflict('module_not_approved');
  if (test.http.length === 0) throw badRequest('nothing_recorded');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO module_recordings (module_name, action, name, test, recorded_by, from_version) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [moduleVersion.name, test.action, test.name, JSON.stringify(test), actor.id, moduleVersion.version],
  );
  await audit(db, { actorId: actor.id, action: 'module.test_recorded', subjectType: 'module', subjectId: moduleVersion.id, outcome: 'ok', relatedId: rows[0]!.id });
  return { id: rows[0]!.id };
}

export async function listRecordings(db: Queryable, moduleName: string) {
  const { rows } = await db.query<{ id: string; action: string; name: string; from_version: string; created_at: Date; handle: string | null }>(
    `SELECT r.id, r.action, r.name, r.from_version, r.created_at, m.handle FROM module_recordings r LEFT JOIN members m ON m.id = r.recorded_by
     WHERE r.module_name = $1 ORDER BY r.created_at`,
    [moduleName],
  );
  return rows.map((r) => ({ id: r.id, action: r.action, name: r.name, fromVersion: r.from_version, recordedAt: r.created_at, recordedBy: r.handle }));
}

export async function deleteRecording(db: Queryable, actor: Member, id: string): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rowCount } = await db.query(`DELETE FROM module_recordings WHERE id = $1`, [id]);
  if (!rowCount) throw notFound('recording');
  await audit(db, { actorId: actor.id, action: 'module.test_recording_removed', subjectType: 'module', subjectId: id, outcome: 'ok' });
}

/** Recorded tests every new version of this module must also pass (for actions it still has). */
export async function recordedTests(db: Queryable, moduleName: string): Promise<ModuleTest[]> {
  const { rows } = await db.query<{ test: unknown; name: string }>(`SELECT test, name FROM module_recordings WHERE module_name = $1 ORDER BY created_at`, [moduleName]);
  return rows.flatMap((r) => {
    const t = moduleTestSchema.safeParse(r.test);
    return t.success ? [{ ...t.data, name: `recorded: ${r.name}`.slice(0, 80) }] : [];
  });
}

// ---------------------------------------------------------------- drift

/** Answers that suggest the app changed (not outages, limits or credentials). */
export const DRIFT_ERRORS = new Set(['http_400', 'http_404', 'http_405', 'http_410', 'http_415', 'http_422', 'output_schema_mismatch']);
/** Ignored by configuration problems: these are about the setup, not the app. */
const NOT_COUNTED = new Set(['module_settings_missing', 'credential_missing']);

export async function recordCall(db: Queryable, call: { module: string; version: string; action: string; ok: boolean; errorType: string | null }): Promise<void> {
  if (call.errorType && NOT_COUNTED.has(call.errorType)) return;
  await db.query(`INSERT INTO module_calls (module_name, version, action, ok, error_type) VALUES ($1, $2, $3, $4, $5)`, [
    call.module,
    call.version,
    call.action,
    call.ok,
    call.errorType,
  ]);
}

export interface DriftSummary {
  calls: number;
  failures: number;
  errors: Record<string, number>;
  actions: string[];
  since: string;
}

/** Maintenance: flag modules whose calls in the last day mostly fail in ways that suggest the app changed. */
export async function detectDrift(db: Queryable, now = new Date()): Promise<string[]> {
  const { rows } = await db.query<{ module_name: string; version: string; calls: number; drift: number; errors: Record<string, number>; actions: string[] }>(
    `SELECT module_name, max(version) AS version, count(*)::int AS calls,
            count(*) FILTER (WHERE error_type = ANY($2))::int AS drift,
            coalesce(jsonb_object_agg(error_type, n) FILTER (WHERE error_type IS NOT NULL), '{}') AS errors,
            array_agg(DISTINCT action) FILTER (WHERE error_type = ANY($2)) AS actions
     FROM (SELECT module_name, version, action, error_type, count(*) OVER (PARTITION BY module_name, error_type) AS n
           FROM module_calls WHERE at > $1::timestamptz - interval '1 day') c
     GROUP BY module_name`,
    [now, [...DRIFT_ERRORS]],
  );
  const flagged: string[] = [];
  for (const r of rows) {
    if (r.drift < 3 || r.drift * 2 < r.calls) continue;
    const open = await db.query(`SELECT 1 FROM module_drift WHERE module_name = $1 AND resolved_at IS NULL`, [r.module_name]);
    if (open.rowCount) continue;
    const summary: DriftSummary = { calls: r.calls, failures: r.drift, errors: r.errors, actions: r.actions ?? [], since: new Date(now.getTime() - 86_400_000).toISOString() };
    await db.query(
      `INSERT INTO module_drift (module_name, version, detected_at, summary, resolved_at) VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (module_name) DO UPDATE SET version = EXCLUDED.version, detected_at = EXCLUDED.detected_at, summary = EXCLUDED.summary, resolved_at = NULL`,
      [r.module_name, r.version, now, JSON.stringify(summary)],
    );
    await audit(db, { actorId: null, action: 'module.drift_detected', subjectType: 'module', subjectId: r.module_name, outcome: 'failed', errorType: Object.keys(r.errors)[0] });
    await notifyRole(db, ['admin'], 'module_drift');
    flagged.push(r.module_name);
  }
  await db.query(`DELETE FROM module_calls WHERE at < $1::timestamptz - interval '30 days'`, [now]);
  return flagged;
}

export async function listDrift(db: Queryable) {
  const { rows } = await db.query<{ module_name: string; version: string; detected_at: Date; summary: DriftSummary; fix_attempted_at: Date | null; fix_version_id: string | null; fix_ref: string | null; fix_status: string | null; fix_error: string | null; fix_flows: unknown[] }>(
    `SELECT d.module_name, d.version, d.detected_at, d.summary, d.fix_attempted_at, d.fix_version_id, mv.name || ' ' || mv.version AS fix_ref, mv.status AS fix_status, d.fix_error, d.fix_flows
     FROM module_drift d LEFT JOIN module_versions mv ON mv.id = d.fix_version_id
     WHERE d.resolved_at IS NULL ORDER BY d.detected_at DESC`,
  );
  return rows.map((r) => ({
    module: r.module_name,
    version: r.version,
    detectedAt: r.detected_at,
    summary: r.summary,
    // What Dittoly did by itself (self-fixing), if anything.
    fix: r.fix_attempted_at && r.fix_attempted_at >= r.detected_at
      ? { attemptedAt: r.fix_attempted_at, moduleVersionId: r.fix_version_id, ref: r.fix_ref, status: r.fix_status, error: r.fix_error, flows: r.fix_flows }
      : null,
  }));
}

export async function resolveDrift(db: Queryable, moduleName: string, actor: Member | null): Promise<void> {
  if (actor && actor.role !== 'admin') throw forbidden('admin_only');
  const { rowCount } = await db.query(`UPDATE module_drift SET resolved_at = now() WHERE module_name = $1 AND resolved_at IS NULL`, [moduleName]);
  if (actor && !rowCount) throw notFound('drift');
  if (rowCount) await audit(db, { actorId: actor?.id ?? null, action: 'module.drift_resolved', subjectType: 'module', subjectId: moduleName, outcome: 'ok' });
}

/** The feedback the AI gets when asked to fix a drifting module: what failed, never any data. */
export function driftFeedback(summary: DriftSummary): string {
  const errors = Object.entries(summary.errors)
    .map(([e, n]) => `${e} x${n}`)
    .join(', ');
  return (
    `In the last day, ${summary.failures} of ${summary.calls} calls failed in ways that suggest the app's API changed ` +
    `(${errors}), in these actions: ${summary.actions.join(', ') || 'several'}. ` +
    `Check the app's current API (endpoints, parameters, response fields) and update the module so these actions work again. ` +
    `Keep the same action names, inputs and outputs where possible.`
  );
}

export function assertRecordable(module: { origin: string; manifest: { browser?: unknown; publicWeb?: string; actions: { name: string; effect: string }[] } }, action: string): void {
  const a = module.manifest.actions.find((x) => x.name === action);
  if (!a) throw notFound('action');
  if (a.effect !== 'read') throw new AppError('only_read_actions_can_be_recorded', 409, 'Recording runs the action for real, so only actions that only read can be recorded.');
  if (module.origin === 'mcp' || module.manifest.browser || module.manifest.publicWeb === 'read') throw new AppError('module_not_recordable', 409, 'Only modules that call HTTP APIs can be recorded.');
}

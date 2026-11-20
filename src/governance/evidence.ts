import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { randomToken } from '../core/crypto.js';
import type { Mailer } from '../core/delivery.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { notifyRole } from '../core/notify.js';
import type { Queryable } from '../db/db.js';
import type { FetchLike } from '../sandbox/broker.js';
import { verifyAudit } from './audit-chain.js';
import type { ReportRow } from './report.js';

/**
 * Audit evidence: which controls each line of the audit report is evidence for, and a
 * daily copy of the audit chain's latest hash sent somewhere outside Dittoly (an email
 * address or a webhook), so a rebuilt chain can be noticed later.
 *
 * The mapping names controls by number and a short name of our own; it does not quote
 * the frameworks. It is a starting point for an auditor, not a claim of compliance.
 */

export interface Control {
  framework: 'SOC 2' | 'ISO/IEC 27001:2022';
  id: string;
  name: string;
}

const SOC2 = (id: string, name: string): Control => ({ framework: 'SOC 2', id, name });
const ISO = (id: string, name: string): Control => ({ framework: 'ISO/IEC 27001:2022', id: `A.${id}`, name });

/** SOC 2 Trust Services Criteria (2017, points of focus revised 2022) and ISO/IEC 27001:2022 Annex A. */
export const CONTROLS = {
  logicalAccess: SOC2('CC6.1', 'Logical access security'),
  userAccess: SOC2('CC6.2', 'Registering, authorizing and removing users'),
  roleAccess: SOC2('CC6.3', 'Access by role; least privilege; segregation of duties'),
  anomalies: SOC2('CC7.2', 'Monitoring for anomalies and security events'),
  incidentResponse: SOC2('CC7.4', 'Responding to security incidents'),
  changeControl: SOC2('CC8.1', 'Change management'),
  monitoring: SOC2('CC4.1', 'Ongoing evaluation of controls'),
  riskAssessment: SOC2('CC3.2', 'Identifying and analyzing risks'),
  isoSegregation: ISO('5.3', 'Segregation of duties'),
  isoInventory: ISO('5.9', 'Inventory of information and other associated assets'),
  isoAccessControl: ISO('5.15', 'Access control'),
  isoAuthInfo: ISO('5.17', 'Authentication information'),
  isoAccessRights: ISO('5.18', 'Access rights'),
  isoPrivileged: ISO('8.2', 'Privileged access rights'),
  isoConfiguration: ISO('8.9', 'Configuration management'),
  isoLogging: ISO('8.15', 'Logging'),
  isoMonitoring: ISO('8.16', 'Monitoring activities'),
  isoIncident: ISO('5.26', 'Response to information security incidents'),
  isoChange: ISO('8.32', 'Change management'),
} as const;

const C = CONTROLS;

/** Controls a report line is evidence for. */
export function controlsFor(row: Pick<ReportRow, 'section' | 'flag' | 'what'>): Control[] {
  switch (row.section) {
    case 'approval':
      return [C.changeControl, C.roleAccess, C.isoChange, C.isoSegregation];
    case 'run':
      return row.flag === 'break-glass' ? [C.roleAccess, C.isoPrivileged, C.isoAccessControl] : [C.logicalAccess, C.isoAccessControl];
    case 'delegation':
      return [C.roleAccess, C.isoAccessRights, C.isoSegregation];
    case 'breakglass':
      return [C.roleAccess, C.anomalies, C.isoPrivileged, C.isoMonitoring];
    case 'policy':
      return [C.changeControl, C.isoConfiguration];
    case 'access':
      return [C.userAccess, C.roleAccess, C.isoAccessRights, C.isoAuthInfo];
    case 'change':
      return [C.changeControl, C.roleAccess, C.isoChange, C.isoSegregation];
    case 'ai':
      return [C.riskAssessment, C.isoInventory];
    case 'autostop':
      return [C.anomalies, C.incidentResponse, C.isoMonitoring, C.isoIncident];
  }
}

/** The audit log and its chain are evidence for logging and monitoring controls. */
export const CHAIN_CONTROLS: Control[] = [C.monitoring, C.anomalies, C.isoLogging, C.isoMonitoring];

/** Per control: how many report lines are evidence for it. */
export function controlSummary(rows: ReportRow[]): { framework: string; id: string; name: string; lines: number; flagged: number }[] {
  const out = new Map<string, { framework: string; id: string; name: string; lines: number; flagged: number }>();
  for (const c of CHAIN_CONTROLS) out.set(`${c.framework}|${c.id}`, { ...c, lines: 0, flagged: 0 });
  for (const r of rows) {
    for (const c of controlsFor(r)) {
      const k = `${c.framework}|${c.id}`;
      const e = out.get(k) ?? { ...c, lines: 0, flagged: 0 };
      e.lines += 1;
      if (r.flag) e.flagged += 1;
      out.set(k, e);
    }
  }
  return [...out.values()].sort((a, b) => a.framework.localeCompare(b.framework) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

// ---------------------------------------------------------------- anchoring

export const anchorBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), target: z.string().email().max(254) }).strict(),
  z.object({ kind: z.literal('webhook'), target: z.string().url().max(500) }).strict(),
]);

const aad = (id: string) => `audit-anchor:${id}`;

export interface AnchorDeps {
  db: Queryable;
  cipher: Cipher;
  mailer: Mailer | null;
  fetchImpl: FetchLike;
  publicUrl: string;
  insecureHttpHosts: string[];
}

export async function listAnchors(db: Queryable, actor: Member) {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rows } = await db.query<{ id: string; kind: string; target: string; enabled: boolean; created_at: Date; last_day: string | null; last_ok: boolean | null; last_error: string | null }>(
    `SELECT a.id, a.kind, a.target, a.enabled, a.created_at, s.day::text AS last_day, s.ok AS last_ok, s.error AS last_error
     FROM audit_anchors a LEFT JOIN LATERAL (SELECT day, ok, error FROM audit_anchor_sends WHERE anchor_id = a.id ORDER BY day DESC LIMIT 1) s ON true
     ORDER BY a.created_at`,
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, target: r.target, enabled: r.enabled, createdAt: r.created_at, lastDay: r.last_day, lastOk: r.last_ok, lastError: r.last_error }));
}

/** A webhook gets a signing key, shown once. */
export async function createAnchor(d: AnchorDeps, actor: Member, body: z.infer<typeof anchorBody>): Promise<{ id: string; signingKey?: string }> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (body.kind === 'webhook') {
    const u = new URL(body.target);
    if (u.protocol !== 'https:' && !d.insecureHttpHosts.includes(u.host)) throw badRequest('webhook_must_be_https');
  }
  if (body.kind === 'email' && !d.mailer) throw badRequest('email_not_configured', 'Set DITTOLY_SMTP_URL to send email.');
  const { rows } = await d.db.query<{ id: string }>(`INSERT INTO audit_anchors (kind, target, created_by) VALUES ($1, $2, $3) RETURNING id`, [body.kind, body.target, actor.id]);
  const id = rows[0]!.id;
  let signingKey: string | undefined;
  if (body.kind === 'webhook') {
    signingKey = randomToken(32);
    await d.db.query(`UPDATE audit_anchors SET secret_enc = $2 WHERE id = $1`, [id, d.cipher.encrypt(signingKey, aad(id))]);
  }
  await audit(d.db, { actorId: actor.id, action: 'audit.anchor_added', subjectType: 'org', subjectId: id, outcome: 'ok' });
  return { id, ...(signingKey ? { signingKey } : {}) };
}

export async function deleteAnchor(db: Queryable, actor: Member, id: string): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rowCount } = await db.query(`DELETE FROM audit_anchors WHERE id = $1`, [id]);
  if (!rowCount) throw notFound('anchor');
  await audit(db, { actorId: actor.id, action: 'audit.anchor_removed', subjectType: 'org', subjectId: id, outcome: 'ok' });
}

interface AnchorRow {
  id: string;
  kind: 'email' | 'webhook';
  target: string;
  secret_enc: string | null;
}

/** What is sent: enough to compare later, nothing else. */
export function anchorMessage(publicUrl: string, day: string, head: { eventId: string; hash: string } | null, ok: boolean) {
  return { server: publicUrl, day, eventId: head?.eventId ?? null, hash: head?.hash ?? null, chainIntact: ok };
}

async function sendOne(d: AnchorDeps, a: AnchorRow, message: ReturnType<typeof anchorMessage>): Promise<void> {
  if (a.kind === 'email') {
    if (!d.mailer) throw new Error('email_not_configured');
    await d.mailer.send({
      to: a.target,
      subject: `Dittoly audit hash ${message.day}`,
      text:
        `Keep this message: it lets you check later that Dittoly's audit log was not rewritten.\n\n` +
        `Server: ${message.server}\nDay: ${message.day}\nLatest sealed event: ${message.eventId ?? 'none'}\nHash: ${message.hash ?? 'none'}\n` +
        `Chain intact when sent: ${message.chainIntact ? 'yes' : 'NO'}\n\nA later report must show this event with this hash.`,
    });
    return;
  }
  const body = JSON.stringify(message);
  const key = a.secret_enc ? d.cipher.decrypt(a.secret_enc, aad(a.id)) : '';
  const res = await d.fetchImpl(a.target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dittoly-signature': `sha256=${createHmac('sha256', key).update(body).digest('hex')}` },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook_http_${res.status}`);
}

/** Maintenance: once a day (UTC), send the chain head to every place set up; retried until it goes through. */
export async function sendDailyAnchors(d: AnchorDeps, now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const { rows } = await d.db.query<AnchorRow>(
    `SELECT a.id, a.kind, a.target, a.secret_enc FROM audit_anchors a
     WHERE a.enabled AND NOT EXISTS (SELECT 1 FROM audit_anchor_sends s WHERE s.anchor_id = a.id AND s.day = $1 AND s.ok)`,
    [day],
  );
  if (!rows.length) return 0;
  const chain = await verifyAudit(d.db);
  const message = anchorMessage(d.publicUrl, day, chain.head, chain.ok);
  let sent = 0;
  for (const a of rows) {
    try {
      await sendOne(d, a, message);
      await d.db.query(
        `INSERT INTO audit_anchor_sends (anchor_id, day, event_id, hash, ok, error) VALUES ($1, $2, $3, $4, true, NULL)
         ON CONFLICT (anchor_id, day) DO UPDATE SET event_id = EXCLUDED.event_id, hash = EXCLUDED.hash, ok = true, error = NULL, sent_at = now()`,
        [a.id, day, chain.head?.eventId ?? null, chain.head?.hash ?? null],
      );
      sent++;
    } catch (err) {
      const error = (err instanceof Error ? err.message : 'send_failed').slice(0, 80);
      const first = await d.db.query(
        `INSERT INTO audit_anchor_sends (anchor_id, day, ok, error) VALUES ($1, $2, false, $3) ON CONFLICT (anchor_id, day) DO UPDATE SET error = EXCLUDED.error, sent_at = now() RETURNING (xmax = 0) AS inserted`,
        [a.id, day, error],
      );
      // Admins are told once a day, not on every retry.
      if ((first.rows[0] as { inserted?: boolean } | undefined)?.inserted) await notifyRole(d.db, ['admin'], 'audit_anchor_failed');
      log.warn('audit_anchor_failed', { errorType: error });
    }
  }
  return sent;
}

/** "Send now" from the admin page: sends today's head to one place, outside the daily record. */
export async function sendAnchorNow(d: AnchorDeps, actor: Member, id: string): Promise<{ ok: boolean; error?: string }> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const a = (await d.db.query<AnchorRow>(`SELECT id, kind, target, secret_enc FROM audit_anchors WHERE id = $1`, [id])).rows[0];
  if (!a) throw notFound('anchor');
  const chain = await verifyAudit(d.db);
  try {
    await sendOne(d, a, anchorMessage(d.publicUrl, new Date().toISOString().slice(0, 10), chain.head, chain.ok));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : 'send_failed').slice(0, 80) };
  }
}

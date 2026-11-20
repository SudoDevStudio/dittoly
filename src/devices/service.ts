import QRCode from 'qrcode';
import { audit } from '../core/audit.js';
import { randomToken, sha256Hex } from '../core/crypto.js';
import { AppError, badRequest, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { withTx, type Db } from '../db/db.js';

/** A pairing code works once, for this long. */
const PAIR_SECONDS = 120;
/** A paired phone stays signed in this long, unless revoked. */
export const DEVICE_DAYS = 30;
export const DEVICE_COOKIE = 'dty_device';

export interface DeviceSession {
  member: Member;
  deviceId: string;
}

/**
 * Phones (and glasses paired to them) as signed-in devices. The portal shows a
 * one-time QR code; scanning it gives the phone its own session, which can only
 * use the command endpoints (/api/m) and can be revoked at any time.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class Devices {
  constructor(
    private readonly db: Db,
    private readonly publicUrl: string,
  ) {}

  /**
   * A one-time code and its QR. `origin` is the address the person is using the
   * portal from (so a phone on the same network can reach it); it only shapes the
   * link shown back to them.
   */
  async startPairing(actor: Member, origin?: string) {
    let base = this.publicUrl;
    if (origin) {
      let u: URL;
      try {
        u = new URL(origin);
      } catch {
        throw badRequest('invalid_origin');
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('invalid_origin');
      // A phone cannot open this computer's localhost: when the portal is open on localhost but the
      // server has a network address (npm start -- --host=0.0.0.0, or DITTOLY_PUBLIC_URL), use that.
      base = LOOPBACK.has(u.hostname) && !LOOPBACK.has(new URL(this.publicUrl).hostname) ? this.publicUrl : u.origin;
    }
    const code = randomToken(24);
    const expiresAt = new Date(Date.now() + PAIR_SECONDS * 1000);
    await this.db.query(`DELETE FROM device_pairings WHERE expires_at < now() - interval '1 day'`);
    await this.db.query(`INSERT INTO device_pairings (code_hash, member_id, expires_at) VALUES ($1, $2, $3)`, [sha256Hex(code), actor.id, expiresAt]);
    const url = `${base}/m/pair#${code}`;
    const host = new URL(base).hostname;
    return {
      url,
      expiresAt,
      qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
      /** The phone cannot open localhost; the person needs the computer's network address or a tunnel. */
      reachable: !LOOPBACK.has(host),
      /** Browsers only allow the microphone on https pages: without it, commands are typed. */
      voice: base.startsWith('https://'),
    };
  }

  /** The phone presents the code: it becomes a device with its own session token. */
  async pair(code: string, name: string): Promise<{ token: string; deviceId: string; expiresAt: Date }> {
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<{ member_id: string }>(
        `UPDATE device_pairings SET used_at = now()
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING member_id`,
        [sha256Hex(code)],
      );
      if (!rows[0]) throw new AppError('pairing_code_invalid', 401, 'This code has expired or was already used. Show a new QR code in Dittoly.');
      const disabled = (await tx.query<{ disabled: boolean }>(`SELECT disabled FROM members WHERE id = $1`, [rows[0].member_id])).rows[0]?.disabled;
      if (disabled !== false) throw new AppError('member_disabled', 403);
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + DEVICE_DAYS * 86_400_000);
      const device = await tx.query<{ id: string }>(
        `INSERT INTO devices (member_id, name, token_hash, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [rows[0].member_id, name.replace(/[\u0000-\u001f]/g, '').slice(0, 80) || 'Phone', sha256Hex(token), expiresAt],
      );
      await audit(tx, { actorId: rows[0].member_id, action: 'device.paired', subjectType: 'device', subjectId: device.rows[0]!.id, outcome: 'ok' });
      return { token, deviceId: device.rows[0]!.id, expiresAt };
    });
  }

  async session(token: string): Promise<DeviceSession | null> {
    const { rows } = await this.db.query<{ device_id: string; id: string; handle: string; role: Member['role'] }>(
      `UPDATE devices d SET last_seen_at = now()
       FROM members m
       WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND d.expires_at > now() AND m.id = d.member_id AND NOT m.disabled
       RETURNING d.id AS device_id, m.id, m.handle, m.role`,
      [sha256Hex(token)],
    );
    const r = rows[0];
    return r ? { deviceId: r.device_id, member: { id: r.id, handle: r.handle, role: r.role } } : null;
  }

  /** Your devices; admins see everyone's. */
  async list(actor: Member) {
    const { rows } = await this.db.query<{ id: string; name: string; handle: string; created_at: Date; last_seen_at: Date | null; expires_at: Date; revoked_at: Date | null }>(
      `SELECT d.id, d.name, m.handle, d.created_at, d.last_seen_at, d.expires_at, d.revoked_at
       FROM devices d JOIN members m ON m.id = d.member_id
       WHERE (d.member_id = $1 OR $2) AND d.revoked_at IS NULL AND d.expires_at > now()
       ORDER BY d.created_at DESC`,
      [actor.id, actor.role === 'admin'],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, member: r.handle, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at }));
  }

  async revoke(id: string, actor: Member): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND (member_id = $2 OR $3)`,
      [id, actor.id, actor.role === 'admin'],
    );
    if (!rowCount) throw notFound('device');
    await audit(this.db, { actorId: actor.id, action: 'device.revoked', subjectType: 'device', subjectId: id, outcome: 'ok' });
  }
}

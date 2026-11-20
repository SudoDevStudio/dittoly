import type { ChatMessage } from '../ai/plan-chat.js';
import type { PlanAnalysis } from '../ai/plan.js';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { canUseTeam, defaultTeamFor } from '../core/teams.js';
import type { Queryable } from '../db/db.js';

/**
 * Home chats are kept so their people can come back to a plan: the owner, and the members of the chat's team (to pick
 * up a plan a teammate started). Messages and the latest plan are encrypted; a chat is deleted the organization's
 * chat retention after its last message (30 days unless an admin sets another number of days).
 */

const KEY = 'chat_retention';
export const DEFAULT_CHAT_DAYS = 30;
export const MAX_CHAT_DAYS = 365;
/** The most messages a chat keeps (the AI reads the newest that fit anyway). */
const MAX_MESSAGES = 200;

interface Row {
  id: string;
  created_by: string;
  team_id: string | null;
  title: string;
  messages_enc: string;
  plan_enc: string | null;
  plan_id: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

export interface StoredChat {
  id: string;
  title: string;
  teamId: string | null;
  createdBy: string | null;
  mine: boolean;
  messages: ChatMessage[];
  plan: PlanAnalysis | null;
  planId: string | null;
  updatedAt: Date;
  expiresAt: Date;
}

const aad = { messages: (id: string) => `home-chat:${id}:messages`, plan: (id: string) => `home-chat:${id}:plan` };
/** For key rotation (src/core/rekey.ts). */
export const HOME_CHAT_AAD = aad;

export async function chatRetentionDays(db: Queryable): Promise<{ days: number; isDefault: boolean }> {
  const days = (await db.query<{ value: { days?: number } }>(`SELECT value FROM org_settings WHERE key = $1`, [KEY])).rows[0]?.value.days;
  return typeof days === 'number' ? { days, isDefault: false } : { days: DEFAULT_CHAT_DAYS, isDefault: true };
}

export async function setChatRetentionDays(db: Queryable, actor: Member, days: number): Promise<{ days: number; isDefault: boolean }> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  if (!Number.isInteger(days) || days < 1 || days > MAX_CHAT_DAYS) throw badRequest('invalid_retention', `days must be 1 to ${MAX_CHAT_DAYS}`);
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify({ days }), actor.id],
  );
  // A shorter period applies to the chats already kept, too.
  await db.query(`UPDATE home_chats SET expires_at = LEAST(expires_at, updated_at + make_interval(days => $1))`, [days]);
  await purgeExpiredChats(db);
  await audit(db, { actorId: actor.id, action: 'org.chat_retention_updated', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
  return chatRetentionDays(db);
}

export async function purgeExpiredChats(db: Queryable, now = new Date()): Promise<number> {
  return (await db.query(`DELETE FROM home_chats WHERE expires_at <= $1`, [now])).rowCount ?? 0;
}

export class HomeChats {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: Cipher,
  ) {}

  private async row(id: string, actor: Member): Promise<Row> {
    const r = (await this.db.query<Row>(`SELECT * FROM home_chats WHERE id = $1 AND expires_at > now()`, [id])).rows[0];
    // Someone else's chat outside your teams reads as missing, not forbidden.
    if (!r || !(await this.maySee(r, actor))) throw notFound('chat');
    return r;
  }

  private async maySee(r: Row, actor: Member): Promise<boolean> {
    return r.created_by === actor.id || (r.team_id !== null && (await canUseTeam(this.db, r.team_id, actor)));
  }

  private view(r: Row, actor: Member, handle: string | null): StoredChat {
    return {
      id: r.id,
      title: r.title,
      teamId: r.team_id,
      createdBy: handle,
      mine: r.created_by === actor.id,
      messages: this.cipher.decryptJson(r.messages_enc, aad.messages(r.id)) as ChatMessage[],
      plan: r.plan_enc ? (this.cipher.decryptJson(r.plan_enc, aad.plan(r.id)) as PlanAnalysis) : null,
      planId: r.plan_id,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
    };
  }

  async get(id: string, actor: Member): Promise<StoredChat> {
    const r = await this.row(id, actor);
    const handle = (await this.db.query<{ handle: string }>(`SELECT handle FROM members WHERE id = $1`, [r.created_by])).rows[0]?.handle ?? null;
    return this.view(r, actor, handle);
  }

  /** Your chats and your teams' chats, newest first (titles only). */
  async list(actor: Member, teamId?: string) {
    const { rows } = await this.db.query<{ id: string; title: string; team_id: string | null; created_by: string; handle: string; plan_id: string | null; updated_at: Date; expires_at: Date }>(
      `SELECT c.id, c.title, c.team_id, c.created_by, m.handle, c.plan_id, c.updated_at, c.expires_at
       FROM home_chats c JOIN members m ON m.id = c.created_by
       WHERE c.expires_at > now() AND ($2::uuid IS NULL OR c.team_id = $2)
         AND (c.created_by = $1 OR $3 OR c.team_id IN (SELECT team_id FROM team_members WHERE member_id = $1))
       ORDER BY c.updated_at DESC LIMIT 50`,
      [actor.id, teamId ?? null, actor.role === 'admin'],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, teamId: r.team_id, createdBy: r.handle, mine: r.created_by === actor.id, planId: r.plan_id, updatedAt: r.updated_at, expiresAt: r.expires_at }));
  }

  /** The messages so far (an empty list for a new chat), checking the actor may continue it. */
  async history(id: string | undefined, actor: Member): Promise<ChatMessage[]> {
    return id ? this.view(await this.row(id, actor), actor, null).messages : [];
  }

  /** Stores a turn: a new chat (in `teamId`, else the actor's default team) or the next messages of one. */
  async save(actor: Member, input: { chatId?: string | undefined; teamId?: string | undefined; messages: ChatMessage[]; plan: PlanAnalysis | null }): Promise<string> {
    const messages = input.messages.slice(-MAX_MESSAGES);
    const { days } = await chatRetentionDays(this.db);
    if (input.chatId) {
      await this.row(input.chatId, actor);
      await this.db.query(
        `UPDATE home_chats SET messages_enc = $2, plan_enc = COALESCE($3, plan_enc), updated_at = now(), expires_at = now() + make_interval(days => $4) WHERE id = $1`,
        [input.chatId, this.cipher.encryptJson(messages, aad.messages(input.chatId)), input.plan ? this.cipher.encryptJson(input.plan, aad.plan(input.chatId)) : null, days],
      );
      return input.chatId;
    }
    const team = input.teamId ?? (await defaultTeamFor(this.db, actor.id));
    const title = (messages.find((m) => m.role === 'user')?.text ?? 'Chat').replace(/\s+/g, ' ').trim().slice(0, 80);
    const id = (await this.db.query<{ id: string }>(
      `INSERT INTO home_chats (created_by, team_id, title, messages_enc, expires_at) VALUES ($1, $2, $3, '', now() + make_interval(days => $4)) RETURNING id`,
      [actor.id, team, title, days],
    )).rows[0]!.id;
    await this.db.query(`UPDATE home_chats SET messages_enc = $2, plan_enc = $3 WHERE id = $1`, [
      id,
      this.cipher.encryptJson(messages, aad.messages(id)),
      input.plan ? this.cipher.encryptJson(input.plan, aad.plan(id)) : null,
    ]);
    return id;
  }

  async markBuilt(chatId: string, planId: string): Promise<void> {
    await this.db.query(`UPDATE home_chats SET plan_id = $2 WHERE id = $1`, [chatId, planId]);
  }

  /** Its owner, an org admin or a team admin of its team deletes it. */
  async remove(id: string, actor: Member): Promise<void> {
    const r = await this.row(id, actor);
    if (r.created_by !== actor.id && actor.role !== 'admin') {
      const admin = r.team_id ? (await this.db.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2 AND role = 'admin'`, [r.team_id, actor.id])).rowCount : 0;
      if (!admin) throw forbidden('owner_only');
    }
    await this.db.query(`DELETE FROM home_chats WHERE id = $1`, [id]);
    await audit(this.db, { actorId: actor.id, action: 'chat.deleted', subjectType: 'chat', subjectId: id, outcome: 'ok' });
  }
}

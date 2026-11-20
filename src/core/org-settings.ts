import { createHash } from 'node:crypto';
import type { Queryable } from '../db/db.js';
import { audit } from './audit.js';
import { badRequest, forbidden } from './errors.js';
import type { Member } from './members.js';

/**
 * Standing instructions admins give the AI for every module and every Flow it
 * generates (naming rules, preferred APIs, "never delete", required fields).
 * They guide drafts; they are not a control: every draft is still validated,
 * sandboxed and reviewed.
 */
export interface AiInstructions {
  modules: string;
  flows: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

const KEY = 'ai_instructions';
export const MAX_INSTRUCTIONS = 10_000;

export async function getAiInstructions(db: Queryable): Promise<AiInstructions> {
  const row = (
    await db.query<{ value: { modules?: string; flows?: string }; updated_at: Date; handle: string | null }>(
      `SELECT s.value, s.updated_at, m.handle FROM org_settings s LEFT JOIN members m ON m.id = s.updated_by WHERE s.key = $1`,
      [KEY],
    )
  ).rows[0];
  return {
    modules: row?.value.modules ?? '',
    flows: row?.value.flows ?? '',
    updatedAt: row ? row.updated_at.toISOString() : null,
    updatedBy: row?.handle ?? null,
  };
}

export async function setAiInstructions(db: Queryable, actor: Member, next: { modules?: string; flows?: string }): Promise<AiInstructions> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const current = await getAiInstructions(db);
  const value = { modules: (next.modules ?? current.modules).trim(), flows: (next.flows ?? current.flows).trim() };
  if (value.modules.length > MAX_INSTRUCTIONS || value.flows.length > MAX_INSTRUCTIONS) throw badRequest('instructions_too_long');
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(value), actor.id],
  );
  await audit(db, { actorId: actor.id, action: 'org.ai_instructions_updated', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
  return getAiInstructions(db);
}

/** The snapshot stored with a draft, so reviewers see exactly what the AI was told. */
export function instructionsSnapshot(text: string): { text: string; sha256: string } | null {
  return text ? { text, sha256: createHash('sha256').update(text).digest('hex') } : null;
}

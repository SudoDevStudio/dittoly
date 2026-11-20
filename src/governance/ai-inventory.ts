import { z } from 'zod';
import { audit } from '../core/audit.js';
import { forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Queryable } from '../db/db.js';
import type { FlowService } from '../flows/service.js';
import type { FlowDefinition } from '../flows/definition.js';
import { getSelfFix } from '../modules/self-fix.js';
import { csvCell } from './report.js';

/**
 * The AI system inventory: every place AI is used in this organization, for the people who must
 * keep such a list (an AI Act deployer, an ISO 27001 asset inventory). It is built from what is
 * set up now, so it cannot fall out of date: approved Flows with AI or AI-guided browse steps,
 * modules an AI drafted, AI agents connected over MCP, and the drafting features of the
 * organization's AI. Admins classify each entry (risk class, purpose, owner); a saved
 * classification counts as a review and is audited.
 */

export const RISK_CLASSES = ['not_classified', 'minimal', 'limited', 'high', 'prohibited_check'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const classifyBody = z
  .object({
    riskClass: z.enum(RISK_CLASSES),
    purpose: z.string().trim().max(500).optional(),
    owner: z.string().trim().max(120).optional(),
  })
  .strict();

export const inventoryKey = z.string().regex(/^(flow|module|agent|feature):[a-z0-9_-]{1,64}$/);

export interface InventoryEntry {
  key: string;
  kind: 'flow' | 'module' | 'agent' | 'feature';
  name: string;
  team: string | null;
  /** The person responsible in Dittoly: the Flow's owner, the agent's person, who drafted the module. */
  person: string | null;
  /** Which AI: provider and model where known. */
  ai: string;
  /** What it does, in plain words. */
  detail: string;
  /** What the AI's output can reach (Flows): steps that change something, and whether a person checks first. */
  reach: { step: string; what: string; guarded: boolean }[];
  classification: { riskClass: RiskClass; purpose: string | null; owner: string | null; reviewedAt: Date | null; reviewedBy: string | null };
}

export interface OrgAi {
  /** The organization's AI provider, or null when none is set up. */
  provider: string | null;
  model: string | null;
}

const orgAiName = (org: OrgAi) => (org.provider ? `${org.provider}${org.model ? ` / ${org.model}` : ''} (organization)` : 'organization AI (not set up)');

async function flowEntries(db: Queryable, flows: FlowService, org: OrgAi): Promise<Omit<InventoryEntry, 'classification'>[]> {
  const { rows } = await db.query<{ id: string; flow_id: string; name: string; team: string; owner: string; definition: FlowDefinition }>(
    `SELECT v.id, v.flow_id, f.name, t.name AS team, m.handle AS owner, v.definition
     FROM flow_versions v JOIN flows f ON f.id = v.flow_id JOIN teams t ON t.id = f.team_id JOIN members m ON m.id = f.created_by
     WHERE v.status = 'approved' AND v.definition::text ~ '"type": ?"(ai|browse|fix)"' ORDER BY f.name`,
  );
  const out: Omit<InventoryEntry, 'classification'>[] = [];
  for (const r of rows) {
    const steps = r.definition.steps.filter((s) => s.type === 'ai' || s.type === 'browse' || s.type === 'fix');
    if (!steps.length) continue;
    const version = (await flows.getVersion(db, r.id))!;
    let reach: InventoryEntry['reach'] = [];
    try {
      const { sinks } = await flows.injection(db, r.definition);
      const guarded = new Set(await flows.guardedSteps(db, version));
      const modules = await flows.pinnedModules(db, r.definition);
      reach = sinks.map((id) => {
        const s = r.definition.steps.find((x) => x.id === id);
        const what =
          s?.type === 'action'
            ? `${modules.get(s.module)?.manifest.title ?? s.module} "${s.action}" changes data in an external app`
            : s?.type === 'table'
              ? `changes the team's data table "${s.table}"`
              : s?.type === 'app' || s?.type === 'fix'
                ? 'builds and runs code from a branch'
                : s?.type === 'flow'
                  ? 'runs another Flow that changes data'
                  : 'changes something';
        return { step: id, what, guarded: guarded.has(id) };
      });
    } catch {
      // A version whose modules can no longer be resolved still shows its AI steps.
    }
    const ai = [...new Set(steps.map((s) => (s.ai === 'runner' ? `${s.provider ?? 'openai'} (the runner's own key, else ${orgAiName(org)})` : orgAiName(org))))].join('; ');
    const detail = steps
      .map((s) =>
        s.type === 'ai'
          ? `AI step "${s.title ?? s.id}"`
          : s.type === 'fix'
            ? `fix and verify "${s.title ?? s.id}": the AI changes a copy of a repository, Dittoly runs its tests`
            : `AI-guided browser "${s.title ?? s.id}" on ${[...s.hosts, ...(s.publicWeb ? ['any public website'] : [])].join(', ') || 'an app the Flow starts'}`,
      )
      .join('; ');
    out.push({ key: `flow:${r.flow_id}`, kind: 'flow', name: r.name, team: r.team, person: r.owner, ai, detail, reach });
  }
  return out;
}

async function moduleEntries(db: Queryable, org: OrgAi): Promise<Omit<InventoryEntry, 'classification'>[]> {
  const { rows } = await db.query<{ id: string; name: string; version: string; status: string; origin: string; author: string | null; assistant: string | null; fix_model: string | null; fix_provider: string | null }>(
    `SELECT mv.id, mv.name, mv.version, mv.status, mv.origin, m.handle AS author, mv.generation->'assistant'->>'name' AS assistant,
            c.ai->>'model' AS fix_model, c.ai->>'provider' AS fix_provider
     FROM module_versions mv LEFT JOIN members m ON m.id = mv.created_by
     LEFT JOIN LATERAL (SELECT ai FROM change_records WHERE module_version_id = mv.id ORDER BY created_at DESC LIMIT 1) c ON true
     WHERE mv.origin IN ('chat', 'assistant') AND mv.status IN ('approved', 'pending_review') ORDER BY mv.name, mv.created_at`,
  );
  return rows.map((r) => ({
    key: `module:${r.id}`,
    kind: 'module' as const,
    name: `${r.name}@${r.version}`,
    team: null,
    person: r.author ?? (r.fix_model || r.fix_provider ? 'Dittoly (self-fix)' : null),
    ai:
      r.origin === 'assistant'
        ? `${r.assistant ?? 'an AI assistant'} over MCP`
        : r.fix_provider
          ? `${r.fix_provider}${r.fix_model ? ` / ${r.fix_model}` : ''} (organization)`
          : orgAiName(org),
    detail: `Module code and manifest drafted by AI, ${r.status === 'approved' ? 'reviewed and approved by an admin' : 'waiting for review'}`,
    reach: [],
  }));
}

async function agentEntries(db: Queryable): Promise<Omit<InventoryEntry, 'classification'>[]> {
  const { rows } = await db.query<{ id: string; name: string; handle: string; expires_at: Date | null; scopes: { tools: Record<string, string>; drafting: boolean } | null; oauth_client_name: string | null }>(
    `SELECT t.id, t.name, m.handle, t.expires_at, t.scopes, t.oauth_client_name FROM mcp_tokens t JOIN members m ON m.id = t.member_id
     WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) ORDER BY t.created_at`,
  );
  return rows.map((r) => {
    const grants = Object.values(r.scopes?.tools ?? {});
    const scopes = r.scopes
      ? `${grants.filter((g) => g === 'run').length} tools used directly, ${grants.filter((g) => g === 'ask').length} that ask first${r.scopes.drafting ? ', may draft Flows and modules' : ''}`
      : 'everything its person can use (made before agent scopes)';
    return {
      key: `agent:${r.id}`,
      kind: 'agent' as const,
      name: r.name,
      team: null,
      person: r.handle,
      ai: r.oauth_client_name ? `${r.oauth_client_name} (signed in with OAuth)` : 'an AI assistant with an MCP token',
      detail: `Acts for ${r.handle} over MCP: ${scopes}; ${r.expires_at ? `expires ${r.expires_at.toISOString().slice(0, 10)}` : 'no expiry'}`,
      reach: [],
    };
  });
}

async function featureEntries(db: Queryable, org: OrgAi): Promise<Omit<InventoryEntry, 'classification'>[]> {
  if (!org.provider) return [];
  const f = (key: string, name: string, detail: string) => ({ key: `feature:${key}`, kind: 'feature' as const, name, team: null, person: null, ai: orgAiName(org), detail, reach: [] });
  const out = [
    f('module_drafting', 'Module drafting', 'Drafts modules from a request and an API reference; every draft is tested in the sandbox and reviewed by an admin.'),
    f('flow_drafting', 'Flow drafting', 'Drafts Flows from a request; every version is reviewed and approved by an approver.'),
    f('plan_drafting', 'Plans from documents', 'Reads an uploaded plan (PDF) and drafts the modules and Flows it needs, for review.'),
    f('commands', 'Spoken and chat commands', 'Turns what someone says to their phone or in chat into one proposed action, which they confirm.'),
  ];
  if ((await getSelfFix(db)).enabled) out.push(f('self_fix', 'Self-fixing Flows', 'Drafts a fixed module version when an app changes, and proposes Flow versions pinned to it; people approve each part.'));
  return out;
}

export async function aiInventory(db: Queryable, flows: FlowService, org: OrgAi): Promise<InventoryEntry[]> {
  const entries = [...(await flowEntries(db, flows, org)), ...(await moduleEntries(db, org)), ...(await agentEntries(db)), ...(await featureEntries(db, org))];
  const saved = new Map(
    (await db.query<{ entry_key: string; risk_class: RiskClass; purpose: string | null; owner: string | null; reviewed_at: Date | null; handle: string | null }>(
      `SELECT i.entry_key, i.risk_class, i.purpose, i.owner, i.reviewed_at, m.handle FROM ai_inventory i LEFT JOIN members m ON m.id = i.reviewed_by`,
    )).rows.map((r) => [r.entry_key, r]),
  );
  return entries.map((e) => {
    const c = saved.get(e.key);
    return {
      ...e,
      classification: c
        ? { riskClass: c.risk_class, purpose: c.purpose, owner: c.owner, reviewedAt: c.reviewed_at, reviewedBy: c.handle }
        : { riskClass: 'not_classified' as const, purpose: null, owner: null, reviewedAt: null, reviewedBy: null },
    };
  });
}

/** Admins classify an entry; saving it counts as reviewing it. */
export async function classifyEntry(db: Queryable, flows: FlowService, org: OrgAi, actor: Member, key: string, body: z.infer<typeof classifyBody>): Promise<InventoryEntry> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const entry = (await aiInventory(db, flows, org)).find((e) => e.key === key);
  if (!entry) throw notFound('inventory_entry');
  await db.query(
    `INSERT INTO ai_inventory (entry_key, risk_class, purpose, owner, reviewed_by, reviewed_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (entry_key) DO UPDATE SET risk_class = EXCLUDED.risk_class, purpose = EXCLUDED.purpose, owner = EXCLUDED.owner, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`,
    [key, body.riskClass, body.purpose || null, body.owner || null, actor.id],
  );
  await audit(db, { actorId: actor.id, action: `ai_inventory.classified_${body.riskClass}`, subjectType: 'org', subjectId: key, outcome: 'ok' });
  return (await aiInventory(db, flows, org)).find((e) => e.key === key)!;
}

/** Per risk class: how many entries; for the governance report. */
export function inventorySummary(entries: InventoryEntry[]) {
  const byClass = Object.fromEntries(RISK_CLASSES.map((c) => [c, 0])) as Record<RiskClass, number>;
  for (const e of entries) byClass[e.classification.riskClass] += 1;
  const reviewed = entries.map((e) => e.classification.reviewedAt).filter((d): d is Date => !!d);
  return {
    entries: entries.length,
    byClass,
    byKind: { flow: entries.filter((e) => e.kind === 'flow').length, module: entries.filter((e) => e.kind === 'module').length, agent: entries.filter((e) => e.kind === 'agent').length, feature: entries.filter((e) => e.kind === 'feature').length },
    oldestReview: reviewed.length ? new Date(Math.min(...reviewed.map((d) => d.getTime()))) : null,
    flowsWithUnguardedReach: entries.filter((e) => e.reach.some((r) => !r.guarded)).length,
  };
}

export function inventoryCsv(entries: InventoryEntry[]): string {
  const head = 'key,kind,name,team,person,ai,detail,reach,risk_class,purpose,owner,last_reviewed,reviewed_by';
  const rows = entries.map((e) =>
    [
      e.key,
      e.kind,
      e.name,
      e.team ?? '',
      e.person ?? '',
      e.ai,
      e.detail,
      e.reach.map((r) => `${r.step}: ${r.what} (${r.guarded ? 'a person checks first' : 'NOT checked by a person'})`).join('; '),
      e.classification.riskClass,
      e.classification.purpose ?? '',
      e.classification.owner ?? '',
      e.classification.reviewedAt ? e.classification.reviewedAt.toISOString() : '',
      e.classification.reviewedBy ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  return [`# Dittoly AI system inventory, generated ${new Date().toISOString()}. Evidence for your records, not a compliance assessment.`, head, ...rows].join('\n') + '\n';
}

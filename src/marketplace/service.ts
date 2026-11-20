import { z } from 'zod';
import { aiTags, flowTags, moduleTags } from './tags.js';
import type { AiProvider } from '../ai/provider.js';
import { audit } from '../core/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { canApprove, type Member } from '../core/members.js';
import type { Db } from '../db/db.js';
import type { FlowService, FlowVersion } from '../flows/service.js';
import { reviewSummary } from '../modules/manifest.js';
import type { ModuleRegistry } from '../modules/registry.js';

const tags = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/)).max(10).default([]);

export const publishModuleSchema = z.object({ moduleVersionId: z.string().uuid(), tags }).strict();
export const publishTemplateSchema = z
  .object({ flowVersionId: z.string().uuid(), title: z.string().min(1).max(120), summary: z.string().min(1).max(1000), tags })
  .strict();

interface ListingRow {
  id: string;
  kind: 'module' | 'flow_template';
  module_name: string | null;
  flow_version_id: string | null;
  title: string;
  summary: string;
  tags: string[];
  published_by: string;
  published_at: Date;
  deprecated_at: Date | null;
}

function semverCmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * The organization's own marketplace (Phase 1: this server only). Listing is
 * curation, not approval: only already-approved modules and Flow versions can
 * be listed, and using a template still needs its own Flow approval.
 */
export class Marketplace {
  constructor(
    private readonly db: Db,
    private readonly modules: ModuleRegistry,
    private readonly flows: FlowService,
    private readonly ai: AiProvider | null = null,
  ) {}

  /** Tags in use on current listings, most used first: the chips above the marketplace. */
  async tags(): Promise<{ tag: string; count: number }[]> {
    const { rows } = await this.db.query<{ tag: string; count: number }>(
      `SELECT t AS tag, count(*)::int AS count FROM marketplace_listings, unnest(tags) AS t
       WHERE deprecated_at IS NULL GROUP BY t ORDER BY count(*) DESC, t LIMIT 40`,
    );
    return rows;
  }

  /** Tags that follow from what is being listed (apps, how it connects, what it changes, step kinds). */
  async suggestTags(ref: { moduleVersionId?: string | undefined; flowVersionId?: string | undefined }): Promise<string[]> {
    if (ref.moduleVersionId) {
      const mv = await this.modules.get(this.db, ref.moduleVersionId);
      if (!mv) throw notFound('module');
      return moduleTags(mv.manifest, mv.generation?.classification?.category ?? null);
    }
    if (ref.flowVersionId) {
      const v = await this.flows.getVersion(this.db, ref.flowVersionId);
      if (!v) throw notFound('flow_version');
      const modules = await this.flows.pinnedModules(this.db, v.definition);
      return flowTags(v.definition, [...modules.values()].map((m) => m.manifest));
    }
    throw badRequest('invalid_request');
  }

  /** The organization's AI reads the title and summary and proposes tags (only for people who can publish). */
  async suggestTagsWithAi(actor: Member, title: string, summary: string): Promise<string[]> {
    if (actor.role !== 'admin' && actor.role !== 'approver') throw forbidden('approver_only');
    if (!this.ai) throw new AppError('ai_provider_not_configured', 503);
    return aiTags(this.ai, { title: title.slice(0, 120), summary: summary.slice(0, 1000), existing: (await this.tags()).map((t) => t.tag) });
  }

  private async approvedVersions(name: string) {
    const all = (await this.modules.list()).filter((m) => m.name === name && m.status === 'approved');
    return all.sort((a, b) => semverCmp(a.version, b.version));
  }

  async publishModule(body: unknown, actor: Member) {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const p = publishModuleSchema.safeParse(body);
    if (!p.success) throw badRequest('invalid_listing');
    const mv = await this.modules.get(this.db, p.data.moduleVersionId);
    if (!mv) throw notFound('module');
    if (mv.status !== 'approved') throw conflict('module_not_approved');
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO marketplace_listings (kind, module_name, title, summary, tags, published_by)
       VALUES ('module', $1, $2, $3, $4, $5)
       ON CONFLICT (module_name) WHERE kind = 'module'
       DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, tags = EXCLUDED.tags, deprecated_at = NULL
       RETURNING id`,
      [mv.name, mv.manifest.title, mv.manifest.description, p.data.tags, actor.id],
    );
    const id = rows[0]!.id;
    await audit(this.db, { actorId: actor.id, action: 'marketplace.module_published', subjectType: 'module', subjectId: mv.id, outcome: 'ok', relatedId: id });
    return { id };
  }

  async publishTemplate(body: unknown, actor: Member) {
    if (!canApprove(actor)) throw forbidden('approver_only');
    const p = publishTemplateSchema.safeParse(body);
    if (!p.success) throw badRequest('invalid_listing');
    await this.flows.assertRunnable(this.db, p.data.flowVersionId); // approved, current, hash intact
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO marketplace_listings (kind, flow_version_id, title, summary, tags, published_by)
       VALUES ('flow_template', $1, $2, $3, $4, $5)
       ON CONFLICT (flow_version_id) WHERE kind = 'flow_template' DO NOTHING
       RETURNING id`,
      [p.data.flowVersionId, p.data.title, p.data.summary, p.data.tags, actor.id],
    );
    if (!rows[0]) throw conflict('already_listed');
    await audit(this.db, { actorId: actor.id, action: 'marketplace.template_published', subjectType: 'flow_version', subjectId: p.data.flowVersionId, outcome: 'ok', relatedId: rows[0].id });
    return { id: rows[0].id };
  }

  async deprecate(id: string, actor: Member): Promise<void> {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const { rowCount } = await this.db.query(`UPDATE marketplace_listings SET deprecated_at = now() WHERE id = $1 AND deprecated_at IS NULL`, [id]);
    if (!rowCount) throw notFound('listing');
    await audit(this.db, { actorId: actor.id, action: 'marketplace.deprecated', subjectType: 'module', subjectId: id, outcome: 'ok' });
  }

  async list(filter: { kind?: string | undefined; q?: string | undefined; tag?: string | undefined } = {}) {
    const { rows } = await this.db.query<ListingRow>(`SELECT * FROM marketplace_listings ORDER BY deprecated_at NULLS FIRST, title`);
    const q = filter.q?.toLowerCase();
    const out = [];
    for (const r of rows) {
      if (filter.kind && r.kind !== filter.kind) continue;
      if (filter.tag && !r.tags.includes(filter.tag)) continue;
      if (q && !`${r.title} ${r.summary} ${r.tags.join(' ')}`.toLowerCase().includes(q)) continue;
      const base = {
        id: r.id,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        tags: r.tags,
        publishedAt: r.published_at,
        deprecated: r.deprecated_at !== null,
      };
      if (r.kind === 'module') {
        const versions = await this.approvedVersions(r.module_name!);
        const latest = versions.at(-1);
        out.push({
          ...base,
          module: r.module_name,
          latest: latest ? { ref: `${latest.name}@${latest.version}`, id: latest.id } : null,
          versions: versions.map((v) => v.version),
          hosts: latest?.manifest.hosts ?? [],
          actions: latest?.manifest.actions.map((a) => ({ name: a.name, title: a.title, effect: a.effect })) ?? [],
        });
      } else {
        out.push({ ...base, flowVersionId: r.flow_version_id });
      }
    }
    return out;
  }

  async details(id: string) {
    const r = (await this.db.query<ListingRow>(`SELECT * FROM marketplace_listings WHERE id = $1`, [id])).rows[0];
    if (!r) throw notFound('listing');
    if (r.kind === 'module') {
      const latest = (await this.approvedVersions(r.module_name!)).at(-1);
      return { id: r.id, kind: r.kind, title: r.title, deprecated: r.deprecated_at !== null, review: latest ? reviewSummary(latest.manifest) : null };
    }
    return { id: r.id, kind: r.kind, title: r.title, deprecated: r.deprecated_at !== null, review: (await this.flows.review(r.flow_version_id!)).summary };
  }

  /** Copy a template into a new Flow owned by the member. It needs its own approval before it runs. */
  async useTemplate(id: string, actor: Member, name?: string): Promise<FlowVersion> {
    const r = (await this.db.query<ListingRow>(`SELECT * FROM marketplace_listings WHERE id = $1`, [id])).rows[0];
    if (!r || r.kind !== 'flow_template') throw notFound('template');
    if (r.deprecated_at) throw conflict('listing_deprecated');
    const source = await this.flows.getVersion(this.db, r.flow_version_id!);
    if (!source) throw notFound('flow_version');
    const v = await this.flows.create(name?.slice(0, 120) || r.title, source.definition, actor);
    await this.db.query(`UPDATE flows SET template_listing_id = $2 WHERE id = $1`, [v.flowId, r.id]);
    await audit(this.db, { actorId: actor.id, action: 'marketplace.template_used', subjectType: 'flow', subjectId: v.flowId, outcome: 'ok', relatedId: r.id });
    return v;
  }

  /**
   * Newer approved versions of the modules a Flow version pins. Upgrading is
   * always a deliberate Flow change, which needs approval again.
   */
  async upgradesFor(flowVersionId: string) {
    const v = await this.flows.getVersion(this.db, flowVersionId);
    if (!v) throw notFound('flow_version');
    const pinned = await this.flows.pinnedModules(this.db, v.definition);
    const out = [];
    for (const mv of pinned.values()) {
      const latest = (await this.approvedVersions(mv.name)).at(-1);
      if (latest && semverCmp(latest.version, mv.version) > 0) out.push({ kind: 'module' as const, module: mv.name, pinned: mv.version, latest: latest.version });
    }
    // Flows a Super Flow runs: a newer approved version is an upgrade too.
    for (const c of (await this.flows.pinnedFlows(this.db, v.definition)).values()) {
      const latest = (await this.db.query<{ version: number }>(`SELECT version FROM flow_versions WHERE flow_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1`, [c.flowId])).rows[0];
      if (latest && latest.version > c.version.version) out.push({ kind: 'flow' as const, module: c.name, flowId: c.flowId, pinned: `v${c.version.version}`, latest: `v${latest.version}` });
    }
    return out;
  }
}

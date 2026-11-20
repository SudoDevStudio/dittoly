import { moduleGuide } from '../core/guides.js';
import type { ModuleConfig } from './module-config.js';
import { hasBase, ownCode } from './module-base.js';
import type { DraftSource } from '../ai/sources.js';
import type { ClassificationRecord } from '../ai/classify.js';
import type { ApiReference } from '../ai/api-source.js';
import { resetMediaCache } from '../core/media.js';
import type { BrowserLauncher } from '../sandbox/browser.js';
import type { Db, Queryable } from '../db/db.js';
import type { DeploymentMode } from '../config.js';
import { audit } from '../core/audit.js';
import { canonicalJson, sha256Hex } from '../core/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { archivedModules } from '../flows/archive.js';
import type { Member } from '../core/members.js';
import { notifyRole } from '../core/notify.js';
import { enqueue } from '../engine/jobs.js';
import { recordedTests, resolveDrift } from './health.js';
import { assertNotRequester, moduleApprovalsNeeded, noteChangeDecision, recordModuleApproval } from '../governance/changes.js';
import { checkModuleApproval } from '../governance/policies.js';
import type { SandboxRunner } from '../sandbox/runner.js';
import { reviewSummary, type Manifest } from './manifest.js';
import { draftQuality, moduleTestSchema, validateModule, type ModuleTest, type ValidationReport } from './validate.js';
import { compileModuleSource } from './source.js';

export type ModuleStatus = 'draft' | 'pending_review' | 'approved' | 'rejected';

/** A deleted (archived) module gets no new versions or approvals until an admin restores it. */
async function assertNotArchived(db: Queryable, name: string): Promise<void> {
  if ((await archivedModules(db)).has(name)) throw new AppError('module_archived', 409, `Module "${name}" was deleted; an admin can restore it first.`);
}

export interface ModuleVersion {
  id: string;
  name: string;
  version: string;
  manifest: Manifest;
  /** The JavaScript the sandbox runs. */
  code: string;
  codeSha256: string;
  /** The TypeScript `code` was compiled from (source.ts); null for modules written as JavaScript. */
  source: string | null;
  sourceSha256: string | null;
  manifestSha256: string;
  status: ModuleStatus;
  origin: 'chat' | 'seed' | 'mcp' | 'script' | 'assistant' | 'git';
  validationReport: ValidationReport | null;
  createdBy: string | null;
  generation: Generation | null;
}

/** What a chat-built draft was generated from; shown to reviewers. */
export interface Generation {
  source: ApiReference['origin'] | null;
  /** The condensed API reference, kept so revisions build on the same source. */
  reference: string | null;
  instructions: { text: string; sha256: string } | null;
  /** What the request was classified as before building, and the person's answers. */
  classification?: ClassificationRecord | null;
  /** Drafted by an AI assistant over MCP (not by Dittoly's AI). */
  assistant?: AssistantDraft | null;
  /** A fix Dittoly drafted on its own because the app seems to have changed. */
  fix?: FixDraft | null;
  /** The web pages the AI read (search) or named as what it relied on (ai), for the reviewer. */
  sources?: DraftSource[];
  /** The builder's short notes for MODULE.md (src/core/guides.ts). */
  notes?: string;
  /** What each action is and does (src/modules/module-config.ts). */
  config?: ModuleConfig;
  /** A new module that started from this approved one (which stays as it was). */
  cloneOf?: { module: string; version: string };
  /**
   * Which AI wrote this version, and how hard it was told to think: "anthropic", "claude-opus-5", "medium".
   * Shown with the draft, so two models' work can be told apart at a glance and compared later.
   */
  by?: DraftedBy | null;
  /** What drafting this version cost: tokens, and how many AI calls it took (one plus each round of fixing). */
  cost?: DraftCost | null;
  /** The team's earlier answers this draft was given (src/ai/decisions.ts), by id, and how many were unreadable. */
  memory?: { used: string[]; unreadable: number; build?: { used: string[]; unreadable: number; omitted: number } } | null;
}

/** What a draft cost the AI that wrote it. `calls` above one means it was sent back to be fixed. */
export interface DraftCost { input: number; output: number; calls: number }

/** The AI behind a draft: the provider as Dittoly names it, the model it answered with, the effort asked for. */
export interface DraftedBy {
  provider: string;
  model: string | null;
  effort?: string | null;
}

/**
 * "anthropic:claude-opus-5-5:medium" — one short label for a list, a chip or a benchmark. The model is the one the
 * answer came from, never a word like "default": opus-5 and opus-5.5 write differently, and a label that hides
 * which one answered cannot be compared with anything. Where a provider truly reports none, it says "unknown".
 */
export function draftedByLabel(by: DraftedBy | null | undefined): string | null {
  if (!by?.provider) return null;
  return [by.provider, by.model || 'unknown', by.effort].filter(Boolean).join(':');
}

/** Why Dittoly drafted a fix by itself: the drift it saw, for the reviewer. */
export interface FixDraft {
  /** What failed, in words (no data). */
  reason: string;
  /** The version that drifted. */
  fromVersion: string;
}

/** Who drafted it: an AI assistant, for a member, through one of their MCP tokens. */
export interface AssistantDraft {
  /** What the assistant called itself, e.g. "Claude Code" (its own word, not verified). */
  name: string | null;
  /** The member's name for the MCP token it used. */
  token: string;
  /** The assistant's own explanation for the approver. */
  explanation: string;
}

interface Row {
  id: string;
  name: string;
  version: string;
  manifest: Manifest;
  code: string;
  code_sha256: string;
  source: string | null;
  source_sha256: string | null;
  manifest_sha256: string;
  status: ModuleStatus;
  origin: 'chat' | 'seed' | 'mcp' | 'script' | 'assistant' | 'git';
  validation_report: ValidationReport | null;
  created_by: string | null;
  generation: Generation | null;
}

const fromRow = (r: Row): ModuleVersion => ({
  id: r.id,
  name: r.name,
  version: r.version,
  manifest: r.manifest,
  code: r.code,
  codeSha256: r.code_sha256,
  source: r.source,
  sourceSha256: r.source_sha256,
  manifestSha256: r.manifest_sha256,
  status: r.status,
  origin: r.origin,
  validationReport: r.validation_report,
  createdBy: r.created_by,
  generation: r.generation,
});

/** "name@1.2.3" — how Flows pin a module version. */
export const moduleRef = (m: { name: string; version: string }) => `${m.name}@${m.version}`;

/** MODULE.md of a version: Dittoly's reference from the manifest and config, with the builder's notes. */
export function guideOfModule(mv: { manifest: unknown; version: string; source: string | null; generation?: Generation | null }): string {
  return moduleGuide(mv.manifest, { version: mv.version, notes: mv.generation?.notes, config: mv.generation?.config ?? null, source: mv.source });
}

export class ModuleRegistry {
  constructor(
    private readonly db: Db,
    private readonly runner: SandboxRunner,
    private readonly mode: DeploymentMode,
    private readonly insecureHttpHosts: readonly string[] = [],
    private readonly browser?: BrowserLauncher,
    private readonly internalHosts: readonly string[] = [],
  ) {}

  /**
   * Store a new draft version (from chat generation or a seed), validated in the sandbox. Give the TypeScript
   * `source` (Dittoly compiles it and runs the result) or, for modules written as JavaScript, the `code`.
   */
  /** Compiles and sandbox-tests a draft without storing it (with the tests recorded for earlier versions). */
  async checkDraft(input: { manifest: unknown; tests: unknown[] } & ({ source: string; code?: undefined } | { code: string; source?: undefined })) {
    const source = input.source ?? null;
    const code = source !== null ? await compileModuleSource(source) : input.code!;
    const tests: ModuleTest[] = [];
    for (const t of input.tests) {
      const r = moduleTestSchema.safeParse(t);
      if (r.success) tests.push(r.data);
    }
    // Tests recorded against the real app for earlier versions must still pass (for actions this version still has).
    const name = (input.manifest as { name?: unknown } | null)?.name;
    if (typeof name === 'string') await assertNotArchived(this.db, name);
    const actions = new Set(((input.manifest as { actions?: { name?: unknown }[] } | null)?.actions ?? []).map((a) => a?.name));
    const recorded = typeof name === 'string' ? (await recordedTests(this.db, name)).filter((t) => actions.has(t.action)) : [];
    const { report, manifest } = await validateModule(this.runner, input.manifest, code, [...tests, ...recorded], { insecureHttpHosts: this.insecureHttpHosts, internalHosts: this.internalHosts, browser: this.browser });
    return { source, code, tests, report, manifest };
  }

  async createDraft(
    input: { manifest: unknown; tests: unknown[]; origin: 'chat' | 'seed' | 'script' | 'assistant' | 'git'; generation?: Generation | null } & ({ source: string; code?: undefined } | { code: string; source?: undefined }),
    actor: Member | null,
  ): Promise<ModuleVersion> {
    const { source, code, tests, report, manifest } = await this.checkDraft(input);
    if (!manifest) throw badRequest('invalid_manifest', report.checks[0]?.details?.join('; '));
    const exists = await this.findByRef(this.db, manifest.name, manifest.version);
    if (exists) throw conflict('module_version_exists');
    const { rows } = await this.db.query<Row>(
      `INSERT INTO module_versions (name, version, manifest, code, code_sha256, manifest_sha256, tests, origin, status, validation_report, created_by, generation, source, source_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11, $12, $13) RETURNING *`,
      [
        manifest.name,
        manifest.version,
        JSON.stringify(manifest),
        code,
        sha256Hex(code),
        sha256Hex(canonicalJson(manifest)),
        JSON.stringify(tests),
        input.origin,
        JSON.stringify(report),
        actor?.id ?? null,
        input.generation ? JSON.stringify(input.generation) : null,
        source,
        source === null ? null : sha256Hex(source),
      ],
    );
    const mv = fromRow(rows[0]!);
    await audit(this.db, {
      actorId: actor?.id ?? null,
      action: 'module.drafted',
      subjectType: 'module',
      subjectId: mv.id,
      outcome: report.passed ? 'ok' : 'failed',
      errorType: report.passed ? undefined : 'validation_failed',
    });
    return mv;
  }

  /**
   * Drafts and modules waiting for review whose sandbox report failed a refusal test only because
   * the input schema refused its input (counted as a failure before that was a pass) get their
   * tests run again. Only the report changes: the code, manifest and their hashes do not.
   * Approved modules are never touched. Returns how many reports were updated.
   */
  async recheckRefusalTests(): Promise<number> {
    const { rows } = await this.db.query<Row & { tests: unknown }>(
      `SELECT * FROM module_versions
       WHERE status IN ('draft', 'pending_review') AND origin <> 'mcp'
         AND validation_report @> '{"tests": [{"errorType": "test_input_invalid"}]}'`,
    );
    let updated = 0;
    for (const row of rows) {
      const mv = fromRow(row);
      const stored = (Array.isArray(row.tests) ? (row.tests as unknown[]) : []).flatMap((t) => {
        const r = moduleTestSchema.safeParse(t);
        return r.success ? [r.data] : [];
      });
      // Only worth a run when a test that expects a refusal is among the failures.
      const refusals = new Set(stored.filter((t: ModuleTest) => !t.expectOk).map((t: ModuleTest) => t.name));
      if (!mv.validationReport?.tests.some((t) => t.errorType === 'test_input_invalid' && refusals.has(t.name))) continue;
      const actions = new Set(mv.manifest.actions.map((a) => a.name));
      const recorded = (await recordedTests(this.db, mv.name)).filter((t) => actions.has(t.action));
      const { report } = await validateModule(this.runner, mv.manifest, mv.code, [...stored, ...recorded], { insecureHttpHosts: this.insecureHttpHosts, internalHosts: this.internalHosts, browser: this.browser });
      await this.db.query(`UPDATE module_versions SET validation_report = $2 WHERE id = $1 AND status IN ('draft', 'pending_review')`, [mv.id, JSON.stringify(report)]);
      await audit(this.db, { actorId: null, action: 'module.tests_rechecked', subjectType: 'module', subjectId: mv.id, outcome: report.passed ? 'ok' : 'failed', errorType: report.passed ? undefined : 'validation_failed' });
      updated++;
    }
    return updated;
  }

  /** Store an imported (non-code) module version, e.g. an MCP server's tool snapshot. Still needs admin approval. */
  async createImported(manifest: Manifest, config: string, report: ValidationReport, actor: Member): Promise<ModuleVersion> {
    if (await this.findByRef(this.db, manifest.name, manifest.version)) throw conflict('module_version_exists');
    await assertNotArchived(this.db, manifest.name);
    const { rows } = await this.db.query<Row>(
      `INSERT INTO module_versions (name, version, manifest, code, code_sha256, manifest_sha256, origin, status, validation_report, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'mcp', 'draft', $7, $8) RETURNING *`,
      [
        manifest.name,
        manifest.version,
        JSON.stringify(manifest),
        config,
        sha256Hex(config),
        sha256Hex(canonicalJson(manifest)),
        JSON.stringify(report),
        actor.id,
      ],
    );
    return fromRow(rows[0]!);
  }

  async get(db: Queryable, id: string): Promise<ModuleVersion | null> {
    const { rows } = await db.query<Row>(`SELECT * FROM module_versions WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async findByRef(db: Queryable, name: string, version: string): Promise<ModuleVersion | null> {
    const { rows } = await db.query<Row>(`SELECT * FROM module_versions WHERE name = $1 AND version = $2`, [name, version]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async resolveRef(db: Queryable, ref: string): Promise<ModuleVersion | null> {
    const at = ref.lastIndexOf('@');
    if (at <= 0) return null;
    return this.findByRef(db, ref.slice(0, at), ref.slice(at + 1));
  }

  /** Every version; `archived` marks a deleted module (every version of that name). */
  async list(): Promise<(Omit<ModuleVersion, 'code' | 'source'> & { archived: boolean })[]> {
    const { rows } = await this.db.query<Row>(`SELECT * FROM module_versions ORDER BY name, created_at`);
    const archived = await archivedModules(this.db);
    return rows.map(fromRow).map(({ code: _code, source: _source, ...rest }) => ({ ...rest, archived: archived.has(rest.name) }));
  }

  /** What the admin sees: the plain summary, the sandbox test report, and the hashes being approved. */
  async review(id: string) {
    const mv = await this.get(this.db, id);
    if (!mv) throw notFound('module');
    return {
      id: mv.id,
      ref: moduleRef(mv),
      status: mv.status,
      origin: mv.origin,
      summary: reviewSummary(mv.manifest),
      /** What the checks found, read as one line: security, performance, tests, settings explained. */
      quality: draftQuality(mv.validationReport),
      manifest: mv.manifest,
      validationReport: mv.validationReport,
      codeSha256: mv.codeSha256,
      manifestSha256: mv.manifestSha256,
      // The TypeScript people read; the sandbox runs what it compiles to (codeSha256).
      source: mv.source,
      sourceSha256: mv.sourceSha256,
      // Where the AI's draft came from (never the reference text itself).
      generation: mv.generation ? { source: mv.generation.source, instructions: mv.generation.instructions, classification: mv.generation.classification ?? null, assistant: mv.generation.assistant ?? null, fix: mv.generation.fix ?? null, cloneOf: mv.generation.cloneOf ?? null } : null,
      /** MODULE.md: what it does and how to use it, for people and the next builder. */
      guide: guideOfModule(mv),
      /** What each action is and does (src/modules/module-config.ts). */
      config: mv.generation?.config ?? null,
      /** The module's own TypeScript, without the Dittoly base above it (the part to review). */
      ownSource: mv.source !== null && hasBase(mv.source) ? ownCode(mv.source) : null,
    };
  }

  /** Send a draft for review; `null` is Dittoly itself (a fix it drafted). */
  async submit(id: string, actor: Member | null): Promise<void> {
    const mv = await this.get(this.db, id);
    if (!mv) throw notFound('module');
    if (actor && mv.createdBy !== null && mv.createdBy !== actor.id && actor.role !== 'admin') throw forbidden();
    if (mv.status !== 'draft') throw conflict('module_not_draft');
    if (!mv.validationReport?.passed) throw conflict('module_validation_failed');
    await this.db.query(`UPDATE module_versions SET status = 'pending_review' WHERE id = $1`, [id]);
    await audit(this.db, { actorId: actor?.id ?? null, action: 'module.submitted', subjectType: 'module', subjectId: id, outcome: 'ok' });
    await notifyRole(this.db, ['admin'], 'module_review_needed', {}, actor?.id);
  }

  async decide(id: string, actor: Member, decision: 'approved' | 'rejected'): Promise<void> {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const mv = await this.get(this.db, id);
    if (!mv) throw notFound('module');
    await assertNotArchived(this.db, mv.name);
    // Shared mode: nobody approves a module they generated. Local mode has one member.
    if (this.mode === 'shared' && mv.createdBy === actor.id) throw forbidden('cannot_review_own_module');
    // Nor a self-fix they asked for (src/governance/changes.ts).
    if (this.mode === 'shared' && decision === 'approved') await assertNotRequester(this.db, 'module', id, actor);
    if (decision === 'approved') {
      await checkModuleApproval(this.db, mv.manifest);
      // A fix that widens access needs several different admins (shared mode): each approval is recorded until there are enough.
      const need = this.mode === 'shared' ? await moduleApprovalsNeeded(this.db, id) : 1;
      if (need > 1) {
        const { done } = await recordModuleApproval(this.db, id, actor, need);
        if (!done) {
          await audit(this.db, { actorId: actor.id, action: 'module.approval_recorded', subjectType: 'module', subjectId: id, outcome: 'ok' });
          await noteChangeDecision(this.db, 'module', id, actor, decision);
          return;
        }
      }
    }
    const { rowCount } = await this.db.query(
      `UPDATE module_versions SET status = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1 AND status = 'pending_review'`,
      [id, decision, actor.id],
    );
    if (!rowCount) throw conflict('module_not_pending_review');
    // A newly approved version is the answer to a drift warning.
    if (decision === 'approved') await resolveDrift(this.db, mv.name, null);
    // Written to the organization's git repository, when one is connected (src/git-sync/service.ts).
    if (decision === 'approved') await enqueue(this.db, 'git_export', { kind: 'module', versionId: id });
    // Plans waiting on this module draft their Flows once it is approved (src/plans/service.ts).
    await enqueue(this.db, 'module_decided', { moduleVersionId: id });
    // Approved browser modules' sites may now be shown in run views (the CSP is rebuilt).
    resetMediaCache();
    await audit(this.db, {
      actorId: actor.id,
      action: decision === 'approved' ? 'module.approved' : 'module.rejected',
      subjectType: 'module',
      subjectId: id,
      outcome: 'ok',
    });
    await noteChangeDecision(this.db, 'module', id, actor, decision);
  }
}

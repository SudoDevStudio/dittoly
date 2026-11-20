import { currentAiContext, withAiContext } from '../ai/metering.js';
import { draftModelFor } from '../ai/draft-model.js';
import { buildMemoryFor, journal } from '../ai/build-memory.js';
import { decisionsForDraft, rememberAnswers } from '../ai/decisions.js';
import { defaultTeamFor } from '../core/teams.js';
import { AiError, draftReviewRound, type AiProvider } from '../ai/provider.js';
import { buildApiReference, type ApiSourceInput } from '../ai/api-source.js';
import { hasBase, ownCode } from './module-base.js';
import { generateModule, type GeneratedModule, type GenerationContext } from '../ai/generate-module.js';
import { log } from '../core/log.js';
import { DocsCache, docsKeyFor, readFoundDocs } from '../ai/docs-cache.js';
import { parseManifest } from './manifest.js';
import { tidyManifest } from './manifest-tidy.js';
import { compileModuleSource } from './source.js';
import { progress } from '../core/progress.js';
import { classificationRecord, classificationText, classifyModuleRequest, needsPerson, type Classification } from '../ai/classify.js';
import { getAiInstructions, instructionsSnapshot } from '../core/org-settings.js';
import type { FetchLike } from '../sandbox/broker.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Cipher } from '../core/crypto.js';
import type { Db } from '../db/db.js';
import type { DraftCost, DraftedBy, FixDraft, Generation, ModuleRegistry, ModuleVersion } from './registry.js';

/** Times the AI may fix a manifest that does not parse before the request fails. */
const MAX_REPAIRS = 2;
/** Times the AI may fix a draft whose own sandbox tests or checks fail, before it is stored for review as it is. */
const TEST_REPAIRS = 2;
/** AI answers that could not be read at all: worth one more try (as for Flows). */
const UNREADABLE = new Set(['ai_response_not_json', 'ai_output_truncated', 'ai_response_shape', 'ai_output_unparseable', 'ai_no_structured_output']);

export function bumpPatch(v: string): string {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${(c ?? 0) + 1}`;
}

export function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Chat-driven module creation: request -> AI draft -> sandbox validation -> draft for review. */
/** "module.ts:240:3" in a compiler message, as the line in the module's own code under the Dittoly base. */
function ownPositions(source: string, message: string): string {
  if (!hasBase(source)) return message;
  const offset = source.length - ownCode(source).length;
  const baseLines = source.slice(0, offset).split('\n').length - 1;
  return message.replace(/module\.ts:(\d+):(\d+)/g, (m: string, line: string, col: string) => {
    const own = Number(line) - baseLines;
    return own > 0 ? `module.ts:${own}:${col}` : `${m} (in the Dittoly base)`;
  });
}

/** The API documentation in the person's answers (the "api_docs" question): a link to read, or pasted text. */
export function docsFromAnswers(answers: Record<string, string> | undefined): ApiSourceInput | undefined {
  const entry = Object.entries(answers ?? {}).find(([k, v]) => /^api_docs$|documentation/i.test(k) && v.trim());
  const value = entry?.[1].trim();
  if (!value) return undefined;
  const url = /^https:\/\/\S+$/.test(value) ? value : undefined;
  return url ? { docsUrl: url } : value.length >= 40 ? { docs: value.slice(0, 200_000) } : undefined;
}

/** Which AI wrote the draft that is being stored now, from what the metering context recorded. */
function draftedBy(): DraftedBy | null {
  const tally = currentAiContext()?.tally;
  if (!tally?.provider) return null;
  return { provider: tally.provider, model: tally.model ?? null, ...(tally.effort ? { effort: tally.effort } : {}) };
}

/** What the draft being stored now cost: its tokens, and how many calls it took (each round of fixing is one). */
function draftCost(): DraftCost | null {
  const tally = currentAiContext()?.tally;
  if (!tally || !tally.calls) return null;
  return { input: tally.input, output: tally.output, calls: tally.calls };
}

export class ModuleChat {
  /** Docs the AI found, read once per draft and kept for its fix rounds and retries (src/ai/docs-cache.ts). */
  private readonly docs = new DocsCache();
  constructor(
    private readonly db: Db,
    private readonly registry: ModuleRegistry,
    private readonly ai: AiProvider | null,
    /** Fetches API specs and docs; goes through the egress guard. */
    private readonly fetchFn: FetchLike,
    /** For what the team already answered (src/ai/decisions.ts); without it, nothing is remembered. */
    private readonly cipher?: Cipher,
  ) {}

  private provider(): AiProvider {
    if (!this.ai) throw new AppError('ai_provider_not_configured', 503);
    return this.ai;
  }

  /** Versions are never reused: if the name exists, the draft becomes the next patch version. */
  async assignVersion(manifest: unknown): Promise<unknown> {
    if (!manifest || typeof manifest !== 'object') return manifest;
    const m = manifest as { name?: unknown; version?: unknown };
    if (typeof m.name !== 'string') return manifest;
    const { rows } = await this.db.query<{ version: string }>(`SELECT version FROM module_versions WHERE name = $1`, [m.name]);
    if (rows.length === 0) return manifest;
    const latest = rows.map((r) => r.version).sort(cmpVersions).at(-1)!;
    const proposed = typeof m.version === 'string' && /^\d+\.\d+\.\d+$/.test(m.version) ? m.version : '0.0.0';
    return { ...m, version: cmpVersions(proposed, latest) > 0 ? proposed : bumpPatch(latest) };
  }

  /**
   * Classify the request first; if the person needs to answer something (or the
   * protocol is one Dittoly cannot use), return that instead of a draft.
   * With `answers`, only questions they leave open are asked; with none open, it builds.
   */
  async generate(
    request: string,
    actor: Member,
    source?: ApiSourceInput,
    answers?: Record<string, string>,
  ): Promise<{ draft: ModuleVersion } | { questions: Classification }> {
    // A module that does not exist yet has no model of its own: the member's choice, else the organization's.
    const draftModel = await draftModelFor(this.db, { type: 'member', id: actor.id }, actor.id);
    return withAiContext({ ...(currentAiContext() ?? { purpose: 'module' as const, memberId: actor.id }), ...(draftModel ? { draftModel } : {}) }, () =>
      this.generated(request, actor, source, answers),
    );
  }

  private async generated(
    request: string,
    actor: Member,
    source?: ApiSourceInput,
    answers?: Record<string, string>,
  ): Promise<{ draft: ModuleVersion } | { questions: Classification }> {
    if (!request || request.length > 20_000) throw badRequest('invalid_request');
    const provider = this.provider();
    // Documentation the person gave because the AI asked for it ("api_docs"): a link is read, a text is used as is.
    const reference = await buildApiReference(this.fetchFn, source ?? docsFromAnswers(answers), request);
    const instructions = (await getAiInstructions(this.db)).modules;
    // Docs found while drafting this before ("Try again"): read already, so the AI need not search for them again.
    const key = docsKeyFor(request);
    const found = reference ? undefined : this.docs.get(key);
    progress('understanding', 5);
    const classification = await classifyModuleRequest(provider, request, { reference: reference?.text ?? found, instructions, answers });
    const ask = needsPerson(classification, answers);
    if (ask) return { questions: ask };
    const team = await defaultTeamFor(this.db, actor.id);
    const memory = this.cipher
      ? await decisionsForDraft(this.db, this.cipher, team, { request, answeredNow: answers })
      : { text: '', used: [], unreadable: 0 };
    const guidance = classificationText(classification, answers) + memory.text;
    const context = { reference: reference?.text ?? found, instructions, guidance, ...(found ? { search: false } : {}) };
    progress('drafting', 15);
    const first = await this.call(() => this.readable(request, undefined, context));
    const out = await this.repaired(request, first, await this.withFoundDocs(key, context, first, request));
    const generation: Generation = {
      source: reference?.origin ?? null,
      reference: reference?.text ?? null,
      instructions: instructionsSnapshot(instructions),
      classification: classificationRecord(classification, answers),
      // Which of the team's earlier answers this draft was given, by id, and how many could not be read.
      ...(memory.used.length || memory.unreadable ? { memory: { used: memory.used, unreadable: memory.unreadable } } : {}),
      ...(out.sources?.length ? { sources: out.sources } : {}),
      ...(out.notes ? { notes: out.notes } : {}),
      ...(out.config ? { config: out.config } : {}),
      ...(draftedBy() ? { by: draftedBy() } : {}),
      ...(draftCost() ? { cost: draftCost() } : {}),
    };
    const draft = await this.registry.createDraft({ manifest: await this.assignVersion(out.manifest), source: out.code, tests: out.tests, origin: 'chat', generation }, actor);
    // What the person answered while this module was built: the next draft asks them nothing of the sort again.
    if (this.cipher) {
      await rememberAnswers(this.db, this.cipher, { teamId: team, source: { type: 'module', id: draft.name }, by: actor.id, about: [draft.name] }, answers);
      // What they asked this module for, kept with the module rather than with this one version of it.
      const artifact = { type: 'module' as const, id: draft.name };
      await journal(this.db, this.cipher, artifact, { kind: 'request', origin: 'user', text: request, versionRef: draft.version, by: actor.id });
      if (out.notes) await journal(this.db, this.cipher, artifact, { kind: 'suggestion', origin: 'ai', text: out.notes.slice(0, 400), versionRef: draft.version });
    }
    this.docs.delete(key);
    return { draft };
  }

  /**
   * After the first draft: the pages it used, read once and kept (DocsCache), so the rounds that fix it and a later
   * "Try again" work from them instead of searching again. Docs the person gave come first and are kept as they are.
   */
  private async withFoundDocs(key: string, context: GenerationContext, first: GeneratedModule, request: string): Promise<GenerationContext> {
    if (context.reference || !first.sources?.length) return context;
    progress('reading the docs it found', 40);
    const text = await readFoundDocs(this.fetchFn, first.sources, request);
    if (!text) return context;
    this.docs.set(key, text);
    return { ...context, reference: text };
  }

  /**
   * "Add this action to <module>" when a Flow needs something an approved module cannot do yet: a new draft version
   * of the module's newest approved version, keeping what Flows already use. Any member may propose it; like every
   * version it is reviewed and approved by an admin before anything can run it.
   */
  async extend(name: string, request: string, actor: Member): Promise<ModuleVersion> {
    if (!request || request.length > 2000) throw badRequest('invalid_request');
    const approved = (await this.registry.list()).filter((m) => m.name === name && m.status === 'approved' && !m.archived).at(-1);
    if (!approved) throw conflict('module_not_approved');
    const prev = await this.registry.get(this.db, approved.id);
    if (!prev) throw notFound('module');
    return this.revised(
      prev,
      `Add to this module what a Flow needs: ${request}\nKeep every existing action, its name, input and output exactly as they are (approved Flows use them); add a new action, with sandbox tests for it.`,
      actor,
    );
  }

  /**
   * A new module that starts from an approved one, which stays as it is: for a change in what an action does, or a
   * module for another purpose on the same app. It gets its own name (`newName`, made unique) and starts at 1.0.0;
   * Flows that use the original keep using it. Reviewed and approved like any new module.
   */
  async clone(name: string, request: string, actor: Member, newName: string): Promise<ModuleVersion> {
    if (!request || request.length > 4000) throw badRequest('invalid_request');
    const approved = (await this.registry.list()).filter((m) => m.name === name && m.status === 'approved' && !m.archived).at(-1);
    if (!approved) throw conflict('module_not_approved');
    const prev = await this.registry.get(this.db, approved.id);
    if (!prev) throw notFound('module');
    const rename = await this.freeName(newName === name ? `${name}-2` : newName);
    return this.revised(
      prev,
      `Make a NEW module named "${rename}", starting from the module "${name}" below (it stays as it is; this is a separate module): ${request}
Keep what still fits, change and add what the request asks, drop what it does not need, and write sandbox tests for every action. Set manifest "name" to "${rename}" and "version" to "1.0.0".`,
      actor,
      undefined,
      { rename, cloneOf: { module: name, version: prev.version } },
    );
  }

  /** `wanted`, or wanted-2, -3...: a module name no version uses yet. */
  private async freeName(wanted: string): Promise<string> {
    const base = wanted.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+/g, '-').slice(0, 36).replace(/-+$/, '') || 'module';
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const { rowCount } = await this.db.query(`SELECT 1 FROM module_versions WHERE name = $1 LIMIT 1`, [candidate]);
      if (!rowCount) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`.slice(0, 40);
  }

  /** `actor` null is Dittoly itself, fixing a module whose app changed (`fix` says why). */
  async revise(moduleVersionId: string, feedback: string, actor: Member | null, fix?: FixDraft): Promise<ModuleVersion> {
    const prev = await this.registry.get(this.db, moduleVersionId);
    if (!prev) throw notFound('module');
    if (actor && prev.createdBy !== actor.id && actor.role !== 'admin') throw forbidden();
    return this.revised(prev, feedback, actor, fix);
  }

  private async revised(prev: ModuleVersion, feedback: string, actor: Member | null, fix?: FixDraft, clone?: { rename: string; cloneOf: { module: string; version: string } }): Promise<ModuleVersion> {
    if (!feedback || feedback.length > 20_000) throw badRequest('invalid_feedback');
    // This module's own model where it has one, else the member's; a fix Dittoly drafts by itself has no member.
    const draftModel = await draftModelFor(this.db, { type: 'module', id: prev.name }, actor?.id);
    if (draftModel && currentAiContext()?.draftModel !== draftModel) {
      return withAiContext({ ...(currentAiContext() ?? { purpose: 'module' as const, ...(actor ? { memberId: actor.id } : {}) }), draftModel }, () =>
        this.revisedWith(prev, feedback, actor, fix, clone),
      );
    }
    return this.revisedWith(prev, feedback, actor, fix, clone);
  }

  private async revisedWith(prev: ModuleVersion, feedback: string, actor: Member | null, fix?: FixDraft, clone?: { rename: string; cloneOf: { module: string; version: string } }): Promise<ModuleVersion> {
    const instructions = (await getAiInstructions(this.db)).modules;
    const request = clone ? `Build the module "${clone.rename}" from the module "${prev.name}".` : `Revise the module "${prev.name}".`;
    const key = docsKeyFor(`${request}\n${feedback}`);
    const found = prev.generation?.reference ? undefined : this.docs.get(key);
    // What this module was first asked for, and what has been said about it since (src/ai/build-memory.ts).
    const build = this.cipher ? await buildMemoryFor(this.db, this.cipher, { type: 'module', id: prev.name }) : { text: '', used: [], unreadable: 0, omitted: 0 };
    const context: GenerationContext = { reference: prev.generation?.reference ?? found, instructions, guidance: recordGuidance(prev.generation?.classification) + build.text, ...(found ? { search: false } : {}) };
    // The builder's notes travel with the module: the AI keeps them true for the new version.
    if (prev.generation?.notes) feedback = `${feedback}\nIts current notes (MODULE.md), to keep up to date in notesMd:\n${prev.generation.notes}`;
    progress('drafting', 10);
    const first = await this.call(() =>
      this.readable(request, { draft: { manifest: prev.manifest, code: prev.source ?? prev.code, validationReport: prev.validationReport, ...(prev.generation?.config ? { config: prev.generation.config } : {}) }, feedback }, context),
    );
    const out = await this.repaired(request, first, await this.withFoundDocs(key, context, first, request));
    // A revision builds on the same API source as the draft it revises.
    const generation: Generation = {
      source: prev.generation?.source ?? null,
      reference: prev.generation?.reference ?? null,
      instructions: instructionsSnapshot(instructions),
      classification: prev.generation?.classification ?? null,
      ...(fix ? { fix } : {}),
      ...(out.sources?.length ? { sources: out.sources } : {}),
      ...(out.notes ? { notes: out.notes } : {}),
      ...(out.config ? { config: out.config } : {}),
      ...(clone ? { cloneOf: clone.cloneOf } : {}),
      ...(build.used.length || build.unreadable ? { memory: { used: [], unreadable: 0, build: { used: build.used, unreadable: build.unreadable, omitted: build.omitted } } } : {}),
      ...(draftedBy() ? { by: draftedBy() } : {}),
      ...(draftCost() ? { cost: draftCost() } : {}),
    };
    // A clone is its own module whatever the AI named it: the name Dittoly chose, from 1.0.0.
    const manifest = clone && out.manifest && typeof out.manifest === 'object' ? { ...(out.manifest as object), name: clone.rename, version: '1.0.0' } : await this.assignVersion(out.manifest);
    const draft = await this.registry.createDraft({ manifest, source: out.code, tests: out.tests, origin: 'chat', generation }, actor);
    // A clone is its own module: what was said about the one it came from is not kept against it.
    if (this.cipher && !clone) {
      // A fix Dittoly drafted by itself is evidence, not an instruction: it is marked for what it is.
      const kind = fix ? ('fix' as const) : ('request' as const);
      await journal(this.db, this.cipher, { type: 'module', id: prev.name }, { kind, origin: fix ? 'evidence' : 'user', text: feedback, versionRef: draft.version, by: actor?.id ?? null });
    }
    this.docs.delete(key);
    return draft;
  }

  /**
   * A manifest that does not even parse, or TypeScript that does not compile, cannot be stored as a draft for the
   * person to revise, so the AI gets the exact problems back and fixes them (twice at most).
   */
  private async repaired(request: string, first: GeneratedModule, context: GenerationContext): Promise<GeneratedModule> {
    // Mechanical slips (a long description, a URL for a host) are corrected here, not sent back to the AI.
    const tidy = (g: GeneratedModule): GeneratedModule => ({ ...g, manifest: tidyManifest(g.manifest) });
    let out = tidy(first);
    for (let attempt = 0; attempt < MAX_REPAIRS; attempt++) {
      progress('checking', 45 + attempt * 5);
      const problem = await this.unusable(out);
      if (!problem) return this.tested(request, out, context, tidy);
      // The config only describes the module: one round to fix it, then the module goes on without it.
      if (problem.kind === 'invalid_module_config' && attempt > 0) break;
      log.info('module_repair', { attempt: attempt + 1, errorType: problem.kind });
      progress('fixing the draft', 50 + attempt * 5);
      try {
        out = tidy(await this.call(() =>
          this.readable(
            request,
            {
              draft: { manifest: out.manifest, code: out.code, validationReport: problem.report, ...(out.config ? { config: out.config } : {}) },
              feedback: `${problem.feedback} Fix these problems and keep everything else the same. Keep the version.`,
            },
            { ...context, search: false },
          ),
        ));
      } catch (err) {
        // The config only describes the module: an unreadable answer while fixing it does not lose a working module.
        if (problem.kind === 'invalid_module_config' && err instanceof AppError && UNREADABLE.has(err.code)) {
          log.info('module_config_fix_unreadable', { errorType: err.code });
          break;
        }
        throw err;
      }
    }
    const left = await this.unusable(out);
    // A config that still does not describe the module is left out, not a reason to lose a working module.
    if (left?.kind === 'invalid_module_config') {
      log.info('module_config_dropped', { count: out.configIssues?.length ?? 0 });
      const { config: _c, configIssues: _i, ...rest } = out;
      return this.tested(request, rest, context, tidy);
    }
    if (left?.kind === 'invalid_manifest') {
      const issues = (left.report as { manifestIssues: string[] }).manifestIssues;
      throw new AppError(
        'ai_manifest_invalid',
        502,
        `The AI's module draft was still incomplete after ${MAX_REPAIRS + 1} tries (${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '; …' : ''}). Try again, or ask for fewer actions at a time; you can add more later as a new version.`,
      );
    }
    return this.tested(request, out, context, tidy);
  }

  /**
   * A draft whose own sandbox tests or checks fail goes back to the AI with what failed (twice at most) before it is
   * stored, so a person reviews a working draft instead of fixing the AI's slips. A fix that makes things worse, or
   * an AI call that fails here, keeps the draft as it was: it is stored with its report, as before.
   */
  private async tested(request: string, first: GeneratedModule, context: GenerationContext, tidy: (g: GeneratedModule) => GeneratedModule): Promise<GeneratedModule> {
    let out = first;
    const done = (g: GeneratedModule) => {
      progress('saving', 95);
      return g;
    };
    // The result of checking `out`: known after a fix round, so the same draft is never run in the sandbox twice.
    let known: Awaited<ReturnType<ModuleChat['failing']>> | undefined;
    for (let round = 0; round < TEST_REPAIRS; round++) {
      progress('testing in the sandbox', 65 + round * 12);
      const failing = known !== undefined ? known : await this.failing(out);
      if (!failing) return done(await this.polished(request, out, context, tidy));
      log.info('module_test_repair', { attempt: round + 1, count: failing.count });
      progress('fixing failed tests', 70 + round * 12);
      let next: GeneratedModule;
      try {
        next = tidy(
          await this.readable(
            request,
            {
              draft: { manifest: out.manifest, code: out.code, validationReport: failing.report, ...(out.config ? { config: out.config } : {}) },
              feedback: `The sandbox validation failed:\n${failing.feedback}\nFix the code (or a test whose canned answer or expectation is wrong for the real API) so every check and test passes. Keep every action, its input and output, and everything else the same. Keep the version.`,
            },
            { ...context, search: false },
          ),
        );
      } catch (err) {
        log.warn('module_test_repair_failed', { errorType: err instanceof AiError || err instanceof AppError ? err.code : 'error' });
        return done(out);
      }
      if (await this.unusable(next)) return done(out);
      const after = await this.failing(next);
      // Only a draft that fails less replaces the one it fixes.
      if (after && after.count >= failing.count) return done(out);
      out = next;
      known = after;
    }
    return done(await this.polished(request, out, context, tidy));
  }

  /**
   * One round on what the security and performance review found. These checks are advisory — Math.random() for an
   * id, a call per item in a loop, pagination with no cap, a write action with no test for bad input, a setting
   * nobody explained — so they never stopped a draft being stored, and nothing ever asked the AI to fix them.
   * Asking once, here, is much cheaper than a person finding them at review. The round is free to fail: a draft
   * that no longer compiles, that breaks a test, or that answers fewer findings than the one it replaces is thrown
   * away and the original is kept.
   */
  private async polished(request: string, out: GeneratedModule, context: GenerationContext, tidy: (g: GeneratedModule) => GeneratedModule): Promise<GeneratedModule> {
    if (!draftReviewRound()) return out;
    const found = await this.advised(out);
    if (!found) return out;
    log.info('module_quality_round', { count: found.count });
    progress('improving security and performance', 88);
    let next: GeneratedModule;
    try {
      next = tidy(
        await this.readable(
          request,
          {
            draft: { manifest: out.manifest, code: out.code, validationReport: found.report, ...(out.config ? { config: out.config } : {}) },
            feedback: `Dittoly's security and performance review of your draft found:\n${found.feedback}\nFix these and keep everything else the same: every action, its input and output, and the version. Keep every test passing.`,
          },
          { ...context, search: false },
        ),
      );
    } catch (err) {
      log.info('module_quality_round_failed', { errorType: err instanceof AiError || err instanceof AppError ? err.code : 'error' });
      return out;
    }
    if (await this.unusable(next)) return out;
    if (await this.failing(next)) return out;
    const after = await this.advised(next);
    if (after && after.count >= found.count) return out;
    return next;
  }

  /** What the security and performance review says about a draft, or null when it says nothing (or cannot run). */
  private async advised(out: GeneratedModule): Promise<{ count: number; report: unknown; feedback: string } | null> {
    let checked;
    try {
      checked = await this.registry.checkDraft({ manifest: out.manifest, source: out.code, tests: out.tests });
    } catch {
      return null;
    }
    const { report, manifest } = checked;
    if (!manifest) return null;
    const advisory = report.checks.filter((c) => !c.passed && c.advisory);
    if (!advisory.length) return null;
    return {
      count: advisory.length,
      report,
      feedback: advisory.map((c) => `- ${c.name}: ${(c.details ?? []).slice(0, 5).join('; ') || 'failed'}`).join('\n').slice(0, 6000),
    };
  }

  /** What fails in the sandbox (checks and tests), or null when it passes or cannot be checked here. */
  private async failing(out: GeneratedModule): Promise<{ count: number; report: unknown; feedback: string } | null> {
    let checked;
    try {
      checked = await this.registry.checkDraft({ manifest: out.manifest, source: out.code, tests: out.tests });
    } catch {
      return null;
    }
    const { report, manifest } = checked;
    if (!manifest || report.passed) return null;
    const checks = report.checks.filter((c) => !c.passed && !c.advisory).map((c) => `- check ${c.name}: ${(c.details ?? []).slice(0, 5).join('; ') || 'failed'}`);
    const tests = report.tests
      .filter((t) => !t.passed)
      .map((t) => `- test "${t.name}": ${t.errorType ?? 'failed'}${t.expectOk === undefined ? '' : t.expectOk ? ' (expected to succeed)' : ' (expected to be refused)'}${t.requests.length ? `; requests: ${t.requests.slice(0, 5).join(', ')}` : ''}${t.blocked?.length ? `; blocked: ${t.blocked.slice(0, 3).join(', ')}` : ''}`);
    const count = checks.length + tests.length;
    if (!count) return null;
    return { count, report, feedback: [...checks, ...tests].join('\n').slice(0, 6000) };
  }

  private async unusable(out: GeneratedModule): Promise<{ kind: string; report: unknown; feedback: string } | null> {
    const parsed = parseManifest(out.manifest);
    if (!parsed.ok) {
      // Required top-level fields missing usually means manifestJson held something else than the manifest itself.
      const shape = parsed.issues.some((i) => /^(name|version|actions): .*received undefined/.test(i))
        ? ' manifestJson must be the manifest object itself (not wrapped in another object), with the top-level fields name, version, title, description (at most 500 characters), hosts, settings, credentials and actions.'
        : '';
      return { kind: 'invalid_manifest', report: { manifestIssues: parsed.issues }, feedback: `The manifest is invalid: ${parsed.issues.join('; ')}.${shape}` };
    }
    try {
      await compileModuleSource(out.code);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      // Positions in the module's own code, as the AI wrote it (the Dittoly base above it is not its code).
      const message = ownPositions(out.code, err.message);
      return { kind: err.code, report: { sourceIssues: message }, feedback: `The TypeScript in code does not compile: ${message}.` };
    }
    // Last: the config must say what the module really does (it only describes; it never runs anything).
    if (out.configIssues?.length) {
      return { kind: 'invalid_module_config', report: { configIssues: out.configIssues }, feedback: `The configJson does not describe the module correctly: ${out.configIssues.join('; ')}. Fix the config (and the code, if the code is what is wrong).` };
    }
    return null;
  }

  /** Generates a module; an answer that cannot be read at all gets one more try, told so. */
  private async readable(request: string, previous: Parameters<typeof generateModule>[2], context: GenerationContext): Promise<GeneratedModule> {
    try {
      return await generateModule(this.provider(), request, previous, context);
    } catch (err) {
      if (!(err instanceof AiError) || !UNREADABLE.has(err.code)) throw err;
      log.info('module_unreadable_retry', { errorType: err.code });
      const why = err.code === 'ai_output_truncated' ? 'Your previous answer was cut off: it was too long.' : 'Your previous answer could not be read as the JSON asked for.';
      return generateModule(
        this.provider(),
        `${request}\n\n${why} Answer again with manifestJson, code and testsJson, each valid. Keep it compact: no long comments, nothing repeated.`,
        previous,
        context,
      );
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // The detail (where the answer broke) is kept for the person; never the AI's whole answer.
      if (err instanceof AiError) throw new AppError(err.code, 502, err.detail, err.raw);
      throw err;
    }
  }
}

/** The stored classification of the draft being revised, as guidance for the revision. */
function recordGuidance(r: Generation['classification']): string | undefined {
  if (!r) return undefined;
  const answers = Object.entries(r.answers).map(([question, a]) => `- ${question}: ${a}`);
  return `\n\nCLASSIFICATION (decided before building; follow it): ${r.summary} Protocols: ${r.protocols.join(', ')}${answers.length ? `\nTHE PERSON ANSWERED:\n${answers.join('\n')}` : ''}`;
}

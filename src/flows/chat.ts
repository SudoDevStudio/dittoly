import { progress } from '../core/progress.js';
import { errorType, log } from '../core/log.js';
import { getAiInstructions, instructionsSnapshot } from '../core/org-settings.js';
import { AiError, draftReviewRound, type AiProvider } from '../ai/provider.js';
import { currentAiContext, withAiContext, type AiTally } from '../ai/metering.js';
import { draftFlow, flowsText, type CatalogAction, type CatalogFlow, type CatalogTable, type DraftedFlow, type FlowPart } from '../ai/generate-flow.js';
import { defaultTeamFor } from '../core/teams.js';
import { canApprove } from '../core/members.js';
import { optionalServicesFor, servicesFor } from '../modules/manifest.js';
import { classificationRecord, classificationText, classifyFlowRequest, needsPerson, type Classification, type MissingCapability } from '../ai/classify.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Cipher } from '../core/crypto.js';
import type { Db } from '../db/db.js';
import type { DraftCost, DraftedBy, ModuleRegistry } from '../modules/registry.js';
import type { TestCase } from './tests.js';
import { flowFindings, flowQuality } from './service.js';
import { draftModelFor } from '../ai/draft-model.js';
import { buildMemoryFor, journal } from '../ai/build-memory.js';
import { decisionsForDraft, rememberAnswers } from '../ai/decisions.js';
import { parseFlowDefinition, type FlowDefinition } from './definition.js';
import { moduleUpdates } from './module-updates.js';
import type { FlowService, FlowVersion } from './service.js';

/** AI answers that could not be read at all: worth one more try. */
/** Repair rounds for a draft the validator refuses. */
const MAX_REPAIRS = 2;
const UNREADABLE = new Set(['ai_response_not_json', 'ai_output_truncated', 'ai_response_shape', 'ai_output_unparseable', 'ai_no_structured_output']);

/**
 * Chat creation of Flows: plain language in, a pending Flow version out. If a
 * draft fails validation, the problems are sent back to the AI once to fix.
 * Nothing here can approve or run anything.
 */
/**
 * What drafting can answer: a Flow, questions for the person first, or that the AI could not build it (an approved
 * module lacks an action it needs). The last comes with the choices to offer instead of an error: add the action to
 * that module, build a new module, or draft without those parts.
 */
export type DraftOutcome = { version: FlowVersion; explanation: string } | { questions: Classification } | { cannotDraft: CannotDraft };
export interface CannotDraft {
  /** The AI's own words for why. */
  reason: string;
  /** What is missing (from the check before drafting); empty when only the AI's reason says it. */
  missing: MissingCapability[];
  /** When one Flow cannot do it all: the Flows to build instead, run together by a Super Flow. */
  split?: FlowPart[];
}

/** The AI answers with no definition (null, empty, not an object) when it decides it cannot build the Flow. */
function cannotDraft(drafted: DraftedFlow, missing: MissingCapability[]): CannotDraft | null {
  const d = drafted.definition;
  if (d && typeof d === 'object' && !Array.isArray(d)) return null;
  // What the check before drafting found, and what the drafter itself names as missing.
  const all = [...missing];
  for (const m of drafted.missing ?? []) if (!all.some((x) => x.capability.toLowerCase() === m.capability.toLowerCase())) all.push(m);
  return { reason: (drafted.explanation.trim() || 'It gave no reason.').slice(0, 1500), missing: all, ...(drafted.split?.length && !all.length ? { split: drafted.split } : {}) };
}

/** The draft's sources, kept with it for the approver. */
function withSources<T extends object>(generation: T, drafted: DraftedFlow): T & { sources?: DraftedFlow['sources']; notes?: string; by?: DraftedBy; cost?: DraftCost } {
  // Called when the version is stored, which is after the AI answered: only then does the context know which
  // model wrote it and how hard it was told to think.
  const by = draftedBy();
  const tally = currentAiContext()?.tally;
  const cost: DraftCost | undefined = tally?.calls ? { input: tally.input, output: tally.output, calls: tally.calls } : undefined;
  return {
    ...generation,
    ...(drafted.sources?.length ? { sources: drafted.sources } : {}),
    ...(drafted.notes ? { notes: drafted.notes } : {}),
    ...(by ? { by } : {}),
    ...(cost ? { cost } : {}),
  };
}

/** For callers with no one to offer the choices to (plans, revisions): a readable error. */
export function notDraftedError(c: CannotDraft): AppError {
  if (c.split?.length) return new AppError('flow_needs_super_flow', 422, `One Flow cannot do all of this: ${c.reason} Build it as these Flows, run together by a Super Flow: ${c.split.map((p) => p.title).join('; ')}.`.slice(0, 1500));
  const build = c.missing.length ? ` Build and approve these first: ${c.missing.map((m) => (m.module ? `${m.capability} (add it to ${m.module})` : m.capability)).join('; ')}.` : '';
  return new AppError('flow_not_drafted', 422, `The AI could not draft this Flow: ${c.reason}${build}`.slice(0, 1500));
}

/** Which AI wrote the draft being stored now, from what the metering context recorded. */
function draftedBy(): DraftedBy | null {
  const tally = currentAiContext()?.tally;
  if (!tally?.provider) return null;
  return { provider: tally.provider, model: tally.model ?? null, ...(tally.effort ? { effort: tally.effort } : {}) };
}

export class FlowChat {
  constructor(
    private readonly db: Db,
    private readonly modules: ModuleRegistry,
    private readonly flows: FlowService,
    private readonly ai: AiProvider | null,
    /** For what the team already answered (src/ai/decisions.ts); without it, nothing is remembered. */
    private readonly cipher?: Cipher,
  ) {}

  /**
   * The Flow tests service, set once at start-up (src/app.ts) because it is built after this one. With it, the
   * examples the AI writes with a draft are kept as the Flow's own tests and played before anyone reviews it.
   */
  private tests: { keepDrafted: (flowId: string, versionId: string, tests: { name: string; case: TestCase }[], askedBy: string) => Promise<unknown> } | null = null;
  useTests(tests: NonNullable<FlowChat['tests']>): void {
    this.tests = tests;
  }

  /**
   * Keeps the draft's own examples and plays them at once. A Flow that passes every check can still do the wrong
   * thing — mail the customer instead of the account manager — and this is where that shows, before an approver
   * reads it. It never fails the draft: a bad example is left out and the approver sees the rest.
   */
  private async keepExamples(drafted: DraftedFlow, version: FlowVersion, actor: Member): Promise<void> {
    if (!drafted.tests?.length || !this.tests) return;
    try {
      await this.tests.keepDrafted(version.flowId, version.id, drafted.tests, actor.id);
    } catch (err) {
      log.info('flow_drafted_tests_not_kept', { errorType: errorType(err) });
    }
  }

  private provider(): AiProvider {
    if (!this.ai) throw new AppError('ai_provider_not_configured', 503);
    return this.ai;
  }

  /** The actions of approved modules only. */
  /**
   * Approved module actions. `newest` keeps only each module's newest approved version: what the AI drafts
   * with, so new steps never pin an older release. Approved Flows keep the versions they were approved with.
   */
  async catalog({ newest = false }: { newest?: boolean } = {}): Promise<CatalogAction[]> {
    let approved = (await this.modules.list()).filter((m) => m.status === 'approved' && !m.archived);
    // list() is ordered by name and creation, and a module's versions only go up: the last one per name is the newest.
    if (newest) approved = [...new Map(approved.map((m) => [m.name, m])).values()];
    return approved.flatMap((m) =>
      m.manifest.actions.map((a) => ({
        module: `${m.name}@${m.version}`,
        moduleTitle: m.manifest.title,
        action: a.name,
        title: a.title,
        description: a.description,
        effect: a.effect,
        input: a.input,
        output: a.output,
        access: { required: servicesFor(m.manifest, a.name), optional: optionalServicesFor(m.manifest, a.name) },
        ...(m.generation?.notes ? { moduleNotes: m.generation.notes } : {}),
        // What the Flow must tell it: a module keeps no configuration of its own.
        ...(m.manifest.settings?.length ? { settings: m.manifest.settings } : {}),
      })),
    );
  }

  /** Approved Flows this member may build a Super Flow from: their teams' (approvers and admins: every team's). */
  async flowCatalog(actor: Member): Promise<CatalogFlow[]> {
    const { rows } = await this.db.query<{ flow_id: string; name: string; version: number; definition: { description?: string; inputs: unknown; steps: { id: string; type: string; title?: string }[] }; notes: string | null }>(
      `SELECT f.id AS flow_id, f.name, v.version, v.definition, v.generation->>'notes' AS notes FROM flows f JOIN flow_versions v ON v.flow_id = f.id
       WHERE v.status = 'approved' AND f.archived_at IS NULL AND ($2 OR f.team_id IN (SELECT team_id FROM team_members WHERE member_id = $1))
       ORDER BY f.name LIMIT 100`,
      [actor.id, canApprove(actor)],
    );
    return rows.map((r) => ({
      flow: r.flow_id,
      name: r.name,
      version: r.version,
      description: r.definition.description ?? '',
      inputs: r.definition.inputs,
      steps: r.definition.steps.map((s) => ({ id: s.id, type: s.type, title: s.title })),
      ...(r.notes ? { notes: r.notes } : {}),
    }));
  }

  /**
   * Classify the request first: questions, a protocol Dittoly cannot use, or a
   * capability no approved module has are shown to the person before drafting.
   * With `answers`, only questions they leave open are asked; with none open, it drafts.
   */
  async draft(
    request: string,
    actor: Member,
    answers?: Record<string, string>,
    /** The team the Flow goes to (default: the member's default team). */
    teamId?: string,
    /** "Draft a Flow with this module": the approved module (by name) the Flow is built around. */
    module?: string,
    /** Parts the person chose to leave out because no approved action can do them yet ("draft without these"). */
    leaveOut?: string[],
    /** A new Flow that starts from a copy of this approved Flow (which stays as it is). */
    startFrom?: { flowId: string; version: number },
  ): Promise<DraftOutcome> {
    // What drafting cost is kept as the Flow's AI baseline (owners can correct it): the tokens
    // an AI spent on this task once, which every later run no longer needs.
    const tally: AiTally = { input: 0, output: 0 };
    // A new Flow has no model of its own yet: the member's choice, else the organization's (src/ai/draft-model.ts).
    const draftModel = await draftModelFor(this.db, { type: 'member', id: actor.id }, actor.id);
    const out = await withAiContext(
      { ...(currentAiContext() ?? { purpose: 'flow' as const, memberId: actor.id }), tally, ...(draftModel ? { draftModel } : {}) },
      () => this.drafted(request, actor, answers, teamId, module, leaveOut, startFrom),
    );
    if ('version' in out && tally.input + tally.output > 0) {
      await this.db.query(
        `UPDATE flows SET ai_baseline_input_tokens = $2, ai_baseline_output_tokens = $3, ai_baseline_provider = $4, ai_baseline_model = $5, ai_baseline_source = 'drafting'
         WHERE id = $1 AND ai_baseline_source IS NULL`,
        [out.version.flowId, tally.input, tally.output, tally.provider ?? null, tally.model ?? null],
      );
    }
    return out;
  }

  private async drafted(
    request: string,
    actor: Member,
    answers: Record<string, string> | undefined,
    teamId: string | undefined,
    module: string | undefined,
    leaveOut: string[] | undefined,
    startFrom?: { flowId: string; version: number },
  ): Promise<DraftOutcome> {
    if (!request || request.length > 20_000) throw badRequest('invalid_request');
    const catalog = await this.catalog({ newest: true });
    if (leaveOut?.length) {
      // The person chose to go ahead without these parts: they are not asked about again.
      answers ??= {};
      request = `${request}\n\nLEAVE OUT (the person chose to draft without these, because no approved action can do them yet):\n${leaveOut.map((p) => `- ${p}`).join('\n')}\nDraft everything else; add no step for these. Start the Flow's "description" with "Leaves out: " and name them, so reviewers see what it does not do.`;
    }
    if (module) {
      // Only an approved module can be built around; its newest approved version, like any draft.
      const actions = catalog.filter((a) => a.module.slice(0, a.module.lastIndexOf('@')) === module);
      if (!actions.length) throw conflict('module_not_approved');
      request = `${request}\n\nBuild this Flow around the approved module ${actions[0]!.module} ("${actions[0]!.moduleTitle}"): use its actions (${actions.map((a) => a.action).join(', ')}) for the work it covers.`;
    }
    const flows = await this.flowCatalog(actor);
    const team = teamId ?? (await defaultTeamFor(this.db, actor.id));
    const tables = await this.tablesOf(team);
    const instructions = (await getAiInstructions(this.db)).flows;
    const brief = [
      ...catalog.map((a) => `- ${a.module} ${a.action} (${a.effect}): ${a.title}. ${a.description}`),
      ...flows.map((f) => `- Flow "${f.name}" v${f.version}: ${f.description}`),
    ].join('\n');
    progress('understanding', 5);
    const classification = await classifyFlowRequest(this.provider(), request, brief, { instructions, answers });
    // "Add it to this module" only for a module that is really approved (the AI may also write its version).
    const approved = new Set(catalog.map((a) => a.module.slice(0, a.module.lastIndexOf('@'))));
    classification.missing = classification.missing.map(({ module: m, ...rest }) => {
      const name = m?.split('@')[0]?.trim();
      return name && approved.has(name) ? { ...rest, module: name } : rest;
    });
    const ask = needsPerson(classification, answers);
    if (ask) return { questions: ask };
    if (catalog.length === 0 && flows.length === 0 && tables.length === 0) throw new AppError('no_approved_modules', 409);
    // What this team already answered, so the second Flow does not ask what the first one asked. An answer
    // given in THIS request wins (it is in the classification text already), and one about apps this request
    // never mentions is left out (src/ai/decisions.ts).
    const memory = this.cipher
      ? await decisionsForDraft(this.db, this.cipher, team, { request, answeredNow: answers, about: catalog.map((a) => a.module.slice(0, a.module.lastIndexOf('@'))) })
      : { text: '', used: [], unreadable: 0 };
    const guidance = classificationText(classification, answers) + memory.text;
    // The approved Flow to start from, when the person may see it: its definition is the first draft to change.
    const base = startFrom ? flows.find((f) => f.flow === startFrom.flowId && f.version === startFrom.version) : undefined;
    const baseDefinition = base
      ? (await this.db.query<{ definition: unknown }>(`SELECT definition FROM flow_versions WHERE flow_id = $1 AND version = $2 AND status = 'approved'`, [base.flow, base.version])).rows[0]?.definition
      : undefined;
    const generation = {
      instructions: instructionsSnapshot(instructions),
      classification: classificationRecord(classification, answers),
      // Which of the team's earlier answers this draft was given, by id, and how many could not be read.
      ...(memory.used.length || memory.unreadable ? { memory: { used: memory.used, unreadable: memory.unreadable } } : {}),
      ...(base && baseDefinition ? { cloneOf: { flowId: base.flow, version: base.version, name: base.name } } : {}),
    };
    const startingPoint = base && baseDefinition
      ? {
          definition: baseDefinition,
          feedback: `This is the approved Flow "${base.name}" v${base.version}. Build a NEW Flow from a copy of it (the original stays as it is): change, add and remove steps so it does what THE PERSON WANTS asks. Give it its own name.`,
        }
      : undefined;
    let drafted: DraftedFlow;
    // What the checks rejected on the way, kept with the Flow so the next draft does not walk into it again.
    const failures: string[] = [];
    progress('drafting', 20);
    try {
      drafted = await draftFlow(this.provider(), request, catalog, startingPoint, { instructions, guidance, flows, tables });
    } catch (err) {
      if (!(err instanceof AiError) || !UNREADABLE.has(err.code)) throw this.wrap(err);
      // One more try when the answer could not be read: usually a long draft whose JSON broke or was cut off.
      drafted = await this.call(() =>
        draftFlow(this.provider(), request, catalog, {
          definition: '(your previous answer could not be read)',
          feedback:
            (err.code === 'ai_output_truncated' ? 'Your previous answer was cut off: it was too long.' : `Your previous definitionJson was not valid JSON: ${err.detail ?? err.code}.`) +
            ' Return the whole definition again as one valid JSON string. Keep it compact: no comments, short titles, nothing repeated.',
        }, { instructions, guidance, flows, tables }),
      );
    }
    const cannot = cannotDraft(drafted, classification.missing);
    if (cannot) return { cannotDraft: cannot };
    drafted = await this.improved(drafted, request, catalog, { instructions, guidance, flows, tables });
    // Up to two repair rounds with the validator's findings (as for modules); then the last problem goes to the person.
    for (let round = 0; ; round++) {
      progress('checking', 70 + round * 10);
      try {
        const version = await this.flows.create(drafted.name, drafted.definition, actor, withSources(generation, drafted), teamId);
        if (this.cipher) {
          // Tagged with the apps this Flow actually uses, so the answer comes back where those apps are.
          const about = version.definition.steps.flatMap((s) => (s.type === 'action' ? [s.module.slice(0, s.module.lastIndexOf('@'))] : []));
          await rememberAnswers(this.db, this.cipher, { teamId: team, source: { type: 'flow', id: version.flowId }, by: actor.id, about }, answers);
          // What they asked for, in their words, kept with the Flow: the build data that holds it now is wiped, and
          // six revisions later nothing else can say what this Flow was for (src/ai/build-memory.ts).
          const artifact = { type: 'flow' as const, id: version.flowId, teamId: team };
          await journal(this.db, this.cipher, artifact, { kind: 'request', origin: 'user', text: request, versionRef: `v${version.version}`, by: actor.id });
          // What the AI said it did. Kept so a person can read it, never handed back to a later draft as a rule.
          if (drafted.explanation) await journal(this.db, this.cipher, artifact, { kind: 'suggestion', origin: 'ai', text: drafted.explanation, versionRef: `v${version.version}` });
          for (const found of failures) await journal(this.db, this.cipher, artifact, { kind: 'failure', origin: 'evidence', text: found, versionRef: `v${version.version}` });
        }
        await this.keepExamples(drafted, version, actor);
        return { version, explanation: drafted.explanation };
      } catch (err) {
        if (!(err instanceof AppError) || err.httpStatus !== 400 || round >= MAX_REPAIRS) throw err;
        log.info('flow_repair', { attempt: round + 1, errorType: err.code });
        failures.push(`${err.code}: ${err.message}`);
        progress('fixing the draft', 75 + round * 10);
        const previous = drafted.definition;
        drafted = await this.call(() =>
          draftFlow(this.provider(), request, catalog, {
            definition: previous,
            feedback: 'Fix the validation problems and keep everything else the same.',
            problems: err.message,
          }, { instructions, guidance, flows, tables }),
        );
        const again = cannotDraft(drafted, classification.missing);
        if (again) return { cannotDraft: again };
      }
    }
  }

  /**
   * One round on what a reviewer would send back anyway: a step that changes something with nobody signing off in
   * front of it, nothing guarding it, no memory of what it already handled, model-written text reaching it, or no
   * examples at all. These are not validation errors — the draft is storable either way — so the round is free to
   * fail: a draft that answers fewer of them than the one it replaces is thrown away, and so is an AI call that
   * breaks here.
   */
  private async improved(drafted: DraftedFlow, request: string, catalog: CatalogAction[], ctx: Parameters<typeof draftFlow>[4]): Promise<DraftedFlow> {
    if (!draftReviewRound()) return drafted;
    const count = async (d: DraftedFlow) => {
      const parsed = parseFlowDefinition(d.definition);
      // A definition that does not even parse is the repair loop's business, not this round's.
      if (!parsed.ok) return null;
      try {
        const modules = await this.flows.pinnedModules(this.db, parsed.definition);
        const sinks = (await this.flows.injection(this.db, parsed.definition)).sinks.length;
        return flowFindings(flowQuality(parsed.definition, modules, { unacceptedInjection: sinks, examples: { total: d.tests?.length ?? 0, passed: d.tests?.length ?? 0 } }));
      } catch {
        return null;
      }
    };
    const found = await count(drafted);
    if (!found?.length) return drafted;
    log.info('flow_quality_round', { count: found.length });
    progress('making it safer', 60);
    let next: DraftedFlow;
    try {
      next = await draftFlow(this.provider(), request, catalog, {
        definition: drafted.definition,
        feedback: "Dittoly's review of your draft found the problems below. Fix them and keep everything else the same.",
        problems: found.map((f) => `- ${f}`).join('\n'),
      }, ctx);
    } catch (err) {
      log.info('flow_quality_round_failed', { errorType: errorType(err) });
      return drafted;
    }
    if (cannotDraft(next, [])) return drafted;
    const after = await count(next);
    if (!after || after.length >= found.length) return drafted;
    return next;
  }

  /** For a revision, where there is no person to offer choices to before it is saved. */
  private assertDrafted(drafted: DraftedFlow): void {
    const cannot = cannotDraft(drafted, []);
    if (cannot) throw notDraftedError(cannot);
  }

  /**
   * A new definition for an existing Flow, drafted and checked but NOT stored: for Dittoly's own fixes, where
   * there is no person asking (src/modules/run-fix.ts). The caller decides what to do with it.
   */
  async redraft(flowId: string, feedback: string): Promise<{ definition: unknown; explanation: string }> {
    const versions = await this.flows.versions(flowId);
    const base = [...versions].reverse().find((v) => v.status === 'approved') ?? versions.at(-1);
    if (!base) throw notFound('flow');
    const catalog = await this.catalog({ newest: true });
    const instructions = (await getAiInstructions(this.db)).flows;
    const team = (await this.db.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [flowId])).rows[0];
    const tables = team ? await this.tablesOf(team.team_id) : [];
    const build = this.cipher ? await buildMemoryFor(this.db, this.cipher, { type: 'flow', id: flowId, teamId: team?.team_id }) : { text: '' };
    const drafted = await this.call(() =>
      // No other Flows in the catalog: a fix changes the steps of this one, it does not turn it into a Super Flow.
      draftFlow(this.provider(), 'Revise the Flow below.', catalog, { definition: base.definition, feedback }, { instructions, flows: [], tables, ...(build.text ? { guidance: build.text } : {}) }),
    );
    this.assertDrafted(drafted);
    return { definition: drafted.definition, explanation: drafted.explanation };
  }

  /** A revision is a new version of the same Flow; it needs approval again. */
  /**
   * "Draft it again": the same Flow, written once more with what Dittoly knows now — the newest approved version
   * of each module, and the review it runs on every draft (a sign-off before anything changes, a condition on it,
   * remembering what was handled, model-written text reaching a step that writes, examples). What the Flow does
   * stays the same; a person asked for a better version of it, not a different one. A new version to approve,
   * like any change.
   */
  async redraftNow(flowId: string, actor: Member): Promise<{ version: FlowVersion; explanation: string }> {
    const moves = (await moduleUpdates(this.db, (await this.flows.versions(flowId)).at(-1)?.definition ?? ({ steps: [] } as unknown as FlowDefinition)))
      .map((u) => `${u.module} ${u.pinned} → ${u.latest}`)
      .join(', ');
    return this.revise(
      flowId,
      'Draft this Flow again, doing exactly what it does now: the same job, the same inputs, the same outcome.' +
        (moves ? ` Move it to the newest approved version of its modules (${moves}), changing the steps that use them to fit.` : '') +
        ' Take the chance to put right what a reviewer would send back: a sign-off before the first step that changes anything, a "when" on each step that changes something, a data table read before it acts so a second run does not repeat the work, no model-written text reaching a step that changes something without a sign-off, and two or three examples. Change nothing else.',
      actor,
      true,
    );
  }

  async revise(flowId: string, feedback: string, actor: Member, review = false): Promise<{ version: FlowVersion; explanation: string }> {
    // This Flow's own model where it has one, else the member's, else the organization's (src/ai/draft-model.ts).
    const draftModel = await draftModelFor(this.db, { type: 'flow', id: flowId }, actor.id);
    return withAiContext(
      { ...(currentAiContext() ?? { purpose: 'flow' as const, memberId: actor.id }), ...(draftModel ? { draftModel } : {}) },
      () => this.revised(flowId, feedback, actor, review),
    );
  }

  private async revised(flowId: string, feedback: string, actor: Member, review: boolean): Promise<{ version: FlowVersion; explanation: string }> {
    if (!feedback || feedback.length > 20_000) throw badRequest('invalid_feedback');
    const versions = await this.flows.versions(flowId);
    const latest = versions.at(-1);
    if (!latest) throw notFound('flow');
    const owner = (await this.db.query<{ created_by: string }>(`SELECT created_by FROM flows WHERE id = $1`, [flowId])).rows[0];
    if (owner?.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
    const catalog = await this.catalog({ newest: true });
    const instructions = (await getAiInstructions(this.db)).flows;
    const prevGeneration = (await this.db.query<{ generation: { classification?: unknown } | null }>(`SELECT generation FROM flow_versions WHERE id = $1`, [latest.id])).rows[0]?.generation;
    const flows = await this.flowCatalog(actor);
    const team = (await this.db.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [flowId])).rows[0]!.team_id;
    const tables = await this.tablesOf(team);
    // Why this Flow exists, and what has been said about it since: a revision that is given only the newest
    // definition and one sentence of feedback quietly drops what the first request asked for.
    const artifact = { type: 'flow' as const, id: flowId, teamId: team };
    const build = this.cipher ? await buildMemoryFor(this.db, this.cipher, artifact) : { text: '', used: [], unreadable: 0, omitted: 0 };
    const generation = {
      instructions: instructionsSnapshot(instructions),
      classification: (prevGeneration?.classification ?? null) as ReturnType<typeof classificationRecord>,
      ...(build.used.length || build.unreadable ? { memory: { used: [], unreadable: 0, build: { used: build.used, unreadable: build.unreadable, omitted: build.omitted } } } : {}),
    };
    const context = { instructions, flows, tables, ...(build.text ? { guidance: build.text } : {}) };
    let drafted = await this.call(() =>
      draftFlow(this.provider(), 'Revise the Flow below.', catalog, { definition: latest.definition, feedback }, context),
    );
    // Asked for by a person pressing "Draft it again": the draft gets the same review round as a new Flow.
    if (review) drafted = await this.improved(drafted, 'Revise the Flow below.', catalog, context);
    this.assertDrafted(drafted);
    const version = await this.flows.update(flowId, drafted.definition, actor, withSources(generation, drafted));
    if (this.cipher) {
      // Their words, not a summary of them: "Draft it again" is Dittoly's own sentence, so it is not theirs to keep.
      if (!review) await journal(this.db, this.cipher, artifact, { kind: 'request', origin: 'user', text: feedback, versionRef: `v${version.version}`, by: actor.id });
      if (drafted.explanation) await journal(this.db, this.cipher, artifact, { kind: 'suggestion', origin: 'ai', text: drafted.explanation, versionRef: `v${version.version}` });
    }
    return { version, explanation: drafted.explanation };
  }

  /** The team's data tables: names and columns only, never their rows. */
  async tablesOf(teamId: string): Promise<CatalogTable[]> {
    const { rows } = await this.db.query<{ name: string; key_column: string; columns: { name: string; type: string }[]; description: string | null }>(
      `SELECT name, key_column, columns, description FROM data_tables WHERE team_id = $1 ORDER BY name`,
      [teamId],
    );
    return rows.map((r) => ({ name: r.name, keyColumn: r.key_column, columns: r.columns, description: r.description }));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.wrap(err);
    }
  }

  private wrap(err: unknown): unknown {
    return err instanceof AiError ? new AppError(err.code, 502, err.detail, err.raw) : err;
  }
}

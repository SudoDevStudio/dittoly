import { z } from 'zod';
import { SKILL_SETS, skillPrompt } from '../ai/skills.js';
import { audit } from '../core/audit.js';
import { AppError } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { getAiInstructions } from '../core/org-settings.js';
import { assertTeamMember, defaultTeamFor, listTeams } from '../core/teams.js';
import { tidyDefinition } from '../flows/tidy.js';
import type { Db } from '../db/db.js';
import type { FlowChat } from '../flows/chat.js';
import type { FlowService, FlowVersion } from '../flows/service.js';
import { parseFlowDefinition } from '../flows/definition.js';
import { playTest, testCaseSchema, type FlowTests } from '../flows/tests.js';
import type { ModuleChat } from '../modules/chat.js';
import type { AssistantDraft, ModuleRegistry, ModuleVersion } from '../modules/registry.js';

/**
 * AI work into Flows: an AI assistant that just did a task for someone saves it, over MCP,
 * as a draft Flow (plus any modules it needs and a test from what the apps answered). The
 * assistant drafts with Dittoly's rules and catalog (get_flow_guide), so the organization
 * spends no tokens; Dittoly validates everything, and nothing runs until people approve it.
 * A draft that does not pass is not saved: the problems go back to the assistant to fix.
 */

export interface CaptureDeps {
  db: Db;
  flows: FlowService;
  flowChat: FlowChat;
  modules: ModuleRegistry;
  moduleChat: ModuleChat;
  flowTests: FlowTests;
  publicUrl: string;
}

const MODULE_RULES = skillPrompt(['module-authoring', 'module-protocols', 'browser-scripts']);
const CAPTURE_RULES = skillPrompt(SKILL_SETS.capture);

export const guideArgs = z.object({ teamId: z.string().uuid().optional(), newModules: z.boolean().optional() }).strict();

/** The rules, the person's teams and what they can build from: approved actions, Flows and the team's tables. */
export async function flowGuide(d: CaptureDeps, member: Member, args: z.infer<typeof guideArgs>): Promise<string> {
  const teams = await listTeams(d.db, member);
  const teamId = args.teamId ?? (await defaultTeamFor(d.db, member.id));
  // Only a team the person is in: its tables are its own business.
  await assertTeamMember(d.db, teamId, member);
  const instructions = await getAiInstructions(d.db);
  const catalog = {
    teams: teams.filter((t) => t.myRole || member.role === 'admin').map((t) => ({ id: t.id, name: t.name, default: t.isDefault })),
    team: teamId,
    actions: await d.flowChat.catalog({ newest: true }),
    flows: await d.flowChat.flowCatalog(member),
    tables: await d.flowChat.tablesOf(teamId),
  };
  return [
    CAPTURE_RULES,
    args.newModules ? `# Module rules (for new modules only)\n\n${MODULE_RULES}` : 'Module rules are left out; call get_flow_guide with "newModules": true if no approved action can do a step.',
    instructions.flows ? `# Your organization's instructions for Flows\n\n${instructions.flows}` : '',
    args.newModules && instructions.modules ? `# Your organization's instructions for modules\n\n${instructions.modules}` : '',
    `# Catalog (JSON)\n\n${JSON.stringify(catalog)}`,
  ].filter(Boolean).join('\n\n');
}

const usage = z
  .object({
    inputTokens: z.number().int().min(0).max(100_000_000),
    outputTokens: z.number().int().min(0).max(100_000_000),
    provider: z.string().trim().max(40).optional(),
    model: z.string().trim().max(80).optional(),
  })
  .strict();

export const saveArgs = z
  .object({
    name: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f\u2028\u2029]*$/, 'one line of text'),
    explanation: z.string().trim().min(1).max(3000),
    definition: z.record(z.string(), z.unknown()),
    teamId: z.string().uuid().optional(),
    flowId: z.string().uuid().optional(),
    modules: z.array(z.object({ manifest: z.record(z.string(), z.unknown()), code: z.string().max(200_000), tests: z.array(z.unknown()).max(20).default([]) }).strict()).max(5).default([]),
    tests: z.array(z.object({ name: z.string().trim().min(1).max(120), case: testCaseSchema }).strict()).max(10).default([]),
    aiUsage: usage.optional(),
    assistant: z.string().trim().max(80).optional(),
  })
  .strict();

export type SaveResult =
  | { saved: false; problems: string[] }
  | {
      saved: true;
      flow: { id: string; name: string; version: number; status: string; url: string };
      modules: { ref: string; status: string; url: string }[];
      tests: { total: number; passed: number; problems: string[] };
      next: string;
    };

/** Replace every string equal to a module ref the assistant used with the version Dittoly gave it. */
function renumber(value: unknown, refs: Map<string, string>): unknown {
  if (typeof value === 'string') return refs.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => renumber(v, refs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renumber(v, refs)]));
  return value;
}

function failedChecks(mv: ModuleVersion): string[] {
  const r = mv.validationReport;
  if (!r) return ['not validated'];
  return [
    ...r.checks.filter((c) => !c.passed).map((c) => `${c.name}${c.details?.length ? `: ${c.details.join('; ')}` : ''}`),
    ...r.tests.filter((t) => !t.passed).map((t) => `test "${t.name}" failed${t.errorType ? ` (${t.errorType})` : ''}`),
  ];
}

export async function saveAsFlow(d: CaptureDeps, member: Member, token: { id: string; name: string }, raw: unknown): Promise<SaveResult> {
  const parsed = saveArgs.safeParse(raw);
  if (!parsed.success) return { saved: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`) };
  const args = parsed.data;
  const drafted: AssistantDraft = { name: args.assistant || null, token: token.name, explanation: args.explanation };

  // New modules first: each must pass its sandbox checks, or nothing is kept.
  const created: ModuleVersion[] = [];
  const refs = new Map<string, string>();
  const problems: string[] = [];
  const discard = async () => {
    if (created.length) await d.db.query(`DELETE FROM module_versions WHERE id = ANY($1::uuid[]) AND status = 'draft'`, [created.map((m) => m.id)]);
  };
  for (const [i, m] of args.modules.entries()) {
    const label = typeof m.manifest.name === 'string' ? `module ${m.manifest.name}` : `modules.${i}`;
    try {
      const manifest = (await d.moduleChat.assignVersion(m.manifest)) as { name: string; version: string };
      const mv = await d.modules.createDraft(
        { manifest, source: m.code, tests: m.tests, origin: 'assistant', generation: { source: null, reference: null, instructions: null, classification: null, assistant: drafted } },
        member,
      );
      created.push(mv);
      if (typeof m.manifest.version === 'string') refs.set(`${mv.name}@${m.manifest.version}`, `${mv.name}@${mv.version}`);
      if (!mv.validationReport?.passed) problems.push(...failedChecks(mv).map((p) => `${label}: ${p}`));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      problems.push(`${label}: ${err.message !== err.code ? `${err.code}: ${err.message}` : err.code}`);
    }
  }
  if (problems.length) {
    await discard();
    return { saved: false, problems };
  }

  // Then the Flow, pointing at the versions the new modules got. Its tests must pass first:
  // they are the assistant's record of what the apps answered.
  const definition = tidyDefinition(renumber(args.definition, refs));
  if (args.tests.length) {
    const def = parseFlowDefinition(definition);
    if (def.ok) {
      let modules: Awaited<ReturnType<FlowService['pinnedModules']>> | null = null;
      try {
        modules = await d.flows.pinnedModules(d.db, def.definition);
      } catch {
        modules = null; // the Flow check below says what is wrong
      }
      if (modules) {
        for (const t of args.tests) problems.push(...playTest(def.definition, modules, t.case).problems.map((p) => `test "${t.name}": ${p}`));
        if (problems.length) {
          await discard();
          return { saved: false, problems };
        }
      }
    }
  }
  const generation = { instructions: null, classification: null, assistant: drafted };
  let version: FlowVersion;
  try {
    version = args.flowId ? await d.flows.update(args.flowId, definition, member, generation) : await d.flows.create(args.name, definition, member, generation, args.teamId);
  } catch (err) {
    await discard();
    if (err instanceof AppError && err.httpStatus < 500) return { saved: false, problems: [`flow: ${err.message !== err.code ? `${err.code}: ${err.message}` : err.code}`] };
    throw err;
  }
  const flowId = version.flowId;

  // Saved: modules go to their reviewers; tests and the cost baseline are kept with the Flow.
  for (const mv of created) await d.modules.submit(mv.id, member);
  for (const t of args.tests) await d.flowTests.save(member, flowId, { name: t.name, case: t.case });
  if (args.aiUsage) {
    await d.db.query(
      `UPDATE flows SET ai_baseline_input_tokens = $2, ai_baseline_output_tokens = $3, ai_baseline_provider = $4, ai_baseline_model = $5, ai_baseline_source = 'assistant'
       WHERE id = $1 AND (ai_baseline_source IS NULL OR ai_baseline_source <> 'owner')`,
      [flowId, args.aiUsage.inputTokens, args.aiUsage.outputTokens, args.aiUsage.provider ?? null, args.aiUsage.model ?? null],
    );
  }
  await audit(d.db, { actorId: member.id, action: 'mcp.flow_saved', subjectType: 'flow_version', subjectId: version.id, outcome: 'ok', relatedId: token.id });
  const results = await d.flowTests.results(member, version.id);
  const flowName = (await d.db.query<{ name: string }>(`SELECT name FROM flows WHERE id = $1`, [flowId])).rows[0]!.name;
  const base = d.publicUrl.replace(/\/$/, '');
  return {
    saved: true,
    flow: { id: flowId, name: flowName, version: version.version, status: version.status, url: `${base}/flows/${flowId}` },
    modules: created.map((mv) => ({ ref: `${mv.name}@${mv.version}`, status: 'pending_review', url: `${base}/modules/${mv.id}` })),
    tests: { total: results.total, passed: results.passed, problems: results.results.filter((r) => !r.passed).flatMap((r) => r.problems.map((p) => `${r.name}: ${p}`)) },
    next: created.length
      ? 'Saved. An admin reviews the new modules, then the Flow can be approved; it cannot run before that. Tell the person it is waiting for approval and give them the links.'
      : 'Saved. The Flow waits for approval and cannot run before that. Tell the person and give them the link.',
  };
}

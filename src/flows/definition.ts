import { ajv } from '../runtime/manifest.js';
import { z } from 'zod';
import { riskyOmissions } from '../engine/fix-limits.js';
import { isDestination, parseDestination } from '../runtime/destinations.js';

/**
 * Super-Flow definition. A Flow is data, never code: action steps name a
 * pinned module version, control steps are conditions, delays and approval gates.
 *
 * Templates: a string that is exactly "{{ path }}" takes the value at path (any
 * type); "{{ path }}" inside other text is interpolated as text. Paths start
 * with inputs., steps.<id>.output, or item (inside forEach). No expressions.
 */

const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** The only form autoApproveWhen takes: a fix step's own verdict, computed by Dittoly. */
export const AUTO_APPROVE = /^steps\.([a-z][a-z0-9_]{0,39})\.output\.autoPushAllowed$/;
const path = z.string().regex(/^(inputs|steps|item)(\.[A-Za-z0-9_]+)*$/);

export const conditionSchema = z.union([
  z.object({ notEmpty: path }).strict(),
  z.object({ isTrue: path }).strict(),
  z.object({ equals: z.tuple([path, z.union([z.string(), z.number(), z.boolean(), z.null()])]) }).strict(),
]);
export type Condition = z.infer<typeof conditionSchema>;

const base = {
  id: stepId,
  title: z.string().max(80).optional(),
  when: conditionSchema.optional(),
};

export const actionStepSchema = z
  .object({
    ...base,
    type: z.literal('action'),
    /** Pinned module version, "name@x.y.z". */
    module: z.string().regex(/^[a-z][a-z0-9-]{1,39}@\d+\.\d+\.\d+$/),
    action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    input: z.record(z.string(), z.unknown()),
    /** Run the action once per element of this array, e.g. "{{ steps.mrs.output.mergeRequests }}". */
    forEach: z.string().regex(/^\{\{\s*[A-Za-z0-9_.]+\s*\}\}$/).optional(),
    /** Ask this teammate to run the action with their own account. */
    delegateTo: z.string().uuid().optional(),
    /**
     * An evidence gate for a step that waits for a sign-off because a fix step's change reaches it:
     * exactly "steps.<fix step id>.output.autoPushAllowed". When Dittoly computed that true at run
     * time the sign-off is released on its own; otherwise a person decides, as without it.
     */
    autoApproveWhen: z.string().regex(AUTO_APPROVE).optional(),
    /**
     * Values for this module's declared settings, for this step only: they override the Flow's "moduleSettings".
     * A value may be a template (the run form, an earlier step), so the person can choose, for example, the site.
     */
    settings: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(300)).optional(),
  })
  .strict();

export const approvalStepSchema = z
  .object({
    ...base,
    type: z.literal('approval'),
    /** Remind the approvers after this many hours without a decision (overrides the organization's rule). */
    remindAfterHours: z.number().int().min(1).max(720).optional(),
    /** Then tell the team's admins (and, after twice as long, org admins). */
    escalateAfterHours: z.number().int().min(1).max(720).optional(),
  })
  .strict()
  .refine((s) => s.remindAfterHours === undefined || s.escalateAfterHours === undefined || s.escalateAfterHours > s.remindAfterHours, {
    message: 'escalateAfterHours must be more than remindAfterHours',
    path: ['escalateAfterHours'],
  });

/** A dot path into a value ("" = the value itself), e.g. "mergeRequests" or "data.items". */
const fieldPath = z.string().regex(/^([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*)?$/);
const template = z.string().regex(/^\{\{\s*[A-Za-z0-9_.]+\s*\}\}$/);
const optionValue = z.union([z.string().max(500), z.number(), z.boolean()]);

/**
 * Where a select box gets its choices:
 * - fixed: written in the Flow;
 * - module: loaded live from an approved READ action, run as the person filling in the form
 *   with their own credential (input values may use {{ inputs.x }} from other fields);
 * - fromStep: an earlier step's output (input steps only).
 * `items` is the path of the list in the result, `value`/`label` the fields of each item.
 */
export const optionsSchema = z.union([
  z.object({ fixed: z.array(z.object({ value: optionValue, label: z.string().max(200).optional() }).strict()).min(1).max(200) }).strict(),
  z
    .object({
      module: z.string().regex(/^[a-z][a-z0-9-]{1,39}@\d+\.\d+\.\d+$/),
      action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      input: z.record(z.string(), z.unknown()).default({}),
      items: fieldPath.default(''),
      value: fieldPath.default(''),
      label: fieldPath.optional(),
    })
    .strict(),
  z.object({ fromStep: template, value: fieldPath.default(''), label: fieldPath.optional() }).strict(),
]);
export type OptionsSource = z.infer<typeof optionsSchema>;

export const WIDGETS = ['text', 'textarea', 'number', 'select', 'multiselect', 'checkbox', 'date', 'email', 'url', 'checklist'] as const;
export const fieldSchema = z
  .object({
    /** Run form: the Flow input it fills. Input step: the key in the step's output. */
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    label: z.string().min(1).max(120),
    help: z.string().max(300).optional(),
    /** A short example value, shown with the help behind the field's "i". */
    example: z.string().max(120).optional(),
    widget: z.enum(WIDGETS),
    placeholder: z.string().max(120).optional(),
    /** Input steps only (the run form takes "required" from the input schema). */
    required: z.boolean().optional(),
    options: optionsSchema.optional(),
    /**
     * Input steps: the value the field starts with, e.g. "{{ steps.plan.output.checks }}" so a
     * person can edit and approve what an AI step proposed. A "checklist" is a list of
     * { check, expect } rows the person can change, add to or remove from.
     */
    default: z.union([template, z.string().max(2000), z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const choice = f.widget === 'select' || f.widget === 'multiselect';
    if (choice && !f.options) ctx.addIssue({ code: 'custom', message: `field ${f.name}: a ${f.widget} needs options` });
    if (!choice && f.options) ctx.addIssue({ code: 'custom', message: `field ${f.name}: only select and multiselect take options` });
  });
export type FormField = z.infer<typeof fieldSchema>;

/** Pause the run and ask the person who runs it to fill in a form; the answers are this step's output. */
export const inputStepSchema = z
  .object({ ...base, type: z.literal('input'), intro: z.string().max(500).optional(), fields: z.array(fieldSchema).min(1).max(20) })
  .strict();
export type InputStep = z.infer<typeof inputStepSchema>;

/** How the run form looks: field order, widgets, labels, help and where choices come from. */
export const formSchema = z
  .object({ intro: z.string().max(500).optional(), fields: z.array(fieldSchema).max(30) })
  .strict();

export const delayStepSchema = z
  .object({ ...base, type: z.literal('delay'), seconds: z.number().int().min(1).max(30 * 24 * 3600) })
  .strict();

/**
 * Whose AI a step uses: the organization's (the provider an admin configured for Dittoly),
 * or the runner's own key for a provider, from their vault ("openai" or "anthropic" service).
 * The approver sees which, and what the step sends to it.
 */
const aiChoice = {
  ai: z.enum(['organization', 'runner']),
  provider: z.enum(['openai', 'anthropic']).optional(),
};

/**
 * A limit on AI spend: tokens, and/or money in the price table's currency. When a run reaches
 * it, the run waits until its owner or an approver allows more (src/ai/costs.ts).
 */
export const costCapSchema = z
  .object({
    tokens: z.number().int().min(100).max(1e10).optional(),
    amount: z.number().min(0.0001).max(1_000_000).optional(),
  })
  .strict()
  .refine((c) => c.tokens !== undefined || c.amount !== undefined, { message: 'a cost cap needs tokens, amount or both' });
export type CostCap = z.infer<typeof costCapSchema>;

/**
 * A Flow's own counts and windows for automatic stops, over the organization's
 * (src/governance/auto-stop.ts). It is part of what is approved; whether a trigger is on is the admins' call.
 */
const stopCount = z.number().int().min(1).max(1000);
const stopMinutes = z.number().int().min(1).max(1440);
export const flowAutoStopSchema = z
  .object({
    blockedCalls: z.object({ count: stopCount, minutes: stopMinutes }).partial().strict().optional(),
    failureSpike: z.object({ count: stopCount, minutes: stopMinutes, percent: z.number().int().min(1).max(100) }).partial().strict().optional(),
    rejectedSignOffs: z.object({ count: stopCount, minutes: stopMinutes }).partial().strict().optional(),
  })
  .strict();

/**
 * An AI step: give the AI an instruction and data from earlier steps; its answer is this
 * step's output. "text" -> { text }, "checklist" -> { checks: [{ check, expect }] }.
 * What earlier steps found (a ticket description, a page) is passed as data, never as
 * instructions; the answer only becomes action through later steps of the approved Flow.
 */
export const aiStepSchema = z
  .object({
    ...base,
    type: z.literal('ai'),
    ...aiChoice,
    instruction: z.string().min(1).max(4000),
    input: z.record(z.string(), z.unknown()).default({}),
    output: z.enum(['text', 'checklist', 'json']).default('text'),
    /** For output "json": the JSON Schema the answer must match; the output is { data } (e.g. a list to forEach over). */
    schema: z.record(z.string(), z.unknown()).optional(),
    /** The most this step may spend on AI in one run. */
    costCap: costCapSchema.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.output !== 'json') {
      if (s.schema) ctx.addIssue({ code: 'custom', path: ['schema'], message: 'only an ai step with output "json" has a schema' });
      return;
    }
    if (!s.schema) return void ctx.addIssue({ code: 'custom', path: ['schema'], message: 'output "json" needs a JSON Schema for the answer' });
    if (JSON.stringify(s.schema).length > 8000) ctx.addIssue({ code: 'custom', path: ['schema'], message: 'the schema is too large (at most 8000 characters)' });
    try {
      ajv.compile(s.schema);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['schema'], message: 'not a valid JSON Schema' });
    }
  });
export type AiStep = z.infer<typeof aiStepSchema>;

/** Host rules for a browse step, like a browser module's (exact host[:port] or "*.domain"). */
const browseHost = z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/);

/**
 * An AI-guided browser: open `url` and, for each check, let the AI look at the page and
 * click, type and navigate until it can say whether the check passes. Pages load only
 * from `hosts` (plus any public https page when publicWeb is "read"). When the AI needs a
 * person (sign in, captcha), the run waits for them in the live view.
 * Output: { passed, url, checks: [{ check, expect, status: "pass"|"fail"|"blocked", note, screenshot }] }.
 */
export const browseStepSchema = z
  .object({
    ...base,
    type: z.literal('browse'),
    ...aiChoice,
    url: z.string().min(1).max(2000),
    hosts: z.array(browseHost).max(20).default([]),
    publicWeb: z.literal('read').optional(),
    /** An earlier app step whose running app this browser may also open (its address is only known at run time). */
    app: stepId.optional(),
    /** A list of { check, expect } (or strings), usually "{{ steps.approve.output.checks }}". */
    checks: z.union([template, z.array(z.union([z.string().max(500), z.object({ check: z.string().max(500), expect: z.string().max(500).optional() }).strict()])).max(30)]),
    /** Browser actions the AI may take per check. */
    maxActions: z.number().int().min(1).max(40).default(15),
    /** The most this step may spend on AI in one run. */
    costCap: costCapSchema.optional(),
  })
  .strict()
  .refine((s) => s.hosts.length > 0 || s.app || s.publicWeb, { message: 'a browse step needs hosts, an app step, or publicWeb' });
export type BrowseStep = z.infer<typeof browseStepSchema>;

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/);
const service = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const envSchema = z.record(envName, z.string().max(500)).default({});
/**
 * Secrets for the code an app or fix step runs, e.g. { "DATABASE_URL": "team-db" }: env var name ->
 * credential service. Read when the step runs (the team's stored credential for that service, else
 * the runner's own from their vault), never written in the Flow, removed from logs and outputs.
 */
const secretEnvSchemaFor = <P extends string>(phases: readonly [P, ...P[]]) =>
  z
    .record(envName, z.union([service, z.object({ service, phases: z.array(z.enum(phases)).min(1).max(phases.length) }).strict()]))
    .refine((m) => Object.keys(m).length <= 20, 'at most 20 secret env vars')
    .default({});
const noSharedEnv = (s: { env: Record<string, string>; secretEnv: Record<string, unknown> }) => !Object.keys(s.secretEnv).some((k) => k in s.env);
const sharedEnvIssue = { message: 'a name is in both env and secretEnv', path: ['secretEnv'] };

/**
 * The phases of an app or fix step. The install (package scripts: the least trusted code) gets no secret
 * and no destination beyond the git host and package registries. A secret written as a plain service name
 * reaches every other phase of its step (as before); { service, phases } narrows it.
 */
export const APP_PHASES = ['build', 'run'] as const;
export const FIX_PHASES = ['build', 'test'] as const;
export type StepPhase = 'install' | (typeof APP_PHASES)[number] | (typeof FIX_PHASES)[number];
export type SecretEnvValue = string | { service: string; phases: StepPhase[] };
export const secretService = (v: SecretEnvValue): string => (typeof v === 'string' ? v : v.service);
/** The phases a secret env var reaches. */
export const secretPhases = (stepType: 'app' | 'fix', v: SecretEnvValue): StepPhase[] =>
  typeof v === 'string' ? [...(stepType === 'app' ? APP_PHASES : FIX_PHASES)] : v.phases;

/** One phase's outside destinations (src/runtime/destinations.ts): checked when written, and against the organization's ceiling when approved and when run. */
const destinationList = z
  .array(z.string().max(260))
  .max(20)
  .superRefine((list, ctx) => {
    const tcpPorts = new Map<number, string>();
    for (const raw of list) {
      const d = parseDestination(raw);
      if (!isDestination(d)) {
        ctx.addIssue({ code: 'custom', message: d.error });
        continue;
      }
      // One TCP forward per port in a phase: plain TCP carries no host name to tell two apart.
      if (d.kind === 'tcp') {
        if (tcpPorts.has(d.port) && tcpPorts.get(d.port) !== d.host) ctx.addIssue({ code: 'custom', message: `"${raw}": another TCP destination in this phase already uses port ${d.port}` });
        if (d.port === 3128) ctx.addIssue({ code: 'custom', message: `"${raw}": port 3128 is the proxy's own` });
        tcpPorts.set(d.port, d.host);
      }
    }
  });
const egressSchemaFor = <P extends string>(phases: readonly [P, ...P[]]) =>
  z.object(Object.fromEntries(phases.map((p) => [p, destinationList.optional()])) as Record<P, z.ZodOptional<typeof destinationList>>).strict().default({} as never);

/**
 * Build and start an app from a git branch, for a later browse step ("app": "<this id>").
 * It RUNS THE BRANCH'S CODE: in a container when Docker is available (installs reach only
 * the git host and package registries; the app only Dittoly's browser), or, on a local
 * install whose admin allowed it, directly on that machine. It stops when the run ends.
 * Output: { url, hostKey, commit, mode }.
 */
export const appStepSchema = z
  .object({
    ...base,
    type: z.literal('app'),
    /** An https git URL; templates allowed, e.g. "{{ inputs.repo }}". */
    repo: z.string().min(1).max(500),
    /** Branch or tag; templates allowed, e.g. "{{ steps.mr.output.sourceBranch }}". */
    ref: z.string().min(1).max(250),
    /** Vault service whose token (the runner's own) clones the repository, e.g. "gitlab". */
    credential: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional(),
    image: z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]{0,200}$/).default('node:26'),
    install: z.string().max(500).optional(),
    build: z.string().max(500).optional(),
    start: z.string().min(1).max(500),
    port: z.number().int().min(1).max(65535).default(3000),
    /** The page to open and to wait for. */
    path: z.string().regex(/^\/[^\s]*$/).max(500).default('/'),
    /** Plain settings for the app (not secrets). */
    env: envSchema,
    /** Secret settings: env var name -> credential service, or { service, phases }, read when the step runs (see secretEnvSchemaFor). */
    secretEnv: secretEnvSchemaFor(APP_PHASES),
    /** Outside services the build and the running app may reach, e.g. { "run": ["api.stripe.com"] } (see destinationList). */
    egress: egressSchemaFor(APP_PHASES),
    readySeconds: z.number().int().min(5).max(900).default(180),
    timeoutSeconds: z.number().int().min(30).max(3600).default(900),
  })
  .strict()
  .refine(noSharedEnv, sharedEnvIssue);
export type AppStep = z.infer<typeof appStepSchema>;

/** A path rule in the repository: a file name ("package.json", "*.tf": at any depth) or a path from its root (".github/workflows/**"). */
export const pathGlob = z
  .string()
  .regex(/^[A-Za-z0-9_.*?\/@+-]{1,200}$/)
  .refine((g) => !g.startsWith('/') && !g.split('/').includes('..') && !g.includes('//'), 'a path rule is relative to the repository, without ..');

/**
 * What a fix step's change may touch, enforced by Dittoly on the change (never by the AI). Unset
 * fields take the defaults in src/engine/fix-limits.ts. blockedPaths replaces the default list (leaving
 * out a CI/CD or dependency rule needs allowRiskyPaths); addBlockedPaths adds to it.
 */
export const fixLimitsSchema = z
  .object({
    blockedPaths: z.array(pathGlob).max(100).optional(),
    addBlockedPaths: z.array(pathGlob).max(100).optional(),
    /** Lets blockedPaths leave out CI/CD and dependency files: the approver sees it flagged. */
    allowRiskyPaths: z.boolean().optional(),
    maxFiles: z.number().int().min(1).max(50).optional(),
    maxLinesChanged: z.number().int().min(1).max(5000).optional(),
    /** Only these files (or folders, ending in /) may change, e.g. the files in the stack trace; templates allowed. */
    onlyFilesIn: z.union([template, z.array(z.string().min(1).max(500)).max(50)]).optional(),
  })
  .strict();
export type FixLimits = z.infer<typeof fixLimitsSchema>;

/**
 * Fix and verify: clone a repository like an app step, let the organization's AI change the code
 * (reading, searching and writing files, and running only the declared test commands), then check
 * with Dittoly's own runs that the bug was there, that it is gone and that the tests pass. Changes
 * nothing outside its sandbox: a later step pushes the change. Output (src/engine/fix.ts):
 * { verified, limits, confidence, change, summary, regressionTest, autoPushAllowed, baseCommit, logTail }.
 * baseCommit is the exact commit the change was verified against: create the fix branch from it.
 */
export const fixStepSchema = z
  .object({
    ...base,
    type: z.literal('fix'),
    ai: z.literal('organization'),
    /** An https git URL and a branch or tag, as for an app step; templates allowed. */
    repo: z.string().min(1).max(500),
    ref: z.string().min(1).max(250),
    credential: service.optional(),
    image: z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]{0,200}$/).default('node:26'),
    install: z.string().max(500).optional(),
    build: z.string().max(500).optional(),
    /** The test suite: must pass after the fix. */
    test: z.string().min(1).max(500),
    /** Runs one test file; {file} is replaced by its path. Default: the test command followed by the file. */
    testFile: z.string().max(500).regex(/\{file\}/).optional(),
    /** Fails while the bug is there. Without it the AI must add a regression test file. */
    reproduce: z.string().max(500).optional(),
    /** What to fix; templates allowed (e.g. the error and logs from earlier steps). */
    instruction: z.string().min(1).max(8000),
    /** More data for the AI (templates allowed), passed as information, never as instructions. */
    context: z.record(z.string(), z.unknown()).default({}),
    env: envSchema,
    secretEnv: secretEnvSchemaFor(FIX_PHASES),
    /** Outside services the build and the test commands may reach, e.g. { "test": ["testdb.example.com:5432"] }. */
    egress: egressSchemaFor(FIX_PHASES),
    limits: fixLimitsSchema.optional(),
    /** Confidence (0-100) from which autoPushAllowed may be true; without it, never. */
    autoPushAt: z.number().int().min(0).max(100).optional(),
    timeoutSeconds: z.number().int().min(30).max(3600).default(900),
    maxTurns: z.number().int().min(1).max(60).default(30),
    /** The most this step may spend on AI in one run. */
    costCap: costCapSchema.optional(),
  })
  .strict()
  .refine(noSharedEnv, sharedEnvIssue)
  .refine((s) => s.limits?.allowRiskyPaths === true || riskyOmissions(s.limits).length === 0, {
    message: 'blockedPaths leaves out CI/CD or dependency files: set "allowRiskyPaths": true (the approver sees it flagged)',
    path: ['limits', 'blockedPaths'],
  });
export type FixStep = z.infer<typeof fixStepSchema>;

/**
 * A report: turn a list of results into text ready to post, in each destination's format.
 * Output: { passed, summary, markdown, slack, plain, screenshots: [data URLs] }.
 */
export const reportStepSchema = z
  .object({
    ...base,
    type: z.literal('report'),
    heading: z.string().min(1).max(200),
    /** The list, usually "{{ steps.check.output.checks }}"; items with check/status/note. */
    items: template,
    /** A link to add at the end, e.g. "{{ inputs.issueUrl }}" (templates allowed). */
    link: z.string().max(2000).optional(),
  })
  .strict();
export type ReportStep = z.infer<typeof reportStepSchema>;

/**
 * Run other approved Flows: what makes a Flow a Super Flow. Every Flow listed starts
 * at once, as the person running this one, pinned to one version (like a module);
 * the step waits for all of them and fails if any fails.
 * Output: { <run id>: { runId, status, steps: { <step id>: output } } }.
 */
export const flowStepSchema = z
  .object({
    ...base,
    type: z.literal('flow'),
    runs: z
      .array(
        z
          .object({
            /** The name later steps use: steps.<step>.output.<id>.steps.<child step>... */
            id: stepId,
            /** The Flow (its id) and the approved version to run. */
            flow: z.string().uuid(),
            version: z.number().int().min(1),
            /** The child Flow's inputs; templates allowed. */
            input: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .refine((runs) => new Set(runs.map((r) => r.id)).size === runs.length, 'run ids must be unique'),
  })
  .strict();
export type FlowStep = z.infer<typeof flowStepSchema>;

/**
 * Read or change a row of one of the team's data tables (src/tables/service.ts).
 * Outputs: get { found, row }, put { row, created }, delete { deleted }, list { rows, count },
 * increment { value, row }, claim { claimed, until }. Changes (put, delete, increment, claim) are skipped in dry runs.
 * claim holds the key for this run until it ends, at most `hours` (default 6): of runs claiming it at the same time
 * exactly one gets it.
 */
export const TABLE_OPS = ['get', 'put', 'delete', 'list', 'increment', 'claim'] as const;
export const tableStepSchema = z
  .object({
    ...base,
    type: z.literal('table'),
    /** The table's name in the Flow's team. */
    table: z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]{0,59}$/),
    op: z.enum(TABLE_OPS),
    /** The row's key (a template or text); not for list. */
    key: z.string().min(1).max(500).optional(),
    /** put: column values (templates allowed); other columns of the row stay. */
    values: z.record(z.string(), z.unknown()).optional(),
    /**
     * put: write only if the row is still the one this run read — the "revision" a get step returned, usually as
     * "{{ steps.<get step>.output.row.revision }}". 0 writes only when there is no row yet. Without it the write
     * wins over whatever another run did in the meantime.
     */
    ifRevision: z.union([z.number().int().min(0), z.string().min(1).max(200)]).optional(),
    /** increment: the number column, and how much to add (default 1). */
    column: z.string().max(40).optional(),
    by: z.union([z.number(), z.string().max(200)]).optional(),
    /** list: only rows whose column equals this value, newest first, at most limit (default 100). */
    where: z.object({ column: z.string().max(40), equals: z.unknown() }).strict().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    /** claim: how long the run holds the key (1 to 168 hours, default 6). */
    hours: z.number().int().min(1).max(168).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const need = (field: keyof typeof s, ok: boolean, why: string) => ok || ctx.addIssue({ code: 'custom', path: [field], message: why });
    if (s.op === 'list') need('key', s.key === undefined, 'list reads many rows: no key');
    else need('key', s.key !== undefined, `${s.op} needs the row's key`);
    need('values', s.op === 'put' ? !!s.values && Object.keys(s.values).length > 0 : s.values === undefined, s.op === 'put' ? 'put needs values' : 'only put has values');
    need('column', s.op === 'increment' ? !!s.column : s.column === undefined, s.op === 'increment' ? 'increment needs the number column' : 'only increment has a column');
    if (s.op !== 'increment') need('by', s.by === undefined, 'only increment has by');
    if (s.op !== 'claim') need('hours', s.hours === undefined, 'only claim has hours');
    if (s.op !== 'put') need('ifRevision', s.ifRevision === undefined, 'only put has ifRevision');
    if (s.op !== 'list') {
      need('where', s.where === undefined, 'only list has where');
      need('limit', s.limit === undefined, 'only list has a limit');
    }
  });
export type TableStep = z.infer<typeof tableStepSchema>;

export const stepSchema = z.discriminatedUnion('type', [actionStepSchema, approvalStepSchema, delayStepSchema, inputStepSchema, aiStepSchema, browseStepSchema, reportStepSchema, appStepSchema, fixStepSchema, flowStepSchema, tableStepSchema]);

/** A Super Flow is a Flow that runs other Flows. */
export const isSuperFlow = (def: { steps: { type: string }[] }) => def.steps.some((s) => s.type === 'flow');
export type Step = z.infer<typeof stepSchema>;
export type ActionStep = z.infer<typeof actionStepSchema>;

export const flowDefinitionSchema = z
  .object({
    description: z.string().max(500).optional(),
    /**
     * Guidance every AI step of the Flow follows (tone, rules, context), written by its owner. Part of the approved
     * version like everything else, so changing it needs approval again. It guides answers; it never adds steps.
     */
    instructions: z.string().trim().min(1).max(4000).optional(),
    inputs: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
    retry: z.object({ manualRetryLimit: z.number().int().min(0).max(10) }).strict().default({ manualRetryLimit: 3 }),
    /** The run form (the Flow's "super view"); without it the form follows the input schema. */
    form: formSchema.optional(),
    /** The most one run may spend on AI; without it, the organization's default cap applies (if set). */
    costCap: costCapSchema.optional(),
    /** Its own counts and windows for automatic stops, over the organization's. */
    autoStop: flowAutoStopSchema.optional(),
    /**
     * What each module this Flow uses needs to know, by module name: the values of the settings the module
     * declares (for example the Jira site). A step may override them with its own "settings". A value may be a
     * template, so the person running it chooses. Modules keep no configuration of their own.
     */
    moduleSettings: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(300))).optional(),
    /**
     * The team data tables its table steps need, with their key and columns: Dittoly creates each one (or adds missing
     * columns) in the Flow's team when the version is approved, so nobody makes them by hand.
     */
    tables: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]{0,59}$/, 'a table name of 1-60 letters, digits, spaces, _ or -'),
            purpose: z.string().min(1).max(200),
            keyColumn: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
            columns: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), type: z.enum(['text', 'number', 'boolean', 'date']) }).strict()).max(30).default([]),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    steps: z.array(stepSchema).min(1).max(50),
  })
  .strict()
  .superRefine((def, ctx) => {
    const props = (def.inputs as { properties?: Record<string, unknown> }).properties ?? {};
    def.form?.fields.forEach((f, i) => {
      if (!(f.name in props)) ctx.addIssue({ code: 'custom', path: ['form', 'fields', i], message: `field "${f.name}" is not a Flow input` });
      if (f.options && 'fromStep' in f.options) ctx.addIssue({ code: 'custom', path: ['form', 'fields', i], message: 'the run form cannot use step outputs (nothing has run yet)' });
    });
    const seen = new Set<string>();
    def.steps.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'id'], message: 'duplicate step id' });
      for (const ref of referencedSteps(s)) {
        if (!seen.has(ref)) {
          ctx.addIssue({ code: 'custom', path: ['steps', i], message: `refers to step "${ref}" that does not run before it` });
        }
      }
      if (s.type === 'action' && s.autoApproveWhen) {
        // (A value of another form was already refused by the step's own schema.)
        const ref = AUTO_APPROVE.exec(s.autoApproveWhen)?.[1];
        if (ref && !def.steps.slice(0, i).some((x) => x.id === ref && x.type === 'fix')) {
          ctx.addIssue({ code: 'custom', path: ['steps', i, 'autoApproveWhen'], message: `autoApproveWhen must name a fix step before this one ("${ref}" is not)` });
        }
      }
      seen.add(s.id);
    });
  });

export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;

const TEMPLATE = /\{\{\s*(?:fingerprint\(\s*)?([A-Za-z0-9_.]+)\s*\)?\s*\}\}/g;

function collectPaths(value: unknown, out: string[]): void {
  if (typeof value === 'string') for (const m of value.matchAll(TEMPLATE)) out.push(m[1]!);
  else if (Array.isArray(value)) value.forEach((v) => collectPaths(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectPaths(v, out));
}

function referencedSteps(step: Step): string[] {
  const paths: string[] = [];
  if (step.type === 'action') {
    collectPaths(step.input, paths);
    if (step.forEach) collectPaths(step.forEach, paths);
    if (step.autoApproveWhen) paths.push(step.autoApproveWhen);
  }
  if (step.type === 'ai') collectPaths([step.instruction, step.input], paths);
  if (step.type === 'browse') {
    collectPaths([step.url, step.checks], paths);
    if (step.app) paths.push(`steps.${step.app}.output`);
  }
  if (step.type === 'app') collectPaths([step.repo, step.ref], paths);
  if (step.type === 'fix') collectPaths([step.repo, step.ref, step.instruction, step.context, step.limits?.onlyFilesIn ?? ''], paths);
  if (step.type === 'report') collectPaths([step.items, step.link ?? '', step.heading], paths);
  if (step.type === 'flow') collectPaths(step.runs.map((r) => r.input), paths);
  if (step.type === 'table') collectPaths([step.key ?? '', step.values ?? {}, step.by ?? '', step.where?.equals ?? ''], paths);
  if (step.type === 'input') {
    for (const f of step.fields) {
      if (typeof f.default === 'string') collectPaths(f.default, paths);
      if (f.options && 'fromStep' in f.options) collectPaths(f.options.fromStep, paths);
      if (f.options && 'module' in f.options) collectPaths(f.options.input, paths);
    }
  }
  if (step.when) paths.push(...Object.values(step.when).flat().filter((v): v is string => typeof v === 'string'));
  return [...new Set(paths.filter((p) => p.startsWith('steps.')).map((p) => p.split('.')[1]!))];
}

export function parseFlowDefinition(value: unknown): { ok: true; definition: FlowDefinition } | { ok: false; issues: string[] } {
  const r = flowDefinitionSchema.safeParse(value);
  if (r.success) return { ok: true, definition: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

/** Every live option lookup (module read action) in the form and in input steps. */
export function optionLookups(def: FlowDefinition): { where: string; field: FormField; source: Extract<OptionsSource, { module: string }> }[] {
  const out: { where: string; field: FormField; source: Extract<OptionsSource, { module: string }> }[] = [];
  for (const f of def.form?.fields ?? []) if (f.options && 'module' in f.options) out.push({ where: 'form', field: f, source: f.options });
  for (const s of def.steps) {
    if (s.type !== 'input') continue;
    for (const f of s.fields) if (f.options && 'module' in f.options) out.push({ where: `step ${s.id}`, field: f, source: f.options });
  }
  return out;
}

/** The setting values an action step runs with: the Flow's, with the step's own on top. */
export function settingsOf(def: Pick<FlowDefinition, 'moduleSettings'>, step: ActionStep): Record<string, string> {
  const name = step.module.split('@')[0]!;
  return { ...(def.moduleSettings?.[name] ?? {}), ...(step.settings ?? {}) };
}

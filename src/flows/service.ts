import { createDeclaredTables } from '../tables/service.js';
import { flowGuide } from '../core/guides.js';
import type { DraftSource } from '../ai/sources.js';
import type { ClassificationRecord } from '../ai/classify.js';
import { hostMatches, optionalServicesFor, resolveManifest, servicesFor, type Manifest } from '../modules/manifest.js';
import type { DeploymentMode } from '../config.js';
import { audit } from '../core/audit.js';
import { canonicalJson, sha256Hex } from '../core/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { canApprove, type Member } from '../core/members.js';
import { assertTeamMember, defaultTeamFor } from '../core/teams.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { enqueue } from '../engine/jobs.js';
import { approvalAuthority, notifyApprovers } from '../governance/approvals.js';
import { assertNotRequester, noteChangeDecision } from '../governance/changes.js';
import { notify } from '../core/notify.js';
import { checkFlowApproval, requiredApprovals } from '../governance/policies.js';
import { ajv } from '../modules/manifest.js';
import { moduleRef, type AssistantDraft, type DraftCost, type DraftedBy, type ModuleRegistry, type ModuleVersion } from '../modules/registry.js';
import { injectionPaths, MODEL_INPUTS, needsSignOff, type InjectionReport } from './injection.js';
import { orgAiSteps } from '../ai/models.js';
import { egressCeiling, judgeEgress } from '../core/egress-policy.js';
import { AUTO_APPROVE, optionLookups, parseFlowDefinition, secretPhases, secretService, settingsOf, type FixStep, type FlowDefinition, type FlowStep, type Step, type FormField, type SecretEnvValue, type StepPhase } from './definition.js';
import { DEFAULT_MAX_FILES, DEFAULT_MAX_LINES, effectiveLimits } from '../engine/fix-limits.js';
import { archivedModules, isFlowArchived } from './archive.js';

export type FlowVersionStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface FlowVersion {
  id: string;
  flowId: string;
  version: number;
  definition: FlowDefinition;
  approvalHash: string;
  status: FlowVersionStatus;
  createdBy: string;
  decidedBy: string | null;
  /** Steps that wait for a sign-off before they run (prompt-injection containment); null until computed. */
  guardedSteps: string[] | null;
  /** Paths the approver accepted, with their reason. */
  injectionAccepted: AcceptedPath[];
  /**
   * The model ("provider:model") it was approved or last checked with; when modelLocked, the one its organization AI
   * steps always run with. Otherwise they follow the organization's model. Null until approved.
   */
  aiModel: string | null;
  /** An approver locked it to aiModel; else it follows the organization's model (src/ai/models.ts). */
  modelLocked: boolean;
}

export interface AcceptedPath {
  sink: string;
  reason: string;
  by: string;
  at: string;
}

interface Row {
  id: string;
  flow_id: string;
  version: number;
  definition: FlowDefinition;
  approval_hash: string;
  status: FlowVersionStatus;
  created_by: string;
  decided_by: string | null;
  guarded_steps: string[] | null;
  injection_accepted: AcceptedPath[] | null;
  ai_model: string | null;
  model_locked?: boolean;
}

const fromRow = (r: Row): FlowVersion => ({
  id: r.id,
  flowId: r.flow_id,
  version: r.version,
  definition: r.definition,
  approvalHash: r.approval_hash,
  status: r.status,
  createdBy: r.created_by,
  decidedBy: r.decided_by,
  guardedSteps: r.guarded_steps ?? null,
  injectionAccepted: r.injection_accepted ?? [],
  aiModel: r.ai_model ?? null,
  modelLocked: r.model_locked === true,
});

/**
 * The hash an approver signs off on: the exact definition plus the exact code
 * and manifest of every pinned module version. If any of it differs at run
 * time, the run is refused.
 */
export function approvalHash(definition: FlowDefinition, modules: ModuleVersion[]): string {
  const pinned = modules
    .map((m) => ({ ref: moduleRef(m), code: m.codeSha256, manifest: m.manifestSha256 }))
    .sort((a, b) => (a.ref < b.ref ? -1 : 1));
  return sha256Hex(canonicalJson({ definition, modules: pinned }));
}

const TEMPLATE_PATH = /\{\{\s*(?:fingerprint\(\s*)?([A-Za-z0-9_.]+)\s*\)?\s*\}\}/g;

function templatePaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') for (const m of value.matchAll(TEMPLATE_PATH)) out.push(m[1]!);
  else if (Array.isArray(value)) value.forEach((v) => templatePaths(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => templatePaths(v, out));
  return out;
}

/**
 * Static checks a Flow must pass before anyone is asked to approve it: every
 * action gets the inputs its manifest requires and no undeclared ones, every
 * `inputs.x` is a declared Flow input, and `item` is only used inside forEach.
 */
/**
 * The Flow's values, tidied once before they are checked and stored: every value trimmed, and a host lowercased
 * (host names are not case-sensitive, but everything that matches them against a pattern is). Templates are left
 * as they are, since what they name is resolved when the run starts.
 */
export function normalizeSettings(def: FlowDefinition, modules: Map<string, ModuleVersion>): void {
  const tidy = (values: Record<string, string> | undefined, manifest: Manifest | undefined) => {
    if (!values) return;
    for (const [id, raw] of Object.entries(values)) {
      const value = raw.trim();
      const st = (manifest?.settings ?? []).find((s) => s.id === id);
      values[id] = st?.type === 'host' && !value.includes('{{') ? value.toLowerCase() : value;
    }
  };
  for (const [name, values] of Object.entries(def.moduleSettings ?? {})) {
    const step = def.steps.find((s) => s.type === 'action' && s.module.split('@')[0] === name);
    tidy(values, step && step.type === 'action' ? modules.get(step.module)?.manifest : undefined);
  }
  for (const step of def.steps) if (step.type === 'action') tidy(step.settings, modules.get(step.module)?.manifest);
}

/**
 * A module keeps no configuration: the Flow gives it. Every setting a used module declares needs a value, in the
 * Flow's "moduleSettings" or on the step; a host written out must match the pattern the manifest declares (one that
 * comes from a template is checked when the run resolves it).
 */
export function checkSettings(def: FlowDefinition, modules: Map<string, ModuleVersion>): string[] {
  const issues: string[] = [];
  const used = new Map<string, Manifest>();
  for (const step of def.steps) {
    if (step.type !== 'action') continue;
    const manifest = modules.get(step.module)!.manifest;
    used.set(step.module.split('@')[0]!, manifest);
    const values = settingsOf(def, step);
    for (const st of manifest.settings ?? []) {
      const v = values[st.id];
      if (v === undefined || v === '') {
        // A text setting falls back to the manifest's default, a certificate to the system's CAs; a host needs a value.
        if (st.type === 'host') {
          issues.push(`step ${step.id}: ${step.module} needs the setting "${st.id}" (${st.label}): give it in the Flow's "moduleSettings"`);
        }
        continue;
      }
      if (st.type === 'host' && !templatePaths(v).length && !hostMatches(st.pattern, v.toLowerCase())) {
        issues.push(`step ${step.id}: setting "${st.id}" must be a host matching ${st.pattern} (got "${v}")`);
      }
    }
    for (const id of Object.keys(values)) {
      if (!(manifest.settings ?? []).some((st) => st.id === id)) issues.push(`step ${step.id}: ${step.module} has no setting "${id}"`);
    }
  }
  // Values for a module no step uses are simply unused (a step may have been removed); only a wrong id is an error.
  for (const [name, values] of Object.entries(def.moduleSettings ?? {})) {
    const manifest = used.get(name);
    if (!manifest) continue;
    for (const id of Object.keys(values)) {
      if (!(manifest.settings ?? []).some((st) => st.id === id)) issues.push(`moduleSettings.${name}: that module has no setting "${id}"`);
    }
  }
  return issues;
}

/** What a fix step hands on, as its own steps describe it (src/engine/fix.ts FixChange). */
const FIX_FILE_FIELDS = ['path', 'action', 'content'];

/**
 * A step that hands a fix step's changed files straight to an action that cannot take them. The files are
 * [{ path, action: create|update|delete, content }] and a Flow has no way to reshape them, so an action whose
 * schema refuses one of those fields can never run with them: better said now than at the end of a run that
 * cloned, fixed and tested the code first.
 */
function fixShapeIssues(def: FlowDefinition, step: Extract<Step, { type: 'action' }>, schema: { properties?: Record<string, unknown> }): string[] {
  const fixSteps = new Set(def.steps.filter((s) => s.type === 'fix').map((s) => s.id));
  const out: string[] = [];
  for (const [key, value] of Object.entries(step.input)) {
    const m = typeof value === 'string' ? /^\{\{\s*steps\.([A-Za-z0-9_-]+)\.output\.change\.files\s*\}\}$/.exec(value) : null;
    if (!m || !fixSteps.has(m[1]!)) continue;
    const items = (schema.properties?.[key] as { items?: { properties?: Record<string, unknown>; additionalProperties?: unknown; required?: string[] } } | undefined)?.items;
    if (!items || items.additionalProperties !== false || !items.properties) continue;
    const refused = FIX_FILE_FIELDS.filter((f) => !(f in items.properties!));
    if (refused.length) {
      out.push(
        `step ${step.id}: ${step.module} ${step.action} input "${key}" cannot take the fix step's files: it has no ${refused.map((f) => `"${f}"`).join(', ')}, and a fix gives [{ path, action, content }]. The action has to take that shape (a "delete" action and no content for a deleted file).`,
      );
    }
    const missing = (items.required ?? []).filter((f) => !FIX_FILE_FIELDS.includes(f));
    if (missing.length) out.push(`step ${step.id}: ${step.module} ${step.action} input "${key}" requires ${missing.map((f) => `"${f}"`).join(', ')}, which a fix step's files do not have.`);
  }
  return out;
}

export function checkStepInputs(def: FlowDefinition, modules: Map<string, ModuleVersion>): string[] {
  const issues: string[] = [];
  const flowInputs = new Set(Object.keys((def.inputs as { properties?: object }).properties ?? {}));
  for (const step of def.steps) {
    if (step.type !== 'action') continue;
    const action = modules.get(step.module)!.manifest.actions.find((a) => a.name === step.action)!;
    const schema = action.input as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
    for (const key of schema.required ?? []) {
      if (!(key in step.input)) issues.push(`step ${step.id}: missing input "${key}" required by ${step.module} ${step.action}`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(step.input)) {
        if (!(key in schema.properties)) issues.push(`step ${step.id}: ${step.module} ${step.action} has no input "${key}"`);
      }
    }
    issues.push(...fixShapeIssues(def, step, schema));
    for (const p of templatePaths([step.input, step.forEach ?? null, settingsOf(def, step)])) {
      const [root, name] = p.split('.');
      if (root === 'inputs' && name && !flowInputs.has(name)) issues.push(`step ${step.id}: "inputs.${name}" is not a declared Flow input`);
      if (root === 'item' && !step.forEach) issues.push(`step ${step.id}: "item" is only available inside forEach`);
    }
  }
  // Live choices: only read actions, given the inputs they require, referring only to what exists at that point.
  for (const { where, field, source } of optionLookups(def)) {
    const action = modules.get(source.module)!.manifest.actions.find((a) => a.name === source.action)!;
    if (action.effect !== 'read') issues.push(`${where} field ${field.name}: choices can only come from an action that reads data (${source.module} ${source.action} changes data)`);
    const schema = action.input as { required?: string[] };
    for (const key of schema.required ?? []) if (!(key in source.input)) issues.push(`${where} field ${field.name}: missing input "${key}" for ${source.module} ${source.action}`);
    for (const p of templatePaths(source.input)) {
      const [root, name] = p.split('.');
      if (root === 'inputs' && name && !flowInputs.has(name)) issues.push(`${where} field ${field.name}: "inputs.${name}" is not a declared Flow input`);
      if (root === 'item') issues.push(`${where} field ${field.name}: "item" is not available here`);
      if (where === 'form' && root === 'steps') issues.push(`form field ${field.name}: the run form cannot use step outputs`);
    }
  }
  return issues;
}

/** A Flow another Flow runs, as pinned: "flowId@version". */
export interface ChildFlow {
  flowId: string;
  name: string;
  version: FlowVersion;
}
export const childRef = (r: { flow: string; version: number }) => `${r.flow}@${r.version}`;

/** Each child Flow gets the inputs it requires, and only `inputs.x` the Super Flow declares. */
/** Table steps name tables of the Flow's own team, and only columns those tables have. */
async function checkTables(db: Queryable, def: FlowDefinition, teamId: string | undefined): Promise<string[]> {
  const steps = def.steps.filter((s) => s.type === 'table');
  if (!steps.length) return [];
  if (!teamId) return ['table steps need the Flow\'s team'];
  const { rows } = await db.query<{ name: string; key_column: string; columns: { name: string; type: string }[] }>(
    `SELECT name, key_column, columns FROM data_tables WHERE team_id = $1`,
    [teamId],
  );
  // Tables the Flow declares count as there: they are created (or get the missing columns) when it is approved.
  for (const d of def.tables ?? []) {
    const t = rows.find((r) => r.name === d.name);
    if (t) t.columns = [...t.columns, ...d.columns.filter((c) => !t.columns.some((x) => x.name === c.name))];
    else rows.push({ name: d.name, key_column: d.keyColumn, columns: d.columns.filter((c) => c.name !== d.keyColumn) });
  }
  const issues: string[] = [];
  for (const s of steps) {
    const t = rows.find((r) => r.name === s.table);
    if (!t) {
      issues.push(`step ${s.id}: the team has no data table "${s.table}": declare it in the definition's "tables"`);
      continue;
    }
    const has = (c: string) => t.columns.some((x) => x.name === c);
    for (const c of Object.keys(s.values ?? {})) if (c !== t.key_column && !has(c)) issues.push(`step ${s.id}: "${s.table}" has no column "${c}"`);
    if (s.where && s.where.column !== t.key_column && !has(s.where.column)) issues.push(`step ${s.id}: "${s.table}" has no column "${s.where.column}"`);
    if (s.column && t.columns.find((x) => x.name === s.column)?.type !== 'number') issues.push(`step ${s.id}: "${s.column}" is not a number column of "${s.table}"`);
  }
  return issues;
}

export function checkChildInputs(def: FlowDefinition, children: Map<string, ChildFlow>): string[] {
  const issues: string[] = [];
  const flowInputs = new Set(Object.keys((def.inputs as { properties?: object }).properties ?? {}));
  for (const step of def.steps) {
    if (step.type !== 'flow') continue;
    for (const r of step.runs) {
      const child = children.get(childRef(r))!;
      const schema = child.version.definition.inputs as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
      for (const key of schema.required ?? []) if (!(key in r.input)) issues.push(`step ${step.id} run ${r.id}: missing input "${key}" required by Flow "${child.name}"`);
      if (schema.additionalProperties === false && schema.properties) {
        for (const key of Object.keys(r.input)) if (!(key in schema.properties)) issues.push(`step ${step.id} run ${r.id}: Flow "${child.name}" has no input "${key}"`);
      }
      for (const p of templatePaths(r.input)) {
        const [root, name] = p.split('.');
        if (root === 'inputs' && name && !flowInputs.has(name)) issues.push(`step ${step.id} run ${r.id}: "inputs.${name}" is not a declared Flow input`);
        if (root === 'item') issues.push(`step ${step.id} run ${r.id}: "item" is only available inside forEach`);
      }
    }
  }
  return issues;
}

function fieldSentence(f: FormField, modules: Map<string, ModuleVersion>): string {
  const o = f.options;
  let source = '';
  if (o && 'fixed' in o) source = `, choices: ${o.fixed.map((c) => c.label ?? String(c.value)).slice(0, 8).join(', ')}${o.fixed.length > 8 ? ', …' : ''}`;
  else if (o && 'fromStep' in o) source = `, choices from ${o.fromStep.replace(/[{}\s]/g, '')}`;
  else if (o && 'module' in o) {
    const mv = modules.get(o.module);
    const action = mv?.manifest.actions.find((a) => a.name === o.action);
    const services = mv && action ? servicesFor(mv.manifest, action.name) : [];
    source = `, choices loaded from ${mv?.manifest.title ?? o.module} "${action?.title ?? o.action}" (reads data${services.length ? ` with the person's own ${services.join(', ')} access` : ''})`;
  }
  return `${f.label} (${f.widget}${source})`;
}

/** A step's own AI spend cap, as the approver reads it. */
function capNote(cap: { tokens?: number | undefined; amount?: number | undefined } | undefined): string {
  if (!cap) return '';
  const parts = [cap.tokens !== undefined ? `${cap.tokens} tokens` : '', cap.amount !== undefined ? `${cap.amount} (price table currency)` : ''].filter(Boolean);
  return ` It may spend at most ${parts.join(' or ')} on AI per run, then the run waits for more to be allowed.`;
}

/** Secret env vars as the approver reads them: names, the credential each comes from and the phases it reaches, never a value. */
function secretEnvNote(stepType: 'app' | 'fix', secretEnv: Record<string, SecretEnvValue>): string {
  const list = Object.entries(secretEnv);
  if (!list.length) return '';
  const one = ([name, v]: [string, SecretEnvValue]) => `${name} from the "${secretService(v)}" credential (${secretPhases(stepType, v).join(' and ')})`;
  return ` Secret env vars: ${list.map(one).join(', ')}; never the install (the team's stored credential, else the runner's own; read when it runs, never shown, removed from logs and outputs).`;
}

/** Outside destinations per phase, as the approver reads them. */
function egressNote(egress: Partial<Record<StepPhase, string[]>>, network: string): string {
  const phases = Object.entries(egress).filter(([, list]) => list && list.length);
  const extra = phases.length ? ` It may ALSO REACH, only in that phase: ${phases.map(([p, list]) => `${p}: ${list!.join(', ')}`).join('; ')} (within the organization's allowed destinations).` : '';
  return ` Network in a container: ${network}.${extra}`;
}

/** A fix step's limits, as the approver reads them; risky ones in capitals. */
function fixLimitsNote(step: FixStep): string {
  const l = effectiveLimits(step.limits, null);
  const only = step.limits?.onlyFilesIn;
  const parts = [
    `at most ${step.limits?.maxFiles ?? DEFAULT_MAX_FILES} files and ${step.limits?.maxLinesChanged ?? DEFAULT_MAX_LINES} changed lines`,
    `never ${l.blockedPaths.join(', ')}`,
    ...(only ? [`only files in ${typeof only === 'string' ? only.replace(/[{}\s]/g, '') : only.join(', ')} (plus its regression test)`] : []),
    'no binary files or file mode changes',
  ];
  const risky = l.riskyAllowed.length ? ` IT ALLOWS RISKY PATHS: ${l.riskyAllowed.join(', ')} (CI/CD or dependency files) may change.` : '';
  return ` Limits Dittoly checks on the change: ${parts.join('; ')}.${risky}`;
}

function aiWho(step: { ai: 'organization' | 'runner'; provider?: string | undefined }): string {
  return step.ai === 'runner' ? `the AI of the person running it (their own ${step.provider ?? 'openai'} key, else the organization's AI)` : "the organization's AI";
}

/** What an approver reads: every step in plain language, with what it changes and whose access it uses. */
/** Hosts as an approver should read them: organization settings filled in, or marked as not set yet. */
export function displayHosts(m: Manifest, values: Record<string, string>): string {
  const { manifest, missing } = resolveManifest(m, values);
  return manifest.hosts.map((h) => (missing.some((id) => h === `{{settings.${id}}}`) ? `${h} (not set yet)` : h)).join(', ');
}

/** What a Flow may do, said as short rows an approver can scan, and what it can never do whatever it says. */
export interface FlowCapabilities {
  /** Apps it talks to: every host its steps may reach, with the module that reaches it. */
  hosts: { host: string; module: string; fromRun: boolean }[];
  /** What it changes out there: the write actions, in the approver's words. */
  changes: { step: string; title: string; module: string }[];
  /** Whose access each call runs with: the credentials its modules need. */
  credentials: { service: string; optional: boolean }[];
  /** Things it does on this machine: AI steps, code sandboxes, a browser, the team's data tables. */
  uses: string[];
  /** True for every Flow, whatever its steps say: the runtime enforces these. */
  never: string[];
}

/** What a drafted Flow is worth, in the same terms a reviewer reads and a benchmark counts. */
export interface FlowQuality {
  /** How many steps change something out there (a write action, a table write, an app or fix step). */
  writes: number;
  /** A person signs off before the first step that changes anything. */
  signOffBeforeWrite: boolean;
  /** Something that changes data runs only when an earlier step found something ("only if there are any"). */
  conditionOnWrite: boolean;
  /** It remembers what it handled, so a second run does not do it twice. */
  remembers: boolean;
  /** Text a model wrote can reach a step that changes something, and nobody has accepted that path. */
  unacceptedInjection: number;
  /** Examples the Flow carries, and how many pass against this version. */
  examples: { total: number; passed: number };
  /** Nothing unguarded, nothing unaccepted, and its examples pass. */
  clean: boolean;
}

export function flowQuality(
  def: FlowDefinition,
  modules: Map<string, ModuleVersion>,
  extra: { unacceptedInjection?: number; examples?: { total: number; passed: number } } = {},
): FlowQuality {
  const writes = def.steps.filter(
    (s) =>
      (s.type === 'action' && modules.get(s.module)?.manifest.actions.find((a) => a.name === s.action)?.effect === 'write') ||
      (s.type === 'table' && s.op !== 'get' && s.op !== 'list') ||
      s.type === 'app' ||
      s.type === 'fix',
  );
  const firstWrite = def.steps.findIndex((s) => writes.includes(s));
  const approval = def.steps.findIndex((s) => s.type === 'approval');
  const signOffBeforeWrite = !writes.length || (approval !== -1 && approval < firstWrite);
  const conditionOnWrite = !writes.length || writes.some((s) => s.when) || def.steps.some((s) => s.type === 'action' && s.autoApproveWhen);
  const remembers = def.steps.some((s) => s.type === 'table' && (s.op === 'get' || s.op === 'claim'));
  const examples = extra.examples ?? { total: 0, passed: 0 };
  const unacceptedInjection = extra.unacceptedInjection ?? 0;
  return {
    writes: writes.length,
    signOffBeforeWrite,
    conditionOnWrite,
    remembers,
    unacceptedInjection,
    examples,
    clean: signOffBeforeWrite && conditionOnWrite && unacceptedInjection === 0 && examples.total > 0 && examples.passed === examples.total,
  };
}

/**
 * The same reading as sentences for the AI that drafted it, so the draft is improved before anyone reviews it
 * rather than after. Empty when there is nothing to say.
 */
export function flowFindings(q: FlowQuality): string[] {
  const out: string[] = [];
  if (!q.signOffBeforeWrite)
    out.push('a step that changes something out there runs before anybody signs off: add an approval step in front of the first step that writes, so a person sees what it is about to do.');
  if (!q.conditionOnWrite)
    out.push('nothing guards the steps that change something: give each a "when" so it runs only if an earlier step actually found something to act on.');
  if (!q.remembers && q.writes)
    out.push('it does not remember what it already handled, so a second run would do the same work twice: read (or claim) a row in a data table keyed on what it is handling before changing anything.');
  if (q.unacceptedInjection)
    out.push(`${q.unacceptedInjection} step(s) that change something can be reached by text a model wrote: either put a sign-off in front of them, or stop passing model-written text into them.`);
  if (!q.examples.total) out.push('it carries no examples: write two or three testsJson cases, one of them for the case where there is nothing to do.');
  return out;
}

export function flowCapabilities(def: FlowDefinition, modules: Map<string, ModuleVersion>): FlowCapabilities {
  const hosts = new Map<string, { host: string; module: string; fromRun: boolean }>();
  const changes: FlowCapabilities['changes'] = [];
  const credentials = new Map<string, boolean>();
  const uses = new Set<string>();
  for (const step of def.steps) {
    if (step.type === 'ai') uses.add('Asks an AI model, with the data the earlier steps found');
    if (step.type === 'browse') uses.add('Opens pages in Dittoly’s own browser');
    if (step.type === 'fix' || step.type === 'app') uses.add('Builds and runs code in a sandbox, with no network but the hosts it declares');
    if (step.type === 'table') uses.add(`Reads and writes the team’s data table “${step.table}”`);
    if (step.type === 'approval' || step.type === 'input') uses.add('Stops and waits for a person');
    if (step.type !== 'action') continue;
    const mv = modules.get(step.module);
    if (!mv) continue;
    const action = mv.manifest.actions.find((a) => a.name === step.action);
    const values = settingsOf(def, step);
    for (const host of resolveManifest(mv.manifest, values).manifest.hosts) {
      const fromRun = host.includes('{{');
      const shown = fromRun ? 'a host the run is asked for' : host;
      if (!hosts.has(`${mv.name}:${shown}`)) hosts.set(`${mv.name}:${shown}`, { host: shown, module: mv.name, fromRun });
    }
    if (action?.effect === 'write') changes.push({ step: step.id, title: action.title, module: mv.name });
    for (const service of servicesFor(mv.manifest, step.action)) credentials.set(service, credentials.get(service) ?? false);
    for (const service of optionalServicesFor(mv.manifest, step.action)) if (!credentials.has(service)) credentials.set(service, true);
  }
  return {
    hosts: [...hosts.values()],
    changes,
    credentials: [...credentials.entries()].map(([service, optional]) => ({ service, optional })),
    uses: [...uses],
    never: [
      'Reach any host but the ones above',
      'Use a credential it does not declare, or see its value',
      'Read the machine’s files or environment variables',
      'Touch another team’s data, or another Flow’s',
      'Keep anything of its own: a module stores nothing between calls',
      'Change itself: every change is a new version, approved again',
    ],
  };
}

export function flowSummary(def: FlowDefinition, modules: Map<string, ModuleVersion>, children: Map<string, ChildFlow> = new Map()): string {
  const lines: string[] = [];
  if (def.description) lines.push(def.description, '');
  if (def.instructions) {
    const ai = def.steps.filter((s) => s.type === 'ai').length;
    lines.push(`Instructions every AI step follows${ai ? '' : ' (this Flow has no AI step, so nothing uses them)'}: "${def.instructions.slice(0, 1000)}"`, '');
  }
  if (def.form?.fields.some((f) => f.options && 'module' in f.options)) {
    lines.push(`Run form: ${def.form.fields.map((f) => fieldSentence(f, modules)).join('; ')}.`, '');
  }
  def.steps.forEach((step, i) => {
    const when = step.when ? ` (only if ${Object.entries(step.when)[0]!.join(' ')})` : '';
    const title = step.title ? `${step.title}: ` : '';
    if (step.type === 'approval') lines.push(`${i + 1}. ${title}waits for an approver to sign off${when}.`);
    else if (step.type === 'input') lines.push(`${i + 1}. ${title}pauses and asks the person running it for: ${step.fields.map((f) => fieldSentence(f, modules)).join('; ')}${when}.`);
    else if (step.type === 'delay') lines.push(`${i + 1}. ${title}waits ${step.seconds} seconds${when}.`);
    else if (step.type === 'ai') {
      const data = Object.keys(step.input).length ? `, sending it ${Object.values(step.input).map((v) => String(v).replace(/[{}\s]/g, '')).join(', ')}` : '';
      lines.push(`${i + 1}. ${title}asks ${aiWho(step)} to ${step.output === 'checklist' ? 'write a check list' : step.output === 'json' ? 'answer as data in a fixed shape' : 'answer'}: "${step.instruction.slice(0, 200)}"${data}${when}. The answer is data for later steps; it does nothing by itself.${capNote(step.costCap)}`);
    } else if (step.type === 'browse') {
      const web = step.publicWeb === 'read' ? ', and may READ any public website' : '';
      lines.push(`${i + 1}. ${title}opens ${step.url.replace(/[{}\s]/g, '')} in a headless browser that ${aiWho(step)} drives (clicking, typing, navigating) to check ${typeof step.checks === 'string' ? step.checks.replace(/[{}\s]/g, '') : `${step.checks.length} items`}. Pages load only from ${[...step.hosts, ...(step.app ? [`the app started by step ${step.app}`] : [])].join(', ')}${web}; it sends no credentials, and asks the person running it when it needs them to sign in${when}.${capNote(step.costCap)}`);
    } else if (step.type === 'app') {
      const cmds = [step.install && `install "${step.install}"`, step.build && `build "${step.build}"`, `start "${step.start}"`].filter(Boolean).join(', ');
      lines.push(
        `${i + 1}. ${title}clones ${step.repo.replace(/[{}\s]/g, '')} at ${step.ref.replace(/[{}\s]/g, '')}${step.credential ? ` with the runner's own ${step.credential} token` : ''} and RUNS THAT BRANCH'S CODE to start the app: ${cmds}, in the ${step.image} image. ` +
          `In a container when Docker is available (the app is reachable only by Dittoly's browser); otherwise only where an admin allowed running project code directly on this machine, WITH FULL NETWORK. It stops when the run ends${when}.` +
          egressNote(step.egress ?? {}, 'the install and build reach the git host and package registries; the running app reaches nothing outside') +
          secretEnvNote('app', step.secretEnv),
      );
    } else if (step.type === 'fix') {
      const cmds = [step.install && `install "${step.install}"`, step.build && `build "${step.build}"`, `test "${step.test}"`, step.reproduce && `reproduce "${step.reproduce}"`, step.testFile && `one test file "${step.testFile}"`].filter(Boolean).join(', ');
      const push =
        step.autoPushAt === undefined
          ? ' It never allows pushing without a person (no autoPushAt).'
          : ` It allows pushing without a person (autoPushAllowed) only at a confidence of ${step.autoPushAt} or more, inside its limits, with the tests passing and the bug shown before the change.`;
      lines.push(
        `${i + 1}. ${title}FIX AND VERIFY: clones ${step.repo.replace(/[{}\s]/g, '')} at ${step.ref.replace(/[{}\s]/g, '')}${step.credential ? ` with the runner's own ${step.credential} token` : ''} and RUNS THAT BRANCH'S CODE (${cmds}) in the ${step.image} image, isolated as for an app step. ` +
          `${aiWho(step)[0]!.toUpperCase()}${aiWho(step).slice(1)} reads, searches and writes files in that copy (up to ${step.maxTurns} turns) and can run only those commands; it never sees secret values. ` +
          `Dittoly then checks the change itself (the regression test fails on the original code and passes with the change, reproduce passes, the build and the tests pass) and scores its confidence from those checks, not from the AI.` +
          fixLimitsNote(step) +
          ` The change is data for later steps: this step pushes nothing.${push}${when}.${capNote(step.costCap)}` +
          egressNote(step.egress ?? {}, 'every command reaches the git host and package registries') +
          secretEnvNote('fix', step.secretEnv),
      );
    } else if (step.type === 'report') {
      lines.push(`${i + 1}. ${title}formats ${step.items.replace(/[{}\s]/g, '')} as a report "${step.heading}" (changes nothing)${when}.`);
    } else if (step.type === 'flow') {
      const list = step.runs.map((r) => {
        const c = children.get(childRef(r));
        return `"${c?.name ?? r.flow}" v${r.version}${c && c.version.status !== 'approved' ? ` (${c.version.status}, not approved)` : ''}`;
      });
      lines.push(
        `${i + 1}. ${title}RUNS ${step.runs.length === 1 ? 'the Flow' : `${step.runs.length} Flows at the same time:`} ${list.join(', ')} as the person running this one, with their own access, and waits for ${step.runs.length === 1 ? 'it' : 'all of them'}. ` +
          `Each runs exactly the pinned version, which was reviewed and approved on its own${when}.`,
      );
    } else if (step.type === 'table') {
      const change = step.op === 'put' || step.op === 'delete' || step.op === 'increment' || step.op === 'claim';
      const verb = { get: 'reads a row of', list: 'lists rows of', put: 'CHANGES (adds or updates) a row of', delete: 'CHANGES (deletes) a row of', increment: `CHANGES (adds to "${step.column}" in) a row of`, claim: `RESERVES for ${step.hours ?? 6} hours (only one run at a time gets it) a key of` }[step.op];
      lines.push(`${i + 1}. ${title}${verb} the team's data table "${step.table}"${change ? '' : ' (changes nothing)'}${when}.`);
    } else {
      const mv = modules.get(step.module)!;
      const action = mv.manifest.actions.find((a) => a.name === step.action)!;
      const effect = action.effect === 'write' ? 'CHANGES data' : 'reads data';
      const services = servicesFor(mv.manifest, action.name);
      const optional = optionalServicesFor(mv.manifest, action.name);
      const access =
        (services.length ? ` using the runner's own ${services.join(', ')} access` : '') +
        (optional.length ? ` (${services.length ? 'and' : 'using'} their own ${optional.join(', ')} access if stored, else public data only)` : '');
      const each = step.forEach ? ` once for each item in ${step.forEach.replace(/[{}\s]/g, '')}` : '';
      const delegate = step.delegateTo ? ', run by a named teammate (delegation)' : '';
      const gate = step.autoApproveWhen
        ? ` EVIDENCE GATE: when this step waits for a sign-off because of the fix step ${AUTO_APPROVE.exec(step.autoApproveWhen)?.[1] ?? '?'}'s change, it goes on automatically when Dittoly verified the fix (${step.autoApproveWhen} is true); otherwise it asks a person. Text from any other AI step reaching it always asks a person.`
        : '';
      const values = settingsOf(def, step);
      const told = (mv.manifest.settings ?? [])
        .filter((st) => values[st.id])
        .map((st) => `${st.label}: ${templatePaths(values[st.id]!).length ? `chosen when the run starts (${values[st.id]})` : values[st.id]}`);
      lines.push(
        `${i + 1}. ${title}${mv.manifest.title} "${action.title}" ${effect}${each}${access}${delegate}${when}. Hosts: ${displayHosts(mv.manifest, values)}.${told.length ? ` Told: ${told.join('; ')}.` : ''}${gate}`,
      );
    }
  });
  return lines.join('\n');
}

/** What a chat-drafted version was generated with; shown to the approver. */
export interface FlowGeneration {
  instructions: { text: string; sha256: string } | null;
  /** The web pages the AI read (search) or named as what it relied on (ai), for the approver. */
  sources?: DraftSource[];
  /** What the request was classified as before drafting, and the person's answers. */
  classification?: ClassificationRecord | null;
  /** Drafted by an AI assistant over MCP from work it did. */
  assistant?: AssistantDraft | null;
  /** Proposed by Dittoly when a module it uses was fixed after its app changed. */
  fix?: FlowFix | null;
  /** Read from the connected git repository: the commit and file it came from (src/git-sync/import.ts). */
  git?: { commit: string; path: string } | null;
  /** The builder's short notes for FLOW.md (src/core/guides.ts). */
  notes?: string;
  /** Which AI wrote this version, and how hard it was told to think ("anthropic", "claude-opus-5", "medium"). */
  by?: DraftedBy | null;
  /** What drafting this version cost: tokens and AI calls (one plus each round of fixing). */
  cost?: DraftCost | null;
  /**
   * Which of the team's earlier answers this draft was given (src/ai/decisions.ts), by id, and how many could
   * not be read with the key in use. Ids only: their words stay encrypted where they were kept.
   */
  memory?: { used: string[]; unreadable: number; build?: { used: string[]; unreadable: number; omitted: number } } | null;
  /** The examples the AI wrote with this draft, and how many passed against it when it was stored. */
  examples?: { total: number; passed: number } | null;
  /** A new Flow that started from a copy of this approved one (which stays as it was). */
  cloneOf?: { flowId: string; version: number; name: string } | null;
}

/** A version Dittoly proposed itself: the same Flow, pinned to a fixed module version. */
export interface FlowFix {
  module: string;
  fromVersion: string;
  toVersion: string;
  /** The Flow's tests, played against the fixed module before proposing. */
  tests: { total: number; passed: number };
  /**
   * The AI wrote this version: pinning the fixed module alone left the Flow's examples failing, because the
   * module now asks for something else than the Flow sent it. The steps that use it were drafted again.
   */
  redrafted?: boolean;
}

export class FlowService {
  constructor(
    private readonly db: Db,
    private readonly modules: ModuleRegistry,
    private readonly mode: DeploymentMode,
    /** The organization's AI model ("provider:model"), pinned on versions when they are approved. */
    /** The organization's model now (an admin may change it). */
    private readonly aiModel: () => string | null = () => null,
  ) {}

  /** Apps following a Flow, and which of their pages a new version breaks (set by the app: src/team-apps/service.ts). */
  appImpact: ((flowId: string, definition: FlowDefinition) => Promise<{ appId: string; name: string; problems: string[]; pinned: boolean }[]>) | null = null;

  /** Resolve and check every module the definition pins. */
  async pinnedModules(db: Queryable, def: FlowDefinition): Promise<Map<string, ModuleVersion>> {
    const out = new Map<string, ModuleVersion>();
    // Actions the steps run, and the read actions that load choices: all pinned and covered by the approval.
    const uses = [
      ...def.steps.flatMap((s) => (s.type === 'action' ? [{ module: s.module, action: s.action }] : [])),
      ...optionLookups(def).map((l) => ({ module: l.source.module, action: l.source.action })),
    ];
    for (const u of uses) {
      if (out.has(u.module)) continue;
      const mv = await this.modules.resolveRef(db, u.module);
      if (!mv) throw badRequest('unknown_module', u.module);
      out.set(u.module, mv);
    }
    for (const u of uses) {
      if (!out.get(u.module)!.manifest.actions.some((a) => a.name === u.action)) throw badRequest('unknown_action', `${u.module} has no action ${u.action}`);
    }
    return out;
  }

  /** Resolve every Flow the definition runs (its flow steps), as pinned. */
  async pinnedFlows(db: Queryable, def: FlowDefinition): Promise<Map<string, ChildFlow>> {
    const out = new Map<string, ChildFlow>();
    for (const step of def.steps.filter((s): s is FlowStep => s.type === 'flow')) {
      for (const r of step.runs) {
        const ref = childRef(r);
        if (out.has(ref)) continue;
        const { rows } = await db.query<Row & { name: string }>(
          `SELECT v.*, f.name FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE v.flow_id = $1 AND v.version = $2`,
          [r.flow, r.version],
        );
        if (!rows[0]) throw badRequest('unknown_flow', `step ${step.id} run ${r.id}: no Flow ${r.flow} version ${r.version}`);
        out.set(ref, { flowId: r.flow, name: rows[0].name, version: fromRow(rows[0]) });
      }
    }
    return out;
  }

  /**
   * FLOW.md of a version: what starts it, its steps, what it changes and, for a Super Flow, every Flow it runs with
   * the modules under each (the whole process in one place), with the builder's notes.
   */
  async guide(db: Queryable, versionId: string): Promise<string> {
    const row = (await db.query<{ name: string; generation: FlowGeneration | null }>(`SELECT f.name, v.generation FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE v.id = $1`, [versionId])).rows[0];
    const v = await this.getVersion(db, versionId);
    if (!v || !row) throw notFound('flow_version');
    const effects = new Map<string, string>();
    const addEffects = (mods: Map<string, ModuleVersion>) => {
      for (const [ref, m] of mods) for (const a of m.manifest.actions) effects.set(`${ref}:${a.name}`, a.effect);
    };
    addEffects(await this.pinnedModules(db, v.definition).catch(() => new Map<string, ModuleVersion>()));
    const children = [];
    for (const c of (await this.pinnedFlows(db, v.definition).catch(() => new Map<string, ChildFlow>())).values()) {
      const modules = [...new Set(c.version.definition.steps.flatMap((s) => (s.type === 'action' ? [s.module] : [])))];
      children.push({ id: c.flowId, name: c.name, version: c.version.version, description: c.version.definition.description ?? '', modules });
    }
    return flowGuide(v.definition, { name: row.name, version: v.version, notes: row.generation?.notes, effects, children });
  }

  /** Paths from model-written text to steps that change something (src/flows/injection.ts). */
  async injection(db: Queryable, def: FlowDefinition, depth = 0, opts: { inputsFromModel?: boolean; inputsExternal?: boolean } = {}): Promise<InjectionReport & { model: boolean; writes: boolean }> {
    const modules = await this.pinnedModules(db, def);
    const children = new Map<string, { model: boolean; writes: boolean }>();
    if (depth < 5) for (const [ref, c] of await this.pinnedFlows(db, def)) children.set(ref, await this.injection(db, c.version.definition, depth + 1));
    const report = injectionPaths(def, {
      writes: (step) => modules.get(step.module)?.manifest.actions.find((a) => a.name === step.action)?.effect === 'write',
      child: (flow, version) => children.get(childRef({ flow, version })),
      inputsFromModel: opts.inputsFromModel === true,
      // A webhook, endpoint or trigger filled these inputs: whoever wrote the ticket wrote the text in them.
      inputsExternal: opts.inputsExternal === true,
    });
    const steps = def.steps;
    return {
      ...report,
      // For a Super Flow running this one: does a model write any of its output, does it change anything?
      model: steps.some((s) => s.type === 'ai' || s.type === 'browse' || s.type === 'fix') || [...children.values()].some((c) => c.model),
      writes:
        steps.some((s) => (s.type === 'action' && modules.get(s.module)?.manifest.actions.find((a) => a.name === s.action)?.effect === 'write') || (s.type === 'table' && s.op !== 'get' && s.op !== 'list') || s.type === 'app' || s.type === 'fix') ||
        [...children.values()].some((c) => c.writes),
    };
  }

  /** The steps of a version that wait for a sign-off: its open paths, less those the approver accepted. */
  async guardedSteps(db: Queryable, v: FlowVersion, opts: { inputsFromModel?: boolean; inputsExternal?: boolean } = {}): Promise<string[]> {
    // Inputs a model wrote were not part of what the approver accepted at all: every step they reach waits.
    if (opts.inputsFromModel) return [...new Set([...(await this.guardedSteps(db, v)), ...(await this.injection(db, v.definition, 0, opts)).sinks])];
    // Inputs a webhook sent: what the approver already saw and accepted still holds — those paths are the same
    // whoever starts the run. Only the paths the inputs themselves open, and only where they take authority,
    // are added (src/flows/injection.ts needsSignOff).
    if (opts.inputsExternal) {
      const report = await this.injection(db, v.definition, 0, opts);
      // A step the approver accepted stays accepted: they decided about that step, with its destination and its
      // effect fixed in the version they approved. What the inputs add is the steps nobody accepted.
      const accepted = new Set(v.injectionAccepted.map((a) => a.sink));
      const fromInputs = report.paths
        .filter((p) => p.source === MODEL_INPUTS && needsSignOff(p.sourceKind, p.influence) && !accepted.has(p.sink))
        .map((p) => p.sink);
      return [...new Set([...(await this.guardedSteps(db, v)), ...fromInputs])];
    }
    if (v.guardedSteps) return v.guardedSteps;
    const accepted = new Set(v.injectionAccepted.map((a) => a.sink));
    return (await this.injection(db, v.definition)).sinks.filter((s) => !accepted.has(s));
  }

  private async checkDefinition(db: Queryable, value: unknown, actor?: Member, teamId?: string) {
    const parsed = parseFlowDefinition(value);
    if (!parsed.ok) throw badRequest('invalid_flow', parsed.issues.join('; '));
    try {
      ajv.compile(parsed.definition.inputs);
    } catch {
      throw badRequest('invalid_flow', 'inputs: not a valid JSON Schema');
    }
    const modules = await this.pinnedModules(db, parsed.definition);
    const children = await this.pinnedFlows(db, parsed.definition);
    // You can only build on Flows you can see.
    if (actor) for (const c of children.values()) await this.assertCanSee(db, actor, { flowId: c.flowId });
    normalizeSettings(parsed.definition, modules);
    const issues = [
      ...checkStepInputs(parsed.definition, modules),
      ...checkSettings(parsed.definition, modules),
      ...checkChildInputs(parsed.definition, children),
      ...(await checkTables(db, parsed.definition, teamId)),
    ];
    if (issues.length) throw badRequest('invalid_flow', issues.join('; '));
    return { definition: parsed.definition, hash: approvalHash(parsed.definition, [...modules.values()]) };
  }

  /** A new Flow in `teamId` (default: the member's default team), which they must belong to. */
  async create(name: string, definition: unknown, actor: Member, generation?: FlowGeneration, teamId?: string): Promise<FlowVersion> {
    // One line of text: names end up in emails, chat messages and the comments of exported code.
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(name)) throw badRequest('invalid_name');
    return withTx(this.db, async (tx) => {
      const team = teamId ?? (await defaultTeamFor(tx, actor.id));
      await assertTeamMember(tx, team, actor);
      const { definition: def, hash } = await this.checkDefinition(tx, definition, actor, team);
      const { rows } = await tx.query<{ id: string }>(`INSERT INTO flows (name, created_by, team_id) VALUES ($1, $2, $3) RETURNING id`, [
        name,
        actor.id,
        team,
      ]);
      const flowId = rows[0]!.id;
      const v = await this.insertVersion(tx, flowId, 1, def, hash, actor, generation);
      await audit(tx, { actorId: actor.id, action: 'flow.created', subjectType: 'flow', subjectId: flowId, outcome: 'ok' });
      return v;
    });
  }

  /**
   * Any change is a new version. Every earlier version is superseded at once,
   * so a change always cancels the Flow's approval until the new version is approved.
   */
  async update(flowId: string, definition: unknown, actor: Member, generation?: FlowGeneration): Promise<FlowVersion> {
    return withTx(this.db, async (tx) => {
      const flow = await tx.query<{ created_by: string; team_id: string; archived_at: Date | null }>(`SELECT created_by, team_id, archived_at FROM flows WHERE id = $1 FOR UPDATE`, [flowId]);
      if (!flow.rowCount) throw notFound('flow');
      if (flow.rows[0]!.archived_at) throw conflict('flow_archived');
      await assertTeamMember(tx, flow.rows[0]!.team_id, actor);
      // A change supersedes every version, so only the owner (or an admin) may make one.
      if (flow.rows[0]!.created_by !== actor.id && actor.role !== 'admin') throw forbidden();
      const { definition: def, hash } = await this.checkDefinition(tx, definition, actor, flow.rows[0]!.team_id);
      const { rows } = await tx.query<{ max: number }>(
        `SELECT COALESCE(MAX(version), 0) AS max FROM flow_versions WHERE flow_id = $1`,
        [flowId],
      );
      const superseded = await tx.query(
        `UPDATE flow_versions SET status = 'superseded' WHERE flow_id = $1 AND status IN ('pending', 'approved')`,
        [flowId],
      );
      const v = await this.insertVersion(tx, flowId, Number(rows[0]!.max) + 1, def, hash, actor, generation);
      if (superseded.rowCount) {
        await audit(tx, {
          actorId: actor.id,
          action: 'flow.approval_cancelled',
          subjectType: 'flow',
          subjectId: flowId,
          outcome: 'ok',
          relatedId: v.id,
        });
      }
      return v;
    });
  }

  /**
   * Dittoly's own proposal (self-fixing): a new pending version recorded as the owner's,
   * that leaves the approved version running until this one is approved.
   */
  /** The tables a version declares that its team does not have yet, or the columns they miss. */
  private async tablesToCreate(v: FlowVersion): Promise<{ name: string; purpose: string; exists: boolean; newColumns: string[] }[]> {
    const declared = v.definition.tables ?? [];
    if (!declared.length) return [];
    const teamId = await this.teamOfVersion(this.db, v.id);
    const { rows } = await this.db.query<{ name: string; key_column: string; columns: { name: string }[] }>(`SELECT name, key_column, columns FROM data_tables WHERE team_id = $1 AND name = ANY($2)`, [teamId, declared.map((t) => t.name)]);
    return declared
      .map((t) => {
        const has = rows.find((r) => r.name === t.name);
        const newColumns = [t.keyColumn, ...t.columns.map((c) => c.name)].filter((c) => !has || (c !== has.key_column && !has.columns.some((x) => x.name === c)));
        return { name: t.name, purpose: t.purpose, exists: Boolean(has), newColumns };
      })
      .filter((t) => !t.exists || t.newColumns.length);
  }

  async proposeFix(flowId: string, definition: unknown, fix: FlowFix): Promise<FlowVersion> {
    return withTx(this.db, async (tx) => {
      const flow = (await tx.query<{ created_by: string; team_id: string; archived_at: Date | null }>(`SELECT created_by, team_id, archived_at FROM flows WHERE id = $1 FOR UPDATE`, [flowId])).rows[0];
      if (!flow) throw notFound('flow');
      if (flow.archived_at) throw conflict('flow_archived');
      const pending = await tx.query(`SELECT 1 FROM flow_versions WHERE flow_id = $1 AND status = 'pending'`, [flowId]);
      if (pending.rowCount) throw conflict('flow_change_pending');
      const owner = (await tx.query<Member>(`SELECT id, handle, role FROM members WHERE id = $1`, [flow.created_by])).rows[0]!;
      const { definition: def, hash } = await this.checkDefinition(tx, definition, undefined, flow.team_id);
      const max = (await tx.query<{ max: number }>(`SELECT COALESCE(MAX(version), 0) AS max FROM flow_versions WHERE flow_id = $1`, [flowId])).rows[0]!.max;
      const v = await this.insertVersion(tx, flowId, Number(max) + 1, def, hash, owner, { instructions: null, fix });
      await audit(tx, { actorId: null, action: 'flow.fix_proposed', subjectType: 'flow_version', subjectId: v.id, outcome: 'ok' });
      await notify(tx, owner.id, 'flow_fix_proposed', { flowVersionId: v.id });
      return v;
    });
  }

  /**
   * A change merged in the connected git repository: a new pending version recorded as the owner's, that leaves the
   * approved version running until this one is approved (like a self-fix). Refused while another change waits.
   */
  async proposeFromGit(flowId: string, definition: unknown, git: { commit: string; path: string }): Promise<FlowVersion> {
    return withTx(this.db, async (tx) => {
      const flow = (await tx.query<{ created_by: string; team_id: string; archived_at: Date | null }>(`SELECT created_by, team_id, archived_at FROM flows WHERE id = $1 FOR UPDATE`, [flowId])).rows[0];
      if (!flow) throw notFound('flow');
      if (flow.archived_at) throw conflict('flow_archived');
      const pending = await tx.query(`SELECT 1 FROM flow_versions WHERE flow_id = $1 AND status = 'pending'`, [flowId]);
      if (pending.rowCount) throw conflict('flow_change_pending');
      const owner = (await tx.query<Member>(`SELECT id, handle, role FROM members WHERE id = $1`, [flow.created_by])).rows[0]!;
      const { definition: def, hash } = await this.checkDefinition(tx, definition, undefined, flow.team_id);
      const max = (await tx.query<{ max: number }>(`SELECT COALESCE(MAX(version), 0) AS max FROM flow_versions WHERE flow_id = $1`, [flowId])).rows[0]!.max;
      const v = await this.insertVersion(tx, flowId, Number(max) + 1, def, hash, owner, { instructions: null, git });
      await audit(tx, { actorId: null, action: 'flow.git_change_proposed', subjectType: 'flow_version', subjectId: v.id, outcome: 'ok' });
      return v;
    });
  }

  private async insertVersion(
    tx: Queryable,
    flowId: string,
    version: number,
    def: FlowDefinition,
    hash: string,
    actor: Member,
    generation?: FlowGeneration,
  ): Promise<FlowVersion> {
    const { rows } = await tx.query<Row>(
      `INSERT INTO flow_versions (flow_id, version, definition, approval_hash, status, created_by, generation)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING *`,
      [flowId, version, JSON.stringify(def), hash, actor.id, generation ? JSON.stringify(generation) : null],
    );
    const v = fromRow(rows[0]!);
    await audit(tx, { actorId: actor.id, action: 'flow.version_created', subjectType: 'flow_version', subjectId: v.id, outcome: 'ok' });
    // Its team's approvers (or their stand-ins) hear that it waits for them; never its author.
    const team = (await tx.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [flowId])).rows[0]!.team_id;
    await notifyApprovers(tx, team, actor.id, 'flow_approval_needed', { flowVersionId: v.id });
    return v;
  }

  async review(versionId: string) {
    const generation = (await this.db.query<{ generation: FlowGeneration | null }>(`SELECT generation FROM flow_versions WHERE id = $1`, [versionId])).rows[0]?.generation ?? null;
    const v = await this.getVersion(this.db, versionId);
    if (!v) throw notFound('flow_version');
    const modules = await this.pinnedModules(this.db, v.definition);
    const children = await this.pinnedFlows(this.db, v.definition);
    // A Flow made from a marketplace template: tell the approver whether it is unchanged.
    const origin = (
      await this.db.query<{ listing_id: string; template_definition: FlowDefinition }>(
        `SELECT l.id AS listing_id, tv.definition AS template_definition
         FROM flows f JOIN marketplace_listings l ON l.id = f.template_listing_id
         JOIN flow_versions tv ON tv.id = l.flow_version_id WHERE f.id = $1`,
        [v.flowId],
      )
    ).rows[0];
    const injection = await this.injectionView(v);
    return {
      fromTemplate: origin
        ? { listingId: origin.listing_id, identical: canonicalJson(origin.template_definition) === canonicalJson(v.definition) }
        : null,
      id: v.id,
      flowId: v.flowId,
      version: v.version,
      status: v.status,
      createdBy: v.createdBy,
      summary: flowSummary(v.definition, modules, children),
      /** The same thing as rows an approver can scan: what it may reach, change and use, and what it never can. */
      capabilities: flowCapabilities(v.definition, modules),
      modules: [...modules.values()].map((m) => ({ ref: moduleRef(m), status: m.status, codeSha256: m.codeSha256 })),
      /** The Flows this one runs (a Super Flow), as pinned. */
      flows: [...children.values()].map((c) => ({ flowId: c.flowId, name: c.name, version: c.version.version, versionId: c.version.id, status: c.version.status })),
      definition: v.definition,
      approvalHash: v.approvalHash,
      /** The model its organization AI steps run with: the one it is locked to, else the organization's now. */
      aiModel: orgAiSteps(v.definition).length ? (v.modelLocked && v.aiModel ? v.aiModel : this.aiModel()) : null,
      /** Locked by an approver to aiModel; else it follows the organization's model. */
      modelLocked: v.modelLocked,
      /** The model it was approved or last checked with. */
      approvedModel: orgAiSteps(v.definition).length ? v.aiModel : null,
      generation,
      /** FLOW.md: what it does and how, for people and the next builder (a Super Flow's covers every Flow it runs). */
      guide: await this.guide(this.db, v.id),
      /** Approvals this version needs (a policy can ask for several approvers) and who gave them. */
      approvals: await this.approvalsOf(v, modules),
      /** Model-written text that can reach a step that changes something, and what the approver accepted. */
      injection: injection,
      /** What the draft is worth, in the terms an approver reads: guards, memory, injection, examples. */
      quality: flowQuality(v.definition, modules, { unacceptedInjection: injection.guarded.length, ...(generation?.examples ? { examples: generation.examples } : {}) }),
      /** Sign-offs released by a fix step's verified evidence (autoApproveWhen); shown prominently. */
      evidenceGates: await this.evidenceGates(v),
      /** Data tables approving creates in the Flow's team (or adds columns to), for the approver to see. */
      tablesToCreate: await this.tablesToCreate(v),
    };
  }

  /**
   * Steps with an evidence gate (autoApproveWhen): the fix step whose verdict releases their sign-off,
   * its threshold, and other model-written sources that reach them (a person is asked in runs where one of them ran).
   */
  private async evidenceGates(v: FlowVersion) {
    const gated = v.definition.steps.filter((s) => s.type === 'action' && s.autoApproveWhen);
    if (!gated.length) return [];
    const { paths } = await this.injection(this.db, v.definition);
    return gated.map((s) => {
      const rule = (s as { autoApproveWhen: string }).autoApproveWhen;
      const fixStep = AUTO_APPROVE.exec(rule)?.[1] ?? null;
      const fix = v.definition.steps.find((x) => x.id === fixStep) as FixStep | undefined;
      return {
        step: s.id,
        rule,
        fixStep,
        autoPushAt: fix?.autoPushAt ?? null,
        // Only sources that would make the step wait on their own count: text carried into a destination this
        // version fixed never closed this gate, and must not start closing it now (src/flows/injection.ts).
        otherSources: [...new Set(paths.filter((p) => p.sink === s.id && p.source !== fixStep && needsSignOff(p.sourceKind, p.influence)).map((p) => p.source))],
      };
    });
  }

  private async injectionView(v: FlowVersion) {
    const { paths, sinks } = await this.injection(this.db, v.definition);
    const accepted = v.injectionAccepted;
    const handles = new Map(
      (await this.db.query<{ id: string; handle: string }>(`SELECT id, handle FROM members WHERE id = ANY($1)`, [accepted.map((a) => a.by)])).rows.map((r) => [r.id, r.handle]),
    );
    return {
      paths,
      sinks,
      accepted: accepted.map((a) => ({ sink: a.sink, reason: a.reason, by: handles.get(a.by) ?? null, at: a.at })),
      /** The steps that wait for a sign-off when this version runs. */
      guarded: v.status === 'pending' ? sinks.filter((s) => !accepted.some((a) => a.sink === s)) : await this.guardedSteps(this.db, v),
    };
  }

  private async approvalsOf(v: FlowVersion, modules: Map<string, ModuleVersion>) {
    const need = await requiredApprovals(this.db, v.definition, modules);
    const given = (
      await this.db.query<{ handle: string; approved_at: Date }>(
        `SELECT m.handle, a.approved_at FROM flow_version_approvals a JOIN members m ON m.id = a.approver_id WHERE a.version_id = $1 ORDER BY a.approved_at`,
        [v.id],
      )
    ).rows.map((r) => ({ handle: r.handle, at: r.approved_at }));
    return { required: need.count, because: need.because, given };
  }

  async getVersion(db: Queryable, id: string): Promise<FlowVersion | null> {
    const { rows } = await db.query<Row>(`SELECT * FROM flow_versions WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async versions(flowId: string): Promise<FlowVersion[]> {
    const { rows } = await this.db.query<Row>(`SELECT * FROM flow_versions WHERE flow_id = $1 ORDER BY version`, [flowId]);
    return rows.map(fromRow);
  }

  /**
   * Approve or reject a version. An approver may accept open prompt-injection paths (by the step
   * they reach, with a reason): those steps then run without waiting for a sign-off.
   */
  async decide(versionId: string, actor: Member, decision: 'approved' | 'rejected', opts: { accept?: { sink: string; reason: string }[]; acceptAppBreaks?: boolean } = {}): Promise<FlowVersion> {
    if (!canApprove(actor)) throw forbidden('approver_only');
    // Apps following this Flow switch to this version: the pages it breaks, checked before the transaction (it reads
    // apps and their Flows on its own connection; a version's definition never changes). Inside it, a single-connection
    // database (the local install) would wait on itself.
    let broken: { name: string; problems: string[] }[] = [];
    if (decision === 'approved' && this.appImpact) {
      const pre = await this.getVersion(this.db, versionId);
      if (pre) broken = (await this.appImpact(pre.flowId, pre.definition)).filter((a) => a.problems.length);
    }
    const decided = await withTx(this.db, async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT * FROM flow_versions WHERE id = $1 FOR UPDATE`, [versionId]);
      if (!rows[0]) throw notFound('flow_version');
      const v = fromRow(rows[0]);
      if (v.status !== 'pending') throw conflict('flow_version_not_pending');
      if (await isFlowArchived(tx, v.flowId)) throw conflict('flow_archived');
      if (this.mode === 'shared' && v.createdBy === actor.id) throw forbidden('cannot_approve_own_flow');
      if (this.mode === 'shared' && decision === 'approved') await assertNotRequester(tx, 'flow', versionId, actor);
      // With the team rule, only the Flow's team (or a stand-in for one of its approvers) decides; an org admin may step in.
      const team = (await tx.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [v.flowId])).rows[0]!.team_id;
      const by = await approvalAuthority(tx, actor, team, this.mode === 'shared' ? v.createdBy : '');
      if (decision === 'approved') {
        const modules = await this.pinnedModules(tx, v.definition);
        const unapproved = [...modules.values()].filter((m) => m.status !== 'approved');
        if (unapproved.length) throw conflict('modules_not_approved');
        const children = await this.pinnedFlows(tx, v.definition);
        if ([...children.values()].some((c) => c.version.status !== 'approved')) throw conflict('child_flows_not_approved');
        if (approvalHash(v.definition, [...modules.values()]) !== v.approvalHash) throw conflict('approval_hash_mismatch');
        await checkFlowApproval(tx, v.definition, modules);
        // Outside destinations of app and fix steps: inside the team's ceiling (src/core/egress-policy.ts).
        const ceiling = await egressCeiling(tx, await this.teamOfVersion(tx, versionId));
        const outside = v.definition.steps.flatMap((s) => (s.type === 'app' || s.type === 'fix' ? judgeEgress(s, ceiling).filter((d) => !d.allowed).map((d) => `${s.id} ${d.phase}: ${d.destination}`) : []));
        if (outside.length) throw new AppError('egress_outside_policy', 409, `not in the team's allowed destinations: ${outside.join(', ')}`);
        // Apps following this Flow switch to this version: the approver confirms the pages it breaks (checked above).
        if (broken.length && !opts.acceptAppBreaks) {
          throw new AppError('app_pages_would_break', 409, broken.map((a) => `${a.name}: ${a.problems.join('; ')}`).join(' | '));
        }
        if (broken.length) {
          await audit(tx, { actorId: actor.id, action: 'flow.app_breaks_accepted', subjectType: 'flow_version', subjectId: versionId, outcome: 'ok', relatedId: String(broken.length) });
        }
        const injection = await this.injection(tx, v.definition);
        if (opts.accept?.length) {
          const bad = opts.accept.filter((a) => !injection.sinks.includes(a.sink));
          if (bad.length) throw badRequest('invalid_acceptance', `no open path reaches ${bad.map((a) => a.sink).join(', ')}`);
          const at = new Date().toISOString();
          const merged = [...v.injectionAccepted.filter((a) => !opts.accept!.some((x) => x.sink === a.sink)), ...opts.accept.map((a) => ({ sink: a.sink, reason: a.reason, by: actor.id, at }))];
          await tx.query(`UPDATE flow_versions SET injection_accepted = $2 WHERE id = $1`, [versionId, JSON.stringify(merged)]);
          v.injectionAccepted = merged;
          for (const a of opts.accept) {
            await audit(tx, { actorId: actor.id, action: 'flow.injection_path_accepted', subjectType: 'flow_version', subjectId: `${versionId}:${a.sink}`, outcome: 'ok' });
          }
        }
        // The steps that wait for a sign-off when it runs: fixed with the approval.
        const accepted = new Set(v.injectionAccepted.map((a) => a.sink));
        await tx.query(`UPDATE flow_versions SET guarded_steps = $2 WHERE id = $1`, [versionId, injection.sinks.filter((s) => !accepted.has(s))]);
        // A policy can ask for several different approvers: each approval is recorded until there are enough.
        const need = await requiredApprovals(tx, v.definition, modules);
        if (need.count > 1) {
          const added = await tx.query(
            `INSERT INTO flow_version_approvals (version_id, approver_id, on_behalf_of, outside_team) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [versionId, actor.id, by.onBehalfOf, by.outsideTeam],
          );
          if (!added.rowCount) throw conflict('already_approved_by_you');
          const given = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM flow_version_approvals WHERE version_id = $1`, [versionId])).rows[0]!.n;
          if (given < need.count) {
            await audit(tx, { actorId: actor.id, action: 'flow.approval_recorded', subjectType: 'flow_version', subjectId: versionId, outcome: 'ok' });
            return v;
          }
        }
      }
      // The model it was tested and approved with, on record (its AI steps follow the organization's unless locked).
      const pin = decision === 'approved' && orgAiSteps(v.definition).length ? this.aiModel() : null;
      const updated = await tx.query<Row>(
        `UPDATE flow_versions SET status = $2, decided_by = $3, decided_at = now(), decided_for = $4, decided_outside_team = $5, ai_model = COALESCE($6, ai_model) WHERE id = $1 RETURNING *`,
        [versionId, decision, actor.id, by.onBehalfOf, by.outsideTeam, pin],
      );
      // One approved version per Flow: a proposed fix kept the old one running until now.
      if (decision === 'approved') {
        await tx.query(`UPDATE flow_versions SET status = 'superseded' WHERE flow_id = $1 AND id <> $2 AND status = 'approved'`, [v.flowId, versionId]);
        // The tables it declares are created in its team (or get the columns they miss): approving is the decision.
        if (v.definition.tables?.length) await createDeclaredTables(tx, await this.teamOfVersion(tx, versionId), v.definition.tables, actor.id);
        // Written to the team's (else the organization's) git repository, when one is connected (src/git-sync/service.ts).
        await enqueue(tx, 'git_export', { kind: 'flow', versionId });
      }
      // Plans waiting on this Flow move on (src/plans/service.ts).
      await enqueue(tx, 'flow_decided', { flowVersionId: versionId });
      await audit(tx, {
        actorId: actor.id,
        action: `flow.${decision}${by.onBehalfOf ? '_as_standin' : by.outsideTeam ? '_outside_team' : ''}`,
        subjectType: 'flow_version',
        subjectId: versionId,
        outcome: 'ok',
        relatedId: by.onBehalfOf ?? undefined,
      });
      return fromRow(updated.rows[0]!);
    });
    // A self-fix's change record notes the decision (src/governance/changes.ts).
    await noteChangeDecision(this.db, 'flow', versionId, actor, decision);
    return decided;
  }

  /**
   * The gate every run passes: the version must be approved and still current,
   * every pinned module approved, and the approval hash must still match.
   */
  async assertRunnable(db: Queryable, versionId: string, opts: { allowSuperseded?: boolean } = {}): Promise<{ version: FlowVersion; modules: Map<string, ModuleVersion> }> {
    const version = await this.getVersion(db, versionId);
    if (!version) throw notFound('flow_version');
    // allowSuperseded: an App's pinned version, run reads-only (src/team-apps/service.ts); never a rejected one.
    if (version.status !== 'approved' && !(opts.allowSuperseded && version.status === 'superseded')) throw conflict('flow_version_not_approved');
    // A deleted (archived) Flow or module never runs again, however the run is started.
    if (await isFlowArchived(db, version.flowId)) throw conflict('flow_archived');
    const modules = await this.pinnedModules(db, version.definition);
    if ([...modules.values()].some((m) => m.status !== 'approved')) throw conflict('modules_not_approved');
    const archived = await archivedModules(db);
    if ([...modules.values()].some((m) => archived.has(m.name))) throw conflict('module_archived');
    // A Super Flow stops when a Flow it runs is replaced or loses its approval, like a module.
    const children = await this.pinnedFlows(db, version.definition);
    if ([...children.values()].some((c) => c.version.status !== 'approved')) throw conflict('child_flow_not_approved');
    if (approvalHash(version.definition, [...modules.values()]) !== version.approvalHash) {
      throw conflict('approval_hash_mismatch');
    }
    return { version, modules };
  }

  /** The team a Flow version belongs to. */
  async teamOfVersion(db: Queryable, versionId: string): Promise<string> {
    const r = await db.query<{ team_id: string }>(`SELECT f.team_id FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE v.id = $1`, [versionId]);
    if (!r.rows[0]) throw notFound('flow_version');
    return r.rows[0].team_id;
  }

  /**
   * Who may look at a Flow: its team's members, and org admins and approvers
   * (approvers review every team's Flows).
   */
  async assertCanSee(db: Queryable, actor: Member, ref: { flowId?: string; versionId?: string }): Promise<void> {
    if (canApprove(actor)) return;
    const r = ref.flowId
      ? await db.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [ref.flowId])
      : await db.query<{ team_id: string }>(`SELECT f.team_id FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE v.id = $1`, [ref.versionId]);
    if (!r.rows[0]) throw notFound(ref.flowId ? 'flow' : 'flow_version');
    await assertTeamMember(db, r.rows[0].team_id, actor);
  }
}

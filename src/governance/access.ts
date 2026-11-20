import type { App } from '../app.js';
import { notFound } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { credentialModes, teamStoredServices } from '../core/team-credentials.js';
import { childRef, type ChildFlow } from '../flows/service.js';
import { optionalServicesFor, servicesFor } from '../modules/manifest.js';
import { listPolicies, describePolicy, requiredApprovals } from './policies.js';
import { egressCeiling, judgeEgress } from '../core/egress-policy.js';
import { APP_PHASES, FIX_PHASES, secretPhases, secretService, type AppStep, type FixStep, type StepPhase } from '../flows/definition.js';
import type { Destination } from '../runtime/destinations.js';

/** Whose access one credential of a step uses. */
export interface AccessUse {
  service: string;
  /** yours: your vault; team: the team's shared account; teammate: a delegate's own; optional: used only if stored. */
  whose: 'yours' | 'team' | 'teammate';
  optional: boolean;
  /** Stored right now (for "teammate": unknown until they accept). */
  ready: boolean | null;
  /** Last token scope check for your credential, if any. */
  scopes?: { status: string; excess: string[]; missing: string[] } | null;
  /** The secret env var an app or fix step passes this credential in (secretEnv). */
  envVar?: string;
}

export interface StepAccess {
  stepId: string;
  title: string;
  kind: string;
  /** What the step does, in a few words. */
  does: string;
  changesData: boolean;
  hosts: string[];
  access: AccessUse[];
  /** Whose AI a step uses ("the organization's", "yours (openai)"). */
  ai: string | null;
  /** In a dry run: runs for real (reads), or is skipped. */
  dryRun: 'runs' | 'skipped';
  /** App and fix steps: what each phase may reach and which secret env vars it gets. */
  network?: StepNetworkView;
}

export interface PhaseView {
  phase: StepPhase;
  reaches: { destination: string; source: 'git host' | 'package registries' | 'this step'; allowed: boolean }[];
  secrets: string[];
}

export interface StepNetworkView {
  /** How this server runs project code now: docker (the rules below hold), direct (full network), off. */
  mode: 'docker' | 'direct' | 'off';
  phases: PhaseView[];
  /** Destinations the team's ceiling does not allow: the step fails with egress_not_allowed until an admin allows them. */
  outsidePolicy: string[];
}

/** Each phase of an app or fix step: the git host and registries (not for a running app), its own destinations, its secrets. */
function networkView(step: AppStep | FixStep, mode: StepNetworkView['mode'], ceiling: Destination[]): StepNetworkView {
  const judged = judgeEgress(step, ceiling);
  const phases: StepPhase[] = ['install', ...(step.type === 'app' ? APP_PHASES : FIX_PHASES)];
  const base: PhaseView['reaches'] = [
    { destination: 'the repository\'s git host', source: 'git host', allowed: true },
    { destination: 'npm, Yarn, PyPI, RubyGems, Maven Central, Go proxy, GitHub downloads', source: 'package registries', allowed: true },
  ];
  return {
    mode,
    phases: phases.map((phase) => ({
      phase,
      reaches: [...(phase === 'run' ? [] : base), ...judged.filter((d) => d.phase === phase).map((d) => ({ destination: d.destination, source: 'this step' as const, allowed: d.allowed }))],
      secrets: phase === 'install' ? [] : Object.entries(step.secretEnv ?? {}).filter(([, v]) => secretPhases(step.type, v).includes(phase)).map(([name]) => name),
    })),
    outsidePolicy: judged.filter((d) => !d.allowed).map((d) => `${d.phase}: ${d.destination}`),
  };
}

/**
 * Before running: every step, what it changes, and exactly whose access it uses
 * (your own, the team's shared account, or a named teammate's by delegation), with
 * what is missing. Nothing runs and no secret is read beyond "is one stored".
 */
export async function accessPreview(app: App, versionId: string, member: Member) {
  const v = await app.flows.getVersion(app.db, versionId);
  if (!v) throw notFound('flow_version');
  const modules = await app.flows.pinnedModules(app.db, v.definition);
  const children = await app.flows.pinnedFlows(app.db, v.definition);
  const teamId = await app.flows.teamOfVersion(app.db, versionId);
  const mine = new Map(
    (await app.db.query<{ service: string; scope_check: { status: string; excess: string[]; missing: string[] } | null }>(`SELECT service, scope_check FROM credentials WHERE member_id = $1`, [member.id])).rows.map((r) => [
      r.service,
      r.scope_check,
    ]),
  );
  const teamStored = await teamStoredServices(app.db, teamId);
  const people = new Map((await app.db.query<{ id: string; handle: string }>(`SELECT id, handle FROM members`)).rows.map((r) => [r.id, r.handle]));
  const steps: StepAccess[] = [];
  const hasCode = v.definition.steps.some((s) => s.type === 'app' || s.type === 'fix');
  const ceiling = hasCode ? await egressCeiling(app.db, teamId) : [];
  const mode = hasCode ? await app.apps.modeFor() : 'off';
  for (const step of v.definition.steps) {
    const title = step.title ?? step.id;
    if (step.type === 'action') {
      const mv = modules.get(step.module)!;
      const action = mv.manifest.actions.find((a) => a.name === step.action)!;
      const modes = await credentialModes(app.db, teamId, mv.name);
      const required = servicesFor(mv.manifest, action.name);
      const optional = optionalServicesFor(mv.manifest, action.name);
      const access: AccessUse[] = [...required.map((s) => ({ s, optional: false })), ...optional.map((s) => ({ s, optional: true }))].map(({ s, optional: opt }) => {
        if (step.delegateTo) return { service: s, whose: 'teammate' as const, optional: opt, ready: null };
        if (modes.get(s) === 'team') return { service: s, whose: 'team' as const, optional: opt, ready: teamStored.has(s) };
        return { service: s, whose: 'yours' as const, optional: opt, ready: mine.has(s), scopes: mine.get(s) ?? null };
      });
      steps.push({
        stepId: step.id,
        title,
        kind: 'action',
        does: `${mv.manifest.title}: ${action.title}${step.forEach ? ' (once per item)' : ''}${step.delegateTo ? `, run by ${people.get(step.delegateTo) ?? 'a teammate'} with their own access` : ''}`,
        changesData: action.effect === 'write',
        hosts: mv.manifest.hosts,
        access,
        ai: null,
        dryRun: action.effect === 'write' || step.delegateTo ? 'skipped' : 'runs',
      });
    } else if (step.type === 'ai' || step.type === 'browse') {
      // Without the runner's key, the organization's AI answers instead (when one is set up).
      const ai = step.ai === 'runner' ? `yours (${step.provider ?? 'openai'} key)${app.ai ? ", else the organization's" : ''}` : "the organization's";
      const key = step.ai === 'runner' ? step.provider ?? 'openai' : null;
      steps.push({
        stepId: step.id,
        title,
        kind: step.type,
        does: step.type === 'ai' ? 'Asks an AI (its answer is data for later steps)' : 'An AI checks pages in a headless browser',
        changesData: false,
        hosts: step.type === 'browse' ? step.hosts : [],
        access: key ? [{ service: key, whose: 'yours', optional: !!app.ai, ready: mine.has(key) }] : [],
        ai,
        dryRun: 'runs',
      });
    } else if (step.type === 'flow') {
      const names = step.runs.map((r) => (children.get(childRef(r)) as ChildFlow | undefined)?.name ?? 'a Flow');
      steps.push({ stepId: step.id, title, kind: 'flow', does: `Runs ${names.join(', ')} as you (each shows its own access when you open it)`, changesData: false, hosts: [], access: [], ai: null, dryRun: 'runs' });
    } else if (step.type === 'app' || step.type === 'fix') {
      // Secret env vars: the team's stored credential for the service when there is one, else yours.
      const secretEnv: AccessUse[] = Object.entries(step.secretEnv).map(([envVar, v]) => {
        const service = secretService(v);
        return teamStored.has(service) ? { service, whose: 'team', optional: false, ready: true, envVar } : { service, whose: 'yours', optional: false, ready: mine.has(service), envVar };
      });
      steps.push({
        stepId: step.id,
        title,
        kind: step.type,
        does:
          step.type === 'app'
            ? `Builds and starts ${step.repo.replace(/[{}\s]/g, '')} (runs that code, isolated)`
            : `Fix and verify: the organization's AI changes a copy of ${step.repo.replace(/[{}\s]/g, '')} and Dittoly runs its tests (runs that code, isolated; pushes nothing)`,
        changesData: false,
        hosts: [],
        access: [...(step.credential ? [{ service: step.credential, whose: 'yours' as const, optional: false, ready: mine.has(step.credential) }] : []), ...secretEnv],
        ai: step.type === 'fix' ? "the organization's" : null,
        dryRun: 'skipped',
        network: networkView(step, mode, ceiling),
      });
    } else if (step.type === 'table') {
      const change = step.op === 'put' || step.op === 'delete' || step.op === 'increment';
      steps.push({
        stepId: step.id, title, kind: 'table',
        does: `${change ? 'Changes' : 'Reads'} the team's data table "${step.table}"`,
        changesData: change, hosts: [], access: [], ai: null, dryRun: change ? 'skipped' : 'runs',
      });
    } else {
      const does = { approval: 'Waits for an approver to sign off', input: 'Asks you to fill in a form', delay: 'Waits', report: 'Formats results (changes nothing)' }[step.type] ?? step.type;
      steps.push({ stepId: step.id, title, kind: step.type, does, changesData: false, hosts: [], access: [], ai: null, dryRun: step.type === 'approval' || step.type === 'delay' ? 'skipped' : 'runs' });
    }
  }
  const missing = steps.flatMap((s) => s.access.filter((a) => a.ready === false && !a.optional).map((a) => ({ step: s.title, service: a.service, whose: a.whose })));
  const policies = (await listPolicies(app.db, true)).filter((p) => p.kind === 'run_window' || p.kind === 'max_runs_per_day').map(describePolicy);
  return {
    versionId,
    steps,
    missing,
    changesData: steps.some((s) => s.changesData),
    yourServices: [...new Set(steps.flatMap((s) => s.access.filter((a) => a.whose === 'yours').map((a) => a.service)))],
    teamServices: [...new Set(steps.flatMap((s) => s.access.filter((a) => a.whose === 'team').map((a) => a.service)))],
    teammates: [...new Set(steps.filter((s) => s.access.some((a) => a.whose === 'teammate')).map((s) => s.title))],
    /** Rules that can stop a run from starting. */
    rules: policies,
    approvals: await requiredApprovals(app.db, v.definition, modules),
  };
}

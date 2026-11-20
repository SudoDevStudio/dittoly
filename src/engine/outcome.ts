import type { Queryable } from '../db/db.js';

/**
 * How a run ended (or where it stands), in one place: derived from its steps' persisted statuses and error
 * types only, the same way for every Flow. The deciding step is the one a person should look at: the step it
 * stopped or waits at, else the last step that ran. Steps skipped by their conditions are listed, never shown
 * as success; steps after a stop are listed as not run.
 */

export interface OutcomeStep {
  id: string;
  title: string | null;
  type?: string | undefined;
  status: string;
  errorType: string | null;
  /** Only when the viewer may see it (the run's owner or the step's executor). */
  output?: unknown;
}

export interface RunOutcome {
  state: 'running' | 'waiting' | 'succeeded' | 'stopped' | 'paused' | 'cancelled';
  tone: 'ok' | 'info' | 'warn' | 'bad';
  headline: string;
  /** Why, in plain language (a failure's reason, what a wait needs). */
  reason: string | null;
  /** The step to look at. */
  step: { id: string; title: string; status: string; errorType: string | null } | null;
  /** A link the deciding step (or the last step that ran) returned, e.g. a pull request. */
  link: { url: string; stepId: string } | null;
  /**
   * Where to go to get it going again, inside Dittoly: a waiting run is of no use if the page it waits on is a
   * search of its own. A path in the portal, never an outside address.
   */
  action: { label: string; href: string } | null;
  ran: number;
  /** Skipped by their conditions (the run decided not to do them). */
  skipped: string[];
  /** Never reached: after the step it stopped or waits at. */
  notRun: string[];
}

/** Plain-language reasons for common error types (the run page has more for single steps). */
const REASONS: Record<string, string> = {
  missing_credential: 'a credential it needs is not stored',
  team_credential_missing: "the team's shared credential is not stored",
  uncertain_outcome: 'a change may or may not have reached the app before the step failed: check the app before retrying',
  approval_rejected: 'an approver rejected a step',
  sign_off_rejected: 'an approver rejected a step after checking what the AI wrote',
  delegation_rejected: 'the teammate asked to run a step declined',
  delegation_expired: 'the teammate asked to run a step did not answer in time',
  pinned_version_retired: 'the App runs a pinned Flow version a newer one replaced, so its steps that change data no longer run: move the App\'s pin',
  flow_version_not_approved: 'the Flow version it runs lost its approval',
  egress_not_allowed: "a step declares an outside service its team's allowed destinations no longer include",
  install_failed: 'installing the project failed',
  build_failed: 'building the project failed',
  clone_failed: 'the repository could not be cloned',
  clone_branch_not_found: 'the branch to clone does not exist in the repository',
  clone_repo_not_found: 'the repository does not exist, or the token cannot see it',
  clone_repo_not_found_no_token: 'the repository is private or does not exist, and the step has no token',
  clone_access_denied: 'the git host refused the token',
  clone_unreachable: 'the git host could not be reached',
  app_needs_docker: 'building code needs a container engine (Docker or Podman) on this server',
  app_needs_docker_or_direct: 'building code needs Docker or Podman, or an admin allowing it to run directly',
  action_timeout: 'an action did not finish in time',
  network_error: 'an app could not be reached',
  worker_crashed: 'the worker running it stopped',
  output_schema_mismatch: 'an app answered in an unexpected shape',
  template_error: 'a step referred to data an earlier step did not produce',
  ai_budget_exhausted: "the team's AI budget is used up",
  run_cancelled: 'it was cancelled',
  skipped_by_person: 'a person skipped it after it failed',
};

const WAITS: Record<string, string> = {
  approval: 'an approver to sign off',
  input_needed: 'someone to fill in a form',
  delay: 'its delay to pass',
  delegation: 'a teammate to run a step with their own account',
  child_flows: 'the Flows it started to finish',
  cost_cap: 'someone to allow more AI spend (it reached its cost cap)',
  auto_stop: 'an automatic stop of its Flow to be resumed',
  step_resolution: 'an approver to agree to skip a failed step that changes data, or to continue with a result typed in',
  sandbox_busy: 'a free code sandbox: the most app and fix steps that build and test at once are running',
};

export function reasonFor(errorType: string | null): string | null {
  if (!errorType) return null;
  if (REASONS[errorType]) return REASONS[errorType]!;
  const http = /^(?:[a-z]+_)?(\d{3})$/.exec(errorType);
  if (http) return `an app answered HTTP ${http[1]}`;
  return `it failed with ${errorType.replace(/_/g, ' ')}`;
}

const LINK_KEY = /^(url|html_url|web_url|[a-z][A-Za-z]*Url)$/;

/** The first http(s) link at the top level of an output. */
function linkIn(output: unknown): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
    if (LINK_KEY.test(k) && typeof v === 'string' && /^https?:\/\/\S+$/.test(v) && v.length <= 2000) return v;
  }
  return null;
}

const name = (s: OutcomeStep) => s.title ?? s.id;

/** What a waiting run needs from a person, when the caller knows it: the automatic stop that paused it. */
export interface OutcomeContext {
  autoStop?: { id: string; triggerName: string; summary: string } | null;
}

export function runOutcome(run: { status: string; waitReason: string | null; dry?: boolean }, steps: OutcomeStep[], ctx: OutcomeContext = {}): RunOutcome {
  const ran = steps.filter((s) => s.status === 'succeeded');
  const skipped = steps.filter((s) => s.status === 'skipped' && s.errorType !== 'skipped_by_person').map(name);
  // Failed steps a person chose to skip are said apart: the run did not decide that, someone did.
  const skippedByPerson = steps.filter((s) => s.status === 'skipped' && s.errorType === 'skipped_by_person').map(name);
  const base = { ran: ran.length, skipped, action: null as RunOutcome['action'] };
  const view = (s: OutcomeStep | undefined) => (s ? { id: s.id, title: name(s), status: s.status, errorType: s.errorType } : null);
  const after = (s: OutcomeStep | undefined) => (s ? steps.slice(steps.indexOf(s) + 1).filter((x) => x.status === 'pending').map(name) : []);
  const linkFrom = (first: OutcomeStep | undefined) => {
    for (const s of [first, ...[...ran].reverse()]) {
      const url = s ? linkIn(s.output) : null;
      if (url) return { url, stepId: s!.id };
    }
    return null;
  };
  const dry = run.dry ? ' (dry run)' : '';

  if (run.status === 'succeeded') {
    const last = ran.at(-1);
    return {
      state: 'succeeded',
      // A run that skipped steps did not do everything it could: neutral, not a success badge.
      tone: skipped.length || skippedByPerson.length ? 'info' : 'ok',
      headline: last ? `Finished${dry} after ${name(last)}` : `Finished${dry} without running a step`,
      reason:
        [
          skipped.length ? `${skipped.length} step${skipped.length === 1 ? ' was' : 's were'} skipped by ${skipped.length === 1 ? 'its condition' : 'their conditions'}.` : '',
          skippedByPerson.length ? `Skipped by a person after failing: ${skippedByPerson.join(', ')}.` : '',
        ].filter(Boolean).join(' ') || null,
      step: view(last),
      link: linkFrom(last),
      notRun: [],
      ...base,
    };
  }
  if (run.status === 'failed' || run.status === 'paused') {
    const failed = steps.find((s) => s.status === 'failed');
    const why = reasonFor(failed?.errorType ?? null);
    return {
      state: run.status === 'paused' ? 'paused' : 'stopped',
      tone: 'bad',
      headline: failed ? `${run.status === 'paused' ? 'Paused' : 'Stopped'} at ${name(failed)}` : run.status === 'paused' ? 'Paused' : 'Stopped',
      reason: why ? `${why[0]!.toUpperCase()}${why.slice(1)}.${run.status === 'paused' ? ' It can be retried.' : ''}` : null,
      step: view(failed),
      link: linkFrom(undefined),
      notRun: after(failed),
      ...base,
    };
  }
  if (run.status === 'waiting') {
    const at = steps.find((s) => s.status === 'waiting') ?? steps.find((s) => s.status === 'running');
    const stop = run.waitReason === 'auto_stop' ? ctx.autoStop : null;
    // "An automatic stop to be resumed" is true and useless on its own: say which rule stopped it, on what, and
    // link straight to the page where someone resumes it.
    const what = stop
      ? `its Flow to be resumed: ${stop.triggerName.toLowerCase()} — ${stop.summary}`
      : (WAITS[run.waitReason ?? ''] ?? 'something before it can go on');
    const action: RunOutcome['action'] = stop
      ? { label: 'Resume the Flow (Automatic stops)', href: `/auto-stops#stop-${stop.id}` }
      : run.waitReason === 'cost_cap'
        ? { label: 'Allow more AI spend', href: '#what-to-do' }
        : run.waitReason === 'approval' || run.waitReason === 'step_resolution'
          ? { label: 'The step waiting for a decision', href: at ? `#step-${at.id}` : '#what-to-do' }
          : null;
    return { state: 'waiting', tone: 'warn', headline: at ? `Waiting at ${name(at)}` : 'Waiting', reason: `It waits for ${what}.`, step: view(at), link: linkFrom(undefined), notRun: after(at), ...base, action };
  }
  if (run.status === 'cancelled') {
    const at = steps.find((s) => s.status === 'cancelled' || s.status === 'running' || s.status === 'waiting');
    return { state: 'cancelled', tone: 'warn', headline: at ? `Cancelled at ${name(at)}` : 'Cancelled', reason: null, step: view(at), link: linkFrom(undefined), notRun: steps.filter((s) => s.status === 'pending').map(name), ...base };
  }
  const at = steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'pending');
  return { state: 'running', tone: 'info', headline: at ? `Running ${name(at)}` : 'Running', reason: null, step: view(at), link: null, notRun: [], ...base };
}

/**
 * The outcome for a notification sent outside Dittoly (email, Slack, Teams): no step names, outputs or links,
 * only the kind of ending (messages carry no Flow content or run data).
 */
export async function outcomeSentence(db: Queryable, runId: string): Promise<string | null> {
  return (await outcomeSentences(db, [runId])).get(runId) ?? null;
}

export async function outcomeSentences(db: Queryable, runIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!runIds.length) return out;
  const runs = (await db.query<{ id: string; status: string; wait_reason: string | null }>(`SELECT id, status, wait_reason FROM runs WHERE id = ANY($1::uuid[])`, [runIds])).rows;
  const steps = (await db.query<{ run_id: string; step_id: string; status: string; error_type: string | null }>(
    `SELECT run_id, step_id, status, error_type FROM run_steps WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, idx`,
    [runIds],
  )).rows;
  for (const r of runs) {
    const o = runOutcome(
      { status: r.status, waitReason: r.wait_reason },
      steps.filter((s) => s.run_id === r.id).map((s) => ({ id: s.step_id, title: null, status: s.status, errorType: s.error_type })),
    );
    const sentence =
      o.state === 'succeeded'
        ? `It finished: ${o.ran} step${o.ran === 1 ? '' : 's'} ran${o.skipped.length ? `, ${o.skipped.length} skipped by their conditions` : ''}.`
        : o.state === 'stopped' || o.state === 'paused'
          ? `It ${o.state === 'paused' ? 'paused' : 'stopped'}${o.step?.errorType ? `: ${reasonFor(o.step.errorType)}` : ''}.`
          : o.state === 'waiting'
            ? o.reason ?? ''
            : o.state === 'cancelled'
              ? 'It was cancelled.'
              : '';
    if (sentence) out.set(r.id, sentence);
  }
  return out;
}

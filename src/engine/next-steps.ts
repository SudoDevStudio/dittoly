/**
 * What to do about a paused run: the step it stopped at, why in plain words, and the exact fixes, with where to make
 * each (a credential by name, a module setting, a team table) and whether retrying alone can help. Built from the
 * step's persisted error type and what is missing right now (so a fix made meanwhile no longer shows), never from
 * the error's raw details. The portal, the MCP server and the API show the same text.
 */

export interface Fix {
  /**
   * `link`: go there and do it, then retry. `retry`: try the step again. `restart`: start the Flow again.
   * `skip` / `result`: get past the step without it (later steps read null) or with a result typed in.
   * `continue`: go on with the newest approved version of the Flow (or start again there, when it does not fit).
   * `ai_fix`: have the AI draft a fixed version of the step's module from this failure (reviewed like any version).
   */
  kind: 'link' | 'retry' | 'restart' | 'skip' | 'result' | 'continue' | 'ai_fix';
  label: string;
  href?: string;
  detail?: string;
  /** For `ai_fix`: the module version to revise, and what to tell the AI. */
  moduleVersionId?: string;
  feedback?: string;
}

export interface NextSteps {
  stepId: string;
  stepTitle: string;
  errorType: string;
  /** One line: what happened. */
  what: string;
  /** Why, and whether retrying alone can help. */
  why: string;
  fixes: Fix[];
  /** What the step called before it failed, and how each call answered. */
  calls?: string[];
  /** What a failed fix or app step printed (install, build, tests), secrets redacted. */
  log?: string;
  /** What the check that refused the step said, field by field. */
  detail?: string;
  /** For typing in its result: a draft in the shape later steps expect, and its fields. */
  result?: { example: unknown; fields: string[] };
}

export interface BlockerContext {
  stepId: string;
  stepTitle: string;
  errorType: string;
  /** The step's module (action steps): its name and the version's id for its page. */
  module?: { name: string; versionId: string | null } | null;
  /** Personal credentials the step uses (stored or not). */
  services: string[];
  /** Personal credentials the step needs that the run's member has not stored, now. */
  missingPersonal: string[];
  /** Team credentials the step needs that its team has not stored, now. */
  missingTeam: string[];
  /** Settings the Flow does not give the module (or whose value the run could not resolve). */
  missingSettings: string[];
  /** The team table a table step uses (for table_not_found). */
  tables: string[];
  flowVersionId: string;
  /** Manual retries left; null when the viewer may not retry (not the run's member). */
  retriesLeft: number | null;
  /** A newer approved version of the Flow (null when none, or the viewer is not the run's member); fits: the run can go on there. */
  newer?: { version: number; fits: boolean } | null;
  /** Getting past the step: null when the viewer may not (not the run's member); changesData: an approver must agree. */
  pastIt: { changesData: boolean; usedBy: string[] } | null;
  /** What the step called before it failed (the run's member and approvers). */
  calls?: string[];
  /** What a fix or app step printed before it failed (the run's member and approvers). */
  log?: string;
  /** What the check that refused the step said (the run's member and approvers). */
  detail?: string;
  /** The step's action and a draft of its result in the shape its module declares. */
  action?: string;
  result?: { example: unknown; fields: string[] };
  /** The viewer may have the AI revise the module (its author or an admin). */
  canFixModule?: boolean;
}

const MANIFEST_BREACH = /^(egress_denied_|effect_read_cannot_|credential_denied|db_query_denied|amqp_exchange_denied|mqtt_topic_denied)/;
const TRANSIENT = new Set(['network_error', 'action_timeout', 'worker_crashed', 'runner_unreachable', 'sandbox_start_failed', 'sandbox_exited', 'db_unreachable', 'db_timeout', 'browser_unavailable', 'app_unavailable', 'job_exhausted']);

/** Errors a new module version cannot fix: something is missing, was refused by policy, or was a person's decision. */
const NOT_THE_MODULE = /^(missing_credential|credential_missing|team_credential_missing|module_settings_missing|table_not_found|approval_rejected|sign_off_rejected|ai_|cost_cap|auto_stop|uncertain_outcome|network_error|action_timeout|upstream_timeout|worker_crashed|runner_unreachable|sandbox_)/;

export function nextSteps(c: BlockerContext): NextSteps {
  const n = explain(c);
  if (c.calls?.length) n.calls = c.calls;
  if (c.log) n.log = c.log;
  if (c.detail) n.detail = c.detail;
  if (c.pastIt && c.result) n.result = c.result;
  if (c.canFixModule && c.module?.versionId && !NOT_THE_MODULE.test(c.errorType)) {
    const calls = c.calls?.length ? ` What it called before it failed: ${c.calls.join('; ')}.` : '';
    n.fixes.push({
      kind: 'ai_fix',
      label: `Have the AI fix ${c.module.name}`,
      detail: 'Drafts a new version of the module from this failure. Once an admin approves it, this Flow gets a new version that uses it; when that is approved, continue this run on it.',
      moduleVersionId: c.module.versionId,
      feedback: `In a run, the action "${c.action ?? 'of this step'}" failed with "${c.errorType.replace(/_/g, ' ')}".${calls} Find the cause in the app's current documentation and fix the action so it does not fail this way. When the app refuses a request, fail with an error type that says why (for example its status), not a general one. Keep every action, its inputs and outputs.`,
    });
  }
  if (c.newer) {
    // A fix (a corrected module, a changed Flow) arrives as a new approved version: the most likely way on, so first.
    n.fixes.unshift(
      c.newer.fits
        ? { kind: 'continue', label: `Continue on version ${c.newer.version}`, detail: 'A newer approved version of this Flow: the steps that already ran keep their results.' }
        : { kind: 'continue', label: `Start again on version ${c.newer.version} with the same inputs`, detail: 'Its steps changed too much to go on from here; this run stays as it is.' },
    );
  }
  if (c.pastIt) {
    // Always a way on without a retry: skip it, or type in what it would have returned. Changing steps need an approver.
    const ask = c.pastIt.changesData ? 'Ask an approver to ' : '';
    const used = c.pastIt.usedBy.length ? `Later steps use its result: ${c.pastIt.usedBy.join(', ')}.` : 'No later step uses its result.';
    n.fixes.push(
      { kind: 'result', label: c.pastIt.changesData ? 'Ask an approver to continue with a result you type in' : 'Type in its result and continue', detail: c.pastIt.changesData ? 'This step changes data, so an approver agrees first.' : undefined },
      { kind: 'skip', label: `${ask}${ask ? 's' : 'S'}kip this step`, detail: `${used}${c.pastIt.changesData ? ' This step changes data, so an approver agrees first.' : ''}` },
    );
  }
  return n;
}

/** A fix or app step's clone failed, by what git said (src/engine/apps.ts cloneFailure). */
const CLONE: Record<string, [string, string]> = {
  clone_branch_not_found: ['The branch to clone does not exist.', 'The repository has no branch (or commit) by the name the step\'s "ref" gives. Check it in the Flow (main or master?), then retry.'],
  clone_repo_not_found: ['The repository was not found.', 'Either its URL in the step is wrong, or your token cannot read it: GitHub and GitLab answer "not found" for a private repository a token may not see. Check the URL, and that your token can read that repository (GitHub: the repo scope, or the repository chosen for a fine-grained token).'],
  clone_repo_not_found_no_token: ['The repository was not found.', 'The step clones without a token, so it can only reach a public repository. Check the URL, or give the step a credential.'],
  clone_access_denied: ['The git host refused your token.', 'It may have expired, been revoked, or lack read access to this repository. Replace it under My credentials, then retry.'],
  clone_unreachable: ['The git host could not be reached.', 'This server could not connect to the repository\'s host. Check the URL and the server\'s network, then retry.'],
};

function explain(c: BlockerContext): NextSteps {
  const base = { stepId: c.stepId, stepTitle: c.stepTitle, errorType: c.errorType };
  const mod = c.module?.name ?? 'its module';
  const modHref = c.module?.versionId ? `/modules/${c.module.versionId}` : '/modules';
  const fixes: Fix[] = [];
  const retry = (label = 'Retry the step') => {
    if (c.retriesLeft === null) return;
    if (c.retriesLeft > 0) fixes.push({ kind: 'retry', label, detail: `${c.retriesLeft} manual ${c.retriesLeft === 1 ? 'retry' : 'retries'} left` });
    else fixes.push({ kind: 'restart', label: 'Start the Flow again', href: `/run/${c.flowVersionId}`, detail: 'This run has used all its manual retries.' });
  };
  const out = (what: string, why: string) => ({ ...base, what, why, fixes });
  const e = c.errorType;
  const http = /^(?:[a-z]+_)?(\d{3})$/.exec(e)?.[1];

  if (e === 'missing_credential' || e === 'credential_missing') {
    for (const s of c.missingPersonal) fixes.push({ kind: 'link', label: `Add your "${s}" credential`, href: `/credentials?add=${encodeURIComponent(s)}` });
    if (!c.missingPersonal.length) fixes.push({ kind: 'link', label: 'Check your credentials', href: '/credentials' });
    retry('Retry after adding it');
    return out(
      'A credential this step needs is not stored.',
      c.missingPersonal.length
        ? `The step uses your own access to ${c.missingPersonal.map((s) => `"${s}"`).join(', ')}. Add it under My credentials, then retry; or ask a teammate who has it to run this step for you.`
        : 'It seems stored now: retry the step.',
    );
  }
  if (CLONE[e]) {
    const [what, why] = CLONE[e];
    if (e === 'clone_repo_not_found' || e === 'clone_access_denied') fixes.push({ kind: 'link', label: 'Check your git credential', href: '/credentials' });
    retry('Retry after fixing it');
    return out(what, why);
  }
  if (e === 'team_credential_missing') {
    fixes.push({ kind: 'link', label: "Store the team's credential", href: '/teams', detail: c.missingTeam.length ? c.missingTeam.join(', ') : undefined });
    retry('Retry after it is stored');
    return out(
      "The team's shared credential is not stored.",
      `This step uses the team's shared access${c.missingTeam.length ? ` to ${c.missingTeam.map((s) => `"${s}"`).join(', ')}` : ''}. A team admin stores it on the Teams page; then retry.`,
    );
  }
  if (e === 'module_settings_missing') {
    fixes.push({ kind: 'link', label: `Fill in the settings of ${mod}`, href: modHref, detail: c.missingSettings.join(', ') || undefined });
    retry('Retry after setting them');
    return out(
      `${mod} is missing settings for this team.`,
      `It needs ${c.missingSettings.length ? c.missingSettings.map((s) => `"${s}"`).join(', ') : 'a setting'} (for example which site to use). The Flow gives it: add it to the Flow's "moduleSettings" in a new version, or ask for it on the run form; then retry.`,
    );
  }
  if (e === 'table_not_found') {
    fixes.push({ kind: 'link', label: c.tables.length === 1 ? `Create the team table "${c.tables[0]}"` : 'Create the team table', href: '/teams', detail: c.tables.length > 1 ? c.tables.join(', ') : undefined });
    retry('Retry after creating it');
    return out(
      'A team data table this step uses does not exist in this team.',
      `This Flow keeps its data in ${c.tables.length ? c.tables.map((t) => `"${t}"`).join(', ') : 'a team table'}, which was deleted since the Flow was approved. A team admin creates it again on the Teams page (Data tables), with the same name; then retry.`,
    );
  }
  if (e.startsWith('ai_key_missing')) {
    const p = e === 'ai_key_missing_openai' ? 'openai' : 'anthropic';
    fixes.push({ kind: 'link', label: `Add your "${p}" key`, href: `/credentials?add=${p}` });
    retry('Retry after adding it');
    return out('This AI step has no AI key to use.', `Add a personal credential named "${p}" (the name must match), or ask an admin to set up the organization's AI; then retry.`);
  }
  if (e === 'organization_ai_not_configured') {
    fixes.push({ kind: 'link', label: "Set up the organization's AI", href: '/admin', detail: 'Admins only' });
    retry();
    return out("The organization's AI is not set up.", 'An admin chooses the AI provider on the Admin page; then retry.');
  }
  if (e === 'credential_rejected' || e === 'credential_invalid' || e === 'db_login_failed' || http === '401') {
    fixes.push({ kind: 'link', label: 'Replace the stored credential', href: c.services[0] ? `/credentials?add=${encodeURIComponent(c.services[0])}` : '/credentials' });
    retry('Retry after replacing it');
    return out('The app did not accept the stored credential.', 'It may have expired or been revoked. Store a new one, then retry. Retrying alone will fail the same way.');
  }
  if (http === '403') {
    retry();
    return out('The app refused: the account has no permission for this.', 'Ask for access in the app itself (or use an account that has it), then retry. Retrying alone will fail the same way.');
  }
  if (MANIFEST_BREACH.test(e)) {
    fixes.push({ kind: 'link', label: `Open ${mod}`, href: modHref, detail: 'A corrected version needs an admin\'s approval' });
    return out(
      `${mod} tried something its approved manifest does not allow, and Dittoly stopped it.`,
      'Nothing was sent. The module needs a corrected version (an admin reviews and approves it); retrying the same version will be stopped again.',
    );
  }
  if (e === 'egress_not_allowed') {
    fixes.push({ kind: 'link', label: "Review the team's allowed destinations", href: '/teams', detail: 'Admins only' });
    retry();
    return out("This step uses an outside service its team's allowed destinations no longer include.", 'An admin can allow it again (Teams or Admin page), or the Flow can drop it; then retry.');
  }
  if (e === 'uncertain_outcome') {
    retry('I checked the app: retry the step');
    return out(
      'This step may or may not have changed data before the connection broke.',
      'Open the app and check whether the change is there. If it is not, retry. If it is, do not retry (it would do it twice): cancel the run, or start the Flow again from a later point.',
    );
  }
  if (e === 'input_invalid' || e === 'template_unresolved' || e === 'input_resolution_failed') {
    fixes.push({ kind: 'restart', label: 'Start the Flow again with other inputs', href: `/run/${c.flowVersionId}` });
    retry();
    return out(
      e === 'input_invalid' ? 'The values this step got do not fit what the action accepts.' : 'This step refers to data an earlier step did not produce.',
      'Usually a run input or an earlier step\'s result was empty or in another shape. Start again with corrected inputs; if it keeps happening, the Flow needs a change.',
    );
  }
  if (e === 'output_schema_mismatch') {
    fixes.push({ kind: 'link', label: `Open ${mod}`, href: modHref });
    retry();
    return out('The app answered in a shape the module did not expect.', 'The app may have changed. Retry once; if it fails again, the module needs a corrected version.');
  }
  if (TRANSIENT.has(e) || (http && Number(http) >= 500) || http === '429') {
    retry();
    return out(
      http === '429' ? 'The app asked to slow down (too many requests).' : http ? `The app had a problem (HTTP ${http}).` : 'The app or the worker could not be reached in time.',
      'This is usually temporary: retry in a moment.',
    );
  }
  if (http === '404') {
    fixes.push({ kind: 'restart', label: 'Start the Flow again with other inputs', href: `/run/${c.flowVersionId}` });
    retry();
    return out('The app could not find what this step asked for (HTTP 404).', 'Check the inputs (a wrong id, project or channel name), then start again; retrying with the same values will fail the same way.');
  }
  if (http) {
    retry();
    return out(`The app refused the request (HTTP ${http}).`, 'Check the values this step sent (its input below). Retrying with the same values may fail the same way.');
  }
  retry();
  if (c.module) fixes.push({ kind: 'link', label: `Open ${mod}`, href: modHref });
  return out(`The step stopped with "${e.replace(/_/g, ' ')}".`, 'Retry the step; if it fails the same way again, open the module or the Flow to see what changed.');
}

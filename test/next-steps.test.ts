import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSteps, type BlockerContext } from '../src/engine/next-steps.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, runStatus, type World } from './helpers.js';

/** A paused run never ends in a bare error code: it says what happened, why, and each way to get it going. */

const ctx = (errorType: string, extra: Partial<BlockerContext> = {}): BlockerContext => ({
  stepId: 's',
  stepTitle: 'Post the summary',
  errorType,
  module: { name: 'slack', versionId: 'mv1' },
  services: ['slack'],
  missingPersonal: [],
  missingTeam: [],
  missingSettings: [],
  tables: [],
  flowVersionId: 'fv1',
  retriesLeft: 2,
  pastIt: null,
  ...extra,
});
const kinds = (n: ReturnType<typeof nextSteps>) => n.fixes.map((f) => [f.kind, f.label, f.href]);

describe('nextSteps', () => {
  it('a missing credential links to adding exactly that one, then retry', () => {
    const n = nextSteps(ctx('missing_credential', { missingPersonal: ['slack'] }));
    expect(n.what).toBe('A credential this step needs is not stored.');
    expect(n.why).toContain('"slack"');
    expect(kinds(n)).toEqual([['link', 'Add your "slack" credential', '/credentials?add=slack'], ['retry', 'Retry after adding it', undefined]]);
  });

  it('setup that lives elsewhere names it and where: team credential, module settings, team table', () => {
    expect(nextSteps(ctx('team_credential_missing', { missingTeam: ['jira'] })).fixes[0]).toMatchObject({ href: '/teams', detail: 'jira' });
    expect(nextSteps(ctx('module_settings_missing', { missingSettings: ['Jira site'] })).fixes[0]).toMatchObject({ label: 'Fill in the settings of slack', href: '/modules/mv1', detail: 'Jira site' });
    const t = nextSteps(ctx('table_not_found', { tables: ['Posted videos'] }));
    expect(t.fixes[0]).toMatchObject({ label: 'Create the team table "Posted videos"', href: '/teams' });
    expect(t.why).toContain('This Flow keeps its data in "Posted videos"');
  });

  it('a manifest breach offers no retry: the same version would be stopped again', () => {
    const n = nextSteps(ctx('egress_denied_host'));
    expect(n.fixes.map((f) => f.kind)).toEqual(['link']);
    expect(n.why).toContain('Nothing was sent');
  });

  it('an app refusing says whether retrying alone can help', () => {
    expect(nextSteps(ctx('http_503')).why).toBe('This is usually temporary: retry in a moment.');
    expect(nextSteps(ctx('http_401')).fixes[0]).toMatchObject({ label: 'Replace the stored credential', href: '/credentials?add=slack' });
    expect(nextSteps(ctx('http_404')).fixes[0]).toMatchObject({ kind: 'restart', href: '/run/fv1' });
    expect(nextSteps(ctx('uncertain_outcome')).why).toContain('do not retry (it would do it twice)');
  });

  it('without retries left it offers starting again; a viewer who may not retry gets no retry', () => {
    expect(nextSteps(ctx('http_503', { retriesLeft: 0 })).fixes).toEqual([{ kind: 'restart', label: 'Start the Flow again', href: '/run/fv1', detail: 'This run has used all its manual retries.' }]);
    expect(nextSteps(ctx('http_503', { retriesLeft: null })).fixes).toEqual([]);
  });

  it('an unknown error still says something and offers a way on', () => {
    const n = nextSteps(ctx('something_new'));
    expect(n.what).toBe('The step stopped with "something new".');
    expect(n.fixes.map((f) => f.kind)).toEqual(['retry', 'link']);
  });
});

let w: World;
let versionId: string;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  versionId = (await approvedReleaseFlow(w)).id;
});
afterAll(async () => {
  await w.db.end();
});

describe('a paused run in the run view', () => {
  it('names the credentials missing now, and drops them once stored', async () => {
    const runId = await w.app.engine.startRun(versionId, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.status).toBe('paused');
    expect(r.nextSteps).toMatchObject({ stepId: r.steps[0]!.id, errorType: 'missing_credential', what: 'A credential this step needs is not stored.' });
    const adds = r.nextSteps!.fixes.filter((f) => f.href?.startsWith('/credentials?add='));
    expect(adds.length).toBeGreaterThan(0);
    expect(r.nextSteps!.fixes.find((f) => f.kind === 'retry')).toMatchObject({ detail: expect.stringMatching(/manual retries? left/) });
    // And always a way on without a retry: the first step only reads, so its member decides.
    expect(r.nextSteps!.fixes.filter((f) => f.kind === 'skip' || f.kind === 'result').map((f) => f.label)).toEqual(['Type in its result and continue', 'Skip this step']);

    await giveAllCredentials(w, w.alice);
    const after = await runStatus(w, runId, w.alice);
    expect(after.nextSteps!.fixes.some((f) => f.href?.startsWith('/credentials?add='))).toBe(false);
    expect(after.nextSteps!.why).toBe('It seems stored now: retry the step.');
  });

  it('an approver sees why it stopped but gets no retry (only the run\'s member retries)', async () => {
    const runId = await w.app.engine.startRun(versionId, w.bob.id, releaseInputs);
    await w.app.worker.drain();
    const asApprover = await runStatus(w, runId, w.approver);
    expect(asApprover.nextSteps!.what).toBe('A credential this step needs is not stored.');
    expect(asApprover.nextSteps!.fixes.some((f) => f.kind === 'retry')).toBe(false);
  });
});

describe('fixing the module from a failure', () => {
  it('is offered to who may revise the module, with the failure and its calls as the request', () => {
    const n = nextSteps(ctx('search_rejected', { canFixModule: true, action: 'search_pull_requests', calls: ['GET api.github.com/search/issues → 422'] }));
    const fix = n.fixes.find((f) => f.kind === 'ai_fix')!;
    expect(fix).toMatchObject({ label: 'Have the AI fix slack', moduleVersionId: 'mv1' });
    expect(fix.feedback).toContain('the action "search_pull_requests" failed with "search rejected"');
    expect(fix.feedback).toContain('GET api.github.com/search/issues → 422');
    expect(n.calls).toEqual(['GET api.github.com/search/issues → 422']);
  });

  it('is not offered when a new version would not help, or to someone who may not revise it', () => {
    for (const e of ['missing_credential', 'module_settings_missing', 'network_error', 'approval_rejected']) expect(nextSteps(ctx(e, { canFixModule: true })).fixes.some((f) => f.kind === 'ai_fix'), e).toBe(false);
    expect(nextSteps(ctx('search_rejected')).fixes.some((f) => f.kind === 'ai_fix')).toBe(false);
  });
});

describe('a failed clone', () => {
  it('says why, from what git said', async () => {
    const { cloneFailure } = await import('../src/engine/apps.js');
    expect(cloneFailure("fatal: Remote branch master not found in upstream origin", true)).toBe('clone_branch_not_found');
    expect(cloneFailure("remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found", true)).toBe('clone_repo_not_found');
    expect(cloneFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled", false)).toBe('clone_repo_not_found_no_token');
    expect(cloneFailure('remote: HTTP Basic: Access denied\nfatal: Authentication failed', true)).toBe('clone_access_denied');
    expect(cloneFailure('fatal: unable to access: Could not resolve host: gitlab.acme.test', true)).toBe('clone_unreachable');
    expect(cloneFailure('something else', true)).toBe('clone_failed');
  });
});

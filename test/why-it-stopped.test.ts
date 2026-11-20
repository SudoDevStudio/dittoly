import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOutcome } from '../src/engine/outcome.js';
import { approveExampleModules, giveAllCredentials, makeWorld, runStatus, type World } from './helpers.js';

/**
 * A run that waits or fails is of no use if the page says only that it does. Each one says which rule, which
 * field, and links to where a person acts.
 */
let w: World;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
});
afterAll(async () => {
  await w.db.end();
});

const steps = [{ id: 'a', title: 'Post it', status: 'waiting', errorType: 'auto_stopped' }];

describe('why a run stopped', () => {
  it('names the automatic stop that holds it, and links to where it is resumed', () => {
    const o = runOutcome({ status: 'waiting', waitReason: 'auto_stop' }, steps, {
      autoStop: { id: 'abc', triggerName: 'Failure spike', summary: '5 failed runs in 10 minutes, 71% of its runs (threshold 5 and 50%)' },
    });
    expect(o.reason).toBe('It waits for its Flow to be resumed: failure spike — 5 failed runs in 10 minutes, 71% of its runs (threshold 5 and 50%).');
    expect(o.action).toEqual({ label: 'Resume the Flow (Automatic stops)', href: '/auto-stops#stop-abc' });
  });

  it('says the plain thing when nobody told it which stop', () => {
    const o = runOutcome({ status: 'waiting', waitReason: 'auto_stop' }, steps);
    expect(o.reason).toBe('It waits for an automatic stop of its Flow to be resumed.');
    expect(o.action).toBe(null);
  });

  it('points a waiting sign-off at the step, and a cost cap at the decision', () => {
    expect(runOutcome({ status: 'waiting', waitReason: 'approval' }, [{ id: 'ok', title: 'Sign off', status: 'waiting', errorType: null }]).action).toEqual({
      label: 'The step waiting for a decision',
      href: '#step-ok',
    });
    expect(runOutcome({ status: 'waiting', waitReason: 'cost_cap' }, steps).action).toEqual({ label: 'Allow more AI spend', href: '#what-to-do' });
    expect(runOutcome({ status: 'succeeded', waitReason: null }, [{ id: 'a', title: 'A', status: 'succeeded', errorType: null }]).action).toBe(null);
  });

  it('says which field an action refused, not only "input invalid"', async () => {
    // The action takes a channel and a text, both non-empty; the Flow leaves the channel empty.
    const v = await w.app.flows.create(
      'Tell the team',
      { inputs: { type: 'object', properties: {} }, steps: [{ id: 'tell', title: 'Tell the team', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '', text: 'hi' } }] },
      w.alice,
    );
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    const view = await runStatus(w, runId, w.alice);
    const step = view.steps.find((s: { id: string }) => s.id === 'tell')!;
    expect([step.status, step.errorType]).toEqual(['failed', 'input_invalid']);
    expect(step.detail).toContain('channel');
    expect(view.nextSteps?.detail).toContain('channel');
  });
});

describe("a Flow that hands a fix's files to an action that cannot take them", () => {
  it('is refused before anybody reviews it, with what the action would have to accept', async () => {
    const manifest = {
      name: 'committer',
      version: '1.0.0',
      title: 'Committer',
      description: 'Commits files.',
      hosts: ['api.example.com'],
      settings: [],
      credentials: [{ id: 'token', service: 'committer', label: 'Token', hosts: ['api.example.com'], placement: { type: 'bearer' } }],
      actions: [
        {
          name: 'commit_files',
          title: 'Commit files',
          description: 'Commits files to a branch.',
          effect: 'write',
          credentials: ['token'],
          // Only path and content: a fix step's files also carry "action", and a Flow cannot drop it.
          input: {
            type: 'object',
            properties: { branch: { type: 'string' }, files: { type: 'array', maxItems: 50, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
            required: ['branch', 'files'],
            additionalProperties: false,
          },
          output: { type: 'object', properties: { sha: { type: 'string' } } },
        },
      ],
    };
    const code = `export const actions = {
  async commit_files(input, ctx) {
    const res = await ctx.http.request({ method: 'POST', url: 'https://api.example.com/commit', json: input, credential: 'token' });
    if (!res.ok) throw new ctx.ActionError('http_' + res.status, { retryable: res.status >= 500 });
    return { sha: res.json().sha };
  },
};`;
    const tests = [
      { name: 'commits', action: 'commit_files', input: { branch: 'b', files: [{ path: 'a.js', content: 'x' }] }, http: [{ method: 'POST', urlPrefix: 'https://api.example.com/commit', json: { sha: 'abc' } }] },
      { name: 'refuses nonsense', action: 'commit_files', input: { branch: '', files: [] }, expectOk: false, http: [] },
    ];
    const mv = await w.app.modules.createDraft({ manifest, code, tests, origin: 'seed' }, w.alice);
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');

    const definition = {
      inputs: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
      steps: [
        { id: 'fix', type: 'fix', ai: 'organization', repo: 'https://github.com/acme/app.git', ref: 'main', instruction: 'Fix {{ inputs.error }}', test: 'npm test' },
        { id: 'commit', type: 'action', module: `committer@${mv.version}`, action: 'commit_files', input: { branch: 'fix/1', files: '{{ steps.fix.output.change.files }}' } },
      ],
    };
    await expect(w.app.flows.create('Fix and commit', definition, w.alice)).rejects.toMatchObject({
      message: expect.stringContaining('cannot take the fix step\'s files'),
    });
  });
});

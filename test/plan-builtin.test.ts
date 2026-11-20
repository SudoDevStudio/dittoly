import { describe, expect, it } from 'vitest';
import { builtInWork, parsePlan } from '../src/ai/plan.js';

/**
 * Cloning a repository, reproducing an error and fixing and verifying it is the built-in fix step's job. A planner that
 * makes it a "module" sent the person to answer where code should run (a hosted sandbox, CI): it is never a module.
 */
const plan = (modules: unknown[], flows: unknown[]) =>
  parsePlan({ planJson: JSON.stringify({ title: 'Error to fix', summary: 'S', questions: [], modules, flows, reuse: [] }) });

describe('built-in work planned as a module', () => {
  it('is told apart from a module that connects an app', () => {
    expect(builtInWork('Clone a repository, reproduce an error, write and verify the smallest fix with a regression test', 'Clone the repo and reproduce the error.')).toBe(true);
    expect(builtInWork('Fix and verify the bug', 'Run the tests in a sandbox.')).toBe(true);
    expect(builtInWork('GitHub: open a pull request and read files', 'Clone the repository? No: read files through the API, and open a pull request.')).toBe(false);
    expect(builtInWork('Jira issues', 'Create and search issues.')).toBe(false);
  });

  it('becomes the fix step of the Flow that needed it, which no longer waits for a module', () => {
    const out = plan(
      [
        { key: 'github', title: 'GitHub: pull requests and files', request: 'Read files, list pull requests, open a pull request.' },
        { key: 'fixer', title: 'Clone a repository, reproduce an error, write and verify the smallest fix with a regression test', request: 'Clone the repository at the base branch, reproduce the error, fix it and run the tests.' },
      ],
      [{ key: 'error_to_fix', title: 'Error to fix PR', request: 'Take an error and open a fix PR.', needs: ['github', 'fixer'] }],
    );
    if ('error' in out) throw new Error(out.error);
    expect(out.plan.modules.map((m) => m.key)).toEqual(['github']);
    expect(out.plan.flows[0]!.needs).toEqual(['github']);
    expect(out.plan.flows[0]!.request).toContain("Do this with Dittoly's built-in fix step");
    expect(out.plan.flows[0]!.request).toContain('reproduce the error, fix it and run the tests');
  });

  it('goes to the first Flow when no Flow named it', () => {
    const out = plan(
      [{ key: 'fixer', title: 'Reproduce the bug and fix and verify it', request: 'Clone the repo, reproduce the bug.' }],
      [{ key: 'f', title: 'Flow', request: 'Do it.', needs: [] }],
    );
    if ('error' in out) throw new Error(out.error);
    expect(out.plan.modules).toEqual([]);
    expect(out.plan.flows[0]!.request).toContain("built-in fix step");
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * The "Review a GitHub pull request" example: the PR's URL in (instructions optional), the AI reviews the diff, and
 * review comments are posted on changed lines, skipping a point already made on the same line.
 */
const ex = path.resolve(import.meta.dirname, 'fixtures');
const SHA = '3f9a2c1d7e3f9a2c1d7e3f9a2c1d7e3f9a2c1d7e';
const PR = 'https://api.github.com/repos/acme/shop/pulls/12';

const ai = new MockProvider();
const posted: { path: string; line: number; body: string; commit_id: string; side: string }[] = [];
let existing: { id: number; path: string; line: number; body: string; user: { login: string } }[] = [];
async function github(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = String(url instanceof Request ? url.url : url);
  const method = init?.method ?? 'GET';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'GET' && u === PR) {
    return json({ number: 12, title: 'Fix cart total', body: 'Rounds totals.', state: 'open', merged_at: null, html_url: 'https://github.com/acme/shop/pull/12', user: { login: 'sam' }, head: { sha: SHA, ref: 'fix' }, base: { ref: 'main' } });
  }
  if (method === 'GET' && u.startsWith(`${PR}/files?`)) {
    return json([{ filename: 'src/cart.js', status: 'modified', additions: 2, deletions: 1, patch: '@@ -10,3 +10,4 @@\n-  return a + b\n+  return Math.round((a + b) * 100) / 100\n+  // TODO' }]);
  }
  if (method === 'GET' && u.startsWith(`${PR}/comments?`)) return json(u.includes('page=1') ? existing : []);
  if (method === 'POST' && u === `${PR}/comments`) {
    const body = JSON.parse(String(init?.body));
    if (body.line > 13) return json({ message: 'line must be part of the diff' }, 422);
    posted.push(body);
    return json({ id: 900 + posted.length, html_url: `https://github.com/acme/shop/pull/12#discussion_r${900 + posted.length}` }, 201);
  }
  return json({ message: `unexpected ${method} ${u}` }, 404);
}

let w: World;
let versionId = '';
let sandboxTests: { name: string; passed: boolean }[] = [];
beforeAll(async () => {
  w = await makeWorld({}, { ai, fetchImpl: github as typeof fetch });
  const dir = path.join(ex, 'modules', 'github-review');
  const mv = await w.app.modules.createDraft(
    {
      manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
      code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
      tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
      origin: 'seed',
    },
    w.alice,
  );
  sandboxTests = ((mv.validationReport as { tests?: { name: string; passed: boolean }[] }).tests ?? []).map((t) => ({ name: t.name, passed: t.passed }));
  expect(mv.validationReport?.passed, JSON.stringify(mv.validationReport)).toBe(true);
  await w.app.modules.submit(mv.id, w.alice);
  await w.app.modules.decide(mv.id, w.admin, 'approved');
  const flow = JSON.parse(await readFile(path.join(ex, 'flows', 'github-pr-review.json'), 'utf8'));
  const v = await w.app.flows.create(flow.name, flow.definition, w.alice);
  // The AI writes what gets posted: the approver accepts that path once, so runs do not stop for a sign-off each time.
  await w.app.flows.decide(v.id, w.approver, 'approved', { accept: [{ sink: 'post', reason: 'Review comments only; the module skips duplicates.' }] });
  versionId = v.id;
  await w.app.vault.put(w.alice.id, 'github', 'github_pat_alice');
});
afterAll(async () => {
  await w.db.end();
});

describe('the github-review module', () => {
  it('passes its own sandbox tests (canned GitHub answers)', () => {
    expect(sandboxTests.map((t) => t.name)).toEqual([
      'reads a pull request and its changed files from its URL',
      'refuses a URL that is not a pull request',
      'lists the review comments already on it',
      'posts a new comment and skips one already made on the same line',
      'refuses a review that is not JSON',
    ]);
    expect(sandboxTests.every((t) => t.passed)).toBe(true);
  });
});

describe('Review a GitHub pull request', () => {
  it('only the PR URL: reviews it, posts the new point, skips the one already there and the line outside the diff', async () => {
    existing = [{ id: 501, path: 'src/cart.js', line: 11, body: 'Please remove the TODO before merging.', user: { login: 'lee' } }];
    ai.enqueue({
      text: JSON.stringify({
        comments: [
          { path: 'src/cart.js', line: 11, body: 'please remove the TODO before merging' },
          { path: 'src/cart.js', line: 10, body: 'Math.round on a float can be off for halves; keep totals in integer cents.' },
          { path: 'src/cart.js', line: 40, body: 'Not part of this diff.' },
        ],
      }),
    });
    const runId = await w.app.engine.startRun(versionId, w.alice.id, { prUrl: 'https://github.com/acme/shop/pull/12' });
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.status, JSON.stringify(r.nextSteps ?? r.steps)).toBe('succeeded');
    expect(posted).toEqual([{ body: 'Math.round on a float can be off for halves; keep totals in integer cents.', commit_id: SHA, path: 'src/cart.js', line: 10, side: 'RIGHT' }]);
    expect(r.steps.at(-1)!.output).toMatchObject({
      posted: [{ path: 'src/cart.js', line: 10 }],
      skipped: [{ line: 11, reason: 'already_commented' }, { line: 40, reason: 'line_not_in_diff' }],
      summary: '1 comment posted, 2 skipped (already commented, line not in diff).',
    });
    // The AI got the diff, the comments already there, and the run's inputs (no instructions given).
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain('Please remove the TODO before merging.');
    expect(prompt).toContain('@@ -10,3 +10,4 @@');
  }, 60_000);

  it('with instructions, the AI is given them; running it again posts nothing new', async () => {
    existing = [...existing, { id: 902, path: 'src/cart.js', line: 10, body: posted[0]!.body, user: { login: 'alice' } }];
    posted.length = 0;
    ai.enqueue({ text: '```json\n{"comments": [{"path": "src/cart.js", "line": 10, "body": "Math.round on a float can be off for halves; keep totals in integer cents."}]}\n```' });
    const runId = await w.app.engine.startRun(versionId, w.alice.id, { prUrl: 'https://github.com/acme/shop/pull/12', instructions: 'Focus on money handling.' });
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.status).toBe('succeeded');
    expect(posted).toEqual([]);
    expect(r.steps.at(-1)!.output).toMatchObject({ posted: [], skipped: [{ line: 10, reason: 'already_commented' }] });
    expect(ai.requests.at(-1)!.prompt).toContain('Focus on money handling.');
  }, 60_000);

  it('refuses a URL that is not a pull request before anything runs', async () => {
    await expect(w.app.engine.startRun(versionId, w.alice.id, { prUrl: 'https://github.com/acme/shop/issues/12' })).rejects.toMatchObject({ code: 'invalid_inputs' });
  });
});

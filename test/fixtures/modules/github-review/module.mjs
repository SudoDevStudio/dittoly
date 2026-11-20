// GitHub pull request review: read a PR's diff and its review comments, post review comments on changed lines,
// skipping any that already say the same thing on the same line. REST API version 2026-03-10 (the endpoints used
// here are unchanged from 2022-11-28).
const fail = (ctx, res, code) => new ctx.ActionError(code ?? `github_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
const odd = (ctx) => new ctx.ActionError('github_unexpected_answer', { retryable: false });

const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10' };
const SHA = /^[0-9a-f]{40}$/;
const MAX_COMMENTS = 30;
const PAGES = 5;

/** api.github.com and GitHub Enterprise Cloud (api.<name>.ghe.com) at the root; GitHub Enterprise Server under /api/v3. */
const apiBase = (ctx) => (ctx.settings.host === 'api.github.com' || ctx.settings.host.endsWith('.ghe.com') ? `https://${ctx.settings.host}` : `https://${ctx.settings.host}/api/v3`);
const pullsApi = (ctx, repo, number) => {
  const [owner, name] = repo.split('/');
  return `${apiBase(ctx)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`;
};
const call = (ctx, method, url, json) => ctx.http.request({ method, url, headers: HEADERS, ...(json ? { json } : {}), credential: 'github_token' });
const str = (v, n) => {
  const s = typeof v === 'string' ? v : '';
  return n && s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Every page of a list endpoint (100 a page), up to PAGES pages. */
async function all(ctx, url) {
  const out = [];
  for (let page = 1; page <= PAGES; page++) {
    const res = await call(ctx, 'GET', `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (res.status === 404) throw new ctx.ActionError('pull_request_not_found', { retryable: false });
    if (!res.ok) throw fail(ctx, res);
    const list = res.json();
    if (!Array.isArray(list)) throw odd(ctx);
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

const commentOf = (c) => ({
  id: c.id,
  path: str(c.path),
  line: Number.isInteger(c.line) ? c.line : Number.isInteger(c.original_line) ? c.original_line : null,
  body: str(c.body, 4000),
  author: str(c.user?.login),
});

/** Same point, written again: compared without case, punctuation or spacing. */
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const sameText = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // One contains the other (a shorter or longer wording of the same remark), when both say something substantial.
  return Math.min(x.length, y.length) >= 30 && (x.includes(y) || y.includes(x));
};

/** The JSON object in an AI's answer: the whole text, or the first {...} in it (it may come in a code fence). */
function reviewOf(text) {
  const tries = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) tries.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) tries.push(text.slice(first, last + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') return Array.isArray(v) ? { comments: v } : v;
    } catch {
      // try the next reading
    }
  }
  return null;
}

export const actions = {
  async read_pull_request(input, ctx) {
    const m = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(input.url);
    if (!m) throw new ctx.ActionError('not_a_pull_request_url', { retryable: false });
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    const res = await call(ctx, 'GET', pullsApi(ctx, repo, number));
    if (res.status === 404) throw new ctx.ActionError('pull_request_not_found', { retryable: false });
    if (!res.ok) throw fail(ctx, res);
    const pr = res.json();
    const headSha = pr?.head?.sha;
    if (!pr || typeof headSha !== 'string' || !SHA.test(headSha)) throw odd(ctx);
    const maxFiles = input.maxFiles ?? 50;
    const maxPatch = input.maxPatchChars ?? 12000;
    const listed = await all(ctx, `${pullsApi(ctx, repo, number)}/files`);
    const files = listed.slice(0, maxFiles).map((f) => {
      const patch = str(f?.patch);
      return {
        path: str(f?.filename),
        status: str(f?.status),
        additions: Number.isInteger(f?.additions) ? f.additions : 0,
        deletions: Number.isInteger(f?.deletions) ? f.deletions : 0,
        patch: patch.slice(0, maxPatch),
        truncated: patch.length > maxPatch,
      };
    });
    return {
      repo,
      number,
      title: str(pr.title, 300),
      body: str(pr.body, 8000),
      author: str(pr.user?.login),
      state: pr.merged_at ? 'merged' : str(pr.state),
      headSha,
      baseRef: str(pr.base?.ref),
      headRef: str(pr.head?.ref),
      url: str(pr.html_url),
      files,
      filesTruncated: listed.length > files.length,
    };
  },

  async list_review_comments(input, ctx) {
    const list = await all(ctx, `${pullsApi(ctx, input.repo, input.number)}/comments`);
    return { comments: list.filter((c) => c && Number.isInteger(c.id)).map(commentOf) };
  },

  async post_review_comments(input, ctx) {
    const review = reviewOf(input.review);
    if (!review) throw new ctx.ActionError('review_not_json', { retryable: false });
    const wanted = (Array.isArray(review.comments) ? review.comments : [])
      .filter((c) => c && typeof c.path === 'string' && c.path && typeof c.body === 'string' && c.body.trim())
      .slice(0, MAX_COMMENTS)
      .map((c) => ({ path: c.path.slice(0, 500), line: Number.isInteger(c.line) && c.line > 0 ? c.line : null, body: c.body.trim().slice(0, 8000) }));
    const url = `${pullsApi(ctx, input.repo, input.number)}/comments`;
    // What is already there, including what an earlier call made before its answer was lost.
    const existing = (await all(ctx, url)).filter((c) => c && Number.isInteger(c.id)).map(commentOf);
    const posted = [];
    const skipped = [];
    for (const c of wanted) {
      if (c.line === null) {
        skipped.push({ path: c.path, line: null, reason: 'no_line' });
        continue;
      }
      const same = [...existing, ...posted.map((p) => ({ ...p, body: p.body }))].some((e) => e.path === c.path && e.line === c.line && sameText(e.body, c.body));
      if (same) {
        skipped.push({ path: c.path, line: c.line, reason: 'already_commented' });
        continue;
      }
      const res = await call(ctx, 'POST', url, { body: c.body, commit_id: input.commitId, path: c.path, line: c.line, side: 'RIGHT' });
      // 422: the line is not part of the diff (GitHub only takes comments on lines the pull request shows).
      if (res.status === 422) {
        skipped.push({ path: c.path, line: c.line, reason: 'line_not_in_diff' });
        continue;
      }
      if (!res.ok) throw fail(ctx, res);
      const made = res.json();
      if (!made || !Number.isInteger(made.id)) throw odd(ctx);
      posted.push({ id: made.id, path: c.path, line: c.line, url: str(made.html_url), body: c.body });
    }
    const summary = `${posted.length} comment${posted.length === 1 ? '' : 's'} posted, ${skipped.length} skipped${skipped.length ? ` (${[...new Set(skipped.map((s) => s.reason.replace(/_/g, ' ')))].join(', ')})` : ''}.`;
    return { posted: posted.map(({ body: _b, ...p }) => p), skipped, summary };
  },
};

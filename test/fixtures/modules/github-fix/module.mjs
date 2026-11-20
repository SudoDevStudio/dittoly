const fail = (ctx, res, code) => new ctx.ActionError(code ?? `github_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
const odd = (ctx) => new ctx.ActionError('github_unexpected_answer', { retryable: false });

const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
const SHA = /^[0-9a-f]{40}$/;

/** api.github.com and GitHub Enterprise Cloud (api.<name>.ghe.com) at the root; GitHub Enterprise Server under /api/v3. */
const apiBase = (ctx) => (ctx.settings.host === 'api.github.com' || ctx.settings.host.endsWith('.ghe.com') ? `https://${ctx.settings.host}` : `https://${ctx.settings.host}/api/v3`);
const repoApi = (ctx, input) => {
  const [owner, name] = input.repo.split('/');
  return `${apiBase(ctx)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
};
/** A branch or file path in a URL: each segment encoded, the slashes kept. */
const segments = (p) => p.split('/').map(encodeURIComponent).join('/');
const call = (ctx, method, url, json) => ctx.http.request({ method, url, headers: HEADERS, ...(json ? { json } : {}), credential: 'github_token' });

const trim = (v, n) => {
  const s = typeof v === 'string' ? v : '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const prOf = (p) => ({
  number: p.number,
  url: typeof p.html_url === 'string' ? p.html_url : '',
  state: p.merged_at ? 'merged' : typeof p.state === 'string' ? p.state : '',
  draft: p.draft === true,
  title: trim(p.title, 200),
});
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export const actions = {
  async find_open_pr_by_head(input, ctx) {
    const owner = input.repo.split('/')[0];
    const params = new URLSearchParams({ state: 'all', head: `${owner}:${input.branch}`, sort: 'created', direction: 'desc', per_page: '5' });
    const res = await call(ctx, 'GET', `${repoApi(ctx, input)}/pulls?${params}`);
    if (!res.ok) throw fail(ctx, res);
    const list = res.json();
    if (!Array.isArray(list)) throw odd(ctx);
    const prs = list.filter((p) => p && Number.isInteger(p.number));
    const open = prs.find((p) => p.state === 'open');
    return { found: Boolean(open), pr: open ? prOf(open) : null, latest: prs.length ? prOf(prs[0]) : null };
  },

  async get_file(input, ctx) {
    const res = await call(ctx, 'GET', `${repoApi(ctx, input)}/contents/${segments(input.path)}?ref=${encodeURIComponent(input.ref)}`);
    if (res.status === 404) throw new ctx.ActionError('file_not_found', { retryable: false });
    if (!res.ok) throw fail(ctx, res);
    const f = res.json();
    if (Array.isArray(f) || f?.type !== 'file') throw new ctx.ActionError('not_a_file', { retryable: false });
    if (f.encoding !== 'base64' || typeof f.content !== 'string') throw new ctx.ActionError('file_too_large', { retryable: false });
    const text = fromBase64(f.content);
    const max = input.maxChars ?? 100000;
    return { path: input.path, content: text.slice(0, max), size: Number.isInteger(f.size) ? f.size : text.length, truncated: text.length > max, sha: typeof f.sha === 'string' ? f.sha : '' };
  },

  async create_branch(input, ctx) {
    const api = repoApi(ctx, input);
    let sha = input.ref;
    if (!SHA.test(sha)) {
      const head = await call(ctx, 'GET', `${api}/git/ref/heads/${segments(input.ref)}`);
      if (head.status === 404) throw new ctx.ActionError('ref_not_found', { retryable: false });
      if (!head.ok) throw fail(ctx, head);
      sha = head.json()?.object?.sha;
      if (typeof sha !== 'string' || !SHA.test(sha)) throw odd(ctx);
    }
    const res = await call(ctx, 'POST', `${api}/git/refs`, { ref: `refs/heads/${input.branch}`, sha });
    if (res.status === 422) {
      // Already there: an earlier call whose answer was lost made it, if it points at the same commit.
      const at = await call(ctx, 'GET', `${api}/git/ref/heads/${segments(input.branch)}`);
      if (at.ok && at.json()?.object?.sha === sha) return { branch: input.branch, commit: sha, reused: true };
      throw fail(ctx, res, 'branch_refused');
    }
    if (!res.ok) throw fail(ctx, res);
    return { branch: input.branch, commit: sha, reused: false };
  },

  async delete_branch(input, ctx) {
    const res = await call(ctx, 'DELETE', `${repoApi(ctx, input)}/git/refs/heads/${segments(input.branch)}`);
    // GitHub answers 422 "Reference does not exist" for a branch that is already gone.
    if (res.status === 404 || res.status === 422) return { branch: input.branch, deleted: false };
    if (!res.ok) throw fail(ctx, res);
    return { branch: input.branch, deleted: true };
  },

  async commit_files(input, ctx) {
    if (input.files.some((f) => f.action !== 'delete' && typeof f.content !== 'string')) throw new ctx.ActionError('content_required', { retryable: false });
    const api = repoApi(ctx, input);
    const ref = `${api}/git/refs/heads/${segments(input.branch)}`;
    // 1. Where the branch is now, and 2. that commit's tree.
    const at = await call(ctx, 'GET', `${api}/git/ref/heads/${segments(input.branch)}`);
    if (at.status === 404) throw new ctx.ActionError('branch_not_found', { retryable: false });
    if (!at.ok) throw fail(ctx, at);
    const parent = at.json()?.object?.sha;
    if (typeof parent !== 'string' || !SHA.test(parent)) throw odd(ctx);
    const commit = await call(ctx, 'GET', `${api}/git/commits/${parent}`);
    if (!commit.ok) throw fail(ctx, commit);
    const head = commit.json();
    const baseTree = head?.tree?.sha;
    if (typeof baseTree !== 'string') throw odd(ctx);
    // 3. One tree with the contents inline (no blob per file); a null sha deletes the path.
    const tree = await call(ctx, 'POST', `${api}/git/trees`, {
      base_tree: baseTree,
      tree: input.files.map((f) => (f.action === 'delete' ? { path: f.path, mode: '100644', type: 'blob', sha: null } : { path: f.path, mode: '100644', type: 'blob', content: f.content })),
    });
    if (tree.status === 422) throw fail(ctx, tree, 'commit_refused');
    if (!tree.ok) throw fail(ctx, tree);
    const treeSha = tree.json()?.sha;
    if (typeof treeSha !== 'string') throw odd(ctx);
    // Trees are content-addressed: the same tree back means the branch already has these files. With our message on
    // its head commit, that commit is ours from an earlier call whose answer was lost.
    if (treeSha === baseTree && typeof head.message === 'string' && head.message.trim() === input.message.trim()) {
      return { sha: parent, url: typeof head.html_url === 'string' ? head.html_url : '', filesChanged: input.files.length, reused: true };
    }
    // 4. The commit, and 5. the branch moved to it (fast-forward only).
    const created = await call(ctx, 'POST', `${api}/git/commits`, { message: input.message, tree: treeSha, parents: [parent] });
    if (!created.ok) throw fail(ctx, created);
    const c = created.json();
    if (typeof c?.sha !== 'string') throw odd(ctx);
    const moved = await call(ctx, 'PATCH', ref, { sha: c.sha, force: false });
    if (moved.status === 422) throw fail(ctx, moved, 'branch_moved');
    if (!moved.ok) throw fail(ctx, moved);
    return { sha: c.sha, url: typeof c.html_url === 'string' ? c.html_url : '', filesChanged: input.files.length, reused: false };
  },

  async create_draft_pr(input, ctx) {
    const api = repoApi(ctx, input);
    const res = await call(ctx, 'POST', `${api}/pulls`, { title: input.title, head: input.head, base: input.base, body: input.body, draft: true });
    let pr;
    let reused = false;
    if (res.status === 422) {
      // GitHub refuses a second open pull request for a head: the one already open (from a call whose answer was lost) is it.
      const params = new URLSearchParams({ state: 'open', head: `${input.repo.split('/')[0]}:${input.head}`, base: input.base, per_page: '5' });
      const open = await call(ctx, 'GET', `${api}/pulls?${params}`);
      const list = open.ok ? open.json() : null;
      pr = Array.isArray(list) ? list.find((p) => p && Number.isInteger(p.number) && p.state === 'open') : undefined;
      if (!pr) throw fail(ctx, res, 'pr_refused');
      reused = true;
    } else {
      if (!res.ok) throw fail(ctx, res);
      pr = res.json();
      if (!pr || !Number.isInteger(pr.number)) throw odd(ctx);
    }
    let labelsApplied = !input.labels?.length;
    if (!labelsApplied) {
      // The pull request exists either way; whether the labels stuck is reported, not hidden.
      const labels = await call(ctx, 'POST', `${api}/issues/${pr.number}/labels`, { labels: input.labels });
      labelsApplied = labels.ok;
    }
    return { number: pr.number, url: typeof pr.html_url === 'string' ? pr.html_url : '', draft: pr.draft !== false, labelsApplied, reused };
  },

  async close_pr(input, ctx) {
    const res = await call(ctx, 'PATCH', `${repoApi(ctx, input)}/pulls/${input.number}`, { state: 'closed' });
    if (!res.ok) throw fail(ctx, res);
    const pr = res.json();
    return { number: input.number, state: typeof pr?.state === 'string' ? pr.state : 'closed' };
  },

  async comment_on_pr(input, ctx) {
    const res = await call(ctx, 'POST', `${repoApi(ctx, input)}/issues/${input.number}/comments`, { body: input.body });
    if (!res.ok) throw fail(ctx, res);
    const c = res.json();
    if (!c || !Number.isInteger(c.id)) throw odd(ctx);
    return { commentId: c.id, url: typeof c.html_url === 'string' ? c.html_url : '' };
  },

  async delete_comment(input, ctx) {
    const res = await call(ctx, 'DELETE', `${repoApi(ctx, input)}/issues/comments/${input.commentId}`);
    if (res.status === 404) return { deleted: false };
    if (!res.ok) throw fail(ctx, res);
    return { deleted: true };
  },
};

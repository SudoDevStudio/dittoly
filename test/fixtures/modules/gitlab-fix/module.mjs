const fail = (ctx, res, code) => new ctx.ActionError(code ?? `gitlab_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });

/** The project's API base, e.g. https://gitlab.com/api/v4/projects/acme%2Fshop. */
const project = (ctx, input) => `https://${ctx.settings.host}/api/v4/projects/${encodeURIComponent(input.project)}`;

const trim = (v, n) => {
  const s = typeof v === 'string' ? v : '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

const mrOf = (m) => ({ iid: m.iid, url: typeof m.web_url === 'string' ? m.web_url : '', state: typeof m.state === 'string' ? m.state : '', draft: m.draft === true, title: trim(m.title, 200) });

/** UTF-8 text from GitLab's base64 file content. */
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

const SHA = /^[0-9a-f]{40}$/;

/** A branch with its head commit, or null when there is no such branch. */
async function branchAt(ctx, input, name) {
  const res = await ctx.http.request({ method: 'GET', url: `${project(ctx, input)}/repository/branches/${encodeURIComponent(name)}`, credential: 'gitlab_token' });
  if (res.status === 404) return null;
  if (!res.ok) throw fail(ctx, res);
  const b = res.json();
  if (!b || typeof b.name !== 'string') throw new ctx.ActionError('gitlab_unexpected_answer', { retryable: false });
  return b;
}

/** True when every file on the branch is already as the commit would leave it (deleted ones gone). Five reads at a time. */
async function filesAre(ctx, input) {
  const check = async (f) => {
    const res = await ctx.http.request({
      method: 'GET',
      url: `${project(ctx, input)}/repository/files/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(input.branch)}`,
      credential: 'gitlab_token',
    });
    if (f.action === 'delete') return res.status === 404;
    if (!res.ok) return false;
    const got = res.json();
    if (typeof got?.content !== 'string') return false;
    return (got.encoding === 'base64' ? fromBase64(got.content) : got.content) === f.content;
  };
  for (let i = 0; i < input.files.length; i += 5) {
    const same = await Promise.all(input.files.slice(i, i + 5).map(check));
    if (!same.every(Boolean)) return false;
  }
  return true;
}

export const actions = {
  async find_open_mr_by_branch(input, ctx) {
    const params = new URLSearchParams({ source_branch: input.branch, state: 'all', order_by: 'created_at', sort: 'desc', per_page: '5' });
    const res = await ctx.http.request({ method: 'GET', url: `${project(ctx, input)}/merge_requests?${params}`, credential: 'gitlab_token' });
    if (!res.ok) throw fail(ctx, res);
    const list = res.json();
    if (!Array.isArray(list)) throw new ctx.ActionError('gitlab_unexpected_answer', { retryable: false });
    const mrs = list.filter((m) => m && Number.isInteger(m.iid));
    const open = mrs.find((m) => m.state === 'opened');
    return { found: Boolean(open), mr: open ? mrOf(open) : null, latest: mrs.length ? mrOf(mrs[0]) : null };
  },

  async get_file(input, ctx) {
    const res = await ctx.http.request({
      method: 'GET',
      url: `${project(ctx, input)}/repository/files/${encodeURIComponent(input.path)}?ref=${encodeURIComponent(input.ref)}`,
      credential: 'gitlab_token',
    });
    if (res.status === 404) throw new ctx.ActionError('file_not_found', { retryable: false });
    if (!res.ok) throw fail(ctx, res);
    const f = res.json();
    if (!f || typeof f.content !== 'string') throw new ctx.ActionError('gitlab_unexpected_answer', { retryable: false });
    const text = f.encoding === 'base64' ? fromBase64(f.content) : f.content;
    const max = input.maxChars ?? 100000;
    return {
      path: input.path,
      content: text.slice(0, max),
      size: Number.isInteger(f.size) ? f.size : text.length,
      truncated: text.length > max,
      blobId: typeof f.blob_id === 'string' ? f.blob_id : '',
      lastCommitId: typeof f.last_commit_id === 'string' ? f.last_commit_id : '',
    };
  },

  async create_branch(input, ctx) {
    const res = await ctx.http.request({
      method: 'POST',
      url: `${project(ctx, input)}/repository/branches`,
      json: { branch: input.branch, ref: input.ref },
      credential: 'gitlab_token',
    });
    if (res.status === 400) {
      // Already there: an earlier call whose answer was lost made it, if it points at the commit asked for.
      const b = await branchAt(ctx, input, input.branch);
      const want = SHA.test(input.ref) ? input.ref : (await branchAt(ctx, input, input.ref))?.commit?.id;
      if (b && typeof want === 'string' && b.commit?.id === want) return { branch: b.name, commit: want, url: typeof b.web_url === 'string' ? b.web_url : '', reused: true };
      throw fail(ctx, res, 'branch_refused');
    }
    if (!res.ok) throw fail(ctx, res);
    const b = res.json();
    if (!b || typeof b.name !== 'string') throw new ctx.ActionError('gitlab_unexpected_answer', { retryable: false });
    return { branch: b.name, commit: typeof b.commit?.id === 'string' ? b.commit.id : '', url: typeof b.web_url === 'string' ? b.web_url : '', reused: false };
  },

  async delete_branch(input, ctx) {
    const res = await ctx.http.request({
      method: 'DELETE',
      url: `${project(ctx, input)}/repository/branches/${encodeURIComponent(input.branch)}`,
      credential: 'gitlab_token',
    });
    if (res.status === 404) return { branch: input.branch, deleted: false };
    if (!res.ok) throw fail(ctx, res);
    return { branch: input.branch, deleted: true };
  },

  async commit_files(input, ctx) {
    // The input schema already asks for content on create and update; checked again before anything is sent.
    if (input.files.some((f) => f.action !== 'delete' && typeof f.content !== 'string')) throw new ctx.ActionError('content_required', { retryable: false });
    // An earlier call whose answer was lost: the branch head has our message and the files are already as asked.
    const b = await branchAt(ctx, input, input.branch);
    if (!b) throw new ctx.ActionError('branch_not_found', { retryable: false });
    const head = b.commit;
    if (typeof head?.id === 'string' && typeof head.message === 'string' && head.message.trim() === input.message.trim() && (await filesAre(ctx, input))) {
      return { sha: head.id, shortSha: typeof head.short_id === 'string' ? head.short_id : head.id.slice(0, 8), url: typeof head.web_url === 'string' ? head.web_url : '', filesChanged: input.files.length, reused: true };
    }
    const res = await ctx.http.request({
      method: 'POST',
      url: `${project(ctx, input)}/repository/commits`,
      json: {
        branch: input.branch,
        commit_message: input.message,
        actions: input.files.map((f) => (f.action === 'delete' ? { action: 'delete', file_path: f.path } : { action: f.action, file_path: f.path, content: f.content })),
      },
      credential: 'gitlab_token',
    });
    if (res.status === 400) throw fail(ctx, res, 'commit_refused');
    if (!res.ok) throw fail(ctx, res);
    const c = res.json();
    if (!c || typeof c.id !== 'string') throw new ctx.ActionError('gitlab_unexpected_answer', { retryable: false });
    return { sha: c.id, shortSha: typeof c.short_id === 'string' ? c.short_id : c.id.slice(0, 8), url: typeof c.web_url === 'string' ? c.web_url : '', filesChanged: input.files.length, reused: false };
  },

  async create_draft_mr(input, ctx) {
    const title = /^(draft:|\[draft\]|\(draft\))/i.test(input.title) ? input.title : `Draft: ${input.title}`;
    const res = await ctx.http.request({
      method: 'POST',
      url: `${project(ctx, input)}/merge_requests`,
      json: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title,
        description: input.description,
        ...(input.labels?.length ? { labels: input.labels.join(',') } : {}),
        remove_source_branch: true,
      },
      credential: 'gitlab_token',
    });
    let mr;
    let reused = false;
    if (res.status === 409) {
      // GitLab refuses a second open merge request for a source branch: the one already open (from a call whose answer was lost) is it.
      const params = new URLSearchParams({ source_branch: input.sourceBranch, target_branch: input.targetBranch, state: 'opened', per_page: '5' });
      const open = await ctx.http.request({ method: 'GET', url: `${project(ctx, input)}/merge_requests?${params}`, credential: 'gitlab_token' });
      const list = open.ok ? open.json() : null;
      mr = Array.isArray(list) ? list.find((m) => m && Number.isInteger(m.iid) && m.state === 'opened') : undefined;
      if (!mr) throw fail(ctx, res, 'mr_already_open');
      reused = true;
    } else {
      if (!res.ok) throw fail(ctx, res);
      mr = res.json();
      if (!mr || !Number.isInteger(mr.iid)) throw new ctx.ActionError('gitlab_unexpected_answer', { retryable: false });
    }
    return { iid: mr.iid, url: typeof mr.web_url === 'string' ? mr.web_url : '', draft: mr.draft !== false, state: typeof mr.state === 'string' ? mr.state : 'opened', reused };
  },

  async close_mr(input, ctx) {
    const res = await ctx.http.request({
      method: 'PUT',
      url: `${project(ctx, input)}/merge_requests/${input.iid}`,
      json: { state_event: 'close' },
      credential: 'gitlab_token',
    });
    if (!res.ok) throw fail(ctx, res);
    const mr = res.json();
    return { iid: input.iid, state: typeof mr?.state === 'string' ? mr.state : 'closed' };
  },

  async comment_on_mr(input, ctx) {
    const res = await ctx.http.request({
      method: 'POST',
      url: `${project(ctx, input)}/merge_requests/${input.iid}/notes`,
      json: { body: input.body },
      credential: 'gitlab_token',
    });
    if (!res.ok) throw fail(ctx, res);
    const note = res.json();
    if (!note || !Number.isInteger(note.id)) throw new ctx.ActionError('gitlab_unexpected_answer', { retryable: false });
    return { noteId: note.id };
  },

  async delete_comment(input, ctx) {
    const res = await ctx.http.request({
      method: 'DELETE',
      url: `${project(ctx, input)}/merge_requests/${input.iid}/notes/${input.noteId}`,
      credential: 'gitlab_token',
    });
    if (res.status === 404) return { deleted: false };
    if (!res.ok) throw fail(ctx, res);
    return { deleted: true };
  },
};

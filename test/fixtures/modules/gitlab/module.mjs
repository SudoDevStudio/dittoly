const API = 'https://gitlab.com/api/v4';

const fail = (ctx, res) => {
  throw new ctx.ActionError(`http_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
};

export const actions = {
  async list_merge_requests(input, ctx) {
    const params = new URLSearchParams({ state: 'opened', per_page: '100' });
    if (input.label) params.set('labels', input.label);
    const res = await ctx.http.request({
      method: 'GET',
      url: `${API}/projects/${encodeURIComponent(input.project)}/merge_requests?${params}`,
      credential: 'gitlab_token',
    });
    if (!res.ok) fail(ctx, res);
    return {
      mergeRequests: res.json().map((mr) => ({
        iid: mr.iid,
        title: mr.title,
        mergeable: mr.detailed_merge_status === 'mergeable',
      })),
    };
  },

  async merge_merge_request(input, ctx) {
    const res = await ctx.http.request({
      method: 'PUT',
      url: `${API}/projects/${encodeURIComponent(input.project)}/merge_requests/${input.iid}/merge`,
      credential: 'gitlab_token',
    });
    if (!res.ok) fail(ctx, res);
    const mr = res.json();
    return { iid: mr.iid, state: mr.state };
  },
};

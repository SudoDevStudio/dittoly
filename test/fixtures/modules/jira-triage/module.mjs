const fail = (ctx, res) => new ctx.ActionError(`http_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });

export const actions = {
  async get_issue(input, ctx) {
    // API v2 returns the description as text (Jira wiki markup); v3 returns a document tree.
    const res = await ctx.http.request({
      method: 'GET',
      url: `https://${ctx.settings.site}/rest/api/2/issue/${encodeURIComponent(input.key)}?fields=summary,description,status`,
      headers: { accept: 'application/json' },
      credential: 'jira_api_token',
    });
    if (!res.ok) throw fail(ctx, res);
    const i = res.json();
    return {
      key: i.key,
      summary: i.fields?.summary ?? '',
      description: i.fields?.description ?? '',
      status: i.fields?.status?.name ?? '',
      url: `https://${ctx.settings.site}/browse/${i.key}`,
    };
  },

  async comment_issue(input, ctx) {
    const shots = input.screenshots ?? [];
    const names = [];
    if (shots.length) {
      const res = await ctx.http.request({
        method: 'POST',
        url: `https://${ctx.settings.site}/rest/api/3/issue/${encodeURIComponent(input.key)}/attachments`,
        // Jira refuses attachment uploads without this header.
        headers: { 'x-atlassian-token': 'no-check', accept: 'application/json' },
        multipart: shots.map((dataUrl, i) => ({ name: 'file', filename: `screenshot-${i + 1}.${dataUrl.startsWith('data:image/png') ? 'png' : 'jpg'}`, dataUrl })),
        credential: 'jira_api_token',
      });
      if (!res.ok) throw fail(ctx, res);
      for (const a of res.json()) names.push(a.filename);
    }
    const body = names.length ? `${input.body}\n\n${names.map((n) => `!${n}|thumbnail!`).join(' ')}` : input.body;
    const res = await ctx.http.request({
      method: 'POST',
      url: `https://${ctx.settings.site}/rest/api/2/issue/${encodeURIComponent(input.key)}/comment`,
      json: { body },
      credential: 'jira_api_token',
    });
    if (!res.ok) throw fail(ctx, res);
    return { commentId: String(res.json().id), attachments: names.length };
  },

  async add_labels(input, ctx) {
    const res = await ctx.http.request({
      method: 'PUT',
      url: `https://${ctx.settings.site}/rest/api/2/issue/${encodeURIComponent(input.key)}`,
      json: { update: { labels: input.labels.map((l) => ({ add: l })) } },
      credential: 'jira_api_token',
    });
    if (!res.ok) throw fail(ctx, res);
    return { labels: input.labels };
  },
};

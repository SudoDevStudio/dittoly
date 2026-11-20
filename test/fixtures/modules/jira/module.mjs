export const actions = {
  async search_issues(input, ctx) {
    const params = new URLSearchParams({
      jql: input.jql,
      fields: 'summary,status',
      maxResults: String(input.maxResults ?? 50),
    });
    const res = await ctx.http.request({
      method: 'GET',
      url: `https://${ctx.settings.site}/rest/api/3/search/jql?${params}`,
      headers: { accept: 'application/json' },
      credential: 'jira_api_token',
    });
    if (!res.ok) throw new ctx.ActionError(`http_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
    const data = res.json();
    return {
      issues: (data.issues ?? []).map((i) => ({
        key: i.key,
        summary: i.fields?.summary ?? '',
        status: i.fields?.status?.name ?? '',
      })),
    };
  },
};

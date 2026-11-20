const fail = (ctx, res) => new ctx.ActionError(`http_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });

export const actions = {
  async comment(input, ctx) {
    const project = encodeURIComponent(input.project);
    const shots = input.screenshots ?? [];
    const images = [];
    for (const [i, dataUrl] of shots.entries()) {
      // The project's Markdown uploads: the answer carries Markdown that shows the image.
      const res = await ctx.http.request({
        method: 'POST',
        url: `https://gitlab.com/api/v4/projects/${project}/uploads`,
        multipart: [{ name: 'file', filename: `screenshot-${i + 1}.${dataUrl.startsWith('data:image/png') ? 'png' : 'jpg'}`, dataUrl }],
        credential: 'gitlab_token',
      });
      if (!res.ok) throw fail(ctx, res);
      images.push(res.json().markdown);
    }
    const path = input.kind === 'issue' ? 'issues' : 'merge_requests';
    const body = images.length ? `${input.body}\n\n${images.join('\n')}` : input.body;
    const res = await ctx.http.request({
      method: 'POST',
      url: `https://gitlab.com/api/v4/projects/${project}/${path}/${input.iid}/notes`,
      json: { body },
      credential: 'gitlab_token',
    });
    if (!res.ok) throw fail(ctx, res);
    return { noteId: res.json().id, uploads: images.length };
  },
};

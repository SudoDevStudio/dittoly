const check = (ctx, res) => {
  if (!res.ok) throw new ctx.ActionError(`http_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
  const data = res.json();
  // Slack reports most errors with HTTP 200 and ok: false.
  if (!data.ok) throw new ctx.ActionError('slack_rejected', { retryable: data.error === 'ratelimited' });
  return data;
};

export const actions = {
  async post(input, ctx) {
    const shots = input.screenshots ?? [];
    if (!shots.length) {
      check(ctx, await ctx.http.request({ method: 'POST', url: 'https://slack.com/api/chat.postMessage', json: { channel: input.channel, text: input.text }, credential: 'slack_token' }));
      return { files: 0 };
    }
    // Slack's upload flow: ask for an upload URL per file, send the bytes there, then share them with the text.
    const files = [];
    for (const [i, dataUrl] of shots.entries()) {
      const filename = `screenshot-${i + 1}.${dataUrl.startsWith('data:image/png') ? 'png' : 'jpg'}`;
      const length = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4) - (dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0);
      const slot = check(
        ctx,
        await ctx.http.request({
          method: 'POST',
          url: 'https://slack.com/api/files.getUploadURLExternal',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ filename, length: String(length) }).toString(),
          credential: 'slack_token',
        }),
      );
      const up = await ctx.http.request({ method: 'POST', url: slot.upload_url, multipart: [{ name: 'file', filename, dataUrl }] });
      if (!up.ok) throw new ctx.ActionError(`upload_${up.status}`, { retryable: up.status >= 500 });
      files.push({ id: slot.file_id, title: filename });
    }
    check(
      ctx,
      await ctx.http.request({
        method: 'POST',
        url: 'https://slack.com/api/files.completeUploadExternal',
        json: { files, channel_id: input.channel, initial_comment: input.text },
        credential: 'slack_token',
      }),
    );
    return { files: files.length };
  },
};

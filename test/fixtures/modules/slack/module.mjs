export const actions = {
  async post_message(input, ctx) {
    const res = await ctx.http.request({
      method: 'POST',
      url: 'https://slack.com/api/chat.postMessage',
      json: { channel: input.channel, text: input.text },
      credential: 'slack_token',
    });
    if (!res.ok) throw new ctx.ActionError(`http_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
    const data = res.json();
    // Slack reports most errors with HTTP 200 and ok: false.
    if (!data.ok) throw new ctx.ActionError('slack_rejected', { retryable: data.error === 'ratelimited' });
    return { ts: data.ts };
  },
  async delete_message(input, ctx) {
    const res = await ctx.http.request({
      method: 'POST',
      url: 'https://slack.com/api/chat.delete',
      json: { channel: input.channel, ts: input.ts },
      credential: 'slack_token',
    });
    if (!res.ok) throw new ctx.ActionError(`http_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
    const data = res.json();
    if (!data.ok) throw new ctx.ActionError(data.error === 'message_not_found' ? 'not_found' : 'slack_rejected', { retryable: data.error === 'ratelimited' });
    return { ts: data.ts };
  },
};

const fail = (ctx, res) => new ctx.ActionError(`datadog_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });

const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const trim = (v, n) => {
  const s = text(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** The value of a "key:value" tag, e.g. version:1.4.2 or git.commit.sha:abc123. */
const tag = (tags, key) => {
  const hit = Array.isArray(tags) ? tags.find((t) => typeof t === 'string' && t.startsWith(`${key}:`)) : undefined;
  return hit ? hit.slice(key.length + 1) : '';
};

/** The window: from/to as given, else windowMinutes either side of "around" (default: the last windowMinutes). */
function timeRange(input, ctx) {
  const minutes = input.windowMinutes ?? 15;
  if (input.from || input.to) return { from: input.from ?? `now-${minutes}m`, to: input.to ?? 'now' };
  if (!input.around) return { from: `now-${minutes}m`, to: 'now' };
  const at = Date.parse(input.around);
  if (Number.isNaN(at)) throw new ctx.ActionError('invalid_time', { retryable: false });
  return { from: new Date(at - minutes * 60_000).toISOString(), to: new Date(at + minutes * 60_000).toISOString() };
}

export const actions = {
  async search_errors(input, ctx) {
    const status = input.status ?? 'error';
    const terms = [];
    if (status !== 'any') terms.push(`status:${status}`);
    if (input.service) terms.push(`service:${input.service}`);
    if (input.traceId) terms.push(`trace_id:${input.traceId}`);
    if (input.query) terms.push(`(${input.query})`);
    const res = await ctx.http.request({
      method: 'POST',
      url: `https://${ctx.settings.site}/api/v2/logs/events/search`,
      json: {
        filter: { query: terms.join(' ') || '*', ...timeRange(input, ctx), indexes: input.indexes?.length ? input.indexes : ['*'] },
        sort: '-timestamp',
        page: { limit: input.limit ?? 20, ...(input.cursor ? { cursor: input.cursor } : {}) },
      },
      credential: 'datadog_token',
    });
    if (!res.ok) throw fail(ctx, res);
    const body = res.json();
    if (!body || !Array.isArray(body.data)) throw new ctx.ActionError('datadog_unexpected_answer', { retryable: false });

    const messageChars = input.messageChars ?? 500;
    const stackChars = input.stackChars ?? 2000;
    const logs = body.data.slice(0, input.limit ?? 20).map((entry) => {
      const a = entry?.attributes ?? {};
      const attrs = a.attributes ?? {};
      const err = attrs.error ?? {};
      return {
        id: text(entry?.id),
        timestamp: text(a.timestamp),
        service: text(a.service),
        status: text(a.status),
        host: text(a.host),
        message: trim(a.message || err.message, messageChars),
        errorKind: trim(err.kind, 200),
        stack: stackChars ? trim(err.stack, stackChars) : '',
        traceId: text(attrs.dd?.trace_id ?? attrs.trace_id),
        version: trim(attrs.version || tag(a.tags, 'version'), 100),
        commit: trim(attrs.git?.commit?.sha || tag(a.tags, 'git.commit.sha'), 64),
      };
    });

    // One text block for an AI step or a table cell: the newest entries first, cut to digestChars.
    const digestChars = input.digestChars ?? 8000;
    let digest = '';
    for (const l of logs) {
      const line = `${l.timestamp} ${l.service} ${l.status}${l.version ? ` v${l.version}` : ''}: ${l.message}${l.stack ? `\n${l.stack}` : ''}\n`;
      if (digest.length + line.length > digestChars) break;
      digest += line;
    }
    const after = body.meta?.page?.after;
    return {
      logs,
      count: logs.length,
      nextCursor: typeof after === 'string' && after ? after : null,
      truncated: typeof after === 'string' && after.length > 0,
      partial: body.meta?.status === 'timeout' || (Array.isArray(body.meta?.warnings) && body.meta.warnings.length > 0),
      digest,
    };
  },
};

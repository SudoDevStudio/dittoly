const fail = (ctx, res) => new ctx.ActionError(`loki_${res.status}`, { retryable: res.status === 429 || res.status >= 500 });

const trim = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Labels worth showing; the rest (and long values) are left out to keep the output small. */
const KEEP = ['service_name', 'service', 'app', 'job', 'level', 'detected_level', 'namespace', 'pod', 'container', 'env', 'version', 'commit'];
const TRACE = /(?:trace[_-]?id|traceID)["']?\s*[:=]\s*["']?([A-Za-z0-9-]{8,64})/i;
const TENANT = /^[A-Za-z0-9_.|-]{1,150}$/;

/** Nanoseconds since the epoch, as Loki takes them. */
const nanos = (ms) => `${Math.floor(ms)}000000`;

function timeRange(input, ctx) {
  const parse = (v) => {
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new ctx.ActionError('invalid_time', { retryable: false });
    return t;
  };
  const minutes = input.windowMinutes ?? 15;
  if (input.start || input.end) {
    const end = input.end ? parse(input.end) : Date.now();
    return { start: input.start ? parse(input.start) : end - minutes * 60_000, end };
  }
  const at = input.around ? parse(input.around) : Date.now();
  return { start: at - minutes * 60_000, end: input.around ? at + minutes * 60_000 : at };
}

export const actions = {
  async query_logs(input, ctx) {
    const tenant = ctx.settings.tenant ?? '';
    if (tenant && !TENANT.test(tenant)) throw new ctx.ActionError('invalid_tenant_setting', { retryable: false });
    const { start, end } = timeRange(input, ctx);
    const limit = input.limit ?? 50;
    const params = new URLSearchParams({
      query: input.query,
      start: nanos(start),
      end: nanos(end),
      limit: String(limit),
      direction: input.direction ?? 'backward',
    });
    const res = await ctx.http.request({
      method: 'GET',
      url: `https://${ctx.settings.site}/loki/api/v1/query_range?${params}`,
      headers: tenant ? { 'X-Scope-OrgID': tenant } : {},
      credential: 'loki_login',
    });
    if (res.status === 401 || res.status === 403) throw new ctx.ActionError('needs_credential', { retryable: false });
    if (!res.ok) throw fail(ctx, res);
    const body = res.json();
    const data = body?.data;
    if (!data || !Array.isArray(data.result)) throw new ctx.ActionError('loki_unexpected_answer', { retryable: false });
    if (data.resultType !== 'streams') throw new ctx.ActionError('not_a_log_query', { retryable: false });

    const all = [];
    for (const s of data.result) {
      const stream = s?.stream && typeof s.stream === 'object' ? s.stream : {};
      const labels = {};
      for (const k of KEEP) if (typeof stream[k] === 'string') labels[k] = trim(stream[k], 100);
      for (const v of Array.isArray(s?.values) ? s.values : []) {
        if (Array.isArray(v) && typeof v[0] === 'string' && /^[0-9]{1,20}$/.test(v[0]) && typeof v[1] === 'string') all.push({ ts: v[0], labels, raw: v[1], stream });
      }
    }
    const newestFirst = (input.direction ?? 'backward') === 'backward';
    all.sort((a, b) => (a.ts.length - b.ts.length || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)) * (newestFirst ? -1 : 1));

    const lineChars = input.lineChars ?? 1000;
    const lines = all.slice(0, limit).map((e) => ({
      timestamp: new Date(Number(e.ts.slice(0, -6) || '0')).toISOString(),
      labels: e.labels,
      line: trim(e.raw, lineChars),
      traceId: typeof e.stream.trace_id === 'string' ? trim(e.stream.trace_id, 64) : (TRACE.exec(e.raw)?.[1] ?? ''),
    }));

    const digestChars = input.digestChars ?? 8000;
    let digest = '';
    for (const l of lines) {
      const who = l.labels.service_name ?? l.labels.service ?? l.labels.app ?? l.labels.job ?? '';
      const row = `${l.timestamp} ${who}: ${l.line}\n`;
      if (digest.length + row.length > digestChars) break;
      digest += row;
    }
    return { lines, count: lines.length, truncated: all.length >= limit, digest };
  },
};

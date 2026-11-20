/**
 * PII-safe structured logging.
 *
 * Only allow-listed field names are written, and each value must look like an
 * identifier, status, error type or number. Anything else is dropped, never
 * written. There is deliberately no way to log a free-form message, payload,
 * URL query, header or error text.
 */

const ALLOWED_FIELDS = [
  'runId',
  'stepId',
  'flowId',
  'flowVersionId',
  'moduleVersionId',
  'triggerId',
  'delegationId',
  'memberId',
  'jobId',
  'jobKind',
  'action',
  'status',
  'errorType',
  'attempt',
  'durationMs',
  'waitMs',
  'httpStatus',
  'route',
  'method',
  'mode',
  'port',
  'count',
  'channel',
] as const;

export type LogField = (typeof ALLOWED_FIELDS)[number];
export type LogFields = Partial<Record<LogField, string | number | boolean | null | undefined>>;

const allowed = new Set<string>(ALLOWED_FIELDS);
/** UUIDs, slugs, route patterns like /runs/:id, error types like http_503. */
const SAFE_STRING = /^[A-Za-z0-9_.:/@-]{1,80}$/;
const EMAIL_LIKE = /@[^/]*\./;

export function sanitize(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue;
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && SAFE_STRING.test(value) && !EMAIL_LIKE.test(value)) out[key] = value;
  }
  return out;
}

export type LogSink = (line: string) => void;

let sink: LogSink = (line) => process.stdout.write(line + '\n');
let level: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'info';
const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;

export function setLogSink(next: LogSink): void {
  sink = next;
}

export function setLogLevel(next: keyof typeof order): void {
  level = next;
}

function write(lvl: Exclude<keyof typeof order, 'silent'>, event: string, fields: LogFields): void {
  if (order[lvl] < order[level]) return;
  const safeEvent = SAFE_STRING.test(event) ? event : 'invalid_event_name';
  sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, event: safeEvent, ...sanitize(fields) }));
}

export const log = {
  debug: (event: string, fields: LogFields = {}) => write('debug', event, fields),
  info: (event: string, fields: LogFields = {}) => write('info', event, fields),
  warn: (event: string, fields: LogFields = {}) => write('warn', event, fields),
  error: (event: string, fields: LogFields = {}) => write('error', event, fields),
};

/** Reduce any thrown value to a safe error type: never its message. */
export function errorType(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code.toLowerCase();
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name)) return name.toLowerCase();
  }
  return 'unknown_error';
}

// Node.js errors from whatever a sender posts (a log entry, log lines, a stack trace, a list of
// errors, a Grafana alert...) and from Loki log lines, as plain functions of the data a Flow passes
// in. No network: the Flow reads Loki or asks the AI, this module picks the error and cleans its stack.

const SERVICE = /^[A-Za-z0-9_.:/-]{1,100}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const TRACE = /^[A-Za-z0-9-]{1,64}$/;
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*){1,5}$/;
const REPO_PATH = /^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*(\/[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*){0,30}$/;
const ERROR_LEVELS = new Set(['error', 'fatal', 'critical', 'crit', 'emerg', 'alert', 'panic']);
/** Where Node apps usually live inside their container; the rest of the path is the repository's. */
const ROOTS = ['/usr/src/app/', '/home/node/app/', '/opt/app/', '/srv/app/', '/workspace/', '/var/task/', '/app/'];
const TEST_DIRS = ['test/', 'tests/', '__tests__/', 'spec/'];
const LOKI_QUERY = '{service_name="{service}"} |~ "(?i)(error|exception|\\"level\\":\\\\s*(50|60))"';

const str = (v, n) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) : v) : '');
const oneLine = (s) => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const first = (...vs) => vs.find((v) => typeof v === 'string' && v.trim() !== '') ?? '';

/** pino and bunyan use numbers (50 error, 60 fatal); winston and others use names. */
function isErrorLevel(level) {
  if (typeof level === 'number') return level >= 50;
  return typeof level === 'string' && (ERROR_LEVELS.has(level.toLowerCase()) || (/^\d+$/.test(level) && Number(level) >= 50));
}

/** A JSON log line from pino, winston or bunyan (or anything shaped like them), or a plain text line. */
function readLine(entry) {
  const raw = str(entry?.line, 20_000);
  let o = null;
  if (raw.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      o = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      o = null; // cut off by the line limit or not JSON: read as text below
    }
  }
  if (!o) return readText(raw, str(entry?.traceId, 64));
  return readObject(o, false, str(entry?.traceId, 64));
}

/** A line or block of plain text: an error when it says so or carries a stack trace. */
function readText(raw, traceId = '') {
  const at = raw.search(/\n\s+at\s/);
  const head = (at === -1 ? raw : raw.slice(0, at)).split('\n')[0] ?? '';
  return {
    error: /\b(error|fatal|exception|panic)\b/i.test(head) || at !== -1,
    message: oneLine(head),
    stack: at === -1 ? '' : raw,
    traceId,
    commit: '',
    service: '',
    time: '',
  };
}

/** A log entry as an object; `hinted` when it sits under a key such as "errors", so it counts as an error. */
function readObject(o, hinted = false, traceId = '') {
  const err = [o.err, o.error, o.exception].find((e) => e && typeof e === 'object' && !Array.isArray(e)) ?? {};
  const type = first(err.type, err.name);
  const text = first(err.message, typeof o.error === 'string' ? o.error : '', typeof o.exception === 'string' ? o.exception : '', o.msg, o.message);
  const stack = first(err.stack, err.stacktrace, o.stack, o.stacktrace);
  const message = type && !text.startsWith(type) ? `${type}: ${text}` : text || first(stack.split('\n')[0]);
  const commit = first(o.commit, o.git_commit, o.gitCommit, o.version).toLowerCase();
  const time = typeof o.time === 'number' || typeof o.timestamp === 'number' ? new Date(Number(o.time ?? o.timestamp)).toISOString() : first(o.timestamp, o.time, o['@timestamp'], o.ts, o.createdAt);
  return {
    error: isErrorLevel(o.level ?? o.severity ?? o.lvl) || Boolean(stack) || (hinted && Boolean(text)),
    message: oneLine(message),
    stack,
    traceId: first(o.trace_id, o.traceId, o.traceID, o['trace.id'], traceId),
    commit: SHA.test(commit) ? commit : '',
    service: first(o.service, o.service_name, o.serviceName, o.app, o.application),
    time: str(time, 40),
  };
}

const ERROR_KEY = /err|exception|fail|crash|fault|problem|incident/i;
const LOG_KEYS = ['err', 'error', 'exception', 'stack', 'stacktrace', 'level', 'severity', 'lvl', 'msg', 'message'];

/**
 * Every log entry found anywhere in a payload, in order: objects shaped like log entries, Loki
 * entries ({ line }), JSON in strings, text with a stack trace, and log lines in a block of text.
 */
function collect(value, out, hinted = false, depth = 0) {
  if (out.length >= 500 || depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const text = value.length > 50_000 ? value.slice(0, 50_000) : value;
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        collect(JSON.parse(t), out, hinted, depth + 1);
        return;
      } catch {
        // not JSON (or several JSON lines): read below
      }
    }
    if (/\n\s+at\s/.test(text)) {
      out.push(readText(text));
      return;
    }
    for (const line of text.split(/\r?\n/).slice(0, 500)) {
      if (line.trim()) out.push(line.trim().startsWith('{') ? readLine({ line: line.trim() }) : readText(line));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 500)) collect(v, out, hinted, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  if (typeof value.line === 'string') {
    out.push(readLine(value));
    return;
  }
  const isEntry = LOG_KEYS.some((k) => k in value) && (typeof value.message === 'string' || typeof value.msg === 'string' || typeof value.error === 'string' || typeof value.stack === 'string' || (value.error && typeof value.error === 'object') || (value.err && typeof value.err === 'object') || (value.exception && typeof value.exception === 'object'));
  if (isEntry) out.push(readObject(value, hinted));
  for (const [k, v] of Object.entries(value)) {
    if (isEntry && LOG_KEYS.includes(k)) continue;
    if (v && typeof v === 'object') collect(v, out, hinted || ERROR_KEY.test(k), depth + 1);
    else if (typeof v === 'string' && (v.includes('\n') || /^\s*[[{]/.test(v))) collect(v, out, hinted || ERROR_KEY.test(k), depth + 1);
  }
}

/** The first Grafana alert in a payload: a whole webhook ({ alerts: [...] }, the first firing one) or one alert. */
function grafanaAlert(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (Array.isArray(p.alerts) && p.alerts.some((a) => a && typeof a === 'object' && a.labels)) return p.alerts.find((a) => a?.status === 'firing') ?? p.alerts[0];
  return p.labels && typeof p.labels === 'object' && typeof p.status === 'string' ? p : null;
}

const fieldOf = (p, ...keys) => (p && typeof p === 'object' && !Array.isArray(p) ? first(...keys.map((k) => p[k])) : '');

/** A path from a stack frame as a repository path: file:// URLs and the container's app folder removed. */
function repoPath(p, roots) {
  let path = p.startsWith('file://') ? p.slice(7) : p;
  try {
    path = decodeURIComponent(path);
  } catch {
    path = p.slice(p.startsWith('file://') ? 7 : 0); // a stray "%": keep the path as written
  }
  for (const root of roots) {
    if (path.startsWith(root)) {
      path = path.slice(root.length);
      break;
    }
  }
  return path;
}

const VENDOR = /node_modules\/|^node:|^internal\/|<anonymous>/;

/**
 * Rewrites each "at fn (path:line:col)" frame with repository paths, drops "async"/"new" before the
 * function (so the fingerprint's top frame reads the same for sync and async code), and lists the
 * app's own files, top frame first.
 */
function cleanStack(stack, roots) {
  const files = [];
  const lines = stack.split('\n').slice(0, 80).map((line) => {
    const m = /^(\s*at\s+)(?:(?:async|new)\s+)?(?:(.+?)\s+\()?((?:file:\/\/)?[^()\s]+?)(:\d+(?::\d+)?)?(\)?)\s*$/.exec(line);
    if (!m) return line;
    const path = repoPath(m[3], roots);
    if (!VENDOR.test(path) && !path.startsWith('/') && !path.split('/').includes('..') && REPO_PATH.test(path) && !files.includes(path)) files.push(path);
    return m[2] ? `${m[1]}${m[2]} (${path}${m[4] ?? ''})` : `${m[1]}${path}${m[4] ?? ''}`;
  });
  return { stack: lines.join('\n'), files: files.slice(0, 10) };
}

/** A Grafana alert: only a firing one starts a fix; a resolved one (or anything else) stops the run. */
async function grafana(a, input, ctx) {
  if (a.status !== 'firing') throw new ctx.ActionError('alert_not_firing', { retryable: false });
  const labels = a.labels && typeof a.labels === 'object' ? a.labels : {};
  const notes = a.annotations && typeof a.annotations === 'object' ? a.annotations : {};
  const service = first(labels.service_name, labels.service, labels.app, labels.job);
  if (!SERVICE.test(service)) throw new ctx.ActionError('alert_has_no_service_label', { retryable: false });
  const repo = first(labels.repo, input.defaultRepo);
  if (!REPO.test(repo)) throw new ctx.ActionError('alert_has_no_repo', { retryable: false });
  const commit = first(labels.commit, notes.commit).toLowerCase();
  const startsAt = Date.parse(str(a.startsAt, 40));
  const query = (input.lokiQuery ?? LOKI_QUERY).split('{service}').join(service);
  if (!query.startsWith('{')) throw new ctx.ActionError('invalid_loki_query', { retryable: false });
  return {
    service,
    repo,
    commit: SHA.test(commit) ? commit : '',
    time: new Date(Number.isNaN(startsAt) || startsAt < 0 ? Date.now() : startsAt).toISOString(),
    summary: oneLine(first(notes.summary, notes.description, labels.alertname, `Errors in ${service}`)).slice(0, 2000),
    lokiQuery: query,
  };
}

/** The picked error with its stack in repository paths, and the files a fix may change. */
function summarize(pick, errorLines, input) {
  const roots = [...(input.containerRoots ?? []), ...ROOTS].map((r) => (r.endsWith('/') ? r : `${r}/`));
  const { stack, files } = cleanStack(str(pick.stack, 50_000), roots);
  const testDirs = input.testDirs ?? TEST_DIRS;
  return {
    message: oneLine(str(pick.message, 4000)).slice(0, 4000),
    stack,
    traceId: TRACE.test(pick.traceId ?? '') ? pick.traceId : '',
    commit: SHA.test(pick.commit ?? '') ? pick.commit : '',
    appFiles: files,
    // Without a file of the app's own in the stack, the fix may change the app's source folders.
    onlyFilesIn: [...(files.length ? files : (input.fallbackFiles ?? ['src/', 'lib/'])), ...testDirs],
    errorLines,
  };
}

/** The AI's answer ({ found, message, stack, service, time, commit } as JSON, maybe in a code fence), or null. */
function readAi(text) {
  const raw = str(text, 60_000).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let o;
  try {
    o = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.found === false || typeof o.message !== 'string' || !o.message.trim()) return null;
  const commit = str(o.commit, 40).toLowerCase();
  return { message: oneLine(o.message), stack: str(o.stack, 50_000), traceId: '', commit: SHA.test(commit) ? commit : '', service: str(o.service, 100), time: str(o.time, 40) };
}

const EMPTY = { found: false, needsLogs: false, needsAi: false, service: '', repo: '', commit: '', time: '', summary: '', lokiQuery: '', message: '', stack: '', traceId: '', appFiles: [], onlyFilesIn: [], errorLines: 0, evidence: '' };

export const actions = {
  /** One alert of a Grafana webhook (alerts[0]): the service, time, repository and commit, and the Loki query for its errors. */
  async from_grafana(input, ctx) {
    return grafana(input.alert ?? {}, input, ctx);
  },

  /**
   * Finds the error in whatever was posted. A Grafana alert says where to look in Loki (needsLogs);
   * anything else is searched for log entries and stack traces; when nothing is found, the Flow asks
   * the AI (needsAi).
   */
  async find_error(input, ctx) {
    let payload = input.payload;
    if (typeof payload === 'string' && /^\s*[[{]/.test(payload)) {
      try {
        payload = JSON.parse(payload);
      } catch {
        // text after all
      }
    }
    const evidence = str(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null), 8000);
    const alert = grafanaAlert(payload);
    if (alert) return { ...EMPTY, ...(await grafana(alert, input, ctx)), needsLogs: true, evidence };
    const read = [];
    collect(payload, read);
    const errors = read.filter((l) => l.error && l.message);
    const pick = errors.find((l) => l.stack) ?? errors[0] ?? null;
    // The default service only once an error is found: the AI may still name one.
    const service = first(pick?.service, fieldOf(payload, 'service', 'service_name', 'serviceName', 'app', 'application'), pick ? input.defaultService : '');
    const repo = first(fieldOf(payload, 'repo', 'repository'), input.defaultRepo);
    const time = Date.parse(first(pick?.time, fieldOf(payload, 'timestamp', 'time', 'createdAt', '@timestamp')));
    return {
      ...EMPTY,
      ...(pick ? summarize(pick, errors.length, input) : {}),
      found: pick !== null,
      needsAi: pick === null,
      service: SERVICE.test(service) ? service : '',
      repo: REPO.test(repo) ? repo : '',
      time: new Date(Number.isNaN(time) || time < 0 ? Date.now() : time).toISOString(),
      evidence,
    };
  },

  /**
   * The error to fix, from whichever way it was found: the payload itself, Loki (after a Grafana
   * alert), or the AI's answer. Steps skipped by their condition pass null.
   */
  async choose(input, ctx) {
    const found = input.found ?? {};
    let err;
    let evidence = str(found.evidence, 8000);
    let source = 'payload';
    if (found.needsLogs) {
      const picked = input.picked ?? {};
      err = { message: str(picked.message, 4000), stack: str(picked.stack, 50_000), traceId: str(picked.traceId, 64), commit: str(picked.commit, 40), appFiles: picked.appFiles ?? [], onlyFilesIn: picked.onlyFilesIn ?? [], errorLines: picked.errorLines ?? 0 };
      evidence = str(input.logs?.digest, 8000);
      source = 'loki';
    } else if (found.found) {
      err = found;
    } else {
      const answer = readAi(input.ai?.text);
      if (!answer) throw new ctx.ActionError('no_error_found', { retryable: false });
      err = summarize(answer, 1, input);
      source = 'ai';
      found.service = found.service || (SERVICE.test(answer.service) ? answer.service : '');
      const t = Date.parse(answer.time);
      if (!Number.isNaN(t) && t >= 0) found.time = new Date(t).toISOString();
    }
    const service = first(found.service, input.defaultService);
    if (!SERVICE.test(service)) throw new ctx.ActionError('error_has_no_service', { retryable: false });
    const repo = first(found.repo, input.defaultRepo);
    if (!REPO.test(repo)) throw new ctx.ActionError('error_has_no_repo', { retryable: false });
    return {
      service,
      repo,
      time: str(found.time, 40) || new Date().toISOString(),
      message: str(err.message, 4000) || 'Error',
      stack: str(err.stack, 50_000),
      traceId: TRACE.test(err.traceId ?? '') ? err.traceId : '',
      commit: SHA.test(err.commit ?? '') ? err.commit : SHA.test(found.commit ?? '') ? found.commit : '',
      appFiles: (err.appFiles ?? []).slice(0, 10),
      onlyFilesIn: (err.onlyFilesIn ?? []).slice(0, 20),
      errorLines: Number.isInteger(err.errorLines) ? err.errorLines : 0,
      evidence,
      source,
    };
  },

  /** The newest error in the log lines (one with a stack trace first), its stack with repository paths, and the files a fix may change. */
  async pick_error(input) {
    // The lines come newest first (the Loki module's default).
    const read = (input.lines ?? []).slice(0, 200).map(readLine).filter((l) => l.error && l.message);
    const pick = read.find((l) => l.stack) ?? read[0] ?? null;
    const out = summarize(pick ?? { message: '', stack: '', traceId: '', commit: '' }, read.length, input);
    return {
      found: pick !== null,
      ...out,
      message: (pick?.message || oneLine(str(input.fallbackMessage, 2000)) || 'Error').slice(0, 4000),
      commit: out.commit || (SHA.test(input.alertCommit ?? '') ? input.alertCommit : ''),
    };
  },
};

// Errors of apps in any major language (JavaScript and TypeScript, Python, Java and Kotlin, Go, Rust, C#,
// Ruby, PHP) from whatever a sender posts (a log entry, log lines, a stack trace, a list of errors, a
// Grafana alert...) and from Loki log lines, as plain functions of the data a Flow passes in. No network:
// the Flow reads Loki or asks the AI, this module picks the error and cleans its stack.

const SERVICE = /^[A-Za-z0-9_.:/-]{1,100}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const TRACE = /^[A-Za-z0-9-]{1,64}$/;
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*){1,5}$/;
const REPO_PATH = /^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*(\/[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*){0,30}$/;
const ERROR_LEVELS = new Set(['error', 'err', 'fatal', 'critical', 'crit', 'emerg', 'alert', 'panic', 'dpanic', 'severe']);
/** Where apps usually live inside their container; the rest of the path is the repository's. */
const ROOTS = ['/usr/src/app/', '/home/node/app/', '/var/www/html/', '/opt/app/', '/srv/app/', '/go/src/app/', '/workspace/', '/var/task/', '/var/www/', '/rails/', '/build/', '/code/', '/app/', '/src/'];
const TEST_DIRS = ['test/', 'tests/', '__tests__/', 'spec/', 'src/test/'];
const LOKI_QUERY = '{service_name="{service}"} |~ "(?i)(error|exception|panic|traceback|fatal|\\"level\\":\\\\s*(50|60))"';
/** Go module paths in -trimpath builds start with a host; these hosts have owner/repo after them. */
const FORGES = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

/** A stack trace in a block of text, in any of the languages. */
const STACK =
  /\n\s+at\s|^Traceback \(most recent call last\)|\n\s*File "[^"]+", line \d+|\ngoroutine \d+ \[|panicked at |\n\s+from \S+:\d+:in |\nStack trace:\n#0 |^\S+\.rb:\d+:in /m;

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

/**
 * The error's message from a block of text with a stack trace, as each language prints it: the last line of
 * a Python traceback, the line after a Rust panic, "Class: message" from a Ruby or PHP first line, else the
 * first line (JavaScript, JVM, .NET, Go).
 */
function messageOf(raw) {
  const lines = raw.split('\n');
  const head = lines[0] ?? '';
  if (/^Traceback \(most recent call last\)/.test(head.trim())) {
    const last = [...lines].reverse().find((l) => l.trim() && !/^\s/.test(l));
    return last && last !== head ? last : head;
  }
  const rust = lines.findIndex((l) => / panicked at \S+:$/.test(l.trim()));
  if (rust !== -1 && lines[rust + 1]?.trim()) return `panic: ${lines[rust + 1].trim()}`;
  const rb = /^\S+\.rb:\d+:in [`'][^']*': (.*) \(([\w:]+)\)$/.exec(head);
  if (rb) return `${rb[2]}: ${rb[1]}`;
  const php = /PHP Fatal error:\s+Uncaught (\w[\w\\]*): (.*?) in \S+\.php:\d+$/.exec(head);
  if (php) return `${php[1]}: ${php[2]}`;
  return head.replace(/^Unhandled exception\. /, '').replace(/^Exception in thread "[^"]*" /, '');
}

/** A line or block of plain text: an error when it says so or carries a stack trace. */
function readText(raw, traceId = '') {
  const hasStack = STACK.test(raw);
  const head = (hasStack ? messageOf(raw) : raw.split('\n')[0]) ?? '';
  return {
    error: /\b(error|fatal|exception|panic|panicked|traceback)\b/i.test(head) || hasStack,
    message: oneLine(head),
    stack: hasStack ? raw : '',
    traceId,
    commit: '',
    service: '',
    time: '',
  };
}

/** A log entry as an object; `hinted` when it sits under a key such as "errors", so it counts as an error. */
function readObject(o, hinted = false, traceId = '') {
  const err = [o.err, o.error, o.exception].find((e) => e && typeof e === 'object' && !Array.isArray(e)) ?? {};
  const type = first(err.type, err.name, err.kind, err.class, o['error.type'], o.exception_class);
  // Serilog's compact JSON (@x the exception, @m the message), python-json-logger (exc_info), Logback's
  // and ECS's stack_trace, zap's stacktrace, a Ruby backtrace list.
  const textException = first(o['@x'], o.Exception, typeof o.exception === 'string' ? o.exception : '', o.exc_info);
  const backtrace = Array.isArray(o.backtrace) ? o.backtrace.filter((l) => typeof l === 'string').join('\n') : '';
  const stack = first(err.stack, err.stacktrace, err.stack_trace, o.stack, o.stacktrace, o.stack_trace, o['error.stack_trace'], textException, backtrace);
  const fromStack = stack && STACK.test(stack) ? messageOf(stack) : '';
  const text = first(err.message, o['error.message'], typeof o.error === 'string' ? o.error : '', o.msg, o.message, o['@m'], o['@mt'], fromStack);
  const message = type && !text.startsWith(type) ? `${type}: ${text}` : text || first(stack.split('\n')[0]);
  const commit = first(o.commit, o.git_commit, o.gitCommit, o.version).toLowerCase();
  const time = typeof o.time === 'number' || typeof o.timestamp === 'number' ? new Date(Number(o.time ?? o.timestamp)).toISOString() : first(o.timestamp, o.time, o['@timestamp'], o.ts, o.createdAt);
  return {
    error: isErrorLevel(o.level ?? o.severity ?? o.lvl ?? o.levelname ?? o['log.level'] ?? (o.log && typeof o.log === 'object' ? o.log.level : undefined) ?? o['@l']) || Boolean(stack) || (hinted && Boolean(text)),
    message: oneLine(message),
    stack,
    traceId: first(o.trace_id, o.traceId, o.traceID, o['trace.id'], traceId),
    commit: SHA.test(commit) ? commit : '',
    service: first(o.service, o.service_name, o.serviceName, o.app, o.application),
    time: str(time, 40),
  };
}

const ERROR_KEY = /err|exception|fail|crash|fault|problem|incident/i;
const LOG_KEYS = ['err', 'error', 'exception', 'Exception', 'stack', 'stacktrace', 'stack_trace', 'exc_info', 'backtrace', 'level', 'levelname', 'severity', 'lvl', 'msg', 'message', '@x', '@m', '@mt', '@l'];

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
    if (STACK.test(text)) {
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
  const isEntry =
    LOG_KEYS.some((k) => k in value) &&
    (['message', 'msg', 'error', 'stack', 'stack_trace', 'stacktrace', 'Exception', 'exception', '@x', '@m', '@mt'].some((k) => typeof value[k] === 'string') ||
      Array.isArray(value.backtrace) ||
      ['error', 'err', 'exception'].some((k) => value[k] && typeof value[k] === 'object'));
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

/**
 * A path from a stack frame as a repository path: file:// URLs, a leading "./" and the container's app
 * folder removed; a Go module path from a -trimpath build ("example.com/shop/internal/cart/cart.go") loses
 * its module part.
 */
function repoPath(p, roots) {
  let path = p.startsWith('file://') ? p.slice(7) : p;
  try {
    path = decodeURIComponent(path);
  } catch {
    path = p.slice(p.startsWith('file://') ? 7 : 0); // a stray "%": keep the path as written
  }
  path = path.replace(/^\.\//, '');
  for (const root of roots) {
    if (path.startsWith(root)) {
      path = path.slice(root.length);
      break;
    }
  }
  const parts = path.split('/');
  if (path.endsWith('.go') && !path.startsWith('/') && parts[0].includes('.') && parts.length > 2) {
    path = parts.slice(FORGES.has(parts[0]) ? 3 : 2).join('/');
  }
  return path;
}

/** Runtimes, standard libraries and installed packages, by language: never the app's own files. */
const VENDOR = /node_modules\/|^node:|^internal\/[\w/]+\.js$|<anonymous>|^bun:|^ext:|site-packages\/|dist-packages\/|^\/usr\/(local\/)?lib\/|^\/usr\/local\/go\/|\/go\/pkg\/mod\/|^\/rustc\/|\.cargo\/registry\/|\/gems\/|^vendor\/|\/vendor\/|^\[internal/;
/** JVM classes of the platform and common libraries. */
const JVM_VENDOR = /^(java|javax|jdk|sun|com\.sun|kotlin|kotlinx|scala|groovy|org\.junit|org\.springframework|org\.apache|org\.hibernate|io\.netty|io\.micronaut|io\.quarkus|io\.ktor|reactor|com\.fasterxml)\./;

/**
 * Each frame format, as [pattern, the group holding the path]: the path is rewritten in place. JavaScript
 * ("at fn (path:1:2)"), .NET ("at X in path:line 1"), Python ('File "path", line 1'), Go ("\tpath:1 +0x1d"),
 * Rust ("at ./src/x.rs:1:2", "panicked at src/x.rs:1:2:"), Ruby ("path:1:in 'm'", "from path:1:in"), PHP
 * ("#0 path(1): f()", "in path:1", "thrown in path on line 1").
 */
const FRAMES = [
  [/^(\s*at\s+.+?\s+in\s+)(.+?\.(?:cs|fs|vb))(:line \d+.*)$/, 2],
  [/^(\s*at\s+(?:(?:async|new)\s+)?(?:.+?\s+\()?)((?:file:\/\/)?[^()\s]+?\.(?:[cm]?[jt]sx?|vue|svelte))((?::\d+){1,2}\)?\s*)$/, 2],
  [/^(\s*File ")([^"]+\.pyw?)(", line \d+.*)$/, 2],
  [/^(\t)(\S+\.go)(:\d+.*)$/, 2],
  [/^(\s+at\s+)(\S+\.rs)(:\d+:\d+\s*)$/, 2],
  [/^(.* panicked at )(\S+\.rs)(:\d+:\d+:\s*)$/, 2],
  [/^(\s*(?:from\s+)?)(\S+\.(?:rb|rake|erb))(:\d+:in .*)$/, 2],
  [/^(#\d+\s+)(\S+\.php)(\(\d+\):.*)$/, 2],
  [/^(.* in )(\S+\.php)(:\d+\s*)$/, 2],
  [/^(\s*thrown in )(\S+\.php)( on line \d+\s*)$/, 2],
];

/**
 * Rewrites the frames with repository paths and lists the app's own files, top frame first. A JVM frame
 * names its class and file only ("at com.acme.shop.Cart.total(Cart.java:6)"): its file is a rule that
 * matches that package folder under any source root ("**\/com/acme/shop/Cart.java"). JavaScript frames lose
 * "async"/"new" before the function, so the fingerprint's top frame reads the same for sync and async code.
 */
function cleanStack(stack, roots) {
  const files = [];
  const add = (path) => {
    if (!VENDOR.test(path) && !path.startsWith('/') && !path.split('/').includes('..') && (REPO_PATH.test(path) || /^\*\*\/[\w/.-]+$/.test(path)) && !files.includes(path)) files.push(path);
  };
  const lines = stack.split('\n').slice(0, 120).map((line) => {
    const jvm = /^\s*at\s+(?:[\w.$-]+\/)*([\w.$]+)\.[\w$<>]+\(([\w$]+\.(?:java|kt|kts|scala|groovy)):\d+\)\s*$/.exec(line);
    if (jvm) {
      if (!JVM_VENDOR.test(jvm[1])) {
        const pkg = jvm[1].split('.').filter((part, i, all) => i < all.length - 1 && /^[a-z_][\w]*$/.test(part));
        add(`**/${[...pkg, jvm[2]].join('/')}`);
      }
      return line;
    }
    for (const [re] of FRAMES) {
      const m = re.exec(line);
      if (!m) continue;
      const path = repoPath(m[2], roots);
      add(path);
      const head = re === FRAMES[1][0] ? m[1].replace(/(at\s+)(?:async|new)\s+/, '$1') : m[1];
      return `${head}${path}${m[3]}`;
    }
    return line;
  });
  // Python prints the outermost call first: its files are reversed so the failing one comes first.
  if (/^Traceback \(most recent call last\)/m.test(stack)) files.reverse();
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
    onlyFilesIn: [...(files.length ? files : (input.fallbackFiles ?? ['src/', 'lib/', 'app/'])), ...testDirs],
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

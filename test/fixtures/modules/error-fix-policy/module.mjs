// The "error to verified fix" rules, as plain functions of the data a Flow passes in. No network:
// the Flow reads its error_fixes table and the forge, this module decides, the Flow acts.

const HOUR = 3_600_000;
const CHANGE_PATH = /^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*(\/[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*){0,30}$/;
const SHA = /^[0-9a-f]{40}$/;

const str = (v, n = 10_000) => (typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…` : v) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);
const time = (v) => {
  const t = typeof v === 'string' && v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};
const oneLine = (s) => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Text from logs or an AI, made safe to put in a GitLab or GitHub Markdown body: no quick actions
 * ("/merge" at the start of a line), no @mentions that notify people, no closing code fence.
 */
const inert = (s) => s.replace(/^(\s*)\//gm, '$1\\/').replace(/@(?=[A-Za-z0-9_-])/g, '@​').replace(/```/g, "'''");

/** The error's stable part: ids, numbers, hex, quoted values and URLs replaced, whitespace folded. */
function normalizeMessage(message) {
  return oneLine(message.split('\n')[0] ?? '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/"[^"]{0,200}"|'[^']{0,200}'|`[^`]{0,200}`/g, '<str>')
    .replace(/\b(0x)?[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .slice(0, 300);
}

const ERROR_TYPE = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception|Fault|Panic))\b|^(panic):|\b(panicked) at\b|^(fatal error):/m;
/** Frames of runtimes and installed packages: never the app's own code. */
const VENDOR = /node_modules|site-packages|dist-packages|node:internal|internal\/|\/usr\/lib\/|<anonymous>|\bjava\.base\//;
/** The same for the JVM, Go, Rust, .NET, Ruby and PHP (JavaScript and Python frames keep VENDOR alone, so their fingerprints stay as they were). */
const OTHER_VENDOR =
  /\bat (?:java|javax|jdk|sun|kotlin|kotlinx|scala|org\.junit|org\.springframework)\.|\/usr\/local\/go\/|\/go\/pkg\/mod\/|^\s*(?:runtime|testing|net\/http)\.|\/rustc\/|\.cargo\/registry|\/library\/(?:std|core|alloc)\/|\bat (?:System|Microsoft)\.|\/gems\/|\/lib\/ruby\/|\/vendor\/|\/usr\/lib\//;
/** Paths in JavaScript and Python frames, as fingerprints have always had them (changing this would split known errors). */
const jsPath = (p) => p.replace(/^.*\/(src|app|lib)\//, '$1/');
/** Paths in the other languages' frames. */
const appPath = (p) => p.replace(/^\.\//, '').replace(/^.*\/(src|app|lib|internal|cmd|pkg)\//, '$1/');

/** A lambda's method, not its compiler-made name: .NET "Cart.<>c.<Total>b__0_0" and Java "Cart.lambda$total$0" are Cart.Total and Cart.total. */
const lambdaName = (n) => n.replace(/\.<>c(?:__DisplayClass[\w]+)?\.<(\w+)>b__\w+$/, '.$1').replace(/\.lambda\$(\w+)\$\d+$/, '.$1');

/**
 * The first stack frame in the app's own code, without line numbers (they move between releases):
 * JavaScript, Python, JVM (Java, Kotlin), Go, Rust, .NET, Ruby and PHP traces.
 */
function topFrame(stack) {
  const lines = stack.split('\n').slice(0, 120);
  // Python prints the outermost call first: the failing frame is its last one in the app's own code.
  const py = lines.map((l) => /^\s*File "([^"]+)", line \d+, in (\S+)/.exec(l)).filter((m) => m && !VENDOR.test(m[0]));
  if (py.length) return `${py.at(-1)[2]} (${jsPath(py.at(-1)[1])})`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    const js = /^\s*at\s+(?:(\S+)\s+\()?([^():]+)(?::\d+)*\)?\s*$/.exec(line);
    if (js && !VENDOR.test(line)) return oneLine(`${js[1] ?? '<fn>'} (${jsPath(js[2])})`);
    if (js || OTHER_VENDOR.test(line)) continue;
    // .NET: "at Shop.Cart.Total(IEnumerable`1 items) in /src/Shop/Cart.cs:line 12"
    const net = /^\s*at\s+([\w.`<>+]+)\(.*\)\s+in\s+(.+?):line \d+\s*$/.exec(line);
    if (net) return `${lambdaName(net[1])} (${appPath(net[2])})`;
    const jvm = /^\s*at\s+([\w$.]+)\(/.exec(line);
    if (jvm && !VENDOR.test(line)) return lambdaName(jvm[1]);
    // Go: "main.(*Cart).Total(...)" then "\t/app/internal/cart/cart.go:12 +0x1d"
    const go = /^\t(\S+\.go):\d+/.exec(next);
    if (go && /^[\w./*()-]+\(.*\)$/.test(line.trim()) && !OTHER_VENDOR.test(next)) return `${line.trim().replace(/\([^()]*\)$/, '').replace(/^.*\//, '')} (${appPath(go[1])})`;
    // Rust: "thread 'main' panicked at src/cart.rs:5:13:", or a backtrace frame "  3: shop::cart::total" then "at ./src/cart.rs:5:13"
    const rustPanic = /panicked at ([^:\s]+\.rs):\d+/.exec(line);
    if (rustPanic) return appPath(rustPanic[1]);
    const rust = /^\s*\d+:\s+([\w:<>]+)$/.exec(line);
    const rustAt = /^\s+at\s+(\S+\.rs):\d+/.exec(next);
    if (rust && rustAt && !OTHER_VENDOR.test(next)) return `${rust[1].replace(/::h[0-9a-f]{16}$/, '')} (${appPath(rustAt[1])})`;
    // Ruby: "/app/lib/cart.rb:5:in 'Cart.total': ..." or "\tfrom /app/lib/cart.rb:10:in 'block in run'"
    const rb = /^\s*(?:from\s+)?([^\s:]+\.rb):\d+:in [`']([^']+)'/.exec(line);
    if (rb) return `${rb[2]} (${appPath(rb[1])})`;
    // PHP: "#0 /var/www/html/src/Cart.php(20): Acme\Shop\Cart::total()"
    const php = /^#\d+\s+(\S+\.php)\(\d+\):\s+([^\s(]+)\(/.exec(line);
    if (php) return `${php[2]} (${appPath(php[1])})`;
  }
  return '';
}

export const actions = {
  /** Clean the alert's fields and build the text the Flow fingerprints. */
  async normalize(input, ctx) {
    const message = str(input.message, 4000);
    const stack = str(input.stack, 8000);
    const service = input.service;
    const m = ERROR_TYPE.exec(message) ?? ERROR_TYPE.exec(stack);
    const errorType = m ? (m[1] ?? (m[4] ? 'fatal error' : 'panic')) : '';
    const frame = topFrame(stack);
    // ISO 8601, or epoch seconds or milliseconds (Datadog's $DATE).
    const epoch = /^\d{10,13}$/.test(input.time ?? '') ? Number(input.time) : null;
    const at = epoch !== null ? (epoch < 1e11 ? epoch * 1000 : epoch) : time(input.time);
    const repoAllowed = (input.allowedRepos ?? []).includes(input.repo);
    const ref = SHA.test(input.commit ?? '') ? input.commit : input.targetBranch;
    const lokiQuery = (input.lokiQuery ?? '{service_name="{service}"} |~ "(?i)(error|exception|panic)"').split('{service}').join(service);
    if (!lokiQuery.startsWith('{')) throw new ctx.ActionError('invalid_loki_query', { retryable: false });
    const pattern = normalizeMessage(message);
    return {
      text: [service, errorType, pattern, frame].join(' | '),
      service,
      errorType,
      topFrame: frame,
      // The message with ids, numbers, addresses and quoted values masked: what merge requests and the table show.
      messagePattern: pattern,
      message: oneLine(message).slice(0, 2000),
      stack,
      traceId: input.traceId ?? '',
      around: new Date(at ?? Date.now()).toISOString(),
      repo: input.repo,
      repoAllowed,
      ref,
      targetBranch: input.targetBranch,
      lokiQuery,
      title: oneLine(frame ? `Fix ${errorType || 'error'} in ${service} at ${frame}` : `Fix ${errorType || 'error'} in ${service}: ${pattern.slice(0, 80)}`).slice(0, 150),
    };
  },

  /** The branch to look at: the one this error last used, else its deterministic dittoly/fix-<fingerprint>. */
  async prepare(input, ctx) {
    const slug = input.fingerprint.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (slug.length < 4) throw new ctx.ActionError('invalid_fingerprint', { retryable: false });
    const base = `dittoly/fix-${slug}`;
    const row = input.existing?.found ? input.existing.row ?? {} : {};
    const last = typeof row.branch === 'string' && /^dittoly\/fix-[a-z0-9-]{4,64}$/.test(row.branch) ? row.branch : base;
    return { fingerprint: input.fingerprint, base, branch: last };
  },

  /**
   * The no-repeat rules. Given the error's row, the forge's answer for its branch and the rows
   * changed recently, say whether this run comments, only counts, or attempts a fix.
   */
  async decide(input) {
    const now = time(input.now) ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const row = input.existing?.found && input.existing.row ? input.existing.row : null;
    // The forge's answer: GitLab's find_open_mr_by_branch says `mr`, GitHub's find_open_pr_by_head `pr`.
    const found = input.mr?.mr ?? input.mr?.pr ?? null;
    const open = input.mr?.found && found ? found : null;
    const latest = input.mr?.latest ?? null;
    const status = typeof row?.status === 'string' && row.status ? row.status : 'new';
    const timesSeen = num(row?.times_seen) + 1;
    const lastAttempt = time(row?.last_attempt);
    const lastComment = time(row?.last_comment_at);
    const within = (t, hours) => t !== null && now - t < hours * HOUR;
    const mrsLast24h = (input.recent ?? []).filter((r) => within(time(r?.mr_opened_at), 24)).length;
    const cap = input.dailyCap ?? 5;
    const base = input.base;

    let decision;
    let nextStatus = status;
    let previousMrUrl = str(row?.previous_mr_url, 500);
    let mrUrl = str(row?.mr_url, 500);
    let mrIid = num(row?.mr_iid) || null;
    let mrNumber = mrIid;

    if (!input.repoAllowed) decision = 'repo_not_allowed';
    else if (open) {
      // An open merge request for this error (recorded, or found on its branch): never a second one.
      nextStatus = 'mr_open';
      mrUrl = str(open.url, 500);
      mrIid = mrNumber = num(open.iid ?? open.number) || null;
      decision = within(lastComment, input.commentEveryHours ?? 24) ? 'mr_open_commented_recently' : 'comment_open_mr';
    } else {
      if (status === 'mr_open' || ((status === 'new' || !row) && latest)) {
        // Its merge request was merged or closed since: a new attempt references it.
        nextStatus = latest?.state === 'merged' ? 'merged' : 'closed';
        previousMrUrl = str(latest?.url, 500) || mrUrl;
      } else if (status === 'merged' || status === 'closed') previousMrUrl = mrUrl || previousMrUrl;

      if (status === 'fixing' && within(lastAttempt, input.staleFixingHours ?? 6)) decision = 'fix_in_progress';
      else if ((status === 'failed' || status === 'fixing') && within(lastAttempt, input.retryAfterHours ?? 24)) decision = 'failed_recently';
      else if (status === 'not_a_bug') decision = 'not_a_bug';
      else if (mrsLast24h >= cap) decision = 'daily_cap_reached';
      else decision = 'attempt';
    }

    const attempt = decision === 'attempt';
    const comment = decision === 'comment_open_mr';
    // A merge request already on the branch counts as an attempt even when the row was lost.
    const attemptNo = Math.max(num(row?.attempts), latest ? 1 : 0) + (attempt ? 1 : 0);
    const branch = attempt ? (attemptNo <= 1 ? base : `${base}-${attemptNo}`) : str(row?.branch, 100) || input.branch || base;
    return {
      decision,
      attempt,
      comment,
      countOnly: !attempt,
      fetchDatadog: attempt && input.logSource === 'datadog',
      fetchLoki: attempt && input.logSource === 'loki',
      status: attempt ? 'fixing' : nextStatus,
      timesSeen,
      firstSeen: str(row?.first_seen, 40) || nowIso,
      now: nowIso,
      attempts: attemptNo,
      branch,
      lastAttempt: attempt ? nowIso : str(row?.last_attempt, 40),
      lastCommentAt: comment ? nowIso : str(row?.last_comment_at, 40),
      mrUrl: attempt ? '' : mrUrl,
      mrIid: attempt ? null : mrIid,
      mrNumber: attempt ? null : mrNumber,
      previousMrUrl,
      mrsLast24h,
      commentText: comment
        ? `Seen again: this error has now happened ${timesSeen} times (last at ${nowIso}). Dittoly will not open another merge request for it while this one is open, and comments here at most once every ${input.commentEveryHours ?? 24} hours.`
        : '',
    };
  },

  /** Read the AI triage's JSON answer: go on only for a real bug, with evidence, at enough confidence. */
  async verdict(input) {
    const text = str(input.triage, 20_000);
    const from = text.indexOf('{');
    const to = text.lastIndexOf('}');
    let parsed = null;
    if (from !== -1 && to > from) {
      try {
        parsed = JSON.parse(text.slice(from, to + 1));
      } catch {
        parsed = null; // not JSON: treated as an unreadable answer below
      }
    }
    const verdict = typeof parsed?.verdict === 'string' ? parsed.verdict.toLowerCase() : '';
    const confidence = Math.max(0, Math.min(100, Math.round(num(parsed?.confidence))));
    const evidence = (Array.isArray(parsed?.evidence) ? parsed.evidence : []).filter((e) => typeof e === 'string' && e.trim()).slice(0, 10).map((e) => oneLine(e).slice(0, 300));
    const isBug = verdict === 'bug';
    const noise = verdict === 'noise' || verdict === 'not_a_bug';
    const min = input.minConfidence ?? 60;
    const proceed = isBug && confidence >= min && evidence.length > 0;
    const reason = !parsed
      ? 'triage_unreadable'
      : noise
        ? 'noise'
        : !isBug
          ? 'triage_unclear'
          : evidence.length === 0
            ? 'no_evidence'
            : confidence < min
              ? 'low_confidence'
              : 'bug';
    return {
      proceed,
      stop: !proceed,
      status: proceed ? '' : noise ? 'not_a_bug' : 'failed',
      isBug,
      confidence,
      evidence,
      reason,
      note: oneLine(`${reason}: ${str(parsed?.reason, 400)}`).slice(0, 500),
    };
  },

  /** After the fix step: push only a verified change (within limits, or for a person to decide), and write the merge request's text. */
  async gate(input) {
    const fix = input.fix ?? {};
    const v = fix.verified ?? {};
    const files = Array.isArray(fix.change?.files) ? fix.change.files : [];
    const problems = [];
    const need = (ok, why) => ok || problems.push(why);
    need(v.buildOk === true, 'build failed');
    // The bug was shown before the fix: by a regression test that fails on the original code, or by the
    // fix step's reproduce command failing there. A regression test the fix names must catch the bug.
    const testShown = v.regressionTestFailsBefore === true;
    const reproShown = v.reproducedBefore === true;
    if (!testShown && !reproShown) {
      need(false, v.regressionTestFailsBefore === false ? 'the regression test did not fail before the fix' : 'the bug was never shown: no regression test and no reproduce command failed before the fix');
    } else need(v.regressionTestFailsBefore !== false, 'the regression test did not fail before the fix');
    // Each check that showed it passes now.
    need(v.regressionTestPassesAfter !== false && (!testShown || v.regressionTestPassesAfter === true), 'the regression test does not pass after the fix');
    need(v.testsPassAfter === true, 'the test suite does not pass after the fix');
    need(v.reproducedAfter !== true && (!reproShown || v.reproducedAfter === false), 'the error still reproduces after the fix');
    const violations = (Array.isArray(fix.limits?.violations) ? fix.limits.violations : []).map((x) => str(x, 200));
    // Outside the fix step's limits (a dependency manifest, too many lines) a fix is never pushed
    // without a person: the fix step's autoPushAllowed is false then. With askOutsideLimits a person
    // decides at the push steps' sign-off; without it the attempt fails here.
    need(fix.limits?.ok === true || input.askOutsideLimits === true, `limits: ${violations.join('; ') || 'not met'}`);
    need(files.length > 0, 'no files changed');
    need(files.length <= 20, 'more than 20 files changed');
    need(
      files.every((f) => typeof f?.path === 'string' && f.path.length <= 300 && CHANGE_PATH.test(f.path) && ['create', 'update', 'delete'].includes(f.action) && (f.action === 'delete' || (typeof f.content === 'string' && f.content.length <= 40_000))),
      'a changed file is a dot-file, too large, or malformed',
    );
    const push = problems.length === 0;

    const yes = (b) => (b === true ? 'yes' : b === false ? 'no' : 'unknown');
    const score = Math.max(0, Math.min(100, Math.round(num(fix.confidence?.score))));
    const reasons = (Array.isArray(fix.confidence?.reasons) ? fix.confidence.reasons : []).slice(0, 10).map((r) => `- ${inert(oneLine(str(r, 300)))}`);
    const evidence = (input.evidence ?? []).slice(0, 10).map((e) => `- ${inert(oneLine(str(e, 300)))}`);
    const message = inert(str(input.message, 2000));
    const lines = [
      '## Automated fix for a production error',
      '',
      '> Draft opened by Dittoly from an alert, after the fix was checked in a sandbox. Nothing was merged; review it like any change. Text taken from logs is shown as quoted data.',
      '',
      `**Error:** \`${inert(str(input.errorType, 100)) || 'error'}\` in **${inert(str(input.service, 100))}**, seen ${num(input.timesSeen)} time(s). Fingerprint \`${str(input.fingerprint, 128)}\`.`,
      ...(input.traceId ? [`**Trace:** \`${inert(str(input.traceId, 64))}\``] : []),
      ...(input.previousMrUrl ? [`**Previous attempt:** ${str(input.previousMrUrl, 500)} (the error came back after it was merged or closed).`] : []),
      '',
      '### What changed',
      inert(str(fix.summary, 3000)) || '(no summary)',
      '',
      `${num(fix.change?.filesChanged) || files.length} file(s), +${num(fix.change?.linesAdded)} -${num(fix.change?.linesRemoved)}. Regression test: \`${inert(oneLine(str(fix.regressionTest, 200))) || 'none'}\``,
      '',
      '### Verification (sandbox)',
      '| Check | Result |',
      '| --- | --- |',
      `| Build passes | ${yes(v.buildOk)} |`,
      `| Error reproduced before the fix | ${yes(v.reproducedBefore)} |`,
      `| Regression test fails before the fix | ${yes(v.regressionTestFailsBefore)} |`,
      `| Regression test passes after the fix | ${yes(v.regressionTestPassesAfter)} |`,
      `| Error reproduced after the fix | ${yes(v.reproducedAfter)} |`,
      `| Test suite passes after the fix | ${yes(v.testsPassAfter)} |`,
      '',
      `### Confidence: ${score}/100 (${inert(str(fix.confidence?.level, 20)) || 'unknown'})`,
      ...reasons,
      '',
      `Limits: ${fix.limits?.ok === true ? 'within limits' : `NOT within limits (${inert(oneLine(violations.join('; '))).slice(0, 1000) || 'not met'})`}. Pushed without a person's sign-off: ${fix.autoPushAllowed === true ? 'allowed by the confidence rules' : 'no, a person signed off'}.`,
      ...(evidence.length ? ['', '### Why the triage called it a bug', ...evidence] : []),
      '',
      '### Error message (from the logs, ids and values masked)',
      '```text',
      message,
      '```',
    ];
    const description = lines.join('\n').slice(0, 60_000);
    // A push that waits for a person: the row says so first (status failed, so a recurrence only counts),
    // because a rejected sign-off ends the run before any later step. Pushed, the row becomes mr_open.
    const needsSignOff = push && fix.autoPushAllowed !== true;
    return {
      push,
      recordFailed: !push,
      needsSignOff,
      signOffNote: needsSignOff
        ? `A verified fix waits for a person's sign-off to push (${fix.limits?.ok === true ? `confidence ${score}/100` : 'outside its limits'}). Nothing is pushed unless someone signs off; if the sign-off is rejected, this stays failed and the error is tried again after the retry wait.`
        : '',
      status: push ? '' : 'failed',
      failureReason: problems.join('; ').slice(0, 1000),
      title: oneLine(str(input.title, 150)) || 'Fix a production error',
      commitMessage: `${oneLine(str(input.title, 150)) || 'Fix a production error'}\n\nVerified in a sandbox by Dittoly (fingerprint ${str(input.fingerprint, 128)}).`,
      description,
      labels: ['dittoly', 'auto-fix'],
    };
  },
};

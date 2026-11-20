import type { FixLimits } from '../flows/definition.js';

/**
 * What a fix step's change may touch, and how much Dittoly trusts it. Both are computed by
 * Dittoly from the change and from its own test runs, never taken from the AI: a change the AI
 * was steered into writing (prompt injection through an error message or a log line) still has
 * to stay inside these limits and pass these checks before anything can push it without a person.
 */

/** CI/CD: a change here runs with the pipeline's secrets. Leaving these out needs allowRiskyPaths. */
export const CI_PATHS = ['.gitlab-ci.yml', '.github/workflows/**', '.circleci/**', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml'];
/** Dependency manifests and lockfiles: a change here pulls in code nobody reviewed. Leaving these out needs allowRiskyPaths. */
export const DEPENDENCY_PATHS = [
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'deno.json', 'deno.jsonc', 'deno.lock',
  'requirements*.txt', 'Pipfile*', 'poetry.lock', 'uv.lock', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile*', '*.gemspec', 'composer.json', 'composer.lock',
  'pom.xml', 'build.gradle*', 'settings.gradle*', 'gradle.properties', 'gradle/libs.versions.toml', 'gradle/wrapper/**', '.mvn/**', 'mvnw', 'gradlew',
  '*.csproj', '*.fsproj', '*.vbproj', '*.sln', '*.slnx', 'Directory.Build.*', 'Directory.Packages.props', 'packages.lock.json', 'NuGet.Config', 'nuget.config', 'global.json',
];
/** Build and infrastructure: how the code is built and deployed. */
export const INFRA_PATHS = ['Dockerfile*', 'docker-compose*', 'Makefile', '*.tf', '**/k8s/**', '**/helm/**', '.env*', 'scripts/**'];
export const DEFAULT_BLOCKED = [...CI_PATHS, ...DEPENDENCY_PATHS, ...INFRA_PATHS];
export const DEFAULT_MAX_FILES = 5;
export const DEFAULT_MAX_LINES = 200;

/**
 * A path rule as a regular expression: "*" is any text without "/", "**" any text, "?" one
 * character. A rule without "/" is a file name and matches at any depth ("package.json" also
 * matches "web/package.json"); a rule with "/" starts at the repository's root.
 */
export function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(glob.includes('/') ? `^${re}$` : `(?:^|/)${re}$`);
}

export const matchesAny = (file: string, globs: readonly string[]) => globs.some((g) => globRegExp(g).test(file));

/**
 * Looks like a test file: in a test folder (Maven's and Gradle's src/test, .NET's Shop.Tests projects), or
 * named like one (cart.test.ts, cart_test.go, test_cart.py, cart_spec.rb, CartTest.java, CartTests.cs, CartTest.php).
 */
export function isTestPath(file: string): boolean {
  const parts = file.split('/');
  const name = parts[parts.length - 1]!;
  return (
    parts.slice(0, -1).some((d) => /^(tests?|__tests__|specs?)$/i.test(d) || /[.-](unit)?tests?$/i.test(d)) ||
    /\.(test|spec)\.[A-Za-z0-9]+$/.test(name) ||
    /_(test|spec)\.[A-Za-z0-9]+$/.test(name) ||
    /^test_.+\.py$/.test(name) ||
    /^[A-Z]\w*(Test|Tests|IT|Spec)\.(java|kt|scala|groovy|cs|fs|vb|php)$/.test(name)
  );
}

export interface EffectiveLimits {
  blockedPaths: string[];
  maxFiles: number;
  maxLinesChanged: number;
  /** Resolved at run time; null = any file. */
  onlyFilesIn: string[] | null;
  /** CI/CD or dependency rules the Flow left out (allowRiskyPaths). */
  riskyAllowed: string[];
}

/** The default CI/CD and dependency rules a limits block leaves out (it then needs allowRiskyPaths). */
export function riskyOmissions(limits: FixLimits | undefined): string[] {
  if (!limits?.blockedPaths) return [];
  return [...CI_PATHS, ...DEPENDENCY_PATHS].filter((g) => !limits.blockedPaths!.includes(g));
}

export function effectiveLimits(limits: FixLimits | undefined, onlyFilesIn: string[] | null): EffectiveLimits {
  return {
    blockedPaths: [...new Set([...(limits?.blockedPaths ?? DEFAULT_BLOCKED), ...(limits?.addBlockedPaths ?? [])])],
    maxFiles: limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxLinesChanged: limits?.maxLinesChanged ?? DEFAULT_MAX_LINES,
    onlyFilesIn,
    riskyAllowed: riskyOmissions(limits),
  };
}

/**
 * onlyFilesIn as resolved at run time: a list, or text with one path per line or comma (e.g. the
 * files of a stack trace). Line and column numbers ("src/cart.js:42:7") and a leading "./" are dropped.
 */
export function normalizeOnlyFiles(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/[\n,]/) : [];
  return [
    ...new Set(
      raw
        .map((p) => p.trim().replace(/^\.\//, '').replace(/(:\d+)+$/, ''))
        .filter((p) => p.length > 0 && p.length <= 500),
    ),
  ].slice(0, 200);
}

/** Whether a file is one of onlyFilesIn: the same path, a folder ("src/cart/"), a rule, or the end of an absolute path from a stack trace. */
export function inOnlyFiles(file: string, only: readonly string[]): boolean {
  return only.some((o) => {
    if (o === file) return true;
    if (o.endsWith('/') && file.startsWith(o.replace(/^\/+/, ''))) return true;
    if (o.endsWith(`/${file}`)) return true;
    return /[*?]/.test(o) && !o.startsWith('/') && globRegExp(o).test(file);
  });
}

export interface ChangedFile {
  path: string;
  action: 'create' | 'update' | 'delete';
  added: number;
  removed: number;
  binary: boolean;
  modeChanged: boolean;
}

/** Every rule the change breaks, in plain words; an empty list means it stays inside the limits. */
export function checkLimits(files: ChangedFile[], l: EffectiveLimits, regressionTest: string | null, outsideWrites: string[] = []): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (matchesAny(f.path, l.blockedPaths)) out.push(`${f.path}: a blocked path (CI/CD, dependencies, build or infrastructure)`);
    if (f.binary) out.push(`${f.path}: a binary file`);
    if (f.modeChanged) out.push(`${f.path}: its file mode changed`);
    // The regression test the fix names may sit in the repository's test folders, wherever onlyFilesIn points.
    const testExempt = f.path === regressionTest && isTestPath(f.path);
    if (l.onlyFilesIn && !testExempt && !inOnlyFiles(f.path, l.onlyFilesIn)) out.push(`${f.path}: not one of the files the fix may change (onlyFilesIn)`);
  }
  if (files.length > l.maxFiles) out.push(`${files.length} files changed, more than ${l.maxFiles}`);
  const lines = files.reduce((n, f) => n + f.added + f.removed, 0);
  if (lines > l.maxLinesChanged) out.push(`${lines} lines changed, more than ${l.maxLinesChanged}`);
  for (const p of outsideWrites) out.push(`${p}: changed by a command, not by the fix`);
  return out;
}

// ---------------------------------------------------------------- confidence

export interface Verified {
  buildOk: boolean;
  reproducedBefore: boolean | null;
  regressionTestFailsBefore: boolean | null;
  regressionTestPassesAfter: boolean | null;
  reproducedAfter: boolean | null;
  testsPassAfter: boolean;
}

export interface Confidence {
  score: number;
  level: 'high' | 'medium' | 'low';
  reasons: string[];
}

/**
 * Confidence from facts Dittoly checked itself (docs/ai-steps.md, "How confidence is scored"):
 * - high, 95 (100 when both the reproduce command and the regression test showed the bug): there is a
 *   change, the build works, the bug was shown to exist (reproduce failed, or the regression test failed,
 *   on the original code), every check that showed it now passes, the test suite passes and the change
 *   stays inside its limits;
 * - medium, 50 (40 when outside the limits): the build works and the test suite passes, but
 *   the bug was never shown to exist, or a check that showed it still fails, or the limits are broken;
 * - low, 0-30: no change, or the build or the test suite fails (10 per passing fact, max 30).
 * What the AI says about its own fix never changes the score.
 */
export function scoreConfidence(v: Verified, limitsOk: boolean, changed: boolean): Confidence {
  const reasons: string[] = [];
  const fact = (ok: boolean | null, yes: string, no: string, unknown?: string) => {
    if (ok === null) {
      if (unknown) reasons.push(`? ${unknown}`);
    } else reasons.push(ok ? `✓ ${yes}` : `✗ ${no}`);
  };
  fact(changed, 'the AI changed the code', 'the AI made no change');
  fact(v.buildOk, 'the build works after the change', 'the build fails after the change');
  fact(v.reproducedBefore, 'the reproduce command failed before the change (the bug was there)', 'the reproduce command passed before the change (the bug did not show)', 'no reproduce command');
  fact(v.regressionTestFailsBefore, 'the regression test fails on the original code', 'the regression test passes on the original code (it does not catch the bug)', 'no regression test was run on the original code');
  fact(v.regressionTestPassesAfter, 'the regression test passes with the change', 'the regression test fails with the change', 'no regression test was run with the change');
  fact(v.reproducedAfter === null ? null : !v.reproducedAfter, 'the reproduce command passes with the change', 'the reproduce command still fails with the change');
  fact(v.testsPassAfter, 'the test suite passes with the change', 'the test suite fails with the change');
  fact(limitsOk, 'the change stays inside its limits', 'the change breaks its limits');

  const shown = v.reproducedBefore === true || v.regressionTestFailsBefore === true;
  const gone = v.regressionTestPassesAfter !== false && v.reproducedAfter !== true && (v.regressionTestPassesAfter === true || v.reproducedAfter === false);
  // Each check that showed the bug must pass now: a regression test that failed before must pass after.
  const consistent = (v.regressionTestFailsBefore !== true || v.regressionTestPassesAfter === true) && (v.reproducedBefore !== true || v.reproducedAfter === false);
  if (changed && v.buildOk && v.testsPassAfter && shown && gone && consistent && limitsOk) {
    return { score: v.reproducedBefore === true && v.regressionTestFailsBefore === true ? 100 : 95, level: 'high', reasons };
  }
  if (changed && v.buildOk && v.testsPassAfter) return { score: limitsOk ? 50 : 40, level: 'medium', reasons };
  const passing = [changed, v.buildOk, v.testsPassAfter].filter(Boolean).length;
  return { score: Math.min(30, passing * 10), level: 'low', reasons };
}

/** Pushing without a person: only at or above the Flow's threshold, inside the limits, with passing tests and evidence of the bug. */
export function autoPushAllowed(c: Confidence, v: Verified, limitsOk: boolean, autoPushAt: number | undefined, changed: boolean): boolean {
  if (autoPushAt === undefined || !changed) return false;
  const evidence = v.regressionTestFailsBefore === true || v.reproducedBefore === true;
  return c.score >= autoPushAt && limitsOk && v.testsPassAfter && evidence;
}

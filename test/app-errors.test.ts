import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dockerRunArgs, mavenSettings, NO_PROXY_HOSTS, PACKAGE_REGISTRIES } from '../src/engine/apps.js';
import { DEFAULT_BLOCKED, inOnlyFiles, isTestPath, matchesAny } from '../src/engine/fix-limits.js';
import { moduleTestSchema, validateModule } from '../src/modules/validate.js';
import { ProcessRunner } from '../src/sandbox/runner.js';

/**
 * Error-to-fix for every major language: the app-errors module finds the error and the app's own files in
 * real stack traces (test/fixtures/traces, captured from each runtime in its official image), the policy
 * module fingerprints them, and the fix step knows each language's test files and dependency manifests.
 */
const examples = path.resolve(import.meta.dirname, 'fixtures');
const traces = path.resolve(import.meta.dirname, 'fixtures', 'traces');
type Actions = Record<string, (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>>;
const ctx = { ActionError: class extends Error {} };
const mod = async (name: string) => ((await import(path.join(examples, 'modules', name, 'module.mjs'))) as { actions: Actions }).actions;
const load = async (name: string) => {
  const dir = path.join(examples, 'modules', name);
  return {
    manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
    code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
    tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')) as unknown[],
  };
};

async function both(payload: unknown) {
  const found = await (await mod('app-errors')).find_error!({ payload, defaultRepo: 'acme/shop', defaultService: 'shop' }, ctx);
  const n = await (await mod('error-fix-policy')).normalize!({ service: 'shop', message: found.message, stack: found.stack, repo: 'acme/shop', targetBranch: 'main', allowedRepos: ['acme/shop'] }, ctx);
  return { message: found.message, appFiles: found.appFiles, errorType: n.errorType, topFrame: n.topFrame };
}

describe('errors in each language', () => {
  const expected: Record<string, Awaited<ReturnType<typeof both>>> = {
    'python.txt': { message: "KeyError: 'qty'", appFiles: ['shop/cart.py', 'main.py'], errorType: 'KeyError', topFrame: '<genexpr> (shop/cart.py)' },
    'java.txt': {
      message: 'java.lang.NullPointerException: Cannot invoke "java.lang.Integer.intValue()" because the return value of "com.acme.shop.Cart$Item.qty()" is null',
      appFiles: ['**/com/acme/shop/Cart.java'],
      errorType: 'NullPointerException',
      topFrame: 'com.acme.shop.Cart.total',
    },
    'go.txt': { message: 'panic: runtime error: index out of range [5] with length 3', appFiles: ['internal/cart/cart.go', 'main.go'], errorType: 'panic', topFrame: 'cart.(*Cart).Item (internal/cart/cart.go)' },
    'go-trimpath.txt': { message: 'panic: runtime error: index out of range [5] with length 3', appFiles: ['internal/cart/cart.go', 'main.go'], errorType: 'panic', topFrame: 'cart.(*Cart).Item (internal/cart/cart.go)' },
    'rust.txt': { message: 'panic: index out of bounds: the len is 3 but the index is 5', appFiles: ['src/cart.rs', 'src/main.rs'], errorType: 'panic', topFrame: 'src/cart.rs' },
    'dotnet.txt': { message: 'System.InvalidOperationException: Nullable object must have a value.', appFiles: ['Shop/Cart.cs', 'Shop/Program.cs'], errorType: 'InvalidOperationException', topFrame: 'Shop.Services.Cart.Total (Shop/Cart.cs)' },
    'ruby.txt': { message: "TypeError: nil can't be coerced into Integer", appFiles: ['lib/cart.rb', 'main.rb'], errorType: 'TypeError', topFrame: 'Integer#* (lib/cart.rb)' },
    'php.txt': { message: 'DivisionByZeroError: Division by zero', appFiles: ['src/Cart.php', 'index.php'], errorType: 'DivisionByZeroError', topFrame: 'intdiv (src/Cart.php)' },
  };

  it('every captured trace has its expectation', async () => {
    expect((await readdir(traces)).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [file, want] of Object.entries(expected)) {
    it(`${file}: the message, the app's files (failing one first) and a stable top frame`, async () => {
      expect(await both(await readFile(path.join(traces, file), 'utf8'))).toEqual(want);
    });
  }

  it('the stack the fix step sees has repository paths', async () => {
    const found = await (await mod('app-errors')).find_error!({ payload: await readFile(path.join(traces, 'dotnet.txt'), 'utf8'), defaultRepo: 'acme/shop' }, ctx);
    expect(found.stack).toContain('in Shop/Cart.cs:line 5');
    expect(found.stack).not.toContain('/src/Shop');
    // A JVM file is a rule for its package folder under any source root.
    const java = await (await mod('app-errors')).find_error!({ payload: await readFile(path.join(traces, 'java.txt'), 'utf8'), defaultRepo: 'acme/shop' }, ctx);
    expect(inOnlyFiles('src/main/java/com/acme/shop/Cart.java', java.onlyFilesIn as string[])).toBe(true);
    expect(inOnlyFiles('src/main/java/com/acme/shop/Other.java', java.onlyFilesIn as string[])).toBe(false);
  });

  it('JSON lines from common loggers: Logback, Serilog, structlog, zap, ECS, a Ruby backtrace list', async () => {
    const java = await readFile(path.join(traces, 'java.txt'), 'utf8');
    const dotnet = await readFile(path.join(traces, 'dotnet.txt'), 'utf8');
    const python = await readFile(path.join(traces, 'python.txt'), 'utf8');
    const go = await readFile(path.join(traces, 'go.txt'), 'utf8');
    const lines = [
      { level: 'ERROR', message: 'Order failed', stack_trace: java },
      { '@t': '2026-10-28T10:00:00Z', '@l': 'Error', '@mt': 'Order {Id} failed', '@x': dotnet },
      { event: 'order failed', level: 'error', exception: python },
      { level: 'panic', msg: 'order failed', stacktrace: go },
      { '@timestamp': '2026-10-28T10:00:00Z', log: { level: 'error' }, error: { type: 'TypeError', message: "nil can't be coerced into Integer", stack_trace: "lib/cart.rb:3:in 'Cart.total'" } },
      { level: 'error', message: 'boom', backtrace: ["/app/lib/cart.rb:3:in 'Cart.total'", "/app/main.rb:2:in 'Object#handle'"] },
    ];
    const picked = [];
    for (const l of lines) {
      const r = await (await mod('app-errors')).pick_error!({ lines: [{ timestamp: '', labels: {}, line: JSON.stringify(l), traceId: '' }] }, ctx);
      picked.push([r.found, r.appFiles]);
    }
    expect(picked).toEqual([
      [true, ['**/com/acme/shop/Cart.java']],
      [true, ['Shop/Cart.cs', 'Shop/Program.cs']],
      [true, ['shop/cart.py', 'main.py']],
      [true, ['internal/cart/cart.go', 'main.go']],
      [true, ['lib/cart.rb']],
      [true, ['lib/cart.rb', 'main.rb']],
    ]);
  });

  it('for Node.js it answers exactly as node-errors does', async () => {
    const tests = (await load('node-errors')).tests as { action: string; input: Record<string, unknown>; expectOk?: boolean }[];
    const [a, n] = [await mod('app-errors'), await mod('node-errors')];
    // Both default the time to now.
    vi.useFakeTimers({ now: new Date('2026-10-28T10:00:00Z'), toFake: ['Date'] });
    for (const t of tests.filter((x) => x.expectOk !== false)) {
      // The default Loki query also looks for panics and tracebacks; the defaults add app/ (Rails, Laravel, many Python apps) and Maven's and Gradle's src/test/.
      const strip = (o: Record<string, unknown>) => ({ ...o, lokiQuery: undefined, onlyFilesIn: (o.onlyFilesIn as string[] | undefined)?.filter((f) => f !== 'src/test/' && f !== 'app/') });
      expect(strip(await a[t.action]!(t.input, ctx)), t.action).toEqual(strip(await n[t.action]!(t.input, ctx)));
    }
    vi.useRealTimers();
  });

  it('app-errors and error-fix-policy pass their sandbox tests with no OWASP or Performance warning', async () => {
    for (const name of ['app-errors', 'error-fix-policy']) {
      const m = await load(name);
      const { report } = await validateModule(new ProcessRunner(), m.manifest, m.code, m.tests.map((t) => moduleTestSchema.parse(t)));
      expect(report.tests.filter((t) => !t.passed), JSON.stringify(report.tests)).toEqual([]);
      expect(report.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.details?.join(', ')}`)).toEqual([]);
    }
  }, 120_000);
});

describe('test files and dependency manifests in each language', () => {
  it('knows test files by folder and by name', () => {
    const tests = [
      'src/test/java/com/acme/shop/CartQtyTest.java',
      'src/test/kotlin/com/acme/shop/CartQtyTest.kt',
      'tests/test_cart_qty.py',
      'internal/cart/cart_qty_test.go',
      'tests/cart_qty.rs',
      'Shop.Tests/CartQtyTests.cs',
      'Shop.UnitTests/Cart.cs',
      'test/cart_qty_test.rb',
      'spec/models/cart_spec.rb',
      'tests/CartQtyTest.php',
      'test/cart-qty.test.ts',
      'CartTests.cs',
    ];
    expect(tests.filter((f) => !isTestPath(f))).toEqual([]);
    const code = ['src/main/java/com/acme/shop/Cart.java', 'shop/cart.py', 'internal/cart/cart.go', 'src/lib.rs', 'Shop/Cart.cs', 'lib/cart.rb', 'src/Cart.php', 'src/Latest.java', 'src/contest.ts'];
    expect(code.filter((f) => isTestPath(f))).toEqual([]);
  });

  it('blocks each toolchain\'s manifests and lockfiles by default', () => {
    const deps = ['Shop/Shop.csproj', 'Shop.slnx', 'Directory.Packages.props', 'global.json', 'gradle/libs.versions.toml', 'gradle/wrapper/gradle-wrapper.properties', 'bun.lock', 'deno.json', 'uv.lock', 'shop.gemspec', 'go.work'];
    expect(deps.filter((f) => !matchesAny(f, DEFAULT_BLOCKED))).toEqual([]);
  });
});

describe('the sandbox for every toolchain', () => {
  it('reaches each toolchain\'s registries', () => {
    for (const host of ['repo.maven.apache.org', 'plugins.gradle.org', 'proxy.golang.org', 'sum.golang.org', 'index.crates.io', 'static.crates.io', 'api.nuget.org', 'repo.packagist.org', 'codeload.github.com', 'rubygems.org', 'jsr.io', 'pypi.org', 'files.pythonhosted.org']) {
      expect(PACKAGE_REGISTRIES).toContain(`${host}:443`);
    }
  });

  it('never sends the project\'s own loopback through the proxy', () => {
    // A test suite that starts its server on a loopback port and calls it is not the step reaching out. Sent to
    // the proxy, those calls come back "403 blocked by ..." and a suite that passes everywhere else fails here.
    const args = dockerRunArgs({ src: '/s', image: 'node:26', cmd: 'npm test', network: 'n', proxyUrl: 'http://dty-proxy-1:3128' });
    expect(args).toContain(`NO_PROXY=${NO_PROXY_HOSTS}`);
    expect(args).toContain(`no_proxy=${NO_PROXY_HOSTS}`);
    for (const own of ['localhost', '127.0.0.1', '::1']) expect(NO_PROXY_HOSTS.split(',')).toContain(own);
    // The machine Dittoly runs on is reached by another name and stays blocked.
    expect(NO_PROXY_HOSTS).not.toContain('host.docker.internal');
    // With no proxy there is nothing to exempt.
    expect(dockerRunArgs({ src: '/s', image: 'node:26', cmd: 'npm test', network: 'n' }).join(' ')).not.toContain('NO_PROXY');
  });

  it('keeps downloads in the step\'s home across phases, and tells Java and Maven about the proxy', () => {
    const args = dockerRunArgs({ src: '/w/src', image: 'maven:3-eclipse-temurin-25', cmd: 'mvn test', network: 'n', proxyUrl: 'http://dty-proxy-1:3128', home: '/w/home', mavenSettingsFile: '/w/conf/maven-settings-0.xml' });
    const joined = args.join(' ');
    expect(joined).toContain('-v /w/home:/dty-home');
    expect(joined).toContain('-e HOME=/dty-home');
    expect(joined).toContain('-e CARGO_HOME=/dty-home/.cargo');
    expect(joined).toContain('-v /w/conf/maven-settings-0.xml:/dty-home/.m2/settings.xml:ro');
    expect(args).toContain('JAVA_TOOL_OPTIONS=-Duser.home=/dty-home -Dhttps.proxyHost=dty-proxy-1 -Dhttps.proxyPort=3128 -Dhttp.proxyHost=dty-proxy-1 -Dhttp.proxyPort=3128 -Dhttp.nonProxyHosts=localhost|127.*|[::1]|0.0.0.0');
    // The Flow's own env comes after and may set its own values; the image and command stay last.
    expect(args.slice(-5, -4)).toEqual(['maven:3-eclipse-temurin-25']);
    expect(mavenSettings('http://dty-proxy-1:3128')).toContain('<protocol>https</protocol><host>dty-proxy-1</host><port>3128</port>');
    // Without a home (older callers): HOME=/tmp as before, nothing else.
    const plain = dockerRunArgs({ src: '/s', image: 'node:26', cmd: 'npm ci', network: 'n' }).join(' ');
    expect(plain).toContain('-e HOME=/tmp');
    expect(plain).not.toContain('JAVA_TOOL_OPTIONS');
  });
});

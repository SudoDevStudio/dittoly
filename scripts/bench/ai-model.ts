/**
 * Model benchmark: can this AI model do Dittoly's own work? It runs the real drafting code (the same system
 * prompts, skills and response schemas the app uses) against a fixed set of requests, and scores every answer with
 * Dittoly's own checks — the manifest parser, the TypeScript compiler, the Flow validator. No database, no sandbox:
 * only the AI call and the checks, so it says what the MODEL can do, not what the server can.
 *
 *   DITTOLY_AI_PROVIDER=ollama DITTOLY_AI_MODEL=gemma-4-26B-A4B-it npx tsx scripts/bench/ai-model.ts
 *   DITTOLY_AI_PROVIDER=anthropic npx tsx scripts/bench/ai-model.ts     (a baseline to compare against)
 *
 * Options (env): BENCH_CASES (a comma-separated list of case names, default all), BENCH_TRIES (1: how many times
 * each case runs, to see how steady the model is), BENCH_KIND (flow | module | all), BENCH_OUT (also write the
 * Markdown report there), BENCH_MOCK (a JSON file of answers, with DITTOLY_AI_PROVIDER=mock: scores answers you
 * already have, and is how this harness itself is tested), DITTOLY_OLLAMA_URL, DITTOLY_MODE (local).
 *
 * A module answer is also scored on what Dittoly's own reviewers look at: the OWASP checks, the performance
 * checks, whether its settings are explained and whether it wrote sandbox tests. Two models can then be compared
 * on more than "it compiles": DITTOLY_AI_PROVIDER=anthropic vs codex-cli vs a model of your own.
 *
 * What each answer is scored on:
 *   answered  the model answered at all (no provider error, no unreadable answer)
 *   read      the answer could be read: a Flow definition / a module manifest, tests and code came out of it
 *   valid     Dittoly accepts it: the Flow passes its checks (steps, inputs, settings), the module's manifest
 *             parses and its TypeScript compiles
 * A case that asks for something no module can do passes when the model says so instead of inventing an action.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProvider } from '../../src/ai/factory.js';
import { draftFlow, type CatalogAction } from '../../src/ai/generate-flow.js';
import { generateModule } from '../../src/ai/generate-module.js';
import { AiError, MockProvider, type AiProvider } from '../../src/ai/provider.js';
import { setLogSink } from '../../src/core/log.js';
import { parseFlowDefinition } from '../../src/flows/definition.js';
import { checkSettings, checkStepInputs } from '../../src/flows/service.js';
import { optionalServicesFor, parseManifest, servicesFor } from '../../src/modules/manifest.js';
import { owaspChecks, performanceChecks } from '../../src/modules/validate.js';
import { tidyManifest } from '../../src/modules/manifest-tidy.js';
import { compileModuleSource } from '../../src/modules/source.js';
import type { ModuleVersion } from '../../src/modules/registry.js';
import type { AiProviderId, DeploymentMode } from '../../src/config.js';

setLogSink(() => undefined);

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules');
const TRIES = Math.max(1, Number(process.env.BENCH_TRIES ?? 1));
const ONLY = (process.env.BENCH_CASES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const KIND = (process.env.BENCH_KIND ?? 'all') as 'flow' | 'module' | 'all';

interface Case {
  name: string;
  kind: 'flow' | 'module';
  request: string;
  /** A Flow that no approved module can do: the model passes by saying so, not by inventing an action. */
  expectMissing?: boolean;
}

const CASES: Case[] = [
  {
    name: 'flow-read',
    kind: 'flow',
    request:
      'Every time someone runs it, ask for a JQL query, find the matching Jira issues and post how many there are to a Slack channel the person picks. Nothing else.',
  },
  {
    name: 'flow-approval',
    kind: 'flow',
    request:
      'Find the open merge requests of a GitLab project, let a person sign off, then merge the ones they chose and tell the release channel in Slack what was merged.',
  },
  {
    name: 'flow-table',
    kind: 'flow',
    request:
      'An error report arrives through a Flow URL as JSON. Decide with AI whether it is a real bug in our code; stop when it is not. Remember each error by the fingerprint of its text in a data table, and when it was seen before, stop and show the link that was recorded. Otherwise comment on the pull request it came from with what the AI found, and record the fingerprint with that link.',
  },
  {
    name: 'flow-settings',
    kind: 'flow',
    request:
      'Search our Jira for issues the person names, and let whoever starts the run choose which Jira site to search. Post nothing; just return the issues.',
  },
  {
    name: 'flow-impossible',
    kind: 'flow',
    expectMissing: true,
    request: 'Charge a customer’s credit card in Stripe and email them a receipt.',
  },
  {
    name: 'module-simple',
    kind: 'module',
    request:
      'Build a module for the public Open-Meteo forecast API (api.open-meteo.com). One read action: given a latitude and longitude, return today’s highest and lowest temperature. No key is needed.',
  },
  {
    name: 'module-setting',
    kind: 'module',
    request:
      'Build a module for a self-hosted Grafana. The address differs per organization (any host ending in .grafana.net), so it must be told the site. One read action: list the dashboards, returning each one’s uid and title. It needs an API token.',
  },
];

/** Every fixture module, as the drafting catalog and the Flow checks see them. */
async function fixtures(): Promise<{ catalog: CatalogAction[]; modules: Map<string, ModuleVersion> }> {
  const catalog: CatalogAction[] = [];
  const modules = new Map<string, ModuleVersion>();
  for (const name of (await readdir(FIXTURES, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const parsed = parseManifest(JSON.parse(await readFile(path.join(FIXTURES, name, 'manifest.json'), 'utf8')));
    if (!parsed.ok) continue;
    const manifest = parsed.manifest;
    const ref = `${manifest.name}@${manifest.version}`;
    modules.set(ref, { name: manifest.name, version: manifest.version, manifest } as ModuleVersion);
    for (const a of manifest.actions) {
      catalog.push({
        module: ref,
        moduleTitle: manifest.title,
        action: a.name,
        title: a.title,
        description: a.description,
        effect: a.effect,
        input: a.input,
        output: a.output,
        access: { required: servicesFor(manifest, a.name), optional: optionalServicesFor(manifest, a.name) },
        ...(manifest.settings?.length ? { settings: manifest.settings } : {}),
      });
    }
  }
  return { catalog, modules };
}

interface Attempt {
  answered: boolean;
  read: boolean;
  valid: boolean;
  /** For a module: what the reviewers would say about it, beyond "it compiles". */
  quality?: { security: string[]; performance: string[]; tests: number; explained: boolean };
  seconds: number;
  /** What went wrong, in one line, and what the model answered when its answer could not be read. */
  why?: string;
  raw?: string;
}

async function runFlow(provider: AiProvider, c: Case, fx: Awaited<ReturnType<typeof fixtures>>): Promise<Attempt> {
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 100) / 10;
  let drafted;
  try {
    drafted = await draftFlow(provider, c.request, fx.catalog);
  } catch (err) {
    const ai = err instanceof AiError ? err : null;
    return {
      answered: !!ai && ai.code !== 'ai_unreachable' && ai.code !== 'ai_api_error',
      read: false,
      valid: false,
      seconds: secs(),
      why: ai ? `${ai.code}${ai.detail ? `: ${ai.detail}` : ''}` : String(err),
      ...(ai?.raw ? { raw: ai.raw } : {}),
    };
  }
  // It said it cannot: right for a case no module covers, a failure for every other.
  if (drafted.definition === null || drafted.definition === undefined) {
    const said = drafted.missing?.map((m) => m.capability).join('; ') || drafted.explanation.slice(0, 200);
    return { answered: true, read: true, valid: !!c.expectMissing, seconds: secs(), why: `said it cannot draft it: ${said}` };
  }
  if (c.expectMissing) return { answered: true, read: true, valid: false, seconds: secs(), why: 'drafted a Flow although no approved module can do it' };
  const parsed = parseFlowDefinition(drafted.definition);
  if (!parsed.ok) return { answered: true, read: true, valid: false, seconds: secs(), why: `definition rejected: ${parsed.issues.slice(0, 3).join('; ')}` };
  const unknown = parsed.definition.steps.filter((s) => s.type === 'action' && !fx.modules.has(s.module)).map((s) => (s.type === 'action' ? s.module : ''));
  if (unknown.length) return { answered: true, read: true, valid: false, seconds: secs(), why: `uses modules that are not in the catalog: ${[...new Set(unknown)].join(', ')}` };
  const issues = [...checkStepInputs(parsed.definition, fx.modules), ...checkSettings(parsed.definition, fx.modules)];
  return { answered: true, read: true, valid: !issues.length, seconds: secs(), ...(issues.length ? { why: issues.slice(0, 3).join('; ') } : {}) };
}

async function runModule(provider: AiProvider, c: Case): Promise<Attempt> {
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 100) / 10;
  let out;
  try {
    out = await generateModule(provider, c.request, undefined, { search: false });
  } catch (err) {
    const ai = err instanceof AiError ? err : null;
    return {
      answered: !!ai && ai.code !== 'ai_unreachable' && ai.code !== 'ai_api_error',
      read: false,
      valid: false,
      seconds: secs(),
      why: ai ? `${ai.code}${ai.detail ? `: ${ai.detail}` : ''}` : String(err),
      ...(ai?.raw ? { raw: ai.raw } : {}),
    };
  }
  const parsed = parseManifest(tidyManifest(out.manifest));
  if (!parsed.ok) return { answered: true, read: true, valid: false, seconds: secs(), why: `manifest rejected: ${parsed.issues.slice(0, 3).join('; ')}` };
  try {
    await compileModuleSource(out.code);
  } catch (err) {
    return { answered: true, read: true, valid: false, seconds: secs(), why: `code does not compile: ${(err as Error).message.slice(0, 200)}` };
  }
  if (!out.tests.length) return { answered: true, read: true, valid: false, seconds: secs(), why: 'no sandbox tests' };
  // The same checks a reviewer reads on the module's page: what is unsafe, what is slow, what is unexplained.
  const manifest = parsed.manifest;
  const tests = out.tests as { action: string; expectOk?: boolean }[];
  const failed = (list: { name: string; passed: boolean }[]) => list.filter((c) => !c.passed).map((c) => c.name);
  const quality = {
    security: failed(owaspChecks(manifest, out.code, tests)),
    performance: failed(performanceChecks(manifest, out.code)),
    tests: out.tests.length,
    explained: (manifest.settings ?? []).every((st) => st.help && st.example),
  };
  return { answered: true, read: true, valid: true, seconds: secs(), quality };
}

async function main(): Promise<void> {
  const id = (process.env.DITTOLY_AI_PROVIDER ?? 'none') as AiProviderId;
  const mode = (process.env.DITTOLY_MODE ?? 'local') as DeploymentMode;
  const num = (name: string) => (process.env[name] === undefined ? undefined : Number(process.env[name]));
  const provider = createProvider(mode, id, {
    model: process.env.DITTOLY_AI_MODEL,
    ollamaUrl: process.env.DITTOLY_OLLAMA_URL,
    ollama: {
      ...(num('DITTOLY_OLLAMA_NUM_CTX') !== undefined ? { maxContext: num('DITTOLY_OLLAMA_NUM_CTX')! } : {}),
      ...(num('DITTOLY_AI_TEMPERATURE') !== undefined ? { temperature: num('DITTOLY_AI_TEMPERATURE')! } : {}),
      ...(num('DITTOLY_AI_TOP_P') !== undefined ? { topP: num('DITTOLY_AI_TOP_P')! } : {}),
      ...(num('DITTOLY_AI_TOP_K') !== undefined ? { topK: num('DITTOLY_AI_TOP_K')! } : {}),
    },
  });
  // Answers from a file instead of a model (BENCH_MOCK=answers.json with the mock provider): how the harness
  // itself is tested, and how a recorded answer is scored again after a change.
  if (provider instanceof MockProvider && process.env.BENCH_MOCK) {
    for (const answer of JSON.parse(await readFile(process.env.BENCH_MOCK, 'utf8')) as Record<string, unknown>[]) provider.enqueue(answer);
  }
  if (!provider) {
    console.error('Set DITTOLY_AI_PROVIDER (and DITTOLY_AI_MODEL for ollama) to the model to benchmark.');
    process.exit(2);
  }
  const fx = await fixtures();
  const cases = CASES.filter((c) => (KIND === 'all' || c.kind === KIND) && (!ONLY.length || ONLY.includes(c.name)));
  console.log(`Model: ${process.env.DITTOLY_AI_MODEL ?? id} (${id}) · ${cases.length} cases × ${TRIES} ${TRIES === 1 ? 'try' : 'tries'} · ${fx.catalog.length} actions in the catalog\n`);

  const rows: { name: string; attempts: Attempt[] }[] = [];
  for (const c of cases) {
    const attempts: Attempt[] = [];
    for (let i = 0; i < TRIES; i++) {
      const a = c.kind === 'flow' ? await runFlow(provider, c, fx) : await runModule(provider, c);
      attempts.push(a);
      const mark = a.valid ? '✓' : a.read ? '~' : '✗';
      const q = a.quality
        ? ` · ${a.quality.tests} test(s)${a.quality.security.length ? `, ${a.quality.security.length} security finding(s): ${a.quality.security.join(', ')}` : ', no security findings'}${a.quality.performance.length ? `, slow: ${a.quality.performance.join(', ')}` : ''}${a.quality.explained ? '' : ', settings unexplained'}`
        : '';
      console.log(`${mark} ${c.name}${TRIES > 1 ? ` #${i + 1}` : ''} · ${a.seconds}s${a.why ? ` · ${a.why}` : ''}${q}`);
      if (a.raw) console.log(`    what it answered: ${a.raw.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    rows.push({ name: c.name, attempts });
  }

  const all = rows.flatMap((r) => r.attempts);
  const share = (f: (a: Attempt) => boolean) => (all.length ? Math.round((all.filter(f).length / all.length) * 100) : 0);
  const seconds = all.map((a) => a.seconds).sort((x, y) => x - y);
  const median = seconds.length ? seconds[Math.floor(seconds.length / 2)]! : 0;
  const made = all.filter((a) => a.quality);
  const clean = made.filter((a) => !a.quality!.security.length && !a.quality!.performance.length && a.quality!.explained).length;
  const summary = [
    '',
    `answered: ${share((a) => a.answered)}%   readable: ${share((a) => a.read)}%   accepted by Dittoly: ${share((a) => a.valid)}%`,
    ...(made.length
      ? [
          `modules written: ${made.length}, of which ${clean} with no security or performance finding and every setting explained`,
          `security findings: ${made.reduce((n, a) => n + a.quality!.security.length, 0)}   performance findings: ${made.reduce((n, a) => n + a.quality!.performance.length, 0)}   sandbox tests written: ${made.reduce((n, a) => n + a.quality!.tests, 0)}`,
        ]
      : []),
    `median ${median}s, slowest ${seconds.at(-1) ?? 0}s`,
  ].join('\n');
  console.log(summary);

  if (process.env.BENCH_OUT) {
    const md = [
      `# Model benchmark: ${process.env.DITTOLY_AI_MODEL ?? id}`,
      '',
      `Provider \`${id}\`, ${cases.length} cases × ${TRIES}, ${new Date().toISOString().slice(0, 10)}.`,
      '',
      '| Case | Accepted | Readable | Median s | Last problem |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map((r) => {
        const ok = r.attempts.filter((a) => a.valid).length;
        const read = r.attempts.filter((a) => a.read).length;
        const ms = r.attempts.map((a) => a.seconds).sort((x, y) => x - y);
        const why = r.attempts.filter((a) => a.why).at(-1)?.why ?? '';
        return `| ${r.name} | ${ok}/${r.attempts.length} | ${read}/${r.attempts.length} | ${ms[Math.floor(ms.length / 2)] ?? 0} | ${why.replace(/\|/g, '\\|').slice(0, 160)} |`;
      }),
      '',
      summary.trim(),
      '',
    ].join('\n');
    await writeFile(process.env.BENCH_OUT, md);
    console.log(`\nWritten to ${process.env.BENCH_OUT}`);
  }
  // Red when the model cannot be used for this work at all.
  process.exit(share((a) => a.valid) === 0 ? 1 : 0);
}

await main();

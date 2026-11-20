import { z } from 'zod';
import type { AiProvider } from '../ai/provider.js';
import type { FixStep } from '../flows/definition.js';
import { aiCall, DATA_RULE, StepError } from '../runtime/ai-step.js';
import { redactDeep, redactor, type CodeRunner, type NetworkReport, type StepNetwork, type Workspace } from './apps.js';
import { Refused } from './workspace-files.js';
import { autoPushAllowed, checkLimits, effectiveLimits, isTestPath, scoreConfidence, type ChangedFile, type Confidence, type Verified } from './fix-limits.js';
import { narrate } from '../core/progress.js';

/**
 * Fix and verify. In a clone of the repository (the same sandbox, modes and egress as an app step):
 *
 * 1. Prepare: install and build; run `reproduce`, which should fail while the bug is there.
 * 2. The organization's AI works on the code, one JSON action per turn: list a folder, read a file,
 *    search for text, write or delete a file, run the declared test or reproduce command or one test
 *    file through the declared test runner (never any other command), and say when it is done.
 *    Paths stay inside the clone. Command output is shown to it with the secrets removed.
 * 3. Verify with Dittoly's own runs, not the AI's word: the regression test against the original
 *    code (it must fail) and with the change (it must pass), `reproduce` with the change, the build
 *    and the full test suite.
 * 4. The change (from git, against the cloned commit), its limits (src/engine/fix-limits.ts), and
 *    a confidence score computed from those facts. Nothing is pushed here: a later step does that,
 *    and it waits for a person unless the evidence gate (autoApproveWhen) lets it go on.
 *
 * Output (a contract other Flows build on; keep the names):
 * { verified: { buildOk, reproducedBefore, regressionTestFailsBefore, regressionTestPassesAfter, reproducedAfter, testsPassAfter },
 *   limits: { ok, violations }, confidence: { score, level, reasons },
 *   change: { files: [{ path, action, content? }], diff, filesChanged, linesAdded, linesRemoved },
 *   summary, regressionTest, autoPushAllowed, baseCommit, logTail }
 * baseCommit: the commit cloned and verified against (the branch's head when it ran). A later step creates
 * the fix branch from it, so a branch that moved on meanwhile never changes what was verified.
 */

export interface FixChange {
  files: { path: string; action: 'create' | 'update' | 'delete'; content?: string }[];
  diff: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface FixOutput {
  verified: Verified;
  limits: { ok: boolean; violations: string[] };
  confidence: Confidence;
  change: FixChange;
  summary: string;
  regressionTest: string | null;
  autoPushAllowed: boolean;
  /** The commit the change was verified against. */
  baseCommit: string;
  logTail: string;
  /** What each phase could reach and which secrets it got, and what was refused (src/engine/apps.ts). */
  network: NetworkReport;
}

export interface FixInput {
  repo: string;
  ref: string;
  instruction: string;
  context: unknown;
  /** limits.onlyFilesIn as resolved for this run; null = any file. */
  onlyFilesIn: string[] | null;
}

export interface FixDeps {
  apps: CodeRunner;
  /** The organization's AI, metered, pinned and capped by the engine. */
  provider: AiProvider;
  runId: string;
  token: string | null;
  /** Secret env vars (name -> value) for the build and the test commands. */
  secrets: Record<string, string>;
  /** The step's destinations per phase and which phases each secret reaches. */
  network?: StepNetwork;
  keepAlive: () => Promise<void>;
}

const LOG_TAIL = 4000;
const MAX_READ = 100_000;
const MAX_WRITE = 200_000;
const MAX_DIFF = 100_000;
const SHOWN_OUTPUT = 6000;
const OLDER_RESULT = 400;

const ACTIONS = ['list', 'read', 'search', 'write', 'delete', 'run', 'done'] as const;

/** Flat string fields only, every one required (empty when unused): portable across providers. */
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    path: { type: 'string' },
    content: { type: 'string' },
    query: { type: 'string' },
    command: { type: 'string' },
    summary: { type: 'string' },
    regressionTest: { type: 'string' },
  },
  required: ['action', 'path', 'content', 'query', 'command', 'summary', 'regressionTest'],
  additionalProperties: false,
} as const;

const text = (max: number) => z.string().max(max).optional().default('');
export const fixActionSchema = z.object({
  action: z.enum(ACTIONS),
  path: text(500),
  content: text(MAX_WRITE),
  query: text(500),
  command: text(500),
  summary: text(4000),
  regressionTest: text(500),
});
export type FixAction = z.infer<typeof fixActionSchema>;

function systemPrompt(step: FixStep): string {
  return (
    'You fix one bug in a code repository. Each turn you get the task, the steps so far and their results; reply with ONE action:\n' +
    '- "list": the files of a folder ("path", "" for the top).\n' +
    '- "read": a file ("path"), up to 100,000 characters.\n' +
    '- "search": lines containing exact text ("query"), across the repository.\n' +
    '- "write": replace or create a file ("path") with its full new text ("content").\n' +
    '- "delete": remove a file ("path").\n' +
    `- "run": "command" is "test" (the test suite)${step.reproduce ? ', "reproduce" (fails while the bug is there)' : ''} or the path of ONE test file to run ` +
    'through the test runner. No other command can run: there is no shell.\n' +
    '- "done": you are finished; "summary" says what was wrong and what you changed (two or three sentences), "regressionTest" is ' +
    'the path of the test file that shows the bug (or "").\n' +
    'Leave unused fields empty. Paths are relative to the repository root.\n' +
    'Rules: make the smallest change that fixes the bug. Add a regression test file in the repository\'s test folder that fails ' +
    'without your fix and passes with it' +
    (step.reproduce ? ' (the reproduce command is checked too)' : ' (there is no reproduce command, so the regression test is the only evidence)') +
    '. Do not change CI/CD files, dependency manifests or lockfiles, Dockerfiles, Makefiles, infrastructure or scripts; ' +
    'they are refused. Use the library versions the repository already locks (read its manifest and lockfile): ' +
    'call their current, non-deprecated APIs, not ones from other versions you remember. Dittoly checks your fix itself by running the tests: say plainly what you could not verify. ' +
    DATA_RULE
  );
}

// ---------------------------------------------------------------- paths and git (src/engine/workspace-files.ts)

export { safePath } from './workspace-files.js';

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const isBinary = (b: Buffer) => b.includes(0) || !isUtf8(b);
function isUtf8(b: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

const git = (ws: Workspace, args: string[], max = 4_000_000) => ws.files.git(args, max);

/** A file as the cloned commit has it, or null when it was not there. */
async function original(ws: Workspace, file: string): Promise<Buffer | null> {
  const r = await git(ws, ['cat-file', 'blob', `HEAD:${file}`]);
  return r.code === 0 ? r.out : null;
}

/** Tracked files that differ from the cloned commit. */
async function modifiedTracked(ws: Workspace): Promise<Set<string>> {
  const r = await git(ws, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  return new Set(r.out.toString('utf8').split('\0').filter(Boolean).map((l) => l.slice(3)));
}

/** A whole file of the clone (up to a size no change gets near), or null when it is not there. */
const MAX_FILE = 20_000_000;
async function readOrNull(ws: Workspace, rel: string): Promise<Buffer | null> {
  try {
    return (await ws.files.read(rel, MAX_FILE)).data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the step

export async function runFixStep(step: FixStep, input: FixInput, d: FixDeps): Promise<FixOutput> {
  const redact = redactor(Object.values(d.secrets));
  const log: string[] = [];
  const note = (line: string) => {
    log.push(redact(line));
    while (log.join('\n').length > LOG_TAIL * 3) log.shift();
  };
  const timeoutMs = step.timeoutSeconds * 1000;
  const ws = await d.apps.workspace({ runId: d.runId, repo: input.repo, ref: input.ref, token: d.token, image: step.image, env: step.env, secrets: d.secrets, network: d.network, keepAlive: d.keepAlive });
  try {
    // install and build are their phases; the reproduce and test commands are the test phase.
    const exec = async (label: string, cmd: string, phase: 'install' | 'build' | 'test' = 'test') => {
      narrate(`Now running ${label}: ${redact(cmd)}`);
      const r = await ws.exec(cmd, { phase, timeoutMs });
      narrate(`${label} ${r.code === 0 ? 'passed' : r.code === null ? 'did not finish' : `failed (exit ${r.code})`}`);
      note(`$ ${label}: ${cmd}\n${r.output.slice(-1500)}\n→ ${r.code === null ? 'did not finish' : `exit ${r.code}`}`);
      return r;
    };
    // 1. Prepare. The install never gets the secrets or the step's destinations.
    if (step.install && (await exec('install', step.install, 'install')).code !== 0) throw new StepError('install_failed');
    if (step.build && (await exec('build', step.build, 'build')).code !== 0) throw new StepError('build_failed');
    const reproducedBefore = step.reproduce ? (await exec('reproduce (before)', step.reproduce)).code !== 0 : null;
    const baseline = await modifiedTracked(ws);

    // 2. The AI works on the code.
    const touched = new Set<string>();
    const agent = await agentLoop(step, input, ws, d.provider, redact, touched, note, reproducedBefore);

    // 3. The change, as git sees it: only the files the AI wrote or deleted.
    const { files, change } = await changeOf(ws, [...touched]);
    const outside = [...(await modifiedTracked(ws))].filter((f) => !baseline.has(f) && !touched.has(f));
    let regressionTest = agent.regressionTest;
    if (regressionTest) {
      try {
        const r = await ws.files.resolve(regressionTest);
        regressionTest = r.isFile ? r.path : null;
      } catch {
        regressionTest = null;
      }
    }

    // 4. Verify with Dittoly's own runs.
    const verified: Verified = { buildOk: true, reproducedBefore, regressionTestFailsBefore: null, regressionTestPassesAfter: null, reproducedAfter: null, testsPassAfter: false };
    const runTestFile = (label: string, file: string) => exec(label, step.testFile ? step.testFile.split('{file}').join(quote(file)) : `${step.test} ${quote(file)}`);
    if (files.length) {
      // The original code with the regression test: it must fail there. Test files the AI wrote (the
      // regression test and any helper beside it) stay, so it fails for the bug, not for a missing helper.
      if (regressionTest) {
        const kept = new Map<string, Buffer | null>();
        const code = files.filter((f) => f.path !== regressionTest && !isTestPath(f.path));
        for (const f of code) kept.set(f.path, await readOrNull(ws, f.path));
        for (const f of code) await ws.files.write(f.path, await original(ws, f.path));
        if (!step.build || (await exec('build (original code)', step.build, 'build')).code === 0) {
          verified.regressionTestFailsBefore = (await runTestFile('regression test (original code)', regressionTest)).code !== 0;
        }
        for (const [p, b] of kept) await ws.files.write(p, b);
      }
      if (step.build) verified.buildOk = (await exec('build (with the change)', step.build, 'build')).code === 0;
      if (verified.buildOk) {
        if (regressionTest) verified.regressionTestPassesAfter = (await runTestFile('regression test (with the change)', regressionTest)).code === 0;
        if (step.reproduce) verified.reproducedAfter = (await exec('reproduce (with the change)', step.reproduce)).code !== 0;
        verified.testsPassAfter = (await exec('test (with the change)', step.test)).code === 0;
      }
    } else note('The AI made no change: nothing to verify.');

    // 5. Limits, confidence and whether a later step may push without a person.
    const limits = effectiveLimits(step.limits, input.onlyFilesIn);
    const violations = checkLimits(files, limits, regressionTest, outside);
    const limitsOk = violations.length === 0;
    const confidence = scoreConfidence(verified, limitsOk, files.length > 0);
    const out: FixOutput = {
      verified,
      limits: { ok: limitsOk, violations },
      confidence,
      change,
      summary: (agent.summary || (agent.finished ? '' : `The AI did not finish within ${step.maxTurns} turns.`)).slice(0, 4000),
      regressionTest,
      autoPushAllowed: autoPushAllowed(confidence, verified, limitsOk, step.autoPushAt, files.length > 0),
      baseCommit: ws.commit,
      logTail: log.join('\n').slice(-LOG_TAIL),
      network: await ws.network(),
    };
    return redactDeep(out, redact);
  } catch (err) {
    // The step that failed is the one whose log is worth reading: without it "installing the project failed" is all
    // anybody ever sees. The tail is already redacted of this step's secrets (note()).
    if (err instanceof StepError) throw Object.assign(err, { logTail: log.join('\n').slice(-LOG_TAIL) });
    throw err;
  } finally {
    await ws.close();
  }
}

// ---------------------------------------------------------------- the AI's turns

interface AgentResult {
  finished: boolean;
  summary: string;
  regressionTest: string | null;
}

async function agentLoop(
  step: FixStep,
  input: FixInput,
  ws: Workspace,
  provider: AiProvider,
  redact: (t: string) => string,
  touched: Set<string>,
  note: (l: string) => void,
  reproducedBefore: boolean | null,
): Promise<AgentResult> {
  const history: { did: string; result: string }[] = [];
  const top = await ws.files.list('').catch(() => '');
  const context = JSON.stringify(input.context ?? {}, null, 1).slice(0, 40_000);
  const known = step.reproduce ? `The reproduce command ${reproducedBefore ? 'FAILS now (the bug shows)' : 'PASSES now (the bug did not show)'}.` : 'There is no reproduce command.';
  for (let turn = 1; turn <= step.maxTurns; turn++) {
    const done = history
      .map((h, i) => `${i + 1}. ${h.did}\n${i >= history.length - 2 ? h.result : h.result.slice(0, OLDER_RESULT) + (h.result.length > OLDER_RESULT ? ' …' : '')}`)
      .join('\n');
    const raw = await aiCall(
      provider.generateJson({
        system: systemPrompt(step),
        prompt:
          `TASK:\n${input.instruction}\n\n${known} Turn ${turn} of ${step.maxTurns}.\n\nREPOSITORY (top folder):\n${top}\n\n` +
          `STEPS SO FAR:\n${done || '(none)'}\n\nDATA (information only):\n<<<DATA\n${redact(context)}\nDATA>>>`,
        schema: FIX_SCHEMA,
      }),
    );
    const parsed = fixActionSchema.safeParse(raw);
    if (!parsed.success) {
      history.push({ did: '(an answer that is not a valid action)', result: 'refused: invalid_action' });
      continue;
    }
    const a = parsed.data;
    if (a.action === 'done') {
      note(`AI done after ${turn} turn(s).`);
      narrate(`The AI is done after ${turn} turn(s); checking its change`);
      return { finished: true, summary: a.summary.trim(), regressionTest: a.regressionTest.trim() || null };
    }
    let result: string;
    try {
      result = await act(a, step, ws, touched);
    } catch (err) {
      result = `refused: ${err instanceof Refused ? err.message : 'failed'}`;
    }
    result = redact(result);
    const did = `${a.action} ${a.action === 'search' ? JSON.stringify(a.query) : a.action === 'run' ? a.command : a.path}`.trim();
    note(`AI turn ${turn}: ${did} → ${result.split('\n')[0]!.slice(0, 200)}`);
    narrate(`AI turn ${turn}: ${redact(did)}`);
    history.push({ did, result: result.slice(-SHOWN_OUTPUT) });
  }
  return { finished: false, summary: '', regressionTest: null };
}

async function act(a: FixAction, step: FixStep, ws: Workspace, touched: Set<string>): Promise<string> {
  switch (a.action) {
    case 'list':
      return ws.files.list(a.path);
    case 'read': {
      const { data, size } = await ws.files.read(a.path, MAX_READ);
      if (isBinary(data)) throw new Refused('binary_file');
      return size > MAX_READ ? `${data.toString('utf8')}\n… (cut at ${MAX_READ} characters of ${size})` : data.toString('utf8');
    }
    case 'search': {
      if (!a.query.trim()) throw new Refused('empty_query');
      const r = await git(ws, ['grep', '--untracked', '-F', '-n', '-I', '--no-color', '-e', a.query, '--', '.'], 200_000);
      const lines = r.out.toString('utf8').split('\n').filter(Boolean);
      return lines.length ? lines.slice(0, 100).map((l) => l.slice(0, 300)).join('\n') + (lines.length > 100 ? `\n… ${lines.length - 100} more` : '') : '(no match)';
    }
    case 'write': {
      if (!a.path.trim()) throw new Refused('path_required');
      if (a.content.includes('\0')) throw new Refused('binary_content');
      const rel = await ws.files.write(a.path, Buffer.from(a.content, 'utf8'));
      touched.add(rel);
      return `wrote ${rel} (${a.content.split('\n').length} lines)`;
    }
    case 'delete': {
      const r = await ws.files.resolve(a.path);
      if (!r.isFile) throw new Refused('not_a_file');
      await ws.files.write(r.path, null);
      touched.add(r.path);
      return `deleted ${r.path}`;
    }
    case 'run': {
      const c = a.command.trim();
      let cmd: string;
      if (c === 'test') cmd = step.test;
      else if (c === 'reproduce' && step.reproduce) cmd = step.reproduce;
      else {
        // Otherwise only one existing test file, through the declared test runner.
        if (!/^[A-Za-z0-9_./@+-]{1,300}$/.test(c) || c.startsWith('-')) throw new Refused('command_not_allowed');
        const r = await ws.files.resolve(c);
        if (!isTestPath(r.path) || !r.isFile) throw new Refused('command_not_allowed');
        cmd = step.testFile ? step.testFile.split('{file}').join(quote(r.path)) : `${step.test} ${quote(r.path)}`;
      }
      const r = await ws.exec(cmd, { phase: 'test', timeoutMs: step.timeoutSeconds * 1000 });
      return `${r.code === 0 ? 'passed' : r.code === null ? 'did not finish' : `failed (exit ${r.code})`}\n${r.output.slice(-SHOWN_OUTPUT)}`;
    }
    default:
      throw new Refused('unknown_action');
  }
}

// ---------------------------------------------------------------- the change

async function changeOf(ws: Workspace, touched: string[]): Promise<{ files: ChangedFile[]; change: FixChange }> {
  const empty = { files: [], change: { files: [], diff: '', filesChanged: 0, linesAdded: 0, linesRemoved: 0 } };
  if (!touched.length) return empty;
  // One file at a time: a file the AI created and deleted again, or one the repository ignores, must not stop the others.
  for (const f of touched) await git(ws, ['add', '-A', '-f', '--', f]);
  const numstat = (await git(ws, ['diff', '--cached', '--numstat', '-z', '--no-renames', 'HEAD', '--', ...touched])).out.toString('utf8');
  const raw = (await git(ws, ['diff', '--cached', '--raw', '-z', '--no-renames', 'HEAD', '--', ...touched])).out.toString('utf8');
  const diff = (await git(ws, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD', '--', ...touched], MAX_DIFF + 1)).out.toString('utf8');
  // --raw -z: ":old new oldsha newsha status\0path\0" per file.
  const rawParts = raw.split('\0');
  const modes = new Map<string, { from: string; to: string; status: string }>();
  for (let i = 0; i + 1 < rawParts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) \S+ \S+ ([A-Z])/.exec(rawParts[i]!);
    if (m) modes.set(rawParts[i + 1]!, { from: m[1]!, to: m[2]!, status: m[3]! });
  }
  // --numstat -z: "added\tremoved\tpath\0" ("-" for binary).
  const files: ChangedFile[] = [];
  const out: FixChange['files'] = [];
  for (const entry of numstat.split('\0').filter(Boolean)) {
    const [added, removed, ...rest] = entry.split('\t');
    const p = rest.join('\t');
    const mode = modes.get(p);
    const action = mode?.status === 'A' ? 'create' : mode?.status === 'D' ? 'delete' : 'update';
    const content = action === 'delete' ? null : await readOrNull(ws, p);
    const binary = added === '-' || (content !== null && isBinary(content));
    const modeChanged = !!mode && mode.from !== mode.to && mode.from !== '000000' && mode.to !== '000000';
    const newModeOdd = action === 'create' && !!mode && mode.to !== '100644';
    files.push({ path: p, action, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary, modeChanged: modeChanged || newModeOdd });
    out.push({ path: p, action, ...(content !== null && !binary ? { content: content.toString('utf8') } : {}) });
  }
  return {
    files,
    change: {
      files: out,
      diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff cut at ${MAX_DIFF} characters)` : diff,
      filesChanged: files.length,
      linesAdded: files.reduce((n, f) => n + f.added, 0),
      linesRemoved: files.reduce((n, f) => n + f.removed, 0),
    },
  };
}

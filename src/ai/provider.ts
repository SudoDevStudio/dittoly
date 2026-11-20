import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AiProviderId } from '../config.js';
import { activityReporter } from '../core/progress.js';

import { AiError, draftReviewRound, draftingMaySearch, looseJson, parseObject, rawExcerpt, refuseImages, type AiImage, type AiProvider as BaseProvider, type JsonRequest } from '../runtime/ai.js';

/**
 * The AI provider layer. Providers only ever return a proposal (a draft module
 * or flow); nothing they return is run until a human approves it, and changing
 * the provider changes none of the controls.
 */
export { AiError, draftReviewRound, draftingMaySearch, looseJson, parseObject, rawExcerpt, refuseImages, type AiImage, type JsonRequest };

export interface AiProvider extends BaseProvider {
  readonly id: AiProviderId;
}

interface CliResult {
  code: number | null;
  stdout: string;
  /** The end of what it wrote to stderr (CLIs report errors there), to tell a missing model from other failures. */
  stderr: string;
}

/** Kept of a CLI's stderr: enough for its error message, never the whole log. */
const STDERR_KEPT = 8000;

/**
 * How the CLIs say the model asked for does not exist (or this account cannot use it):
 * - Claude Code: `{"is_error": true, "result": "There's an issue with the selected model (x). It may not exist or you
 *   may not have access to it. ..."}`, or the API's own `not_found_error` for `model: x`;
 * - Codex: on stderr, the API's `model_not_found`, or "The model `x` does not exist or you do not have access to it."
 * Anything else stays ai_cli_failed.
 */
const MODEL_MISSING = /issue with the selected model|"?not_found_error"?[^\n]{0,200}model|model_not_found|model\W{1,3}[\w.:\/-]{1,100}\W{1,3}(does not exist|not found|is not supported)/i;

/**
 * What a CLI said as it failed, short enough to read and safe to keep.
 *
 * "The AI command-line provider failed" on its own sends a person looking through logs on the server for a line
 * the CLI already wrote: not signed in, no credit left, a model this account cannot use, a proxy refusing it. So
 * the last thing it said is kept with the error — the CLI's own message, never a whole log, and never a secret:
 * anything shaped like a key, a token or an authorization header is blanked out first.
 */
const SECRETS = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|secret|password|passwd|pwd)["'\s:=]{1,4}[A-Za-z0-9._~+/=-]{6,}/gi,
];
const DETAIL_KEPT = 400;

export function cliDetail(r: CliResult, extra = ''): string {
  // Its own error message first (Claude Code puts it in `result`), else the end of stderr, else stdout.
  const said = [extra, r.stderr, r.stdout]
    .map((t) => (t ?? '').trim())
    .find((t) => t.length > 0) ?? '';
  let text = said.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' ');
  for (const secret of SECRETS) text = text.replace(secret, '[removed]');
  text = text.slice(0, DETAIL_KEPT);
  const exit = r.code === null ? 'the CLI was stopped' : `the CLI exited with code ${r.code}`;
  return text ? `${exit}: ${text}` : `${exit} and said nothing`;
}

function cliFailure(r: CliResult, extra = ''): AiError {
  return new AiError(MODEL_MISSING.test(`${r.stdout}\n${r.stderr}\n${extra}`) ? 'ai_model_not_found' : 'ai_cli_failed', cliDetail(r, extra));
}

/**
 * How long a CLI may take for one answer. Drafting a whole module at a high effort can take several minutes;
 * DITTOLY_AI_CLI_TIMEOUT_MS changes it (at least one minute).
 */
export function cliTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.DITTOLY_AI_CLI_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 60_000 ? v : 900_000;
}

function runCli(cmd: string, args: string[], stdin: string, cwd: string, timeoutMs: number, onLine?: (line: string) => void): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let partial = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      stdout += text;
      if (!onLine) return;
      const lines = (partial + text).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        try {
          onLine(line);
        } catch {
          // Watching the CLI work never stops it.
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-STDERR_KEPT)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new AiError('ai_cli_not_installed') : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Out of time: ai_timeout (a plan item tries it again later), not a CLI failure.
      if (timedOut) reject(new AiError('ai_timeout', `the CLI gave no answer within ${Math.round(timeoutMs / 60_000)} minutes`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

type ClaudeBlock = { type?: string; name?: string; text?: string; thinking?: string; input?: { query?: string; url?: string } };

/** What a Claude Code stream-json line says it is doing, in a few words: its searches, the pages it reads, its answer. */
export function claudeActivity(line: string): string[] {
  let e: { type?: string; parent_tool_use_id?: string | null; message?: { content?: ClaudeBlock[] } };
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  if (e.type !== 'assistant' || e.parent_tool_use_id || !Array.isArray(e.message?.content)) return [];
  const out: string[] = [];
  for (const b of e.message.content) {
    if (b.type === 'thinking' && b.thinking) out.push(`thinking: ${b.thinking.trim().split('\n')[0]}`);
    else if (b.type === 'tool_use' && b.name === 'WebSearch') out.push(b.input?.query ? `searching the web: ${b.input.query}` : 'searching the web');
    else if (b.type === 'tool_use' && b.name === 'WebFetch') out.push(b.input?.url ? `reading: ${b.input.url}` : 'reading a web page');
    else if (b.type === 'tool_use' && b.name === 'StructuredOutput') out.push('writing the answer');
  }
  return out;
}

/** A page Claude Code fetched while working (WebFetch), to read again later. */
export function claudePage(line: string): string | undefined {
  try {
    const e = JSON.parse(line) as { type?: string; message?: { content?: ClaudeBlock[] } };
    if (e.type !== 'assistant') return undefined;
    const url = e.message?.content?.find((b) => b.type === 'tool_use' && b.name === 'WebFetch')?.input?.url;
    return url && /^https:\/\/\S+$/i.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The "result" line of a stream-json run (the last one); a single JSON object (--output-format json) also reads. */
function claudeResult(stdout: string): Record<string, never> & { is_error?: boolean; result?: unknown; structured_output?: unknown; usage?: never } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]!) as { type?: string };
      if (e.type === 'result') return e as never;
    } catch {
      // Not a JSON line.
    }
  }
  return JSON.parse(stdout) as never;
}

/**
 * Claude Code CLI in non-interactive mode (`claude -p`), with all tools
 * disabled and structured output. Runs in an empty directory so no project
 * files, CLAUDE.md or project MCP config are picked up. Local mode only.
 */
export class ClaudeCliProvider implements AiProvider {
  readonly id = 'claude-cli' as const;

  /** The Claude Code CLI has no command that lists models; these are its documented aliases (full names such as claude-opus-5-5 also work). */
  async listModels(): Promise<string[]> {
    return ['fable', 'opus', 'sonnet', 'haiku'];
  }
  constructor(
    private readonly model?: string,
    private readonly bin = 'claude',
    private readonly timeoutMs = cliTimeoutMs(),
  ) {}

  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    refuseImages(req);
    const cwd = await mkdtemp(path.join(tmpdir(), 'dty-ai-'));
    try {
      const args = [
        '-p',
        // One JSON object a line as it works (its searches, the pages it reads), ending with the "result" line that
        // holds the structured output (checked with Claude Code 2.1.321).
        '--output-format',
        'stream-json',
        '--verbose',
        '--json-schema',
        JSON.stringify(req.schema),
        '--system-prompt',
        req.system,
        // Drafting may search and read the web for current docs (and nothing else); every other call has no tools.
        ...(req.webSearch && draftingMaySearch() ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', '']),
        '--strict-mcp-config',
        '--no-session-persistence',
      ];
      const model = req.model ?? this.model;
      if (model) args.push('--model', model);
      // Claude Code's --effort takes the same levels (a model without one falls back to the highest it has).
      if (req.effort) args.push('--effort', req.effort);
      const note = activityReporter();
      const r = await runCli(this.bin, args, req.prompt, cwd, this.timeoutMs, (line) => {
        for (const what of claudeActivity(line)) note(what);
        const page = claudePage(line);
        if (page) req.onSources?.([{ url: page }]);
      });
      let parsed: { is_error?: boolean; result?: unknown; structured_output?: unknown; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
      try {
        parsed = claudeResult(r.stdout);
      } catch {
        // A CLI that stopped before answering (a model it does not know, among others) writes no JSON.
        throw r.code !== 0 ? cliFailure(r) : new AiError('ai_output_unparseable', `the Claude CLI wrote ${r.stdout.length} characters that are not JSON`);
      }
      if (r.code !== 0 || parsed.is_error) throw cliFailure(r, typeof parsed.result === 'string' ? parsed.result : '');
      const u = parsed.usage;
      if (u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
        req.onUsage?.({ inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens, model: model ?? 'claude-cli' });
      }
      const out = parsed.structured_output;
      if (!out || typeof out !== 'object') throw new AiError('ai_no_structured_output');
      return out as Record<string, unknown>;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

type CodexEvent = { type?: string; item?: { type?: string; text?: string; query?: string; command?: string; action?: { type?: string; url?: string } } };

/** The page a finished Codex web search opened (or a query that is itself a link), to read again later. */
export function codexPage(line: string): string | undefined {
  let e: CodexEvent;
  try {
    e = JSON.parse(line) as CodexEvent;
  } catch {
    return undefined;
  }
  if (e.type !== 'item.completed' || e.item?.type !== 'web_search') return undefined;
  const url = e.item.action?.url ?? e.item.query;
  return url && /^https:\/\/\S+$/i.test(url) ? url : undefined;
}

/**
 * What a Codex CLI event (`codex exec --json`, one JSON object a line; codex-rs/exec/src/exec_events.rs) says it is
 * doing, in a few words, for the person watching the draft; undefined for events that say nothing new.
 */
export function codexActivity(line: string): string | undefined {
  let e: CodexEvent;
  try {
    e = JSON.parse(line) as CodexEvent;
  } catch {
    return undefined;
  }
  const item = e.item ?? {};
  if (e.type === 'turn.started') return 'thinking';
  if (e.type === 'item.started' && item.type === 'web_search') return item.query ? `searching the web: ${item.query}` : 'searching the web';
  // A search that opened a page has no query; it still finished.
  if (e.type === 'item.completed' && item.type === 'web_search') return item.query ? `read search results: ${item.query}` : 'read a web page';
  // A reasoning summary starts with its title ("**Checking the comments endpoint**").
  if (e.type === 'item.completed' && item.type === 'reasoning' && item.text) return `thinking: ${item.text.trim().split('\n')[0]}`;
  if (e.type === 'item.started' && item.type === 'command_execution' && item.command) return `running: ${item.command}`;
  if (e.type === 'item.started' && item.type === 'agent_message') return 'writing the answer';
  return undefined;
}

/**
 * OpenAI Codex CLI in non-interactive mode (`codex exec`), read-only sandbox,
 * no session files, final message constrained by --output-schema. Local mode only.
 */
export class CodexCliProvider implements AiProvider {
  readonly id = 'codex-cli' as const;
  constructor(
    private readonly model?: string,
    private readonly bin = 'codex',
    private readonly timeoutMs = cliTimeoutMs(),
  ) {}

  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    refuseImages(req);
    const cwd = await mkdtemp(path.join(tmpdir(), 'dty-ai-'));
    try {
      const schemaPath = path.join(cwd, 'schema.json');
      const outPath = path.join(cwd, 'last-message.json');
      await writeFile(schemaPath, JSON.stringify(req.schema));
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outPath,
        // Its events, one JSON object a line, so the person sees what it is doing while it works.
        '--json',
      ];
      const model = req.model ?? this.model;
      if (model) args.push('--model', model);
      // Codex's levels stop at xhigh.
      if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort === 'max' ? 'xhigh' : req.effort}"`);
      // Drafting reads the current docs on the live web; everything else (AI steps in runs) cannot search at all.
      // Codex's own default (cached search) is never left on by accident.
      args.push('-c', `web_search="${req.webSearch && draftingMaySearch() ? 'live' : 'disabled'}"`);
      // No shell: everything it needs is in the prompt, so it never spends minutes listing or reading local files.
      // (features.shell_tool and features.unified_exec, codex-rs/features/src/lib.rs; an unknown key only warns.)
      args.push('-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false');
      args.push('-');
      const note = activityReporter();
      const r = await runCli(this.bin, args, `${req.system}\n\n${req.prompt}`, cwd, this.timeoutMs, (line) => {
        const what = codexActivity(line);
        if (what) note(what);
        const page = codexPage(line);
        if (page) req.onSources?.([{ url: page }]);
      });
      if (r.code !== 0) throw cliFailure(r);
      let out: unknown;
      try {
        out = JSON.parse(await readFile(outPath, 'utf8'));
      } catch {
        throw new AiError('ai_output_unparseable', 'the Codex CLI left no readable JSON answer');
      }
      if (!out || typeof out !== 'object') throw new AiError('ai_no_structured_output');
      return out as Record<string, unknown>;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

/**
 * Deterministic provider for tests and demos: returns queued responses in order.
 * Classification requests (classify.ts) are answered with "nothing to ask" unless
 * a classification response is queued next; they are recorded separately.
 */
/** Marks a queued mock answer that is an error instead. */
const FAIL = '__mockFail';
/** In a queued mock answer: the pages its web search "read" (passed to onSources, not part of the answer). */
export const SOURCES = '__mockSources';
/** In a queued mock answer: what it "is doing" while it works (as a CLI reports it), then a promise to wait for. */
export const ACTIVITY = '__mockActivity';
export const HOLD = '__mockHold';
/** In a queued mock answer: milliseconds between its activities (as a real AI works step by step); default none. */
export const ACTIVITY_GAP = '__mockActivityGapMs';

export class MockProvider implements AiProvider {
  readonly id = 'mock' as const;
  readonly requests: JsonRequest[] = [];
  /** What listModels answers (tests set it; empty: the provider lists none). */
  models: string[] = [];
  readonly classifications: JsonRequest[] = [];
  constructor(private readonly responses: Record<string, unknown>[] = []) {}

  async listModels(): Promise<string[]> {
    return this.models;
  }

  enqueue(response: Record<string, unknown>): void {
    this.responses.push(response);
  }

  /** Answers only a request `match` accepts (e.g. by its schema): another caller (a background job) cannot take it. */
  private readonly addressed: { match: (req: JsonRequest) => boolean; response: Record<string, unknown> }[] = [];
  enqueueFor(match: (req: JsonRequest) => boolean, response: Record<string, unknown>): void {
    this.addressed.push({ match, response });
  }

  /** The next request fails with this error code (as a busy or unreachable AI service would). */
  fail(code: string): void {
    this.responses.push({ [FAIL]: code });
  }

  /** Drops the answers nobody asked for (a test that stopped early); returns how many there were. */
  clear(): number {
    return this.responses.splice(0).length + this.addressed.splice(0).length;
  }

  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    if ('classificationJson' in ((req.schema as { properties?: object }).properties ?? {})) {
      this.classifications.push(req);
      if (this.responses[0] && 'classificationJson' in this.responses[0]) return this.responses.shift()!;
      return { classificationJson: JSON.stringify({ summary: '', category: 'web_api', protocols: [], questions: [] }) };
    }
    this.requests.push(req);
    const mine = this.addressed.findIndex((a) => a.match(req));
    let next = mine !== -1 ? this.addressed.splice(mine, 1)[0]!.response : this.responses.shift();
    if (!next) throw new AiError('mock_exhausted');
    if (typeof next[FAIL] === 'string') throw new AiError(next[FAIL] as string);
    if (Array.isArray(next[ACTIVITY]) || next[HOLD] instanceof Promise) {
      const note = activityReporter();
      const gap = typeof next[ACTIVITY_GAP] === 'number' ? (next[ACTIVITY_GAP] as number) : 0;
      for (const a of (next[ACTIVITY] as string[] | undefined) ?? []) {
        note(a);
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
      await next[HOLD];
      const { [ACTIVITY]: _a, [HOLD]: _h, [ACTIVITY_GAP]: _g, ...answer } = next;
      next = answer;
    }
    // Pages its "web search" read, as a provider with search reports them.
    if (Array.isArray(next[SOURCES])) {
      req.onSources?.(next[SOURCES] as { url: string; title?: string }[]);
      const { [SOURCES]: _s, ...answer } = next;
      next = answer;
    }
    // Roughly four characters a token, so budgets can be tested.
    req.onUsage?.({ inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: Math.ceil(JSON.stringify(next).length / 4), model: req.model ?? 'mock' });
    return next;
  }
}

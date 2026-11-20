import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinTo } from '../src/ai/models.js';
import { ClaudeCliProvider, claudeActivity, cliTimeoutMs, codexActivity, CodexCliProvider, draftingMaySearch } from '../src/ai/provider.js';
import { progress, withProgress, type Progress } from '../src/core/progress.js';

/**
 * The Claude Code and Codex CLI providers, against fake CLIs that answer like the real ones: a model
 * the CLI does not know is ai_model_not_found (so a pinned Flow fails with pinned_model_unavailable),
 * any other failure stays ai_cli_failed.
 */
let dir: string;
let claude: string;
let codex: string;
const req = { system: 'Answer.', prompt: 'Say ok.', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } };

// Both fake CLIs read the model after --model: "gone" is unknown, "broken" fails otherwise, anything else answers.
const claudeScript = `#!/usr/bin/env node
const a = process.argv.slice(2);
const model = a[a.indexOf('--model') + 1];
if (model === 'gone') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: "There's an issue with the selected model (gone). It may not exist or you may not have access to it. Run --model to pick a different model." }));
  process.exit(1);
}
if (model === 'gone-api') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: gone-api"}}' }));
  process.exit(1);
}
if (model === 'broken') {
  process.stderr.write('Error: connect ECONNREFUSED\\n');
  process.exit(1);
}
if (model === 'events') {
  // What claude -p --output-format stream-json --verbose writes (checked with Claude Code 2.1.321).
  const lines = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'Finding the comments endpoint\\nmore' }, { type: 'tool_use', name: 'WebSearch', input: { query: 'GitHub REST review comments' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://docs.github.com/en/rest/pulls/comments' } }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { ok: true } }] } },
    { type: 'result', subtype: 'success', is_error: false, structured_output: { ok: true }, usage: { input_tokens: 3, output_tokens: 2 } },
  ].map((l) => JSON.stringify(l) + '\\n').join('');
  process.stdout.write(lines.slice(0, 40));
  process.stdout.write(lines.slice(40));
  process.exit(0);
}
// "echo" answers with the arguments it was given.
const out = model === 'echo' ? { ok: true, args: a.join(' ') } : { ok: true };
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: out, usage: { input_tokens: 3, output_tokens: 2 } }));
`;
const codexScript = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const model = a[a.indexOf('--model') + 1];
if (model === 'gone') {
  process.stderr.write('[2026-10-21T10:00:00] ERROR: unexpected status 404 Not Found: {"error":{"message":"The model \`gone\` does not exist or you do not have access to it.","type":"invalid_request_error","param":null,"code":"model_not_found"}}\\n');
  process.exit(1);
}
if (model === 'broken') {
  process.stderr.write('ERROR: stream disconnected before completion\\n');
  process.exit(1);
}
if (model === 'events') {
  // What codex exec --json writes while it works (codex-rs/exec/src/exec_events.rs), split across writes.
  const ev = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'w1', type: 'web_search', query: 'GitHub REST create review comment', action: { type: 'search' } } },
    { type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: '**Checking the review comments endpoint**\\n\\nThe docs say…' } },
    { type: 'item.started', item: { id: 'i3', type: 'agent_message', text: '' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
  ].map((e) => JSON.stringify(e) + '\\n').join('');
  process.stdout.write(ev.slice(0, 50));
  process.stdout.write(ev.slice(50) + 'not json\\n');
}
if (model === 'slow') setTimeout(() => {}, 60_000);
else fs.writeFileSync(a[a.indexOf('--output-last-message') + 1], JSON.stringify(model === 'echo' ? { ok: true, args: a.join(' ') } : { ok: true }));
`;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dty-fake-cli-'));
  claude = path.join(dir, 'claude');
  codex = path.join(dir, 'codex');
  await writeFile(claude, claudeScript);
  await writeFile(codex, codexScript);
  await chmod(claude, 0o755);
  await chmod(codex, 0o755);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const code = (p: Promise<unknown>) => p.then(() => 'ok', (err: Error & { code?: string }) => err.code ?? err.message);

describe('Claude Code CLI', () => {
  it('tells the person what it is doing from its stream-json lines, and answers from the result line', async () => {
    const seen: Progress[] = [];
    const pages: string[] = [];
    const out = await withProgress((p) => seen.push(p), async () => {
      progress('drafting', 10);
      return new ClaudeCliProvider('events', claude).generateJson({ ...req, onSources: (s) => pages.push(...s.map((x) => x.url)) });
    });
    expect(out).toEqual({ ok: true });
    expect(seen.map((p) => p.detail ?? `${p.step} ${p.percent}`)).toEqual([
      'drafting 10',
      'thinking: Finding the comments endpoint',
      'searching the web: GitHub REST review comments',
      'reading: https://docs.github.com/en/rest/pulls/comments',
      'writing the answer',
    ]);
    expect(pages).toEqual(['https://docs.github.com/en/rest/pulls/comments']);
  });

  it('runs with stream-json and --verbose; a subagent\'s steps are not shown as its own', async () => {
    expect((await new ClaudeCliProvider('echo', claude).generateJson(req)).args).toContain('--output-format stream-json --verbose');
    expect(claudeActivity(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'q' } }] } }))).toEqual([]);
    expect(claudeActivity('not json')).toEqual([]);
  });

  it('answers with the model it knows', async () => {
    expect(await new ClaudeCliProvider('sonnet', claude).generateJson(req)).toEqual({ ok: true });
  });

  it('tells a model it does not know from other failures', async () => {
    expect(await code(new ClaudeCliProvider('gone', claude).generateJson(req))).toBe('ai_model_not_found');
    expect(await code(new ClaudeCliProvider('gone-api', claude).generateJson(req))).toBe('ai_model_not_found');
    expect(await code(new ClaudeCliProvider('broken', claude).generateJson(req))).toBe('ai_cli_failed');
  });

  it('a Flow pinned to a model the CLI no longer knows fails with pinned_model_unavailable', async () => {
    const p = new ClaudeCliProvider(undefined, claude);
    expect(await code(pinTo(p, 'claude-cli:gone').generateJson(req))).toBe('pinned_model_unavailable');
    expect(await code(pinTo(p, 'claude-cli:broken').generateJson(req))).toBe('ai_cli_failed');
    expect(await pinTo(p, 'claude-cli:sonnet').generateJson(req)).toEqual({ ok: true });
  });
});

describe('effort on the command line', () => {
  it('Claude Code may use only web search and fetch, and only when drafting asks for it', async () => {
    expect((await new ClaudeCliProvider('echo', claude).generateJson({ ...req, webSearch: true })).args).toContain('--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch');
    const plain = String((await new ClaudeCliProvider('echo', claude).generateJson(req)).args);
    expect(plain).toContain('--tools  --strict-mcp-config');
    expect(plain).not.toContain('WebSearch');
  });

  it('Claude Code gets --effort; none when no effort is set', async () => {
    expect((await new ClaudeCliProvider('echo', claude).generateJson({ ...req, effort: 'low' })).args).toContain('--effort low');
    expect((await new ClaudeCliProvider('echo', claude).generateJson(req)).args).not.toContain('--effort');
  });

  it('Codex gets model_reasoning_effort, max mapped to its highest level (xhigh)', async () => {
    expect((await new CodexCliProvider('echo', codex).generateJson({ ...req, effort: 'medium' })).args).toContain('-c model_reasoning_effort="medium"');
    expect((await new CodexCliProvider('echo', codex).generateJson({ ...req, effort: 'max' })).args).toContain('-c model_reasoning_effort="xhigh"');
  });
});

describe('Codex CLI', () => {
  it('tells the person what it is doing while it drafts, from its --json events', async () => {
    const seen: Progress[] = [];
    const out = await withProgress((p) => seen.push(p), async () => {
      progress('drafting', 10);
      return new CodexCliProvider('events', codex).generateJson(req);
    });
    expect(out).toEqual({ ok: true });
    expect(seen.map((p) => p.detail ?? `${p.step} ${p.percent}`)).toEqual([
      'drafting 10',
      'thinking',
      'searching the web: GitHub REST create review comment',
      'thinking: Checking the review comments endpoint',
      'writing the answer',
    ]);
    // Every activity keeps the step it happens in.
    expect(seen.every((p) => p.step === 'drafting' && p.percent === 10)).toBe(true);
  });

  it('reads only the events that say something new', () => {
    expect(codexActivity('{"type":"thread.started","thread_id":"x"}')).toBeUndefined();
    expect(codexActivity('{"type":"item.started","item":{"type":"web_search","query":""}}')).toBe('searching the web');
    expect(codexActivity('{"type":"item.started","item":{"type":"command_execution","command":"ls"}}')).toBe('running: ls');
    expect(codexActivity('garbage')).toBeUndefined();
  });

  it('runs with --json, keeping its last message as the answer', async () => {
    expect((await new CodexCliProvider('echo', codex).generateJson(req)).args).toMatch(/--output-last-message \S+ --json/);
  });

  it('answers with the model it knows', async () => {
    expect(await new CodexCliProvider('gpt-5', codex).generateJson(req)).toEqual({ ok: true });
  });

  it('may search the live web only when drafting asks for it; otherwise web search is off (never its cached default)', async () => {
    expect((await new CodexCliProvider('echo', codex).generateJson({ ...req, webSearch: true })).args).toContain('-c web_search="live"');
    expect((await new CodexCliProvider('echo', codex).generateJson(req)).args).toContain('-c web_search="disabled"');
    expect(draftingMaySearch({ DITTOLY_AI_WEB_SEARCH: 'off' })).toBe(false);
    expect(draftingMaySearch({})).toBe(true);
  });

  it('a CLI that takes too long is ai_timeout (tried again later), after 15 minutes unless set otherwise', async () => {
    expect(await code(new CodexCliProvider('slow', codex, 300).generateJson(req))).toBe('ai_timeout');
    expect(cliTimeoutMs({})).toBe(900_000);
    expect(cliTimeoutMs({ DITTOLY_AI_CLI_TIMEOUT_MS: '1200000' })).toBe(1_200_000);
    expect(cliTimeoutMs({ DITTOLY_AI_CLI_TIMEOUT_MS: '5' })).toBe(900_000);
  });

  it('reads the missing model from its error output; other failures stay ai_cli_failed', async () => {
    expect(await code(new CodexCliProvider('gone', codex).generateJson(req))).toBe('ai_model_not_found');
    expect(await code(new CodexCliProvider('broken', codex).generateJson(req))).toBe('ai_cli_failed');
    expect(await code(pinTo(new CodexCliProvider(undefined, codex), 'codex-cli:gone').generateJson(req))).toBe('pinned_model_unavailable');
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/runtime/ai-anthropic.js';
import { createProvider } from '../src/ai/factory.js';
import { MODULE_RESPONSE_SCHEMA } from '../src/ai/generate-module.js';
import { OllamaProvider } from '../src/runtime/ai-ollama.js';
import { OpenAiProvider } from '../src/runtime/ai-openai.js';
import { ConfigError, loadConfig } from '../src/config.js';

/**
 * These tests run each provider against a local server that speaks that API's
 * wire format. They check request shape and response handling; they are not a
 * substitute for a live call with real credentials.
 */

interface Captured {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let base: string;
let captured: Captured[] = [];
let handler: (req: Captured, res: ServerResponse) => void = () => undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const c = { path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      captured.push(c);
      handler(c, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  captured = [];
});

const schema = MODULE_RESPONSE_SCHEMA as unknown as Record<string, unknown>;
const answer = { manifestJson: '{}', code: 'export const actions = {}', testsJson: '[]' };
const req = { system: 'SYSTEM', prompt: 'PROMPT', schema };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------- Anthropic

function anthropicStream(res: ServerResponse, text: string, stopReason: string, before: unknown[] = []) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  // Blocks before the answer (e.g. web search results) arrive whole, as the API streams them.
  before.forEach((block, i) => {
    send('content_block_start', { type: 'content_block_start', index: i, content_block: block });
    send('content_block_stop', { type: 'content_block_stop', index: i });
  });
  const at = before.length;
  send('content_block_start', { type: 'content_block_start', index: at, content_block: { type: 'text', text: '' } });
  // Split the JSON across deltas, as a real stream does.
  const mid = Math.floor(text.length / 2);
  for (const part of [text.slice(0, mid), text.slice(mid)]) {
    send('content_block_delta', { type: 'content_block_delta', index: at, delta: { type: 'text_delta', text: part } });
  }
  send('content_block_stop', { type: 'content_block_stop', index: at });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

describe('Anthropic provider', () => {
  const provider = () => new AnthropicProvider(undefined, { baseURL: base, apiKey: 'test-key' });

  it('streams a structured-output request to claude-opus-5-5 and parses the JSON', async () => {
    handler = (_c, res) => anthropicStream(res, JSON.stringify(answer), 'end_turn');
    await expect(provider().generateJson(req)).resolves.toEqual(answer);
    const c = captured[0]!;
    expect(c.path).toMatch(/^\/v1\/messages/);
    expect(c.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'PROMPT' }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      fallbacks: 'default',
    });
    expect(String(c.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    // SDK 1.x: API version 2026-10-21, the key as a bearer token (the API accepts either header).
    expect(c.headers.authorization).toBe('Bearer test-key');
    expect(c.headers['anthropic-version']).toBe('2026-10-21');
  });

  it('does not send effort or fallbacks for models outside the current set', async () => {
    handler = (_c, res) => anthropicStream(res, JSON.stringify(answer), 'end_turn');
    await new AnthropicProvider('claude-haiku-4-5', { baseURL: base, apiKey: 'k' }).generateJson(req);
    const body = captured[0]!.body as { output_config: Record<string, unknown>; fallbacks?: unknown };
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema } });
    expect(body.fallbacks).toBeUndefined();
    expect(captured[0]!.headers['anthropic-beta']).toBeUndefined();
  });

  it('reports refusals and truncation as error codes', async () => {
    handler = (_c, res) => anthropicStream(res, '', 'refusal');
    await expect(provider().generateJson(req)).rejects.toMatchObject({ code: 'ai_refused' });
    handler = (_c, res) => anthropicStream(res, '{"manifestJson":', 'max_tokens');
    await expect(provider().generateJson(req)).rejects.toMatchObject({ code: 'ai_output_truncated' });
  });

  it('asks for a pinned model per request, and reports a model it no longer has', async () => {
    handler = (_c, res) => anthropicStream(res, JSON.stringify(answer), 'end_turn');
    await provider().generateJson({ ...req, model: 'claude-sonnet-5-5' });
    expect(captured[0]!.body).toMatchObject({ model: 'claude-sonnet-5-5' });
    handler = (_c, res) => json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-old' } });
    await expect(provider().generateJson({ ...req, model: 'claude-old' })).rejects.toMatchObject({ code: 'ai_model_not_found' });
  });

  it('maps an authentication failure without exposing the API message', async () => {
    handler = (_c, res) => json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    await expect(provider().generateJson(req)).rejects.toMatchObject({ code: 'ai_auth_failed', message: 'ai_auth_failed' });
  });
  const searched = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'github rest api create review comment' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://docs.github.com/en/rest/pulls/comments', title: 'REST API endpoints for pull request review comments', encrypted_content: 'x', page_age: null }] },
  ];

  it('drafting may search and fetch the web; the pages read are reported as sources', async () => {
    handler = (_c, res) => anthropicStream(res, JSON.stringify(answer), 'end_turn', searched);
    const sources: unknown[] = [];
    await expect(provider().generateJson({ ...req, webSearch: true, onSources: (s) => sources.push(...s) })).resolves.toEqual(answer);
    expect(captured[0]!.body.tools).toEqual([
      { type: 'web_search_20260318', name: 'web_search', max_uses: 8 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
    ]);
    expect(sources).toEqual([{ url: 'https://docs.github.com/en/rest/pulls/comments', title: 'REST API endpoints for pull request review comments' }]);
    // Not asked to search (e.g. an AI step in a run): no tools at all.
    handler = (_c, res) => anthropicStream(res, JSON.stringify(answer), 'end_turn');
    await provider().generateJson(req);
    expect(captured[1]!.body.tools).toBeUndefined();
  });

  it('a paused search turn is resumed by sending it back; older models get the basic tools', async () => {
    let n = 0;
    handler = (_c, res) => (n++ === 0 ? anthropicStream(res, '', 'pause_turn', searched) : anthropicStream(res, JSON.stringify(answer), 'end_turn'));
    await expect(provider().generateJson({ ...req, webSearch: true })).resolves.toEqual(answer);
    const second = captured[1]!.body as { messages: { role: string }[] };
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    handler = (_c, res) => anthropicStream(res, JSON.stringify(answer), 'end_turn');
    await new AnthropicProvider('claude-haiku-4-5', { baseURL: base, apiKey: 'k' }).generateJson({ ...req, webSearch: true });
    expect((captured[2]!.body.tools as { type: string }[]).map((t) => t.type)).toEqual(['web_search_20250305', 'web_fetch_20250910']);
  });

  it('where web search is refused (400), the draft is written without it', async () => {
    let n = 0;
    handler = (_c, res) => (n++ === 0 ? json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'web search is not enabled' } }) : anthropicStream(res, JSON.stringify(answer), 'end_turn'));
    await expect(provider().generateJson({ ...req, webSearch: true })).resolves.toEqual(answer);
    expect(captured).toHaveLength(2);
    expect(captured[1]!.body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------- OpenAI

function openaiResponse(content: unknown[], status = 'completed') {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status,
    model: 'gpt-5.5',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content }],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  };
}

describe('OpenAI provider', () => {
  const provider = () => new OpenAiProvider(undefined, { baseURL: `${base}/v1`, apiKey: 'test-key' });

  it('sends a strict json_schema Responses request and parses output_text', async () => {
    handler = (_c, res) => json(res, 200, openaiResponse([{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }]));
    await expect(provider().generateJson(req)).resolves.toEqual(answer);
    const c = captured[0]!;
    expect(c.path).toBe('/v1/responses');
    expect(c.body).toMatchObject({
      model: 'gpt-5.5',
      instructions: 'SYSTEM',
      input: 'PROMPT',
      text: { format: { type: 'json_schema', name: 'dittoly_output', schema, strict: true } },
    });
    expect(c.headers.authorization).toBe('Bearer test-key');
  });

  it('reports refusals and incomplete responses as error codes', async () => {
    handler = (_c, res) => json(res, 200, openaiResponse([{ type: 'refusal', refusal: 'I cannot help with that.' }]));
    await expect(provider().generateJson(req)).rejects.toMatchObject({ code: 'ai_refused' });
    handler = (_c, res) => json(res, 200, openaiResponse([{ type: 'output_text', text: '{"a":', annotations: [] }], 'incomplete'));
    await expect(provider().generateJson(req)).rejects.toMatchObject({ code: 'ai_output_truncated' });
  });

  it('maps an authentication failure', async () => {
    handler = (_c, res) => json(res, 401, { error: { message: 'Incorrect API key', type: 'invalid_request_error' } });
    await expect(provider().generateJson(req)).rejects.toMatchObject({ code: 'ai_auth_failed' });
  });
  it('drafting may search the web; the sources and cited pages come back', async () => {
    handler = (_c, res) => {
      const r = openaiResponse([{ type: 'output_text', text: JSON.stringify(answer), annotations: [{ type: 'url_citation', url: 'https://docs.github.com/en/rest/pulls', title: 'Pulls', start_index: 0, end_index: 1 }] }]);
      json(res, 200, { ...r, output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['github api'], sources: [{ type: 'url', url: 'https://docs.github.com/en/rest/pulls/comments' }] } }, ...r.output] });
    };
    const sources: unknown[] = [];
    await expect(provider().generateJson({ ...req, webSearch: true, onSources: (s) => sources.push(...s) })).resolves.toEqual(answer);
    expect(captured[0]!.body).toMatchObject({ tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'] });
    expect(sources).toEqual([{ url: 'https://docs.github.com/en/rest/pulls/comments' }, { url: 'https://docs.github.com/en/rest/pulls', title: 'Pulls' }]);
    handler = (_c, res) => json(res, 200, openaiResponse([{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }]));
    await provider().generateJson(req);
    expect(captured[1]!.body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------- Ollama

describe('Ollama provider', () => {
  it('posts to /api/chat with the schema as format and parses the message', async () => {
    handler = (_c, res) =>
      json(res, 200, { model: 'qwen3-coder', message: { role: 'assistant', content: JSON.stringify(answer) }, done: true, done_reason: 'stop' });
    await expect(new OllamaProvider('qwen3-coder', base).generateJson(req)).resolves.toEqual(answer);
    expect(captured[0]).toMatchObject({
      path: '/api/chat',
      body: {
        model: 'qwen3-coder',
        stream: false,
        format: schema,
        messages: [
          { role: 'system', content: 'SYSTEM' },
          { role: 'user', content: 'PROMPT' },
        ],
      },
    });
  });

  it('asks for a pinned model per request', async () => {
    handler = (_c, res) => json(res, 200, { message: { role: 'assistant', content: JSON.stringify(answer) }, done: true, done_reason: 'stop' });
    await new OllamaProvider('qwen3-coder', base).generateJson({ ...req, model: 'llama4' });
    expect(captured[0]!.body).toMatchObject({ model: 'llama4' });
  });

  it('asks for a context window the prompt fits in, and for the sampling the operator set', async () => {
    handler = (_c, res) => json(res, 200, { message: { role: 'assistant', content: JSON.stringify(answer) }, done: true, done_reason: 'stop' });
    // Ollama's own default window is a few thousand tokens: a longer prompt would be cut silently, which looks
    // like a stupid model. A short prompt still asks for a small window, so nothing is loaded for nothing.
    await new OllamaProvider('m', base).generateJson(req);
    expect(captured[0]!.body.options).toMatchObject({ temperature: 0, num_ctx: 12_288 }); // room for the answer itself
    const long = { ...req, prompt: 'x'.repeat(100_000) };
    await new OllamaProvider('m', base).generateJson(long);
    expect((captured[1]!.body as { options: { num_ctx: number } }).options.num_ctx).toBe(40_960); // ~31k tokens of prompt plus room for the answer
    // A prompt longer than the ceiling asks for the ceiling (and the server, not Dittoly, decides what fits).
    await new OllamaProvider('m', base).generateJson({ ...req, prompt: 'x'.repeat(400_000) });
    expect((captured[2]!.body as { options: { num_ctx: number } }).options.num_ctx).toBe(65_536);
    // Never more than the operator allows (a laptop pays for every token of context in memory).
    await new OllamaProvider('m', base, undefined, { maxContext: 16_384, temperature: 1, topP: 0.95, topK: 64 }).generateJson(long);
    expect(captured[3]!.body.options).toEqual({ temperature: 1, top_p: 0.95, top_k: 64, num_ctx: 16_384 });
  });

  it('reports a missing model, truncation and an unreachable server', async () => {
    handler = (_c, res) => json(res, 404, { error: 'model "nope" not found, try pulling it first' });
    await expect(new OllamaProvider('nope', base).generateJson(req)).rejects.toMatchObject({ code: 'ai_model_not_found' });
    handler = (_c, res) => json(res, 200, { message: { role: 'assistant', content: '{"a":' }, done: true, done_reason: 'length' });
    await expect(new OllamaProvider('m', base).generateJson(req)).rejects.toMatchObject({ code: 'ai_output_truncated' });
    await expect(new OllamaProvider('m', 'http://127.0.0.1:1').generateJson(req)).rejects.toMatchObject({ code: 'ai_unreachable' });
  });
});

// ---------------------------------------------------------------- configuration

describe('provider configuration', () => {
  const env = { DATABASE_URL: 'postgres://x', DITTOLY_MASTER_KEY: randomBytes(32).toString('base64'), DITTOLY_AMQP_URL: 'amqp://rabbit.internal' };

  afterEach(() => vi.unstubAllEnvs());

  it.each(['anthropic', 'openai'])('%s is allowed on a shared server', (p) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    expect(loadConfig({ ...env, DITTOLY_MODE: 'shared', DITTOLY_AI_PROVIDER: p }).aiProvider).toBe(p);
    expect(createProvider('shared', p as 'anthropic')?.id).toBe(p);
  });

  it('the openai provider fails at startup without OPENAI_API_KEY', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(() => createProvider('shared', 'openai')).toThrow(/OPENAI_API_KEY/);
  });

  it('ollama is allowed in both modes but needs a model name', () => {
    expect(() => loadConfig({ ...env, DITTOLY_MODE: 'shared', DITTOLY_AI_PROVIDER: 'ollama' })).toThrow(ConfigError);
    const c = loadConfig({
      ...env,
      DITTOLY_MODE: 'shared',
      DITTOLY_AI_PROVIDER: 'ollama',
      DITTOLY_AI_MODEL: 'qwen3-coder',
      DITTOLY_OLLAMA_URL: 'http://ollama.internal:11434',
    });
    expect(c.ollamaUrl).toBe('http://ollama.internal:11434');
    expect(createProvider('shared', 'ollama', { model: 'qwen3-coder' })?.id).toBe('ollama');
    expect(() => createProvider('local', 'ollama')).toThrow(ConfigError);
  });
});

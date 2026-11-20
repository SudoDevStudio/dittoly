import Anthropic from '@anthropic-ai/sdk';
import { AiError, cleanSources, draftingMaySearch, parseObject, type AiProvider, type JsonRequest, type WebSource } from './ai.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** Models that accept output_config.effort and the server-side refusal fallback. */
const CURRENT_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/**
 * Anthropic Messages API with structured output (output_config.format).
 * Credentials come from the environment (ANTHROPIC_API_KEY or another source
 * the SDK resolves). Allowed in both deployment modes.
 *
 * On current models the request opts into server-side refusal fallbacks
 * ("default" routing), so a safety-classifier decline is retried on a
 * suitable model inside the same call instead of failing the generation.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    private readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    options: { baseURL?: string; apiKey?: string; timeoutMs?: number } = {},
  ) {
    this.client = new Anthropic({
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      timeout: options.timeoutMs ?? 600_000,
    });
  }

  /** The models the account can use (GET /v1/models), newest first. */
  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list({ limit: 100 })) {
      ids.push(m.id);
      if (ids.length >= 200) break;
    }
    return ids;
  }

  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    if (!req.webSearch || !draftingMaySearch()) return this.ask(req, false);
    try {
      return await this.ask(req, true);
    } catch (err) {
      // A model, platform or organization without web search (or without it next to a JSON schema) answers 400:
      // draft without the web rather than not at all.
      if (!(err instanceof AiError) || err.code !== 'ai_bad_request') throw err;
      return this.ask(req, false);
    }
  }

  private async ask(req: JsonRequest, web: boolean): Promise<Record<string, unknown>> {
    const model = req.model ?? this.model;
    const current = CURRENT_MODELS.has(model);
    const userContent = req.images?.length
      ? [...req.images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })), { type: 'text' as const, text: req.prompt }]
      : req.prompt;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: userContent }];
    const sources: WebSource[] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let message: Anthropic.Beta.BetaMessage | undefined;
    // A long search turn can pause (pause_turn); it is resumed by sending the paused answer back, a few times at most.
    for (let turn = 0; turn < (web ? 4 : 1); turn++) {
      try {
        // Streaming: a whole module can be a long response, and streaming avoids HTTP timeouts.
        const stream = this.client.beta.messages.stream({
          model,
          max_tokens: 64_000,
          system: req.system,
          messages,
          output_config: {
            // The organization's effort when set; else high on current models (working integration code is intelligence-sensitive).
            ...(req.effort ? { effort: req.effort } : current ? { effort: 'high' as const } : {}),
            format: { type: 'json_schema', schema: req.schema },
          },
          // Drafting reads the current official docs: web search, and fetching a page it found or was given.
          ...(web ? { tools: (current ? WEB_TOOLS : WEB_TOOLS_BASIC) as unknown as Anthropic.Beta.BetaToolUnion[] } : {}),
          ...(current ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        });
        message = await stream.finalMessage();
      } catch (err) {
        throw mapError(err);
      }
      const u = message.usage;
      usage = {
        inputTokens: usage.inputTokens + u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: usage.outputTokens + u.output_tokens,
      };
      sources.push(...sourcesOf(message.content));
      if (message.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: message.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
    }
    req.onUsage?.({ ...usage, model: message!.model });
    if (sources.length) req.onSources?.(cleanSources(sources));
    if (message!.stop_reason === 'refusal') throw new AiError('ai_refused');
    if (message!.stop_reason === 'max_tokens') throw new AiError('ai_output_truncated');
    if (message!.stop_reason === 'pause_turn') throw new AiError('ai_timeout', 'the web search did not finish');
    const text = message!.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseObject(text);
  }
}

/**
 * Web search and fetch for drafting (docs: platform.claude.com, tool-use/web-search-tool and web-fetch-tool).
 * Current models get the versions with dynamic filtering; older ones the basic versions. Bounded per answer.
 */
const WEB_TOOLS = [
  { type: 'web_search_20260318', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
] as const;
const WEB_TOOLS_BASIC = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8 },
] as const;

/** The pages a response's web search and fetch results and citations name. */
function sourcesOf(content: unknown[]): WebSource[] {
  const out: { url?: unknown; title?: unknown }[] = [];
  for (const b of content as Record<string, unknown>[]) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) out.push(...(b.content as { url?: unknown; title?: unknown }[]));
    if (b.type === 'web_fetch_tool_result' && b.content && typeof b.content === 'object') {
      const c = b.content as { url?: unknown; content?: { title?: unknown } };
      out.push({ url: c.url, title: c.content?.title });
    }
    if (b.type === 'text' && Array.isArray(b.citations)) out.push(...(b.citations as { url?: unknown; title?: unknown }[]));
  }
  return cleanSources(out);
}

function mapError(err: unknown): AiError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiError('ai_auth_failed');
  }
  if (err instanceof Anthropic.NotFoundError) return new AiError('ai_model_not_found');
  if (err instanceof Anthropic.RateLimitError) return new AiError('ai_rate_limited');
  if (err instanceof Anthropic.BadRequestError) return new AiError('ai_bad_request');
  if (err instanceof Anthropic.APIConnectionError) return new AiError('ai_unreachable');
  if (err instanceof Anthropic.APIError) return new AiError('ai_api_error');
  return new AiError('ai_api_error');
}

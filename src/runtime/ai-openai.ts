import OpenAI from 'openai';
import { AiError, cleanSources, draftingMaySearch, parseObject, type AiProvider, type JsonRequest } from './ai.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

/**
 * OpenAI Responses API with strict JSON-schema output (text.format).
 * Credentials come from OPENAI_API_KEY. Allowed in both deployment modes.
 */
export class OpenAiProvider implements AiProvider {
  readonly id = 'openai' as const;
  private readonly client: OpenAI;

  constructor(
    private readonly model: string = DEFAULT_OPENAI_MODEL,
    options: { baseURL?: string; apiKey?: string; timeoutMs?: number } = {},
  ) {
    this.client = new OpenAI({
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      timeout: options.timeoutMs ?? 600_000,
    });
  }

  /**
   * The models the key can use (GET /v1/models), without the ones that cannot answer a prompt with text
   * (embeddings, speech, images, moderation).
   */
  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) {
      if (!/embedding|tts|whisper|transcribe|dall-e|image|moderation|audio|realtime|search/i.test(m.id)) ids.push(m.id);
      if (ids.length >= 200) break;
    }
    return ids.sort();
  }

  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    if (!req.webSearch || !draftingMaySearch()) return this.ask(req, false);
    try {
      return await this.ask(req, true);
    } catch (err) {
      // A model or account without web search (or without it next to a JSON schema) answers 400: draft without it.
      if (!(err instanceof AiError) || err.code !== 'ai_bad_request') throw err;
      return this.ask(req, false);
    }
  }

  private async ask(req: JsonRequest, web: boolean): Promise<Record<string, unknown>> {
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create({
        // Drafting reads the current official docs on the live web; the pages it used come back as sources.
        ...(web ? { tools: [{ type: 'web_search' as const }], include: ['web_search_call.action.sources' as const] } : {}),
        model: req.model ?? this.model,
        ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
        instructions: req.system,
        input: req.images?.length
          ? [
              {
                role: 'user',
                content: [
                  ...req.images.map((i) => ({ type: 'input_image' as const, image_url: `data:${i.mediaType};base64,${i.data}`, detail: 'auto' as const })),
                  { type: 'input_text' as const, text: req.prompt },
                ],
              },
            ]
          : req.prompt,
        text: {
          format: { type: 'json_schema', name: 'dittoly_output', schema: req.schema, strict: true },
        },
      });
    } catch (err) {
      throw mapError(err);
    }
    if (response.usage) req.onUsage?.({ inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, model: response.model });
    if (web) {
      const found: { url?: unknown; title?: unknown }[] = [];
      for (const item of response.output as unknown as Record<string, unknown>[]) {
        const action = item.type === 'web_search_call' ? (item.action as { sources?: { url?: unknown }[]; url?: unknown } | undefined) : undefined;
        if (action?.sources) found.push(...action.sources);
        if (action?.url) found.push({ url: action.url });
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content as { annotations?: { type?: string; url?: unknown; title?: unknown }[] }[]) found.push(...(c.annotations ?? []).filter((a) => a.type === 'url_citation'));
        }
      }
      const sources = cleanSources(found);
      if (sources.length) req.onSources?.(sources);
    }
    if (response.status === 'incomplete') throw new AiError('ai_output_truncated');
    const refused = response.output.some(
      (item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'),
    );
    if (refused) throw new AiError('ai_refused');
    if (!response.output_text) throw new AiError('ai_no_structured_output');
    return parseObject(response.output_text);
  }
}

function mapError(err: unknown): AiError {
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new AiError('ai_auth_failed');
  }
  if (err instanceof OpenAI.NotFoundError) return new AiError('ai_model_not_found');
  if (err instanceof OpenAI.RateLimitError) return new AiError('ai_rate_limited');
  if (err instanceof OpenAI.BadRequestError) return new AiError('ai_bad_request');
  if (err instanceof OpenAI.APIConnectionError) return new AiError('ai_unreachable');
  return new AiError('ai_api_error');
}

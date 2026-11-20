import { AiError, parseObject, type AiProvider, type JsonRequest, refuseImages } from './ai.js';
import { readLimited } from './broker.js';

const MAX_RESPONSE_BYTES = 10_000_000;

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/**
 * Ollama's own context window is small unless the caller asks for more, and a prompt that does not fit is cut
 * silently — which looks like a stupid model, not a setting. Dittoly's drafting prompts (the skills, the catalog
 * of approved actions, the request) are far longer than that default, so the window is asked for per call, from
 * the size of the prompt, and never more than `maxContext`.
 */
const CHARS_PER_TOKEN = 3.2;
/** Room for the answer itself, in tokens: a module's manifest, code and tests are long. */
const ANSWER_TOKENS = 8192;
const STEP = 4096;

export function contextFor(system: string, prompt: string, max: number): number {
  const wanted = Math.ceil((system.length + prompt.length) / CHARS_PER_TOKEN) + ANSWER_TOKENS;
  // Rounded up to whole steps, so the same kind of call reuses the same loaded context instead of reloading it.
  return Math.min(max, Math.max(STEP * 2, Math.ceil(wanted / STEP) * STEP));
}

/**
 * Ollama chat API (POST /api/chat) with a JSON Schema in `format` for
 * structured output. Prompts stay on infrastructure the organization runs.
 * Allowed in both deployment modes. There is no default model: the operator
 * names one that is pulled on their Ollama server.
 */
export class OllamaProvider implements AiProvider {
  readonly id = 'ollama' as const;

  /** What this server was pointed at; a request may name another model. */
  get configuredModel(): string {
    return this.model;
  }

  constructor(
    private readonly model: string,
    private readonly baseUrl: string = DEFAULT_OLLAMA_URL,
    private readonly timeoutMs = 900_000,
    /** The largest context to ask the server for, and the sampling a local model wants (Gemma asks for its own). */
    private readonly opts: { maxContext?: number; temperature?: number; topP?: number; topK?: number } = {},
  ) {}

  /** The models pulled on the Ollama server (GET /api/tags). */
  async listModels(): Promise<string[]> {
    const res = await fetch(new URL('/api/tags', this.baseUrl), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new AiError('ai_api_error');
    const body = (await res.json()) as { models?: { name?: unknown }[] };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string').sort();
  }

  async generateJson(req: JsonRequest): Promise<Record<string, unknown>> {
    refuseImages(req);
    let res: Response;
    try {
      res = await fetch(new URL('/api/chat', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model ?? this.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt },
          ],
          stream: false,
          format: req.schema,
          // Thinking models take a level; Ollama's stop at max and have no xhigh.
          ...(req.effort ? { think: req.effort === 'xhigh' ? 'high' : req.effort } : {}),
          options: {
            temperature: this.opts.temperature ?? 0,
            ...(this.opts.topP !== undefined ? { top_p: this.opts.topP } : {}),
            ...(this.opts.topK !== undefined ? { top_k: this.opts.topK } : {}),
            num_ctx: contextFor(req.system, req.prompt, this.opts.maxContext ?? 65_536),
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AiError('ai_unreachable');
    }
    if (res.status === 404) throw new AiError('ai_model_not_found');
    if (!res.ok) throw new AiError('ai_api_error');
    let body: { model?: unknown; message?: { content?: unknown }; done_reason?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
    try {
      const raw = await readLimited(res, MAX_RESPONSE_BYTES);
      if (!raw) throw new AiError('ai_output_truncated');
      body = JSON.parse(raw.toString('utf8')) as typeof body;
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError('ai_output_unparseable');
    }
    if (typeof body.prompt_eval_count === 'number' && typeof body.eval_count === 'number') {
      req.onUsage?.({ inputTokens: body.prompt_eval_count, outputTokens: body.eval_count, model: typeof body.model === 'string' && body.model ? body.model : (req.model ?? this.model) });
    }
    if (body.done_reason === 'length') throw new AiError('ai_output_truncated');
    if (typeof body.message?.content !== 'string') throw new AiError('ai_no_structured_output');
    return parseObject(body.message.content);
  }
}

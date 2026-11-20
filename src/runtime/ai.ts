/**
 * What an AI provider is: one call that returns a JSON object of a given shape.
 */
export interface JsonRequest {
  system: string;
  prompt: string;
  /** JSON Schema for the response. Keep it flat: string fields only, for portability across providers. */
  schema: Record<string, unknown>;
  /** Told how many tokens the call used, when the provider reports it (for budgets). */
  onUsage?: (usage: { inputTokens: number; outputTokens: number; model?: string }) => void;
  /** Images to look at (e.g. a layout sketch), base64. Providers that cannot read images refuse with ai_images_unsupported. */
  images?: AiImage[];
  /** Ask this model instead of the provider's own (a Flow version's pinned model). */
  model?: string;
  /** How hard the model works (thinking and length); absent: the provider's or model's default. */
  effort?: Effort;
  /**
   * The model may search the web while it answers (drafting a module, Flow or plan: to read the current official API
   * docs instead of writing calls from memory). Never set for AI steps in runs, which handle untrusted data: a search
   * query could carry it out. Providers that cannot search ignore it; those that can are told to search only when set.
   */
  webSearch?: boolean;
  /** Told which web pages the provider's own search returned or fetched (when it reports them). */
  onSources?: (sources: WebSource[]) => void;
}

/** Drafting may search the web unless the operator turned it off (DITTOLY_AI_WEB_SEARCH=off), for every AI. */
export function draftingMaySearch(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no)$/i.test(env.DITTOLY_AI_WEB_SEARCH ?? '');
}

/**
 * While it drafts, the AI is handed back what Dittoly's own review of the draft found — the security and
 * performance findings of a module, the missing sign-off or guard of a Flow — and asked to fix them, which is far
 * cheaper than a person finding them at review. It costs one more AI call on a draft that has findings, so an
 * operator can turn it off (DITTOLY_AI_DRAFT_REVIEW=off).
 */
export function draftReviewRound(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no)$/i.test(env.DITTOLY_AI_DRAFT_REVIEW ?? '');
}

/** A web page an AI read while drafting. */
export interface WebSource {
  url: string;
  title?: string;
}

/** http(s) URLs only, without duplicates, at most `max`. */
export function cleanSources(list: { url?: unknown; title?: unknown }[], max = 30): WebSource[] {
  const out: WebSource[] = [];
  for (const s of list) {
    if (typeof s.url !== 'string' || !/^https?:\/\/[^\s]{3,2000}$/.test(s.url) || out.some((o) => o.url === s.url)) continue;
    out.push({ url: s.url, ...(typeof s.title === 'string' && s.title.trim() ? { title: s.title.trim().slice(0, 200) } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

/** Effort levels, as the Claude API names them; each provider maps them to its own (see each provider). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AiImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Base64, no data: prefix. */
  data: string;
}

/** For providers without image input: a request with images is refused rather than answered blind. */
export function refuseImages(req: JsonRequest): void {
  if (req.images?.length) throw new AiError('ai_images_unsupported');
}

export interface AiProvider {
  readonly id: string;
  generateJson(req: JsonRequest): Promise<Record<string, unknown>>;
  /** The models this provider offers, for an admin's picker (absent: the provider cannot say). */
  listModels?(): Promise<string[]>;
  /**
   * The model this provider was set up with, when a request names none. Only a fallback: what a draft records is
   * the model the answer itself came from, because "the newest Opus" is a different model month to month.
   */
  readonly configuredModel?: string | undefined;
}

/** How much of a model's answer is kept with an error: enough to see what it wrote, never the whole essay. */
export const RAW_LIMIT = 4000;
/** The part of an answer worth showing: the start and, when it was cut, the end, where the break usually is. */
export function rawExcerpt(text: string, limit = RAW_LIMIT): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const head = Math.floor(limit * 0.7);
  return `${t.slice(0, head)}\n\n… ${t.length - limit} characters left out …\n\n${t.slice(-(limit - head))}`;
}

export class AiError extends Error {
  /**
   * `detail` says what went wrong, for the person. `raw` is what the AI actually answered (an excerpt), kept only
   * for answers that could not be read: without it nobody can tell why, and guessing wastes another run.
   */
  constructor(
    readonly code: string,
    readonly detail?: string,
    readonly raw?: string,
  ) {
    super(code);
    this.name = 'AiError';
  }
}

/**
 * JSON as models write it inside a string field: valid JSON, or JSON with the slips they often make (wrapped in a
 * ```json fence, or a comma before a closing bracket). Anything else still fails, as before.
 */
export function looseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    let t = text.trim();
    const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(t);
    if (fenced) t = fenced[1]!.trim();
    // Drop commas right before } or ], outside strings.
    let out = '';
    let inString = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i]!;
      if (inString) {
        out += c;
        if (c === '\\') out += t[++i] ?? '';
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      if (c === ',' && /^\s*[}\]]/.test(t.slice(i + 1))) continue;
      out += c;
    }
    if (out === text) throw err;
    return JSON.parse(out);
  }
}

/** Parse a model's JSON answer into an object, or fail with a safe error code. */
export function parseObject(text: string): Record<string, unknown> {
  let out: unknown;
  try {
    out = looseJson(text);
  } catch {
    throw new AiError('ai_output_unparseable', `the answer (${text.length} characters) is not valid JSON`, rawExcerpt(text));
  }
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new AiError('ai_no_structured_output');
  return out as Record<string, unknown>;
}

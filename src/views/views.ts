import { z } from 'zod';
import { AiError, type AiProvider } from '../ai/provider.js';
import { AppError, badRequest } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Db } from '../db/db.js';

/**
 * Custom views. Members rearrange their own screens by asking in chat ("hide
 * merge requests"). A view is a configuration of trusted components chosen
 * from a fixed list; the AI can only produce a value that passes this schema,
 * never markup or code. Changing a view never changes a Flow.
 */

export const HOME_WIDGETS = ['approvals', 'delegations', 'notifications', 'recent_runs', 'my_flows'] as const;

const homeView = z
  .object({
    widgets: z
      .array(z.object({ id: z.enum(HOME_WIDGETS), visible: z.boolean() }).strict())
      .max(HOME_WIDGETS.length)
      .refine((ws) => new Set(ws.map((w) => w.id)).size === ws.length, 'duplicate widget'),
    recentRunsLimit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const runView = z
  .object({
    /** Hide steps that use these modules (by module name, e.g. "gitlab"). */
    hideModules: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/)).max(20).default([]),
    /** Hide steps by status, e.g. skipped ones. */
    hideStatuses: z.array(z.enum(['succeeded', 'skipped', 'not_run'])).max(3).default([]),
    showOutputs: z.boolean().default(true),
    compact: z.boolean().default(false),
  })
  .strict();

export const VIEW_SCHEMAS = { home: homeView, run: runView } as const;
export type ViewPage = keyof typeof VIEW_SCHEMAS;

export const DEFAULT_VIEWS: { [P in ViewPage]: z.infer<(typeof VIEW_SCHEMAS)[P]> } = {
  home: { widgets: HOME_WIDGETS.map((id) => ({ id, visible: true })), recentRunsLimit: 10 },
  run: { hideModules: [], hideStatuses: [], showOutputs: true, compact: false },
};

const VIEW_PROMPT = `You change one member's screen layout in Dittoly. You return only a JSON configuration for that screen.
You cannot change workflows, permissions or data; only what this member sees and in what order.

Screens and their configuration:
- "home": { "widgets": [{ "id": one of ${HOME_WIDGETS.join(', ')}, "visible": boolean }...] in display order, "recentRunsLimit": 1-50 }
  approvals = things waiting for this member's approval; delegations = requests from teammates; notifications;
  recent_runs = this member's runs; my_flows = Flows this member created.
- "run": { "hideModules": [module names like "gitlab", "jira", "slack"], "hideStatuses": ["succeeded" | "skipped" | "not_run"],
  "showOutputs": boolean, "compact": boolean }
  Example: "hide merge requests" -> hide the "gitlab" module's steps.

Start from the current configuration and change only what the member asks for. Return fields configJson (the full new configuration as JSON) and reply (one short sentence confirming the change).

When the member asks for something that is not about what this screen shows (a Flow should do something else, a step
should post or create something, a run failed, a module is missing an action), you cannot do it here: return
notLayout true, configJson as the current configuration unchanged, and in reply one short sentence saying this box
only changes what they see, and where to do it instead: a change to what a Flow does is made in the home chat or on
the Flow's page (as a new version, approved before it runs); a stopped run says what to do on its own page.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: { configJson: { type: 'string' }, reply: { type: 'string' }, notLayout: { type: 'boolean' } },
  required: ['configJson', 'reply', 'notLayout'],
  additionalProperties: false,
} as const;

/** How long a layout change may take before the member is told, instead of waiting on a spinning button. */
export const VIEW_CHAT_DEADLINE_MS = 60_000;
const NOT_LAYOUT = 'This box only changes what you see. To change what a Flow does, say it in the home chat or on the Flow\'s page.';

/** The answer, or ai_timeout once `ms` have passed (the request itself is left to finish or fail on its own). */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError('ai_timeout', 504, `The AI did not answer within ${Math.round(ms / 1000)} seconds. Nothing was changed; try again, or try a shorter request.`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

function assertPage(page: string): ViewPage {
  if (!Object.hasOwn(VIEW_SCHEMAS, page)) throw badRequest('unknown_view');
  return page as ViewPage;
}

export class Views {
  constructor(
    private readonly db: Db,
    private readonly ai: AiProvider | null,
  ) {}

  async get(member: Member, page: string) {
    const p = assertPage(page);
    const { rows } = await this.db.query<{ config: unknown }>(`SELECT config FROM views WHERE member_id = $1 AND page = $2`, [member.id, p]);
    const parsed = rows[0] ? VIEW_SCHEMAS[p].safeParse(rows[0].config) : null;
    return parsed?.success ? parsed.data : DEFAULT_VIEWS[p];
  }

  async set(member: Member, page: string, config: unknown) {
    const p = assertPage(page);
    const parsed = VIEW_SCHEMAS[p].safeParse(config);
    if (!parsed.success) throw badRequest('invalid_view', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    await this.db.query(
      `INSERT INTO views (member_id, page, config) VALUES ($1, $2, $3)
       ON CONFLICT (member_id, page) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [member.id, p, JSON.stringify(parsed.data)],
    );
    return parsed.data;
  }

  async reset(member: Member, page: string) {
    const p = assertPage(page);
    await this.db.query(`DELETE FROM views WHERE member_id = $1 AND page = $2`, [member.id, p]);
    return DEFAULT_VIEWS[p];
  }

  /** "hide merge requests" -> a validated view configuration. */
  async chat(member: Member, page: string, request: string) {
    const p = assertPage(page);
    if (!request || request.length > 2000) throw badRequest('invalid_request');
    if (!this.ai) throw new AppError('ai_provider_not_configured', 503);
    const current = await this.get(member, p);
    let out: Record<string, unknown>;
    try {
      // A layout change is a small answer: it never keeps the button spinning for the minutes a module may take.
      out = await withDeadline(
        this.ai.generateJson({
          system: VIEW_PROMPT,
          prompt: `Screen: "${p}"\nCurrent configuration: ${JSON.stringify(current)}\nThe member asks: ${request}`,
          schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        }),
        VIEW_CHAT_DEADLINE_MS,
      );
    } catch (err) {
      if (err instanceof AiError) throw new AppError(err.code, 502);
      throw err;
    }
    // Not about this screen (e.g. "it does not post the comment"): nothing is saved; the reply says where to go.
    if (out.notLayout === true) return { config: current, reply: String(out.reply ?? '').slice(0, 300) || NOT_LAYOUT, notLayout: true };
    let config: unknown;
    try {
      config = JSON.parse(String(out.configJson));
    } catch {
      throw new AppError('ai_response_not_json', 502);
    }
    const saved = await this.set(member, p, config);
    return { config: saved, reply: String(out.reply ?? '').slice(0, 300) };
  }
}

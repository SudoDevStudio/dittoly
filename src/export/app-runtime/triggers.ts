/** What starts runs besides the API: webhooks (hooks.ts) and schedules (schedules.ts). */

export interface HookDef { flow: string; provider: string; payloadSchema: unknown; inputMap: Record<string, string>; rateLimitPerMinute: number }
export interface ScheduleDef { flow: string; cron: string; timezone: string; inputs: unknown }

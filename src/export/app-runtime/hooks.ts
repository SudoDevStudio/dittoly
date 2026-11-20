import { createHash } from 'node:crypto';
import { ajv } from '../../runtime/manifest.js';
import { verifyGithub, verifyGitlab, verifyStandard, verifyToken } from '../../runtime/verify.js';
import type { AppEngine } from './engine.js';
import type { Store } from './store.js';
import type { HookDef } from './triggers.js';

/** Webhooks: signed requests that start runs of the app's Flows. Only apps with webhooks carry this file. */

function pointer(doc: unknown, ptr: string): unknown {
  if (ptr === '') return doc;
  let cur: unknown = doc;
  for (const raw of ptr.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export type HookResult = { status: number; body: Record<string, unknown> };

/**
 * One webhook delivery. The provider's signature (secret from HOOK_SECRET_<FLOW>) is the
 * authentication; each delivery id starts at most one run, and GitHub bodies are deduplicated too
 * (its signature does not cover the delivery id). Payloads never choose the Flow.
 */
export async function receiveHook(
  hook: HookDef,
  secret: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  d: { engine: AppEngine; store: Store; limited: (key: string, max: number) => boolean },
): Promise<HookResult & { runId?: string }> {
  if (!secret) return { status: 404, body: { error: 'not_found' } };
  const result =
    hook.provider === 'github'
      ? verifyGithub(headers, body, [secret])
      : hook.provider === 'gitlab'
        ? verifyGitlab(headers, body, [secret], null, 300)
        : hook.provider === 'token'
          ? verifyToken(headers, body, [secret], 300)
          : verifyStandard(headers, body, [secret], 300);
  if (!result.ok) return { status: 401, body: { error: `webhook_${result.reason}` } };
  if (d.limited(`hook:${hook.flow}`, hook.rateLimitPerMinute)) return { status: 429, body: { error: 'webhook_rate_limited' } };
  const ttl = hook.provider === 'github' ? 90 * 86_400 : 86_400;
  if (!(await d.store.mark(`hook:${hook.flow}:${result.deliveryId}`, ttl))) return { status: 200, body: { duplicate: true } };
  // GitHub's signature and a token do not cover the delivery id: a resent body is a duplicate too.
  if ((hook.provider === 'github' || hook.provider === 'token') && !(await d.store.mark(`hook:${hook.flow}:body:${createHash('sha256').update(body).digest('hex')}`, ttl))) {
    return { status: 200, body: { duplicate: true } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'webhook_invalid_json' } };
  }
  if (!ajv.validate(hook.payloadSchema as object, payload)) return { status: 422, body: { error: 'webhook_payload_schema' } };
  const inputs: Record<string, unknown> = {};
  for (const [name, ptr] of Object.entries(hook.inputMap)) {
    const v = pointer(payload, ptr);
    if (v !== undefined) inputs[name] = v;
  }
  try {
    const run = await d.engine.start(hook.flow, inputs);
    return { status: 202, body: {}, runId: run.id };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { status: code === 'invalid_inputs' ? 422 : 500, body: { error: code === 'invalid_inputs' ? 'webhook_invalid_inputs' : 'internal_error' } };
  }
}

/** Thin client for the Dittoly API. The session cookie is sent automatically; writes carry the CSRF header. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    ...(opts.signal ? { signal: opts.signal } : {}),
    credentials: 'same-origin',
    headers: {
      'x-dittoly-request': '1',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `http_${res.status}`, data.detail);
  return data as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}, opts: { signal?: AbortSignal } = {}) => api<T>(path, { method: 'POST', body, ...opts });

export interface Me {
  id: string;
  handle: string;
  role: 'admin' | 'approver' | 'member';
}

export interface AuthConfig {
  mode: 'shared' | 'local';
  sso: boolean;
}

export async function authConfig(): Promise<AuthConfig> {
  return (await fetch('/auth/config')).json();
}

export async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', headers: { 'x-dittoly-request': '1' } });
}

/** Plain-language messages for the error codes members are most likely to see. */
export const MESSAGES: Record<string, string> = {
  unauthenticated: 'Your session has ended. Sign in again.',
  forbidden: 'You do not have permission to do that.',
  admin_only: 'Only an admin can do that.',
  approver_only: 'Only an approver can do that.',
  cannot_approve_own_flow: 'Someone else has to approve a Flow you created.',
  cannot_approve_own_run: 'Someone else has to approve a step in your own run.',
  cannot_review_own_module: 'Another admin has to review a module you created.',
  cannot_approve_change_you_requested: 'Someone other than the person who asked for this fix has to approve it.',
  already_approved_by_you: 'You already approved this; it needs another approver.',
  flow_version_not_approved: 'This Flow version is not approved (or a newer version replaced it).',
  modules_not_approved: 'A module this Flow uses is not approved yet.',
  delegate_missing_credential: 'You need your own credential for this app before you can run it for someone.',
  ai_provider_not_configured: 'No AI is set up yet, so nothing can be drafted from a description.',
  ai_budget_exhausted: "Your team has used this month's AI budget. An admin can raise it on the AI usage page.",
  retry_limit_reached: 'The retry limit for this Flow is used up.',
  missing_credential: 'You have no credential for this app. Add one, or ask a teammate to run this step.',
  oauth_request_not_found: 'This sign-in request has expired or was already answered. Start connecting again from the app.',
  app_not_allowed: 'Your organization does not allow this app to connect. Ask an admin (Members & Access, "Apps that may connect").',
};
/** Codes whose detail is the useful part (which field, what is wrong). */
const WITH_DETAIL: Record<string, string> = { result_invalid: 'Change the result', invalid_inputs: 'Check the inputs', lookup_needs_input: 'The input does not fit this action', export_not_possible: 'This cannot be exported' };
/** Codes whose detail is already the message to show. */
const DETAIL_IS_MESSAGE = new Set(['classification_unavailable', 'flow_not_drafted', 'policy_violation', 'breakglass_inactive', 'only_read_actions_can_be_recorded', 'module_not_recordable', 'not_a_pdf', 'pdf_too_large', 'pdf_unreadable', 'pdf_has_no_text']);

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (DETAIL_IS_MESSAGE.has(err.code) && err.detail) return err.detail;
    if (WITH_DETAIL[err.code] && err.detail) return `${WITH_DETAIL[err.code]}:${err.detail.includes('\n') ? '\n' : ' '}${err.detail}`;
    return MESSAGES[err.code] ?? (err.detail ? `${err.code}: ${err.detail}` : err.code);
  }
  // The browser could not reach the server at all (it stopped, or the network dropped).
  if (err instanceof TypeError) return 'Could not reach Dittoly. Check that the server is running, then try again.';
  // An error the page raised itself says what is wrong ("The result is not valid JSON").
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}

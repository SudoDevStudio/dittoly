import type { Queryable } from '../db/db.js';
import type { FetchLike } from '../sandbox/broker.js';
import type { Manifest } from '../modules/manifest.js';

/**
 * Least privilege for stored tokens: ask the provider which scopes a token has and
 * compare them with what the approved modules using that service declare they need.
 * Supported: GitLab (personal/project/group access tokens report their scopes) and
 * GitHub classic tokens (the X-OAuth-Scopes header). Anything else is "unknown".
 */

export type ScopeStatus = 'ok' | 'broader' | 'missing' | 'unknown' | 'error';
export interface ScopeCheck {
  status: ScopeStatus;
  provider: 'gitlab' | 'github' | null;
  /** Scopes the token has (null when the provider does not say). */
  granted: string[] | null;
  /** Scopes the approved modules for this service declare. */
  needed: string[];
  /** Granted but not needed: a narrower token would do. */
  excess: string[];
  /** Needed but not granted: some actions will be refused. */
  missing: string[];
  note: string | null;
  checkedAt: string;
}

/** Scopes that include others (only where the provider documents the relation). */
const IMPLIES: Record<'gitlab' | 'github', Record<string, string[]>> = {
  gitlab: { api: ['read_api'], write_repository: ['read_repository'], write_registry: ['read_registry'] },
  github: {},
};

function covers(provider: 'gitlab' | 'github', granted: Set<string>, scope: string): boolean {
  if (granted.has(scope)) return true;
  if ([...granted].some((g) => IMPLIES[provider][g]?.includes(scope))) return true;
  if (provider === 'github') {
    // Classic scopes: "repo" covers "repo:status"; "admin:org" covers "write:org" covers "read:org".
    const [head, tail] = scope.split(':');
    if (tail && ['read', 'write'].includes(head!)) return granted.has(`admin:${tail}`) || (head === 'read' && granted.has(`write:${tail}`));
    if (tail && granted.has(head!)) return true;
  }
  return false;
}

export function compareScopes(provider: 'gitlab' | 'github', granted: string[], needed: string[]): Pick<ScopeCheck, 'status' | 'excess' | 'missing'> {
  const g = new Set(granted);
  const missing = needed.filter((s) => !covers(provider, g, s));
  const n = new Set(needed);
  const excess = granted.filter((s) => !n.has(s) && !needed.some((x) => covers(provider, new Set([s]), x)));
  return { status: missing.length ? 'missing' : excess.length ? 'broader' : 'ok', excess, missing };
}

/** The provider and host to ask, and the scopes needed, from approved modules using this service. */
export async function scopeTarget(db: Queryable, service: string): Promise<{ provider: 'gitlab' | 'github' | null; host: string | null; needed: string[] }> {
  const { rows } = await db.query<{ manifest: Manifest }>(`SELECT manifest FROM module_versions WHERE status = 'approved'`);
  let provider: 'gitlab' | 'github' | null = null;
  let host: string | null = null;
  const needed = new Set<string>();
  for (const { manifest } of rows) {
    for (const c of manifest.credentials.filter((x) => x.service === service)) {
      for (const s of (c as { scopes?: string[] }).scopes ?? []) needed.add(s);
      if (provider) continue;
      const h = c.hosts.find((x) => !x.includes('{{'));
      if (!h) continue;
      if (h === 'api.github.com') [provider, host] = ['github', h];
      else if (/(^|\.)gitlab\./.test(h) || (c.placement.type === 'header' && c.placement.name.toLowerCase() === 'private-token')) [provider, host] = ['gitlab', h];
    }
  }
  return { provider, host, needed: [...needed].sort() };
}

export async function probeScopes(
  fetchImpl: FetchLike,
  target: { provider: 'gitlab' | 'github' | null; host: string | null; needed: string[] },
  secret: string,
  insecureHttpHosts: string[] = [],
): Promise<ScopeCheck> {
  const base = { provider: target.provider, needed: target.needed, granted: null, excess: [], missing: [], checkedAt: new Date().toISOString() };
  if (!target.provider || !target.host) return { ...base, status: 'unknown', note: 'This service does not report token scopes to Dittoly.' };
  const origin = `${insecureHttpHosts.includes(target.host) ? 'http' : 'https'}://${target.host}`;
  const signal = AbortSignal.timeout(5000);
  try {
    if (target.provider === 'gitlab') {
      const res = await fetchImpl(`${origin}/api/v4/personal_access_tokens/self`, { headers: { 'PRIVATE-TOKEN': secret }, signal });
      if (res.status === 401) return { ...base, status: 'error', note: 'GitLab did not accept this token (expired or revoked?).' };
      if (!res.ok) return { ...base, status: 'error', note: `GitLab answered ${res.status}.` };
      const body = (await res.json()) as { scopes?: unknown };
      const granted = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : null;
      if (!granted) return { ...base, status: 'unknown', note: 'GitLab did not list the scopes.' };
      return { ...base, granted, ...compareScopes('gitlab', granted, target.needed), note: null };
    }
    const res = await fetchImpl(`${origin}/user`, { headers: { authorization: `Bearer ${secret}`, accept: 'application/vnd.github+json', 'user-agent': 'dittoly' }, signal });
    if (res.status === 401) return { ...base, status: 'error', note: 'GitHub did not accept this token (expired or revoked?).' };
    if (!res.ok) return { ...base, status: 'error', note: `GitHub answered ${res.status}.` };
    const header = res.headers.get('x-oauth-scopes');
    if (header === null) return { ...base, status: 'unknown', note: 'A fine-grained GitHub token: its permissions are set per repository and are not reported.' };
    const granted = header.split(',').map((s) => s.trim()).filter(Boolean);
    return { ...base, granted, ...compareScopes('github', granted, target.needed), note: null };
  } catch {
    return { ...base, status: 'error', note: `Could not reach ${target.host}.` };
  }
}

export class ScopeChecker {
  constructor(
    private readonly db: Queryable,
    private readonly fetchImpl: FetchLike,
    private readonly insecureHttpHosts: string[],
  ) {}

  /** Check a member's stored credential and keep the result with it. */
  async checkPersonal(memberId: string, service: string, secret: string): Promise<ScopeCheck> {
    const check = await probeScopes(this.fetchImpl, await scopeTarget(this.db, service), secret, this.insecureHttpHosts);
    await this.db.query(`UPDATE credentials SET scope_check = $3 WHERE member_id = $1 AND service = $2`, [memberId, service, JSON.stringify(check)]);
    return check;
  }

  async checkTeam(teamId: string, service: string, secret: string): Promise<ScopeCheck> {
    const check = await probeScopes(this.fetchImpl, await scopeTarget(this.db, service), secret, this.insecureHttpHosts);
    await this.db.query(`UPDATE team_credentials SET scope_check = $3 WHERE team_id = $1 AND service = $2`, [teamId, service, JSON.stringify(check)]);
    return check;
  }
}

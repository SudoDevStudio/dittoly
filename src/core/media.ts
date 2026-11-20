import type { Queryable } from '../db/db.js';
import { audit } from './audit.js';
import { badRequest, forbidden } from './errors.js';
import type { Member } from './members.js';

/**
 * Media shown inside run views: video players from known providers, and
 * files, images, PDFs and web pages from hosts an admin allows. The portal's
 * Content-Security-Policy is built from the same list, so the browser refuses
 * to load media from anywhere else, whatever a module returns.
 */

/** Players embedded for links to these sites (YouTube through its privacy-enhanced domain). */
export const BUILTIN_PLAYERS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'] as const;

const KEY = 'media_hosts';
export const MAX_MEDIA_HOSTS = 50;
/** host, *.host, optionally with a port. Strict, because each entry goes into a CSP header. */
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

export interface MediaHosts {
  hosts: string[];
}

let cache: { hosts: string[]; pages: string[]; at: number } | null = null;
const TTL_MS = 30_000;

export async function getMediaHosts(db: Queryable): Promise<MediaHosts> {
  const row = (await db.query<{ value: { hosts?: unknown } }>(`SELECT value FROM org_settings WHERE key = $1`, [KEY])).rows[0];
  const hosts = Array.isArray(row?.value.hosts) ? row.value.hosts.filter((h): h is string => typeof h === 'string' && HOST.test(h)) : [];
  return { hosts };
}

/** Host patterns as an admin typed them: lowercased, without a scheme or trailing slash, checked. */
function cleanHosts(hosts: string[], code: string): string[] {
  const clean = [...new Set(hosts.map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')).filter(Boolean))];
  const bad = clean.filter((h) => !HOST.test(h));
  if (bad.length) throw badRequest(code, `not a host: ${bad.join(', ')} (use example.com or *.example.com)`);
  if (clean.length > MAX_MEDIA_HOSTS) throw badRequest(code, `at most ${MAX_MEDIA_HOSTS} hosts`);
  return clean;
}

export async function setMediaHosts(db: Queryable, actor: Member, hosts: string[]): Promise<MediaHosts> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const clean = cleanHosts(hosts, 'invalid_media_hosts');
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify({ hosts: clean }), actor.id],
  );
  cache = null;
  await audit(db, { actorId: actor.id, action: 'org.media_hosts_updated', subjectType: 'org', subjectId: KEY, outcome: 'ok' });
  return { hosts: clean };
}

/**
 * Sites that approved browser modules may open: run views may show those pages live
 * (in a sandboxed frame), next to the script's screenshot. As origins, e.g.
 * "https://shop.example.com"; plain http only for hosts listed for local development.
 * Hosts an admin sets per organization ({{settings.x}}) are not included.
 */
export async function browserPageOrigins(db: Queryable, plainHttp: readonly string[] = []): Promise<string[]> {
  const { rows } = await db.query<{ host: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(manifest->'browser'->'hosts') AS host FROM module_versions WHERE status = 'approved' AND manifest ? 'browser'`,
  );
  const out: string[] = [];
  for (const { host } of rows) {
    const h = host.toLowerCase();
    if (!HOST.test(h) && !/^[a-z0-9.-]+(:\d{1,5})?$/.test(h)) continue;
    out.push(plainHttp.includes(h) ? `http://${h}` : `https://${h}`);
  }
  return out.sort();
}

async function load(db: Queryable, plainHttp: readonly string[]): Promise<{ hosts: string[]; pages: string[] }> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    try {
      cache = { hosts: (await getMediaHosts(db)).hosts, pages: await browserPageOrigins(db, plainHttp), at: Date.now() };
    } catch {
      cache = { hosts: cache?.hosts ?? [], pages: cache?.pages ?? [], at: Date.now() };
    }
  }
  return cache;
}

const BROWSER_KEY = 'browser_sites';

/**
 * Sites the Dittoly Browser may open besides those of approved browser modules: host or
 * *.host, set by an admin. They are for people browsing; browser modules' scripts still
 * open only the sites their own reviewed manifest declares.
 */
export async function getBrowserSites(db: Queryable): Promise<string[]> {
  const row = (await db.query<{ value: { hosts?: unknown } }>(`SELECT value FROM org_settings WHERE key = $1`, [BROWSER_KEY])).rows[0];
  return Array.isArray(row?.value.hosts) ? row.value.hosts.filter((h): h is string => typeof h === 'string' && HOST.test(h)) : [];
}

export async function setBrowserSites(db: Queryable, actor: Member, hosts: string[]): Promise<string[]> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const clean = cleanHosts(hosts, 'invalid_browser_sites');
  await db.query(
    `INSERT INTO org_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [BROWSER_KEY, JSON.stringify({ hosts: clean }), actor.id],
  );
  await audit(db, { actorId: actor.id, action: 'org.browser_sites_updated', subjectType: 'org', subjectId: BROWSER_KEY, outcome: 'ok' });
  return clean;
}

/** What run views may embed: admin-allowed media hosts and the browser modules' sites. */
export async function embeddable(db: Queryable, plainHttp: readonly string[] = []): Promise<{ hosts: string[]; pages: string[] }> {
  const { hosts, pages } = await load(db, plainHttp);
  return { hosts, pages };
}

/** The portal's Content-Security-Policy, with the allowed media sources. Cached briefly. */
export async function contentSecurityPolicy(db: Queryable, plainHttp: readonly string[] = []): Promise<string> {
  const { hosts, pages } = await load(db, plainHttp);
  const extra = hosts.map((h) => ` https://${h}`).join('');
  const frames = pages.filter((p) => !extra.includes(` ${p}`)).map((p) => ` ${p}`).join('');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${extra}`,
    `media-src 'self'${extra}`,
    // 'self': the portal frames an app's own pages (/a/...) to preview them.
    `frame-src 'self' ${BUILTIN_PLAYERS.join(' ')}${extra}${frames}`,
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Test hook: forget the cached list. */
export function resetMediaCache(): void {
  cache = null;
}

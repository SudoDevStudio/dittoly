/**
 * Which links in run views are media, and how to show them. Video sites get
 * their players; files, images, PDFs and pages are shown only from hosts an
 * admin allows (the server's Content-Security-Policy enforces the same list).
 */

export type Media =
  | { kind: 'youtube'; src: string; title: string }
  | { kind: 'vimeo'; src: string; title: string }
  | { kind: 'video' | 'audio' | 'image' | 'pdf' | 'page' | 'live'; src: string; title: string };

const VIDEO = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const PDF = /\.pdf$/i;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** Whether `host` is allowed by an entry ("example.com" or "*.example.com", optionally with a port). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a));
}

/** Seconds from a YouTube t= / start= value like "90", "90s" or "1m30s". */
function seconds(t: string | null): number | null {
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || !m[0]) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Whether a URL is on one of these origins ("https://example.com", "https://*.example.com", "http://127.0.0.1:3000"). */
export function onOrigin(u: URL, origins: readonly string[]): boolean {
  return origins.some((o) => {
    const i = o.indexOf('://');
    return o.slice(0, i + 1) === u.protocol && hostAllowed(u.host, [o.slice(i + 3)]);
  });
}

/**
 * `pages`: sites approved browser modules open. A link to one is shown as the live page
 * (it may still refuse to be framed; the script's screenshot is the fallback).
 */
export function detectMedia(raw: string, allowedHosts: readonly string[], pages: readonly string[] = []): Media | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!u.username && !u.password && !/^(youtube\.com|youtu\.be|vimeo\.com)$/.test(u.hostname.replace(/^www\.|^m\./, '')) && onOrigin(u, pages)) {
    return { kind: 'live', src: u.href, title: u.host };
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');

  // YouTube: watch, short links, shorts, embeds, live. Played through the privacy-enhanced domain.
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    const id =
      host === 'youtu.be' ? parts[0] : parts[0] === 'watch' || (parts.length === 0 && u.searchParams.has('v')) ? u.searchParams.get('v') : ['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '') ? parts[1] : null;
    if (!id || !YT_ID.test(id)) return null;
    const start = seconds(u.searchParams.get('t') ?? u.searchParams.get('start'));
    return { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`, title: 'YouTube video' };
  }
  // Vimeo: vimeo.com/<id> and player links.
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = /(?:^|\/)(\d{4,12})(?:\/|$)/.exec(u.pathname)?.[1];
    return id ? { kind: 'vimeo', src: `https://player.vimeo.com/video/${id}`, title: 'Vimeo video' } : null;
  }

  // Everything else only from hosts an admin allows.
  if (!hostAllowed(u.host, allowedHosts)) return null;
  const name = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) ?? u.hostname);
  if (VIDEO.test(u.pathname)) return { kind: 'video', src: u.href, title: name };
  if (AUDIO.test(u.pathname)) return { kind: 'audio', src: u.href, title: name };
  if (IMAGE.test(u.pathname)) return { kind: 'image', src: u.href, title: name };
  if (PDF.test(u.pathname)) return { kind: 'pdf', src: u.href, title: name };
  return { kind: 'page', src: u.href, title: u.hostname };
}

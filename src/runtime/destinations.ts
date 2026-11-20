import { hostMatches } from './manifest.js';

/**
 * Outside services an app or fix step may reach in one phase (src/engine/apps.ts), and the organization's
 * ceiling on them (src/core/egress-policy.ts). A destination is a host name with an optional port:
 *
 * - "api.example.com" (port 443), "api.example.com:8443";
 * - "*.example.com": any ONE label in front ("eu.example.com", not "a.b.example.com", not "example.com");
 * - "**.example.com": one or more labels in front;
 * - anything else with a star ("*.example.*", "*", "api.*.com", "ex*.com") is refused: no guessing.
 *
 * Ports 80 and 443 go through the step's HTTP(S) proxy. Any other port is a plain TCP connection (a test
 * database): forwarded by the proxy to that exact host, so it must be an exact name and a port from 1024.
 * IP addresses are refused: the proxy resolves names when it connects, so a name cannot pass the check
 * with one address and connect to another, and private addresses stay refused unless the admin listed the
 * host as internal.
 */

export interface Destination {
  /** As written, normalized: lower case, port always shown. */
  text: string;
  host: string;
  port: number;
  /** exact name, one label in front (*.), or any depth (**.). */
  match: 'exact' | 'one' | 'any';
  /** https: through the HTTP(S) proxy (ports 80, 443); tcp: forwarded as plain TCP. */
  kind: 'https' | 'tcp';
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A destination, or the reason it is refused (shown to the author). */
export function parseDestination(raw: string): Destination | { error: string } {
  const s = raw.trim().toLowerCase();
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return { error: `"${raw}": write a host name, optionally with :port` };
  const port = m[2] === undefined ? 443 : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `"${raw}": the port must be 1 to 65535` };
  let host = m[1]!;
  let match: Destination['match'] = 'exact';
  if (host.startsWith('**.')) [match, host] = ['any', host.slice(3)];
  else if (host.startsWith('*.')) [match, host] = ['one', host.slice(2)];
  if (host.includes('*')) return { error: `"${raw}": a star may only stand for the first labels ("*.example.com" or "**.example.com")` };
  if (/^[\d.]+$/.test(host) || host.includes('[')) return { error: `"${raw}": use a host name, not an IP address` };
  const labels = host.split('.');
  if (host.length > 253 || !labels.every((l) => LABEL.test(l))) return { error: `"${raw}": not a valid host name` };
  if (match !== 'exact' && labels.length < 2) return { error: `"${raw}": a pattern needs a domain with at least two labels after the star` };
  const kind = port === 80 || port === 443 ? 'https' : 'tcp';
  if (kind === 'tcp' && match !== 'exact') return { error: `"${raw}": a TCP destination (port ${port}) must be one exact host` };
  if (kind === 'tcp' && port < 1024) return { error: `"${raw}": TCP destinations need a port from 1024 (80 and 443 go through the proxy)` };
  const prefix = match === 'any' ? '**.' : match === 'one' ? '*.' : '';
  return { text: `${prefix}${host}:${port}`, host, port, match, kind };
}

export function isDestination(d: Destination | { error: string }): d is Destination {
  return !('error' in d);
}

/** Parses a list; throws nothing, returns the problems. */
export function parseDestinations(list: readonly string[]): { destinations: Destination[]; problems: string[] } {
  const destinations: Destination[] = [];
  const problems: string[] = [];
  for (const raw of list) {
    const d = parseDestination(raw);
    if (isDestination(d)) destinations.push(d);
    else problems.push(d.error);
  }
  return { destinations, problems };
}

/** The pattern a destination is written with, for hostMatches ("*.example.com"). */
const pattern = (d: Destination) => `${d.match === 'any' ? '**.' : d.match === 'one' ? '*.' : ''}${d.host}`;

/**
 * Whether a ceiling entry allows a destination: same port, and every host the destination can name is one the
 * ceiling names. "**.example.com" covers "*.example.com", "**.eu.example.com" and "api.example.com";
 * "*.example.com" covers "api.example.com" and itself; an exact host covers only itself.
 */
export function covers(ceiling: Destination, d: Destination): boolean {
  if (ceiling.port !== d.port) return false;
  if (d.match === 'exact') return hostMatches(pattern(ceiling), d.host) || (ceiling.match === 'exact' && ceiling.host === d.host);
  if (ceiling.match === 'exact') return false;
  if (ceiling.match === 'one') return d.match === 'one' && d.host === ceiling.host;
  // ceiling **.x: d's suffix must be x or end in .x
  return d.host === ceiling.host || d.host.endsWith(`.${ceiling.host}`);
}

/** The first ceiling entry allowing d, or null. */
export function allowedBy(ceiling: readonly Destination[], d: Destination): Destination | null {
  return ceiling.find((c) => covers(c, d)) ?? null;
}

/** The proxy's allow-list form: "host:port", "*.host:port" (one label), "**.host:port" (any depth). */
export const proxyEntry = (d: Destination) => d.text;

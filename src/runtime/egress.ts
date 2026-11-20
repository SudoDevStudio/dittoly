import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { FetchLike } from './broker.js';

/**
 * Egress guard for module traffic (server-side request forgery). Declared
 * hostnames are resolved at connect time and the connection is refused if any
 * address is one a module must never reach:
 *
 * - always: loopback, link-local (cloud metadata at 169.254.169.254),
 *   unspecified, multicast and reserved ranges;
 * - private ranges (10/8, 172.16/12, 192.168/16, CGNAT 100.64/10, fc00::/7)
 *   unless the host is on the admin's internal-hosts list, e.g. a self-hosted
 *   GitLab on the company network.
 *
 * The check runs inside the socket's own DNS lookup, so a hostname cannot pass
 * the check with one address and connect to another (DNS rebinding).
 */

/**
 * Ranges a module must never reach, as [address, prefix length]. The egress proxy
 * (sandbox-runtime/egress-proxy.mjs) keeps a copy of both lists; a test checks they agree.
 */
export const FORBIDDEN_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['::', 128],
  ['::1', 128],
  // IPv4-compatible (::a.b.c.d, ::7f00:1) and IPv4-translated (::ffff:0:a.b.c.d) addresses.
  ['::', 96],
  ['::ffff:0:0:0', 96],
  // NAT64 and 6to4 can map back to any IPv4 address.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2002::', 16],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

/** Private ranges: reachable only for hosts on the admin's internal-hosts list. */
export const PRIVATE_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['198.18.0.0', 15],
  ['fc00::', 7],
];

function blockList(ranges: ReadonlyArray<readonly [string, number]>): BlockList {
  const list = new BlockList();
  for (const [a, p] of ranges) list.addSubnet(a, p, isIP(a) === 4 ? 'ipv4' : 'ipv6');
  return list;
}

const ALWAYS = blockList(FORBIDDEN_RANGES);
const PRIVATE = blockList(PRIVATE_RANGES);

export type AddressClass = 'public' | 'private' | 'forbidden';

function mappedIPv4(address: string): string | undefined {
  // The URL parser writes every spelling the same way: ::ffff:a00:1.
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!hex) return undefined;
  const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 0) return 'forbidden';
  // IPv4-mapped IPv6 (::ffff:10.0.0.1, ::ffff:a00:1) is judged as the IPv4 address it maps to.
  const mapped = family === 6 ? mappedIPv4(address) : undefined;
  const [addr, type] = mapped ? [mapped, 'ipv4' as const] : [address, family === 4 ? ('ipv4' as const) : ('ipv6' as const)];
  if (ALWAYS.check(addr, type)) return 'forbidden';
  if (PRIVATE.check(addr, type)) return 'private';
  return 'public';
}

export interface EgressPolicy {
  /** host[:port] values allowed to resolve to private addresses (admin-configured internal systems). */
  internalHosts: readonly string[];
  /** host[:port] values allowed to resolve to loopback (local-mode development only). */
  loopbackHosts: readonly string[];
}

export class EgressDeniedError extends Error {
  readonly code = 'EGRESS_DENIED_IP';
  constructor() {
    super('egress_denied_ip');
  }
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

export function isAllowed(address: string, hostKey: string, policy: EgressPolicy): boolean {
  const cls = classifyAddress(address);
  if (cls === 'public') return true;
  if (cls === 'private') return policy.internalHosts.includes(hostKey);
  // Loopback is only ever allowed for explicitly named local development hosts.
  const isLoopback = address === '::1' || address.startsWith('127.') || /^::ffff:127\./i.test(address);
  return isLoopback && policy.loopbackHosts.includes(hostKey);
}

/** True when any of the host keys (host, host:port) passes the address check. */
const allowedForAny = (address: string, hostKeys: readonly string[], policy: EgressPolicy) => hostKeys.some((k) => isAllowed(address, k, policy));

/**
 * Resolve a hostname for a non-HTTP connection and check every address. The
 * caller connects to the returned address (with TLS verifying the hostname),
 * so the check cannot be bypassed by a second DNS answer.
 */
export async function resolveChecked(
  hostname: string,
  hostKeys: readonly string[],
  policy: EgressPolicy,
  resolve: Resolver = systemResolver,
): Promise<{ address: string; family: number }> {
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal)) {
    if (!allowedForAny(literal, hostKeys, policy)) throw new EgressDeniedError();
    return { address: literal, family: isIP(literal) };
  }
  const addrs = await resolve(hostname);
  if (addrs.length === 0 || !addrs.every((a) => allowedForAny(a.address, hostKeys, policy))) throw new EgressDeniedError();
  return { address: addrs[0]!.address, family: addrs[0]!.family };
}

/** A socket lookup function that refuses addresses a module must not reach (for libraries that take one). */
export function guardedLookup(hostKeys: readonly string[], policy: EgressPolicy, resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addrs) => {
        if (addrs.length === 0 || !addrs.every((a) => allowedForAny(a.address, hostKeys, policy))) {
          callback(new EgressDeniedError() as unknown as NodeJS.ErrnoException, '', 0);
          return;
        }
        if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addrs);
        else callback(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}

/**
 * A fetch whose connections only reach allowed addresses. `hostKey` is the
 * URL's host[:port]; the lookup checks every address it returns.
 */
export function guardedFetch(policy: EgressPolicy, resolve: Resolver = systemResolver): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const hostKey = u.host.toLowerCase();
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isAllowed(literal, hostKey, policy)) throw new EgressDeniedError();

    const lookup: LookupFunction = (hostname, options, callback) => {
      resolve(hostname).then(
        (addrs) => {
          if (addrs.length === 0 || !addrs.every((a) => isAllowed(a.address, hostKey, policy))) {
            callback(new EgressDeniedError() as unknown as NodeJS.ErrnoException, '', 0);
            return;
          }
          if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addrs);
          else callback(null, addrs[0]!.address, addrs[0]!.family);
        },
        (err: NodeJS.ErrnoException) => callback(err, '', 0),
      );
    };
    // One short-lived agent per request so the check can never be skipped by a pooled connection.
    const dispatcher = new Agent({ connect: { lookup }, keepAliveTimeout: 1, pipelining: 0 });
    try {
      // Never follow redirects here: the next hop would skip the checks above. Callers handle 3xx themselves.
      return (await undiciFetch(url, { ...(init as object), redirect: 'manual', dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    } finally {
      dispatcher.close().catch(() => undefined);
    }
  };
}

/** True when a fetch failure was caused by the egress guard. */
export function isEgressDenied(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === 'EGRESS_DENIED_IP') return true;
  }
  return false;
}

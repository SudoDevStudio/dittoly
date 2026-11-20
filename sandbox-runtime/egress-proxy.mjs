// Dittoly egress proxy for sandboxed local MCP servers.
//
// Runs in its own container, attached to the sandbox's internal network (which
// has no route out) and to a normal network. It is the server's only way out:
// it forwards plain HTTP and HTTPS (CONNECT) only to the approved host:port pairs
// in DTY_ALLOW, and refuses loopback, link-local and private addresses unless the
// host is listed in DTY_ALLOW_PRIVATE. It logs one line per decision (with the
// reason for a refusal), never bodies.
//
// DTY_TCP ("listenPort=host:port,..."): plain TCP forwards for an app or fix step's
// test database. The proxy listens on listenPort and connects each connection to
// host:port, resolved and checked like any other destination, when it arrives.
//
// Plain JavaScript on purpose: it is mounted into the container as-is.

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const allow = new Set((process.env.DTY_ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const allowPrivate = new Set((process.env.DTY_ALLOW_PRIVATE ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const port = Number(process.env.DTY_PORT ?? 3128);
const bindHost = process.env.DTY_HOST ?? '0.0.0.0';

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Exact host:port; "*.example.com:443" for any ONE label in front; "**.example.com:443" for one or more. */
function allowed(hostKey) {
  if (allow.has(hostKey)) return true;
  const i = hostKey.lastIndexOf(':');
  const host = hostKey.slice(0, i);
  const p = hostKey.slice(i + 1);
  // "*:443": any public host on that port (read-only public web for browser modules; private addresses stay refused below).
  if (allow.has(`*:${p}`)) return true;
  for (const a of allow) {
    if (!a.endsWith(`:${p}`)) continue;
    const deep = a.startsWith('**.');
    if (!deep && !a.startsWith('*.')) continue;
    const suffix = a.slice(deep ? 2 : 1, a.length - p.length - 1); // ".example.com"
    if (!host.endsWith(suffix) || host.length <= suffix.length) continue;
    const labels = host.slice(0, -suffix.length).split('.');
    if ((deep || labels.length === 1) && labels.every((l) => LABEL.test(l))) return true;
  }
  return false;
}

// The same ranges as src/runtime/egress.ts (FORBIDDEN_RANGES and PRIVATE_RANGES); a test checks they agree.
// Here both are refused unless the host is listed in DTY_ALLOW_PRIVATE.
export const FORBIDDEN_RANGES = [
  ['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['192.0.0.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['::', 128], ['::1', 128], ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];
export const PRIVATE_RANGES = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['198.18.0.0', 15], ['fc00::', 7]];

const blocked = new net.BlockList();
for (const [a, p] of [...FORBIDDEN_RANGES, ...PRIVATE_RANGES]) blocked.addSubnet(a, p, net.isIPv6(a) ? 'ipv6' : 'ipv4');

/** IPv4-mapped IPv6 (::ffff:10.0.0.1, ::ffff:a00:1) is judged as the IPv4 address it maps to. */
function unmapped(address) {
  if (!net.isIPv6(address)) return address;
  let canonical;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return address;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!m) return address;
  const [hi, lo] = [parseInt(m[1], 16), parseInt(m[2], 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** An internal host may be listed as host:port or as a bare host (any port). */
const privateAllowed = (host, hostKey) => allowPrivate.has(hostKey) || allowPrivate.has(host);

/** One line per decision; a refusal says why: not_allowed (not on the list), unresolved, private_address. */
const log = (decision, hostKey, reason) => process.stdout.write(JSON.stringify({ decision, host: hostKey, ...(reason ? { reason } : {}) }) + '\n');

/** Resolve and check; returns { address } to connect to, or { reason } when refused. */
async function permitted(rawHost, portNum) {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  const hostKey = `${host}:${portNum}`;
  if (!allowed(hostKey)) return { reason: 'not_allowed' };
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) return { reason: 'unresolved' };
  for (const a of addrs) {
    if (isBlocked(a.address) && !privateAllowed(host, hostKey)) return { reason: 'private_address' };
  }
  return { address: addrs[0].address };
}

/** True for an address only an internal host may reach. */
export function isBlocked(address) {
  const v = unmapped(address);
  if (!net.isIP(v)) return true;
  return blocked.check(v, net.isIPv6(v) ? 'ipv6' : 'ipv4');
}

const server = http.createServer(async (req, res) => {
  // Browsers abort requests all the time (navigation, cancelled loads): never let that crash the proxy.
  req.on('error', () => res.destroy());
  res.on('error', () => undefined);
  // Plain HTTP: absolute-form request URL (http://host/path).
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const p = Number(target.port || 80);
  const checked = target.protocol === 'http:' ? await permitted(target.hostname, p) : { reason: 'not_allowed' };
  const address = checked.address;
  log(address ? 'allow' : 'deny', `${target.hostname}:${p}`, checked.reason);
  if (!address) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('blocked by Dittoly egress policy\n');
    return;
  }
  const headers = { ...req.headers };
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];
  const upstream = http.request({ host: address, port: p, method: req.method, path: target.pathname + target.search, headers, setHost: false }, (up) => {
    up.on('error', () => res.destroy());
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  // Once the response has started, a failing upstream can only cut the connection.
  upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});

server.on('connect', async (req, socket, head) => {
  // host:port, or [v6 address]:port
  const target = String(req.url);
  const i = target.lastIndexOf(':');
  const host = i > 0 && !target.endsWith(']') ? target.slice(0, i) : target;
  const p = Number((i > 0 && !target.endsWith(']') ? target.slice(i + 1) : '') || 443);
  const checked = host ? await permitted(host, p) : { reason: 'not_allowed' };
  const address = checked.address;
  log(address ? 'allow' : 'deny', `${host}:${p}`, checked.reason);
  if (!address) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = net.connect(p, address, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.on('clientError', (_err, socket) => socket.destroy());

/** "listenPort=host:port,...": each a TCP listener forwarding to its one destination (which DTY_ALLOW must list too). */
const tcpForwards = (process.env.DTY_TCP ?? '')
  .split(',')
  .map((s) => /^(\d{1,5})=([a-z0-9.-]+):(\d{1,5})$/.exec(s.trim().toLowerCase()))
  .filter(Boolean)
  .map((m) => ({ listen: Number(m[1]), host: m[2], port: Number(m[3]) }));

function startTcpForward(f) {
  const tcp = net.createServer(async (socket) => {
    socket.on('error', () => socket.destroy());
    socket.pause();
    const checked = await permitted(f.host, f.port);
    log(checked.address ? 'allow' : 'deny', `${f.host}:${f.port}`, checked.reason);
    if (!checked.address) return socket.destroy();
    const upstream = net.connect(f.port, checked.address, () => {
      upstream.pipe(socket);
      socket.pipe(upstream);
      socket.resume();
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  return new Promise((resolve) => tcp.listen(f.listen, bindHost, () => resolve(tcp.address().port)));
}

// Imported (by the tests that compare its address rules with the server's), it only exports them.
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  // Last resort: one broken connection must not take down every other one.
  process.on('uncaughtException', (err) => log('error', String(err?.code ?? 'unknown')));
  server.listen(port, bindHost, async () => {
    const tcp = await Promise.all(tcpForwards.map(startTcpForward));
    process.stdout.write(JSON.stringify({ ready: true, port: server.address().port, ...(tcp.length ? { tcp } : {}) }) + '\n');
  });
}

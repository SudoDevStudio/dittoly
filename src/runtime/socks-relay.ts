import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, connect as netConnect, isIP, type Server, type Socket } from 'node:net';
import { isEgressDenied, resolveChecked, type EgressPolicy, type Resolver } from './egress.js';

/**
 * A SOCKS5 relay on 127.0.0.1 for drivers that open connections we do not choose: MongoDB
 * connects to every replica set member the server lists, which can be IP addresses that a
 * DNS lookup hook never sees. The driver is pointed at this relay; every connection it asks
 * for is checked here before it is made:
 *
 * - the host must be the endpoint's host, or a name in the same parent domain (Atlas lists
 *   cluster0-shard-00-01.abcde.mongodb.net for cluster0.abcde.mongodb.net), and an IP only
 *   when the endpoint itself is that IP;
 * - the address must pass the same egress rules as all module traffic;
 * - only the relay's own one-time user name and password are accepted.
 *
 * One relay per call; it closes with the call. TLS runs end to end through it.
 */

export interface Relay {
  port: number;
  username: string;
  password: string;
  /** Hosts the relay refused (egress or name rules). */
  denied: string[];
  close(): Promise<void>;
}

/** Whether a host the driver wants is part of the endpoint's deployment. */
export function sameDeployment(endpointHost: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const e = endpointHost.toLowerCase().replace(/\.$/, '');
  if (h === e) return true;
  if (isIP(e) || isIP(h)) return false;
  const labels = e.split('.');
  // Atlas and other SRV deployments list members beside the name: compare the parent domain,
  // but never a bare public suffix (at least two labels must remain).
  const parent = labels.length >= 3 ? labels.slice(1).join('.') : e;
  return h.endsWith(`.${parent}`);
}

export async function startRelay(
  endpointHost: string,
  endpointPort: number,
  hostKeys: readonly string[],
  policy: EgressPolicy,
  opts: { resolve?: Resolver; timeoutMs?: number } = {},
): Promise<Relay> {
  const username = 'dittoly';
  const password = randomBytes(18).toString('base64url');
  const denied: string[] = [];
  const sockets = new Set<Socket>();
  const portOk = (p: number) => p === endpointPort || (p >= 27015 && p <= 27020);

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    client.setTimeout(opts.timeoutMs ?? 30_000, () => client.destroy());
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'request' | 'piping' = 'greeting';
    const reply = (code: number) => client.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 600) return client.destroy();
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return client.destroy();
        const n = buf[1]!;
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        // Username/password (method 2) only.
        if (!methods.includes(2)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1]!;
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen]!;
        if (buf.length < 3 + ulen + plen) return;
        const u = buf.subarray(2, 2 + ulen);
        const p = buf.subarray(3 + ulen, 3 + ulen + plen);
        buf = buf.subarray(3 + ulen + plen);
        const want = Buffer.from(password);
        const ok = u.toString() === username && p.length === want.length && timingSafeEqual(p, want);
        if (!ok) {
          client.end(Buffer.from([1, 1]));
          return;
        }
        client.write(Buffer.from([1, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        if (buf[0] !== 5 || buf[1] !== 1) {
          reply(7); // command not supported: CONNECT only
          return client.end();
        }
        const atyp = buf[3];
        let host: string;
        let end: number;
        if (atyp === 1) {
          end = 4 + 4;
          if (buf.length < end + 2) return;
          host = [...buf.subarray(4, 8)].join('.');
        } else if (atyp === 3) {
          const len = buf[4]!;
          end = 5 + len;
          if (buf.length < end + 2) return;
          host = buf.subarray(5, end).toString('latin1');
        } else if (atyp === 4) {
          end = 4 + 16;
          if (buf.length < end + 2) return;
          const b = buf.subarray(4, 20);
          host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':');
        } else {
          reply(8);
          return client.end();
        }
        const port = buf.readUInt16BE(end);
        const rest = buf.subarray(end + 2);
        stage = 'piping';
        client.off('data', onData);
        client.pause();
        void open(client, host, port, rest, reply);
      }
    };
    client.on('data', onData);
  });

  const open = async (client: Socket, host: string, port: number, rest: Buffer, reply: (c: number) => void) => {
    if (!sameDeployment(endpointHost, host) || !portOk(port)) {
      denied.push(`${host}:${port}`);
      reply(2); // not allowed by ruleset
      return client.end();
    }
    let address: string;
    try {
      const keys = [...new Set([...hostKeys, `${host.toLowerCase()}:${port}`])];
      address = (await resolveChecked(host, keys, policy, opts.resolve)).address;
    } catch (err) {
      if (isEgressDenied(err)) denied.push(`${host}:${port}`);
      reply(isEgressDenied(err) ? 2 : 4);
      return client.end();
    }
    const upstream = netConnect({ host: address, port });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.setTimeout(opts.timeoutMs ?? 30_000, () => upstream.destroy());
    upstream.once('connect', () => {
      reply(0);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on('error', () => {
      if (!upstream.readyState || upstream.connecting) reply(5);
      client.destroy();
    });
    client.on('close', () => upstream.destroy());
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    username,
    password,
    denied,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

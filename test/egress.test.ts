import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Broker } from '../src/sandbox/broker.js';
import { classifyAddress, FORBIDDEN_RANGES, guardedFetch, isEgressDenied, PRIVATE_RANGES } from '../src/runtime/egress.js';
import { EGRESS_PROXY_SCRIPT } from '../src/paths.js';
import { parseManifest, type Manifest } from '../src/modules/manifest.js';

describe('address classification', () => {
  it.each([
    ['93.184.215.14', 'public'],
    ['2606:4700::1111', 'public'],
    ['10.1.2.3', 'private'],
    ['172.20.0.5', 'private'],
    ['192.168.1.10', 'private'],
    ['100.100.100.200', 'private'], // Alibaba Cloud metadata (CGNAT range)
    ['fd00:ec2::254', 'private'], // AWS IPv6 metadata (unique local)
    ['127.0.0.1', 'forbidden'],
    ['169.254.169.254', 'forbidden'], // cloud metadata
    ['0.0.0.0', 'forbidden'],
    ['::1', 'forbidden'],
    ['fe80::1', 'forbidden'],
    ['::ffff:169.254.169.254', 'forbidden'], // IPv4-mapped
    ['::ffff:10.0.0.1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'forbidden'], // NAT64 of 169.254.169.254
    ['64:ff9b:1::a9fe:a9fe', 'forbidden'], // local-use NAT64
    ['::7f00:1', 'forbidden'], // IPv4-compatible 127.0.0.1
    ['::127.0.0.1', 'forbidden'],
    ['::a9fe:a9fe', 'forbidden'],
    ['::ffff:0:7f00:1', 'forbidden'], // IPv4-translated
    ['::ffff:0:10.0.0.1', 'forbidden'],
    ['::ffff:7f00:1', 'forbidden'], // IPv4-mapped, hex spelling
    ['::ffff:a00:1', 'private'],
    ['0:0:0:0:0:ffff:127.0.0.1', 'forbidden'],
    ['2002:7f00:1::1', 'forbidden'], // 6to4 of 127.0.0.1
    ['2002:a9fe:a9fe::', 'forbidden'],
    ['fec0::1', 'forbidden'], // site-local
    ['ff02::1', 'forbidden'],
    ['198.18.0.1', 'private'],
    ['240.0.0.1', 'forbidden'],
    ['192.0.0.170', 'forbidden'],
    ['not-an-ip', 'forbidden'],
  ])('%s is %s', (addr, cls) => expect(classifyAddress(addr)).toBe(cls));

  it('the browser egress proxy refuses exactly what module traffic may not reach on its own', async () => {
    const proxy = (await import(EGRESS_PROXY_SCRIPT)) as { FORBIDDEN_RANGES: [string, number][]; PRIVATE_RANGES: [string, number][]; isBlocked: (a: string) => boolean };
    const key = (r: readonly [string, number]) => `${r[0]}/${r[1]}`;
    expect(proxy.FORBIDDEN_RANGES.map(key).sort()).toEqual(FORBIDDEN_RANGES.map(key).sort());
    expect(proxy.PRIVATE_RANGES.map(key).sort()).toEqual(PRIVATE_RANGES.map(key).sort());
    // And it judges every spelling the same way (the proxy refuses private ranges too, unless listed).
    const samples = [
      '93.184.215.14', '8.8.8.8', '2606:4700::1111', '10.1.2.3', '127.0.0.1', '169.254.169.254', '198.18.5.5', '240.0.0.1', '192.0.0.8', '224.0.0.1',
      '::1', '::', '::7f00:1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '::ffff:0:7f00:1', '64:ff9b::808:808', '64:ff9b:1::1',
      '2002:808:808::1', 'fec0::1', 'fe80::1', 'fd00::1', 'ff02::1', '2001:db8::1',
    ];
    for (const a of samples) expect([a, proxy.isBlocked(a)]).toEqual([a, classifyAddress(a) !== 'public']);
  });
});

describe('guarded connections', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((_req, res) => res.end('reached'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  /** A DNS stub: every name resolves to the address given in its first label. */
  const dns = (map: Record<string, string>) => async (host: string) => [{ address: map[host]!, family: map[host]!.includes(':') ? 6 : 4 }];

  it('refuses a hostname that resolves to loopback or metadata addresses, at connect time', async () => {
    const f = guardedFetch({ internalHosts: [], loopbackHosts: [] }, dns({ 'evil.example.com': '127.0.0.1' }));
    const err = await f(`http://evil.example.com:${port}/`, {}).catch((e) => e);
    expect(isEgressDenied(err)).toBe(true);
  });

  it('refuses IP literals outside the policy without any DNS lookup', async () => {
    const f = guardedFetch({ internalHosts: [], loopbackHosts: [] });
    await expect(f(`http://127.0.0.1:${port}/`, {})).rejects.toMatchObject({ code: 'EGRESS_DENIED_IP' });
    await expect(f('http://169.254.169.254/latest/meta-data/', {})).rejects.toMatchObject({ code: 'EGRESS_DENIED_IP' });
  });

  it('allows a private address only for hosts on the internal-hosts list', async () => {
    const resolve = dns({ 'gitlab.corp.example': '10.0.0.7' });
    const denied = await guardedFetch({ internalHosts: [], loopbackHosts: [] }, resolve)('http://gitlab.corp.example:18080/', {}).catch((e) => e);
    expect(isEgressDenied(denied)).toBe(true);
    // Allowed by policy: the connection is attempted (and fails only because nothing listens there).
    const attempted = await guardedFetch({ internalHosts: ['gitlab.corp.example:18080'], loopbackHosts: [] }, resolve)('http://gitlab.corp.example:18080/', {
      signal: AbortSignal.timeout(2000),
    }).catch((e) => e);
    expect(isEgressDenied(attempted)).toBe(false);
  });

  it('connects through the guard when allowed and reads the body', async () => {
    const host = `dev.example.test:${port}`;
    const f = guardedFetch({ internalHosts: [], loopbackHosts: [host] }, dns({ 'dev.example.test': '127.0.0.1' }));
    const res = await f(`http://${host}/`, {});
    expect(await res.text()).toBe('reached');
  });

  it('the broker records a denied address as a manifest violation', async () => {
    const r = parseManifest({
      name: 'meta',
      version: '1.0.0',
      title: 'Meta',
      description: 'd',
      hosts: ['169.254.169.254'],
      credentials: [],
      actions: [{ name: 'a', title: 'A', description: 'a', effect: 'read', credentials: [], input: {}, output: {} }],
    });
    const manifest = (r as { manifest: Manifest }).manifest;
    const broker = new Broker({ manifest, action: 'a', resolveSecret: async () => null });
    const out = await broker.handle({ method: 'GET', url: 'https://169.254.169.254/latest', headers: {}, credential: null, body: null, json: false });
    expect(out).toMatchObject({ ok: false, error: 'egress_denied_ip', violation: true });
    expect(broker.violations).toEqual(['egress_denied_ip']);
  });
});

describe('broker response size limit', () => {
  const manifest = (parseManifest({
    name: 'big',
    version: '1.0.0',
    title: 'Big',
    description: 'd',
    hosts: ['api.example.com'],
    credentials: [],
    actions: [{ name: 'a', title: 'A', description: 'a', effect: 'read', credentials: [], input: {}, output: {} }],
  }) as { manifest: Manifest }).manifest;
  const get = { method: 'GET', url: 'https://api.example.com/', headers: {}, credential: null, body: null, json: false };

  it('stops reading a body at the limit instead of buffering all of it', async () => {
    let pulled = 0;
    let cancelled = false;
    // An endless body: only the limit ends the read.
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      });
    const broker = new Broker({ manifest, action: 'a', resolveSecret: async () => null, maxResponseBytes: 1_000_000, fetchImpl: async () => new Response(endless()) });
    expect(await broker.handle(get)).toMatchObject({ ok: false, error: 'response_too_large' });
    expect(pulled).toBeLessThan(25);
    expect(cancelled).toBe(true);
  });

  it('refuses a body announced as too large without reading it, and still reads one within the limit', async () => {
    let pulled = 0;
    // highWaterMark 0: the stream pulls only when someone reads it.
    const body = () => new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode('x')); c.close(); } }, { highWaterMark: 0 });
    const big = new Broker({ manifest, action: 'a', resolveSecret: async () => null, maxResponseBytes: 10, fetchImpl: async () => new Response(body(), { headers: { 'content-length': '5000000000' } }) });
    expect(await big.handle(get)).toMatchObject({ ok: false, error: 'response_too_large' });
    expect(pulled).toBe(0);
    const small = new Broker({ manifest, action: 'a', resolveSecret: async () => null, maxResponseBytes: 10, fetchImpl: async () => new Response('hello') });
    expect(await small.handle(get)).toMatchObject({ ok: true, response: { status: 200, body: 'hello' } });
  });
});

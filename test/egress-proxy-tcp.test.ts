import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EGRESS_PROXY_SCRIPT } from '../src/paths.js';

/**
 * The egress proxy as app and fix steps use it: "*." is one label and "**." any depth, every refusal is
 * logged with its reason, and a TCP forward (a test database) connects only to its one destination,
 * resolved and checked when each connection arrives.
 */
let echo: net.Server;
let echoPort: number;
let proxy: ChildProcess;
let proxyPort: number;
let tcpPorts: number[];
const lines: { decision?: string; host?: string; reason?: string }[] = [];

beforeAll(async () => {
  echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoPort = (echo.address() as AddressInfo).port;
  proxy = spawn(process.execPath, [EGRESS_PROXY_SCRIPT], {
    env: {
      DTY_ALLOW: ['*.one.test:443', '**.deep.test:443', `127.0.0.1:${echoPort}`, `localhost:${echoPort}`].join(','),
      // The echo server stands in for a test database on an internal address the admin listed; "localhost" is not listed.
      DTY_ALLOW_PRIVATE: `127.0.0.1:${echoPort}`,
      // Listen ports 0: any free port (in a container each forward listens on its destination's own port).
      DTY_TCP: `0=127.0.0.1:${echoPort},0=localhost:${echoPort}`,
      DTY_PORT: '0',
      DTY_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  [proxyPort, tcpPorts] = await new Promise<[number, number[]]>((resolve) => {
    let buf = '';
    proxy.stdout!.on('data', (d: Buffer) => {
      buf += String(d);
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = JSON.parse(buf.slice(0, i)) as { ready?: boolean; port?: number; tcp?: number[]; decision?: string; host?: string; reason?: string };
        buf = buf.slice(i + 1);
        if (line.ready) resolve([line.port!, line.tcp ?? []]);
        else lines.push(line);
      }
    });
  });
});
afterAll(() => {
  proxy.kill('SIGKILL');
  echo.close();
});

/** CONNECT through the proxy: the status line it answers. */
function connect(target: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once('data', (d) => {
      resolve(String(d).split('\r\n')[0]!);
      s.destroy();
    });
    s.on('error', () => resolve('error'));
  });
}

/** Send a line through a TCP forward: what comes back (the echo), or "closed". */
function through(port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('ping'));
    s.once('data', (d) => {
      resolve(String(d));
      s.destroy();
    });
    s.on('close', () => resolve('closed'));
    s.on('error', () => resolve('closed'));
  });
}

const reasonFor = async (host: string) => {
  for (let i = 0; i < 50 && !lines.some((l) => l.host === host); i++) await new Promise((r) => setTimeout(r, 20));
  return lines.filter((l) => l.host === host).map((l) => `${l.decision}:${l.reason ?? ''}`);
};

describe('egress proxy for app and fix steps', () => {
  it('"*." allows exactly one label in front; "**." any depth; nothing else', async () => {
    // Allowed by the list, then refused as unresolved (these names do not exist): the list itself let them through.
    expect(await connect('api.one.test:443')).toContain('403');
    expect(await reasonFor('api.one.test:443')).toEqual(['deny:unresolved']);
    expect(await connect('a.b.one.test:443')).toContain('403');
    expect(await reasonFor('a.b.one.test:443')).toEqual(['deny:not_allowed']);
    expect(await connect('one.test:443')).toContain('403');
    expect(await reasonFor('one.test:443')).toEqual(['deny:not_allowed']);
    await connect('a.b.deep.test:443');
    expect(await reasonFor('a.b.deep.test:443')).toEqual(['deny:unresolved']);
    await connect('api.one.test:8443');
    expect(await reasonFor('api.one.test:8443')).toEqual(['deny:not_allowed']);
  });

  it('a private address is refused unless the host is listed as internal, and says so', async () => {
    expect(await connect(`localhost:${echoPort}`)).toContain('403');
    expect(await reasonFor(`localhost:${echoPort}`)).toEqual(['deny:private_address']);
    expect(await connect(`127.0.0.1:${echoPort}`)).toContain('200');
  });

  it('a TCP forward reaches its one destination; one to a refused address closes the connection', async () => {
    expect(tcpPorts).toHaveLength(2);
    expect(await through(tcpPorts[0]!)).toBe('ping');
    expect(await through(tcpPorts[1]!)).toBe('closed');
    expect(await reasonFor(`localhost:${echoPort}`)).toContain('deny:private_address');
  });
});

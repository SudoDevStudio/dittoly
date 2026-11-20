import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EGRESS_PROXY_SCRIPT } from '../src/paths.js';

/** The egress proxy must survive the aborted and broken connections browsers produce constantly. */
let app: http.Server;
let appPort: number;
let proxy: ChildProcess;
let proxyPort: number;

beforeAll(async () => {
  app = http.createServer((req, res) => {
    if (req.url === '/ok') return res.end('ok');
    // Starts a response, then drops the connection mid-body.
    res.writeHead(200);
    res.write('start');
    setTimeout(() => req.socket.destroy(), 50);
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  appPort = (app.address() as AddressInfo).port;
  proxy = spawn(process.execPath, [EGRESS_PROXY_SCRIPT], {
    env: { DTY_ALLOW: `127.0.0.1:${appPort}`, DTY_ALLOW_PRIVATE: `127.0.0.1:${appPort}`, DTY_PORT: '0', DTY_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  proxyPort = await new Promise<number>((resolve) => {
    proxy.stdout!.on('data', (d: Buffer) => {
      const m = /"ready":true,"port":(\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
  });
});
afterAll(() => {
  proxy.kill('SIGKILL');
  app.close();
});

/** A request through the proxy; resolves when it ends in any way, within a second. */
function through(path: string, abortAfterFirstChunk = false): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 1000);
    const done = (v: string) => {
      clearTimeout(timer);
      resolve(v);
    };
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${appPort}${path}` }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => {
        body += d;
        if (abortAfterFirstChunk) {
          req.destroy();
          done('aborted');
        }
      });
      res.on('end', () => done(body));
      res.on('error', () => done('cut'));
      res.on('close', () => done(body || 'closed'));
    });
    req.on('error', () => done('error'));
    req.end();
  });
}

describe('egress proxy', () => {
  it('keeps serving after upstreams drop mid-response and clients abort mid-response', async () => {
    for (let i = 0; i < 5; i++) {
      await through('/drop');
      await through('/drop', true);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(proxy.exitCode).toBeNull();
    expect(await through('/ok')).toBe('ok');
  });
});

describe('egress proxy private addresses', () => {
  async function startProxy(allowPrivate: string): Promise<{ port: number; stop: () => void }> {
    const child = spawn(process.execPath, [EGRESS_PROXY_SCRIPT], {
      env: { DTY_ALLOW: `127.0.0.1:${appPort}`, DTY_ALLOW_PRIVATE: allowPrivate, DTY_PORT: '0', DTY_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const port = await new Promise<number>((resolve) => {
      child.stdout!.on('data', (d: Buffer) => {
        const m = /"ready":true,"port":(\d+)/.exec(String(d));
        if (m) resolve(Number(m[1]));
      });
    });
    return { port, stop: () => child.kill('SIGKILL') };
  }
  const get = (port: number) =>
    new Promise<number>((resolve) => {
      http
        .get({ host: '127.0.0.1', port, path: `http://127.0.0.1:${appPort}/ok` }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', () => resolve(0));
    });

  it('an internal host listed without a port is allowed on any allowed port; an unlisted one is refused', async () => {
    for (const [listed, status] of [['127.0.0.1', 200], [`127.0.0.1:${appPort}`, 200], ['', 403], ['127.0.0.2', 403]] as const) {
      const p = await startProxy(listed);
      try {
        expect([listed, await get(p.port)]).toEqual([listed, status]);
      } finally {
        p.stop();
      }
    }
  });
});

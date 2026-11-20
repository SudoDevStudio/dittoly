// Dittoly app relay: makes an app step's app, running on a remote code runner, reachable to this run's browser
// as if it ran here. It listens on DTY_PORT (in a container with the app's name on a network only the browser's
// proxy joins, or on this machine's loopback address) and carries each connection to the runner through an
// authenticated HTTPS upgrade (DTY_TUNNEL_URL, the token in DTY_RELAY_TOKEN: it opens only this app's tunnel).
// A runner whose certificate is not publicly trusted: NODE_EXTRA_CA_CERTS names its CA.
//
// Plain JavaScript on purpose: it is mounted into the container as-is (src/engine/remote-runner.ts does the same on
// this machine's loopback address when the browser runs without Docker).

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** One tunnel to the runner: resolves with the socket once the runner switched protocols. */
function openTunnel(tunnelUrl, token, ca) {
  const u = new URL(tunnelUrl);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname,
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, connection: 'Upgrade', upgrade: 'dittoly-tcp' },
      ...(ca ? { ca } : {}),
      timeout: 15_000,
    });
    req.on('upgrade', (_res, socket, head) => {
      socket.setTimeout(0);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`tunnel_refused_${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('tunnel_timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** Listens on host:port and joins each connection to a new tunnel. */
function startRelay({ host, port, tunnelUrl, token, ca }) {
  const server = net.createServer((client) => {
    client.pause();
    openTunnel(tunnelUrl, token, ca).then(
      (upstream) => {
        client.pipe(upstream).pipe(client);
        client.resume();
        const end = () => {
          client.destroy();
          upstream.destroy();
        };
        client.on('error', end);
        upstream.on('error', end);
        client.on('close', end);
        upstream.on('close', end);
      },
      () => client.destroy(),
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

const server = await startRelay({ host: '0.0.0.0', port: Number(process.env.DTY_PORT), tunnelUrl: process.env.DTY_TUNNEL_URL ?? '', token: process.env.DTY_RELAY_TOKEN ?? '' });
process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port })}\n`);

// Dittoly TCP forward: on a code runner machine (src/runner/server.ts), the one way in to an app step's running
// app. The app's network has no route in or out; this container is attached to it and to Docker's bridge, where
// its port is published on the runner's loopback address only. Each connection to DTY_PORT is joined to
// DTY_TARGET (the app's name and port on its network); nothing else is reachable through it.
//
// Plain JavaScript on purpose: it is mounted into the container as-is.

import net from 'node:net';

const port = Number(process.env.DTY_PORT ?? 8080);
const [host, targetPort] = (() => {
  const t = process.env.DTY_TARGET ?? '';
  const i = t.lastIndexOf(':');
  return [t.slice(0, i), Number(t.slice(i + 1))];
})();

net
  .createServer((client) => {
    const upstream = net.connect({ host, port: targetPort });
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end);
    upstream.on('error', end);
  })
  .listen(port, '0.0.0.0', () => process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`));

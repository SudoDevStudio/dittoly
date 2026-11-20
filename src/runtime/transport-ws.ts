import { guardedLookup, resolveChecked } from './egress.js';
import { TransportError, type TransportMaker } from './protocols.js';

/** A short WebSocket session: send messages, collect replies. */
export const ws: TransportMaker<'ws'> = (policy) =>
  async (url, t, opts) => {
    // Sockets skip the lookup for an IP literal, so it is checked here; names are checked again in the lookup.
    await resolveChecked(t.hostname, t.hostKeys, policy);
    const { default: WebSocket } = await import('ws');
    return new Promise((resolve, reject) => {
      const messages: string[] = [];
      let bytes = 0;
      let done = false;
      const socket = new WebSocket(url, opts.protocols, {
        headers: opts.headers,
        lookup: guardedLookup(t.hostKeys, policy),
        handshakeTimeout: Math.min(opts.maxMs, 15_000),
        maxPayload: opts.maxBytes,
        followRedirects: false,
        perMessageDeflate: false,
      });
      const finish = (closed: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.terminate();
        resolve({ messages: messages.slice(0, opts.maxMessages), closed });
      };
      const timer = setTimeout(() => finish(false), opts.maxMs);
      socket.on('open', () => {
        for (const m of opts.send) socket.send(m);
      });
      socket.on('message', (data, isBinary) => {
        if (done) return;
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        bytes += buf.length;
        if (bytes > opts.maxBytes) {
          done = true;
          clearTimeout(timer);
          socket.terminate();
          reject(new TransportError('response_too_large', false));
          return;
        }
        messages.push(isBinary ? buf.toString('base64') : buf.toString('utf8'));
        if (messages.length >= opts.maxMessages) finish(false);
      });
      socket.on('close', () => finish(true));
      socket.on('unexpected-response', (_req, res) => {
        done = true;
        clearTimeout(timer);
        socket.terminate();
        reject(new TransportError(`websocket_http_${res.statusCode ?? 0}`, (res.statusCode ?? 0) >= 500 || res.statusCode === 429));
      });
      socket.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  };

import { resolveChecked } from './egress.js';
import { TransportError, within, type TransportMaker } from './protocols.js';

/** Publishing to an AMQP (RabbitMQ) exchange. */
export const amqp: TransportMaker<'amqp'> = (policy) =>
  async (t, tls, login, vhost, pub, timeoutMs) => {
    const { address } = await resolveChecked(t.hostname, t.hostKeys, policy);
    const { connect: amqpConnect } = await import('amqplib');
    const model = await within(
      timeoutMs,
      amqpConnect(
        { protocol: tls ? 'amqps' : 'amqp', hostname: address, port: t.port, vhost, heartbeat: 0, ...(login ? { username: login.username, password: login.password } : {}) },
        { servername: t.hostname, timeout: timeoutMs },
      ),
    );
    try {
      const ch = await model.createConfirmChannel();
      // A missing exchange closes the channel; that surfaces as an error below instead of a crash.
      ch.on('error', () => undefined);
      await within(
        timeoutMs,
        new Promise<void>((resolve, reject) => {
          ch.publish(pub.exchange, pub.routingKey, pub.body, { contentType: pub.contentType, headers: pub.headers, persistent: pub.persistent }, (err) =>
            err ? reject(new TransportError('amqp_not_confirmed', true)) : resolve(),
          );
        }),
      );
      await ch.close().catch(() => undefined);
    } finally {
      await model.close().catch(() => undefined);
    }
  };

import { resolveChecked } from './egress.js';
import { within, type TransportMaker } from './protocols.js';

/** Publishing to an MQTT topic. */
export const mqtt: TransportMaker<'mqtt'> = (policy) =>
  async (t, tls, login, pub, timeoutMs) => {
    const { address } = await resolveChecked(t.hostname, t.hostKeys, policy);
    const { connectAsync: mqttConnect } = await import('mqtt');
    const client = await within(
      timeoutMs,
      mqttConnect({
        protocol: tls ? 'mqtts' : 'mqtt',
        host: address,
        port: t.port,
        ...(tls ? { servername: t.hostname, rejectUnauthorized: true } : {}),
        ...(login ? { username: login.username, password: login.password } : {}),
        reconnectPeriod: 0,
        connectTimeout: timeoutMs,
        clean: true,
      }),
    );
    try {
      await within(timeoutMs, client.publishAsync(pub.topic, pub.payload, { qos: pub.qos, retain: pub.retain }));
    } finally {
      await client.endAsync().catch(() => undefined);
    }
  };

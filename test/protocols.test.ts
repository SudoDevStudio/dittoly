import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect as amqpConnect } from 'amqplib';
import { Aedes } from 'aedes';
import { SMTPServer } from 'smtp-server';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest, reviewSummary, type Manifest } from '../src/modules/manifest.js';
import { Broker } from '../src/sandbox/broker.js';
import { parseSse } from '../src/runtime/protocols.js';
import { ProcessRunner } from '../src/sandbox/runner.js';
import { validateModule } from '../src/modules/validate.js';

/**
 * Module connections other than HTTPS, against real servers on loopback: an
 * SMTP server, RabbitMQ, an MQTT broker, a WebSocket server and an SSE stream.
 * Loopback plain-text ports are allowed the way an admin would allow a local
 * development host; everything else about the policy is the production one.
 */
const runner = new ProcessRunner();
const SECRET = 'svc-user:svc-pass';

function manifestWith(endpoints: object[], actions: object[], extra: Partial<Manifest> = {}): Manifest {
  const hosts = [...new Set(endpoints.map((e) => (e as { host: string }).host))];
  const r = parseManifest({
    name: 'proto-test',
    version: '1.0.0',
    title: 'Protocol test',
    description: 'Talks to things.',
    hosts: [],
    credentials: [{ id: 'login', service: 'svc', label: 'Service login', hosts, placement: { type: 'basic' } }],
    endpoints,
    actions,
    ...extra,
  });
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r.manifest;
}
const action = (name: string, effect: 'read' | 'write', credentials = ['login']) => ({
  name,
  title: name,
  description: name,
  effect,
  credentials,
  input: { type: 'object' },
  output: { type: 'object' },
});

async function run(m: Manifest, code: string, actionName: string, input: unknown, plain: string[]) {
  const broker = new Broker({ manifest: m, action: actionName, resolveSecret: async () => SECRET, insecureHttpHosts: plain, timeoutMs: 5_000 });
  const r = await runner.invoke({ code, action: actionName, input, broker, timeoutMs: 20_000 });
  return { r, violations: broker.violations, writeSent: broker.writeSent };
}

// ------------------------------------------------------------------ SMTP

describe('SMTP send', () => {
  const received: { from: string; to: string[]; user: string; pass: string; body: string }[] = [];
  let server: SMTPServer;
  let host: string;
  beforeAll(async () => {
    server = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      authMethods: ['PLAIN', 'LOGIN'],
      onAuth(auth, _session, cb) {
        if (auth.username === 'svc-user' && auth.password === 'svc-pass') cb(null, { user: auth.username });
        else cb(new Error('bad login'));
      },
      onData(stream, session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            user: String(session.user),
            pass: '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
          cb();
        });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server.server, 'listening');
    host = `127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const m = () =>
    manifestWith(
      [{ id: 'mail', protocol: 'smtp', host, tls: 'none', credential: 'login', from: 'alerts@acme.test' }],
      [action('send_alert', 'write'), action('peek', 'read')],
    );
  const code = `export const actions = {
    async send_alert(i, ctx) { return ctx.smtp.send({ endpoint: 'mail', to: i.to, subject: 'Build ' + i.n, text: 'Build ' + i.n + ' failed.' }); },
    async peek(i, ctx) { return ctx.smtp.send({ endpoint: 'mail', to: 'x@acme.test', subject: 's', text: 't' }); },
  };`;

  it('sends through the declared server, signed in with the member credential, always from the reviewed sender', async () => {
    const { r, violations, writeSent } = await run(m(), code, 'send_alert', { to: ['dev@acme.test', 'ops@acme.test'], n: 42 }, [host]);
    expect(violations).toEqual([]);
    expect(r).toMatchObject({ ok: true, output: { accepted: ['dev@acme.test', 'ops@acme.test'], rejected: [] } });
    expect(writeSent).toBe(true);
    const mail = received.at(-1)!;
    expect(mail).toMatchObject({ from: 'alerts@acme.test', to: ['dev@acme.test', 'ops@acme.test'], user: 'svc-user' });
    expect(mail.body).toContain('Subject: Build 42');
  }, 30_000);

  it('a read action cannot send email', async () => {
    const { r, violations } = await run(m(), code, 'peek', {}, [host]);
    expect(violations).toEqual(['effect_read_cannot_send']);
    expect(r.ok).toBe(false);
  }, 30_000);

  it('plain text is refused unless an admin listed the host; bad recipients are refused before connecting', async () => {
    expect((await run(m(), code, 'send_alert', { to: ['dev@acme.test'], n: 1 }, [])).violations).toEqual(['egress_denied_plaintext']);
    const before = received.length;
    const bad = await run(m(), code, 'send_alert', { to: ['dev@acme.test\r\nBcc: all@x.test'], n: 1 }, [host]);
    expect(bad.r).toMatchObject({ ok: false, errorType: 'smtp_bad_recipients' });
    expect(received.length).toBe(before);
  }, 30_000);

  it('verifies the server certificate (a self-signed one is refused)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dty-tls-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    } catch {
      return; // no openssl here
    }
    const tlsServer = new SMTPServer({ secure: true, key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')), authOptional: true, onData: (s, _x, cb) => s.on('end', cb).resume() });
    tlsServer.listen(0, '127.0.0.1');
    await once(tlsServer.server, 'listening');
    const tlsHost = `127.0.0.1:${(tlsServer.server.address() as AddressInfo).port}`;
    const mt = manifestWith([{ id: 'mail', protocol: 'smtp', host: tlsHost, tls: 'implicit', credential: 'login', from: 'alerts@acme.test' }], [action('send_alert', 'write')]);
    // Loopback still has to be allowed for the address check; the certificate check is separate.
    const { r } = await run(mt, code, 'send_alert', { to: ['dev@acme.test'], n: 1 }, [tlsHost]);
    expect(r).toMatchObject({ ok: false, errorType: 'smtp_error' });
    await new Promise<void>((res) => tlsServer.close(() => res()));
  }, 30_000);

  it('the sender can be an organization setting, and the review says what it can do', () => {
    const mt = manifestWith([{ id: 'mail', protocol: 'smtp', host: 'smtp.acme.test', credential: 'login', from: '{{settings.sender}}' }], [action('send_alert', 'write')], {
      settings: [{ id: 'sender', type: 'text', label: 'Sender address' }],
    });
    expect(reviewSummary(mt)).toContain('It can SEND EMAIL through the SMTP server smtp.acme.test:587 over TLS (starttls)');
    expect(parseManifest({ ...mt, endpoints: [{ id: 'mail', protocol: 'smtp', host: 'smtp.acme.test', from: '{{settings.nope}}' }] }).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ AMQP (RabbitMQ)

const AMQP_URL = process.env.TEST_AMQP_URL ?? 'amqp://dittoly:dittoly@127.0.0.1:5672';
const rabbitUp = await amqpConnect(AMQP_URL).then(
  async (c) => {
    await c.close();
    return true;
  },
  () => false,
);

describe.skipIf(!rabbitUp)('AMQP publish (RabbitMQ)', () => {
  const host = '127.0.0.1:5672';
  const m = manifestWith([{ id: 'bus', protocol: 'amqp', host, tls: false, vhost: '/', exchanges: ['dty-test-orders'], credential: 'login' }], [action('publish_order', 'write')]);
  const code = `export const actions = { async publish_order(i, ctx) { return ctx.amqp.publish({ endpoint: 'bus', exchange: i.exchange, routingKey: 'new', message: { id: i.id } }); } };`;

  it('publishes to an allowed exchange with confirms; other exchanges are refused', async () => {
    const conn = await amqpConnect(AMQP_URL);
    const ch = await conn.createChannel();
    await ch.assertExchange('dty-test-orders', 'direct', { durable: false, autoDelete: true });
    const q = await ch.assertQueue('', { exclusive: true });
    await ch.bindQueue(q.queue, 'dty-test-orders', 'new');
    const broker = (exchange: string) =>
      new Broker({ manifest: m, action: 'publish_order', resolveSecret: async () => 'dittoly:dittoly', insecureHttpHosts: [host], timeoutMs: 5_000 });
    const b = broker('dty-test-orders');
    const r = await runner.invoke({ code, action: 'publish_order', input: { exchange: 'dty-test-orders', id: 7 }, broker: b, timeoutMs: 20_000 });
    expect(r).toMatchObject({ ok: true, output: { published: true } });
    let msg = null;
    for (let i = 0; i < 20 && !msg; i++) {
      msg = await ch.get(q.queue, { noAck: true });
      if (!msg) await new Promise((res) => setTimeout(res, 50));
    }
    expect(msg && JSON.parse(msg.content.toString())).toEqual({ id: 7 });
    expect(msg && msg.properties.contentType).toBe('application/json');

    const other = broker('amq.topic');
    await runner.invoke({ code, action: 'publish_order', input: { exchange: 'amq.topic', id: 8 }, broker: other, timeoutMs: 20_000 });
    expect(other.violations).toEqual(['amqp_exchange_denied']);
    await conn.close();
  }, 30_000);
});

// ------------------------------------------------------------------ MQTT

describe('MQTT publish', () => {
  let broker: Aedes;
  let server: net.Server;
  let host: string;
  const seen: { topic: string; payload: string; user?: string }[] = [];
  beforeAll(async () => {
    broker = await Aedes.createBroker({
      authenticate: (client, username, password, done) => {
        const ok = username === 'svc-user' && password?.toString() === 'svc-pass';
        if (ok) (client as unknown as { user: string }).user = username!;
        done(null, ok);
      },
    });
    broker.on('publish', (packet, client) => {
      if (client) seen.push({ topic: packet.topic, payload: packet.payload.toString(), user: (client as unknown as { user?: string }).user });
    });
    server = net.createServer(broker.handle);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => broker.close(() => r()));
  });

  it('publishes only to topics matching the reviewed filters', async () => {
    const m = manifestWith([{ id: 'iot', protocol: 'mqtt', host, tls: false, topics: ['devices/+/commands'], credential: 'login' }], [action('command', 'write')]);
    const code = `export const actions = { async command(i, ctx) { return ctx.mqtt.publish({ endpoint: 'iot', topic: 'devices/' + i.device + '/commands', message: { cmd: i.cmd } }); } };`;
    const ok = await run(m, code, 'command', { device: 'pump-1', cmd: 'stop' }, [host]);
    expect(ok.r).toMatchObject({ ok: true, output: { published: true } });
    expect(seen.at(-1)).toEqual({ topic: 'devices/pump-1/commands', payload: '{"cmd":"stop"}', user: 'svc-user' });
    const escape = await run(m, code, 'command', { device: 'pump-1/../../admin', cmd: 'x' }, [host]);
    expect(escape.violations).toEqual(['mqtt_topic_denied']);
    const wildcard = await run(m, code, 'command', { device: '+', cmd: 'x' }, [host]);
    expect(wildcard.r).toMatchObject({ ok: false, errorType: 'mqtt_bad_topic' });
  }, 30_000);
});

// ------------------------------------------------------------------ WebSocket and SSE

describe('WebSocket sessions and SSE reads', () => {
  let wss: WebSocketServer;
  let sseServer: http.Server;
  let wsHost: string;
  let sseHost: string;
  let lastAuth: string | undefined;
  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    wsHost = `127.0.0.1:${(wss.address() as AddressInfo).port}`;
    wss.on('connection', (socket, req) => {
      lastAuth = req.headers.authorization;
      socket.on('message', (data) => {
        socket.send(`ack:${data.toString()}`);
        socket.send('tick-1');
        socket.send('tick-2');
      });
    });
    sseServer = http.createServer((req, res) => {
      lastAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': hello\n\n');
      res.write('event: price\ndata: {"p":1}\nid: 1\n\n');
      res.write('data: line one\ndata: line two\n\n');
      // Stays open: the reader must stop on its own limits.
    });
    sseServer.listen(0, '127.0.0.1');
    await once(sseServer, 'listening');
    sseHost = `127.0.0.1:${(sseServer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    wss.close();
    sseServer.closeAllConnections();
    await new Promise<void>((r) => sseServer.close(() => r()));
  });

  it('a WebSocket session sends, collects a bounded number of replies, and carries the credential', async () => {
    const m = manifestWith([{ id: 'feed', protocol: 'websocket', host: wsHost, tls: false, credential: 'login' }], [action('ask', 'read')]);
    const code = `export const actions = { async ask(i, ctx) { return ctx.ws.exchange({ endpoint: 'feed', path: '/v1', send: [{ subscribe: i.channel }], maxMessages: 2, maxMs: 3000 }); } };`;
    const { r, violations } = await run(m, code, 'ask', { channel: 'prices' }, [wsHost]);
    expect(violations).toEqual([]);
    expect(r).toMatchObject({ ok: true, output: { messages: ['ack:{"subscribe":"prices"}', 'tick-1'], closed: false } });
    expect(lastAuth).toBe(`Basic ${Buffer.from(SECRET).toString('base64')}`);
  }, 30_000);

  it('an SSE read stops at its event limit on a stream that never ends', async () => {
    const m = manifestWith([{ id: 'events', protocol: 'sse', host: sseHost, tls: false }], [action('read_prices', 'read', [])]);
    const code = `export const actions = { async read_prices(i, ctx) { return ctx.sse.read({ endpoint: 'events', path: '/stream', maxEvents: 2, maxMs: 3000 }); } };`;
    const { r } = await run(m, code, 'read_prices', {}, [sseHost]);
    expect(r).toMatchObject({
      ok: true,
      output: { status: 200, events: [{ event: 'price', data: '{"p":1}', id: '1' }, { event: 'message', data: 'line one\nline two' }] },
    });
  }, 30_000);

  it('private and metadata addresses are refused for WebSockets, IP literals included', async () => {
    for (const h of ['169.254.169.254', '10.1.2.3']) {
      const m = manifestWith([{ id: 'feed', protocol: 'websocket', host: h, tls: true }], [action('ask', 'read', [])], { credentials: [] });
      const code = `export const actions = { async ask(i, ctx) { return ctx.ws.exchange({ endpoint: 'feed', path: '/' }); } };`;
      expect((await run(m, code, 'ask', {}, [])).violations).toEqual(['egress_denied_ip']);
    }
  }, 30_000);

  it('an endpoint must be declared and used with its own protocol', async () => {
    const m = manifestWith([{ id: 'events', protocol: 'sse', host: sseHost, tls: false }], [action('a', 'read', [])], { credentials: [] });
    const undeclared = `export const actions = { async a(i, ctx) { return ctx.ws.exchange({ endpoint: 'other', path: '/' }); } };`;
    expect((await run(m, undeclared, 'a', {}, [sseHost])).violations).toEqual(['endpoint_denied']);
    const wrong = `export const actions = { async a(i, ctx) { return ctx.ws.exchange({ endpoint: 'events', path: '/' }); } };`;
    expect((await run(m, wrong, 'a', {}, [sseHost])).violations).toEqual(['endpoint_protocol_mismatch']);
  }, 30_000);
});

describe('sandbox tests for protocol modules', () => {
  it('canned servers answer protocol calls, so a generated email module can be validated', async () => {
    const m = {
      name: 'mailer',
      version: '1.0.0',
      title: 'Mailer',
      description: 'Sends email.',
      hosts: [],
      settings: [{ id: 'smtp_host', type: 'host', label: 'SMTP server', pattern: '*.acme.test:587', default: 'smtp.acme.test:587' }],
      credentials: [{ id: 'login', service: 'smtp', label: 'SMTP login', hosts: ['{{settings.smtp_host}}'], placement: { type: 'basic' } }],
      endpoints: [{ id: 'mail', protocol: 'smtp', host: '{{settings.smtp_host}}', credential: 'login', from: 'bot@acme.test' }],
      actions: [action('send', 'write')],
    };
    const code = `export const actions = { async send(i, ctx) { const r = await ctx.smtp.send({ endpoint: 'mail', to: i.to, subject: 'Hi', text: 'Hello' }); return { sent: r.accepted.length }; } };`;
    const tests = [
      { name: 'sends', action: 'send', input: { to: ['a@acme.test'] }, http: [], expectOk: true },
      { name: 'refused recipient', action: 'send', input: { to: ['b@acme.test'] }, http: [], calls: [{ protocol: 'smtp' as const, rejected: ['b@acme.test'] }], expectOk: true },
    ];
    const { report } = await validateModule(runner, m, code, tests);
    expect(report.passed).toBe(true);
    expect(report.tests[0]!.requests).toEqual(['SMTP smtp.acme.test to 1 recipient(s)']);
  }, 30_000);

  it('parses SSE framing', () => {
    expect(parseSse('data: a\r\n\r\nevent: x\ndata: b\n\ndata: partial')).toEqual({ events: [{ event: 'message', data: 'a' }, { event: 'x', data: 'b' }], rest: 'data: partial' });
  });
});

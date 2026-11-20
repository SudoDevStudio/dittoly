import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { deadLetterQueue, RabbitWebhookQueue } from '../src/webhooks/queue.js';
import { signStandard } from '../src/runtime/verify.js';
import { approvedReleaseFlow, approveExampleModules, giveAllCredentials, makeWorld, type World } from './helpers.js';

/**
 * Shared-server webhooks through a real RabbitMQ (scripts/dev/services.sh starts one).
 * Each run uses its own queue names so runs never see each other's messages.
 */
const AMQP_URL = process.env.TEST_AMQP_URL ?? 'amqp://dittoly:dittoly@127.0.0.1:5672';
const QUEUE = `dittoly.webhooks.test-${randomUUID()}`;

let w: World;
let queue: RabbitWebhookQueue;
let server: ReturnType<typeof buildServer>;
let flowVersionId: string;

beforeAll(async () => {
  queue = new RabbitWebhookQueue(AMQP_URL, { queue: QUEUE });
  w = await makeWorld({}, { webhookQueue: queue });
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  flowVersionId = (await approvedReleaseFlow(w)).id;
  server = buildServer(w.app);
  queue.consume((content) => w.app.webhooks.handleQueued(content));
});
afterAll(async () => {
  await server.close();
  await queue.close();
  const conn = await connect(AMQP_URL);
  const ch = await conn.createChannel();
  await ch.deleteQueue(QUEUE);
  await ch.deleteQueue(deadLetterQueue(QUEUE));
  await conn.close();
  await w.db.end();
});

const inputMap = { release: '/release', project: '/project', jql: '/release', channel: '/release' };
const body = JSON.stringify({ release: '2.4', project: 'acme/app' });
const now = () => Math.floor(Date.now() / 1000);
function signed(secret: string, payload: string, id = `msg_${randomUUID()}`) {
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(now()), 'webhook-signature': signStandard(secret, id, now(), payload) };
}
const post = (id: string, payload: string, headers: Record<string, string>) => server.inject({ method: 'POST', url: `/hooks/${id}`, payload, headers });

async function eventually<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const runsOf = async (triggerId: string) =>
  (await w.db.query<{ id: string; run_as: string }>(`SELECT id, run_as FROM runs WHERE trigger_id = $1`, [triggerId])).rows;

describe('webhooks through RabbitMQ (shared server)', () => {
  it('answers at once, then a worker starts the run as the trigger owner', async () => {
    const t = await w.app.webhooks.create({ flowVersionId, provider: 'standard', payloadSchema: {}, inputMap }, w.alice);
    const res = await post(t.id, body, signed(t.secret, body));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    const runs = await eventually(async () => ((await runsOf(t.id)).length ? runsOf(t.id) : undefined));
    expect(runs).toEqual([{ id: expect.any(String), run_as: w.alice.id }]);
    const delivery = (await w.db.query(`SELECT run_id FROM webhook_deliveries WHERE trigger_id = $1`, [t.id])).rows[0];
    expect(delivery.run_id).toBe(runs[0]!.id);
  });

  it('a message delivered twice by the broker still starts one run', async () => {
    const t = await w.app.webhooks.create({ flowVersionId, provider: 'standard', payloadSchema: {}, inputMap }, w.alice);
    // Capture the queued message by publishing through a spy, then publish it again ourselves.
    const sent: Buffer[] = [];
    const original = queue.publish.bind(queue);
    queue.publish = async (content) => (sent.push(content), original(content));
    try {
      expect((await post(t.id, body, signed(t.secret, body))).statusCode).toBe(202);
    } finally {
      queue.publish = original;
    }
    await queue.publish(sent[0]!);
    await eventually(async () => ((await runsOf(t.id)).length ? true : undefined));
    await new Promise((r) => setTimeout(r, 1000)); // give the duplicate time to be consumed
    expect(await runsOf(t.id)).toHaveLength(1);
  });

  it('a payload that fails its schema is rejected and audited by the worker, and not retried', async () => {
    const t = await w.app.webhooks.create(
      { flowVersionId, provider: 'standard', payloadSchema: { type: 'object', required: ['release', 'missing'] }, inputMap },
      w.alice,
    );
    expect((await post(t.id, body, signed(t.secret, body))).statusCode).toBe(202);
    const audited = await eventually(async () => {
      const r = await w.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE subject_id = $1 AND error_type = 'payload_schema'`, [t.id]);
      return r.rows[0].n > 0 ? r.rows[0].n : undefined;
    });
    expect(audited).toBe(1);
    expect(await runsOf(t.id)).toHaveLength(0);
  });

  it('a payload built to make regular expressions backtrack is handled in linear time by the worker', async () => {
    const t = await w.app.webhooks.create(
      { flowVersionId, provider: 'standard', payloadSchema: { type: 'object', properties: { x: { type: 'string', pattern: '^(a|a)*$' } } }, inputMap },
      w.alice,
    );
    const evil = JSON.stringify({ x: 'a'.repeat(50_000) + 'b' });
    const started = Date.now();
    expect((await post(t.id, evil, signed(t.secret, evil))).statusCode).toBe(202);
    await eventually(async () => {
      const r = await w.db.query(`SELECT 1 FROM audit_events WHERE subject_id = $1 AND error_type = 'payload_schema'`, [t.id]);
      return r.rowCount ? true : undefined;
    });
    expect(Date.now() - started).toBeLessThan(5000);
    // The server kept answering meanwhile.
    expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('when the broker is unreachable the sender gets 503 and its retry is not treated as a replay', async () => {
    const t = await w.app.webhooks.create({ flowVersionId, provider: 'standard', payloadSchema: {}, inputMap }, w.alice);
    const down = new RabbitWebhookQueue('amqp://dittoly:dittoly@127.0.0.1:1', { queue: QUEUE });
    const original = queue.publish.bind(queue);
    queue.publish = (content) => down.publish(content);
    const headers = signed(t.secret, body);
    try {
      expect((await post(t.id, body, headers)).statusCode).toBe(503);
    } finally {
      queue.publish = original;
      await down.close();
    }
    expect((await post(t.id, body, headers)).statusCode).toBe(202);
  });

  it('a message that keeps failing on the server side is dead-lettered after a few attempts', async () => {
    const q = `${QUEUE}.poison`;
    const poison = new RabbitWebhookQueue(AMQP_URL, { queue: q });
    let attempts = 0;
    poison.consume(async () => (attempts++, 'retry'));
    await poison.publish(Buffer.from('{}'));
    const conn = await connect(AMQP_URL);
    const ch = await conn.createChannel();
    try {
      const dead = await eventually(async () => (await ch.get(deadLetterQueue(q), { noAck: true })) || undefined);
      expect(dead.content.toString()).toBe('{}');
      expect(attempts).toBeGreaterThanOrEqual(5);
      expect(attempts).toBeLessThanOrEqual(6);
    } finally {
      await poison.close();
      await ch.deleteQueue(q);
      await ch.deleteQueue(deadLetterQueue(q));
      await conn.close();
    }
  });
});

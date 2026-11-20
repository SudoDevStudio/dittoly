import { connect, type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage, type RecoveringChannelModel } from 'amqplib';
import { AppError } from '../core/errors.js';
import { errorType, log } from '../core/log.js';

/**
 * Shared-server webhook queue on RabbitMQ.
 *
 * The HTTP handler only verifies the signature, applies the rate limit and
 * replay check, and publishes; the request is answered at once. Workers (every
 * server process) consume and do the rest: parse, payload schema, start the run.
 *
 * - Quorum queue, persistent messages, publisher confirms: an accepted
 *   delivery survives a broker restart.
 * - A message whose processing keeps failing is redelivered at most
 *   DELIVERY_LIMIT times, then moved to the dead-letter queue, so one bad
 *   message can never tie up every worker in turn.
 * - The connection recovers on its own; while it is down, publishing fails
 *   and the sender gets 503 so it can retry.
 */
export const WEBHOOK_QUEUE = 'dittoly.webhooks';
/** Messages that kept failing end up in `<queue>.dead` for an operator to inspect. */
export const deadLetterQueue = (queue: string) => `${queue}.dead`;
const DELIVERY_LIMIT = 5;

export type QueueHandler = (content: Buffer) => Promise<'done' | 'retry'>;

export interface WebhookQueue {
  publish(content: Buffer): Promise<void>;
  /** Start consuming; may be called before the broker is reachable. */
  consume(handler: QueueHandler): void;
  close(): Promise<void>;
  /** Whether the broker can take messages now (readiness). */
  connected(): boolean;
}

export class RabbitWebhookQueue implements WebhookQueue {
  private model: RecoveringChannelModel | undefined;
  private publisher: ConfirmChannel | undefined;
  private handler: QueueHandler | undefined;
  /** The live connection, and the one the consumer was started on (one consumer per connection). */
  private live: ChannelModel | undefined;
  private consumingOn: ChannelModel | undefined;
  private connecting: Promise<void> | undefined;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly url: string,
    private readonly opts: { prefetch?: number; queue?: string; connectWaitMs?: number } = {},
  ) {}

  private get queue() {
    return this.opts.queue ?? WEBHOOK_QUEUE;
  }

  /** A publisher channel exists only while connected: it is dropped when the connection closes. */
  connected(): boolean {
    return this.publisher !== undefined;
  }

  private start(): Promise<void> {
    this.connecting ??= (async () => {
      this.model = await connect(this.url, {
        recovery: {
          waitForConnect: false,
          maxDelay: 10_000,
          // Runs after every (re)connect: channels do not survive a lost connection.
          setup: async (model: ChannelModel) => {
            this.live = model;
            const ch = await model.createConfirmChannel();
            await declare(ch, this.queue);
            this.publisher = ch;
            for (const wake of this.waiters.splice(0)) wake();
            ch.on('close', () => {
              if (this.publisher === ch) this.publisher = undefined;
            });
            if (this.handler) await this.startConsumer(model);
          },
        },
      });
      this.model.on('disconnect', (err: Error) => log.warn('webhook_queue_disconnected', { errorType: errorType(err) }));
      this.model.on('error', (err: Error) => log.warn('webhook_queue_error', { errorType: errorType(err) }));
    })();
    return this.connecting;
  }

  private async startConsumer(model: ChannelModel): Promise<void> {
    if (this.consumingOn === model) return;
    this.consumingOn = model; // set before any await, so a concurrent call cannot start a second consumer
    const ch = await model.createChannel();
    await declare(ch, this.queue);
    await ch.prefetch(this.opts.prefetch ?? 4);
    await ch.consume(this.queue, (msg: ConsumeMessage | null) => {
      if (!msg) return;
      // If the channel closed meanwhile, the broker redelivers the message on its own.
      const settle = (done: boolean) => {
        try {
          if (done) ch.ack(msg);
          else ch.nack(msg, false, true);
        } catch {
          /* channel already closed */
        }
      };
      this.handler!(msg.content).then(
        (outcome) => settle(outcome === 'done'),
        (err: unknown) => {
          log.error('webhook_queue_handler_failed', { errorType: errorType(err) });
          settle(false);
        },
      );
    });
  }

  /** The publishing channel, waiting up to `ms` for a (re)connection. */
  private async channel(ms: number): Promise<ConfirmChannel | undefined> {
    await this.start();
    if (this.publisher) return this.publisher;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.waiters.push(() => (clearTimeout(timer), resolve()));
    });
    return this.publisher;
  }

  async publish(content: Buffer): Promise<void> {
    const ch = await this.channel(this.opts.connectWaitMs ?? 3000);
    if (!ch) throw new AppError('webhook_queue_unavailable', 503);
    try {
      await new Promise<void>((resolve, reject) =>
        ch.sendToQueue(this.queue, content, { persistent: true, contentType: 'application/json' }, (err: unknown) => (err ? reject(err) : resolve())),
      );
    } catch (err) {
      log.warn('webhook_queue_publish_failed', { errorType: errorType(err) });
      throw new AppError('webhook_queue_unavailable', 503);
    }
  }

  consume(handler: QueueHandler): void {
    this.handler = handler;
    this.start()
      .then(async () => {
        // Already connected: setup ran before the handler existed, so start the consumer now.
        if (this.live) await this.startConsumer(this.live);
      })
      .catch((err: unknown) => log.error('webhook_queue_consume_failed', { errorType: errorType(err) }));
  }

  async close(): Promise<void> {
    for (const wake of this.waiters.splice(0)) wake();
    if (!this.connecting) return;
    await this.connecting.catch(() => undefined);
    await this.model?.close().catch(() => undefined);
  }
}

async function declare(ch: Channel, queue: string): Promise<void> {
  await ch.assertQueue(deadLetterQueue(queue), { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await ch.assertQueue(queue, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': DELIVERY_LIMIT,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': deadLetterQueue(queue),
    },
  });
}

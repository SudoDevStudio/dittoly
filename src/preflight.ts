import net from 'node:net';
import type { Config } from './config.js';
import type { Db } from './db/db.js';

/**
 * Startup checks that turn "econnrefused" into a sentence naming the service,
 * its address and what to try. Addresses never include credentials.
 */
export class PreflightError extends Error {}

const hint = (mode: Config['mode']) => (mode === 'local' ? ' Start it with `npm run services:up`.' : '');

function where(url: string): string {
  try {
    const u = new URL(url);
    const socket = u.searchParams.get('host');
    return socket ? `socket ${socket}` : `${u.hostname}:${u.port || (u.protocol.startsWith('amqp') ? '5672' : '5432')}`;
  } catch {
    return 'the configured address';
  }
}

export async function checkDatabase(db: Db, config: Pick<Config, 'databaseUrl' | 'mode'>): Promise<void> {
  try {
    await db.query('SELECT 1');
  } catch (err) {
    const code = (err as { code?: string }).code ?? (err as Error).name;
    const reason =
      code === 'ECONNREFUSED' ? 'nothing is listening there' : code === 'ENOTFOUND' ? 'the host name does not resolve' : code === '3D000' ? 'the database does not exist' : code === '28P01' || code === '28000' ? 'the credentials were refused' : `error ${code}`;
    throw new PreflightError(
      `cannot reach PostgreSQL at ${where(config.databaseUrl)} (DATABASE_URL): ${reason}.${code === 'ECONNREFUSED' ? hint(config.mode) : ''}`,
    );
  }
}

/** RabbitMQ is only needed for webhook deliveries, so an outage is a warning, not a stop. */
export async function rabbitReachable(amqpUrl: string, timeoutMs = 3000): Promise<string | null> {
  let host: string;
  let port: number;
  try {
    const u = new URL(amqpUrl);
    host = u.hostname;
    port = Number(u.port || (u.protocol === 'amqps:' ? 5671 : 5672));
  } catch {
    return 'DITTOLY_AMQP_URL is not a valid URL';
  }
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (problem: string | null) => {
      s.destroy();
      resolve(problem);
    };
    s.setTimeout(timeoutMs, () => done(`no answer from RabbitMQ at ${host}:${port}`));
    s.once('connect', () => done(null));
    s.once('error', (e: NodeJS.ErrnoException) => done(`cannot reach RabbitMQ at ${host}:${port} (${e.code ?? e.name})`));
  });
}

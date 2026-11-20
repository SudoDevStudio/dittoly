import { RedisStore } from './store-redis.js';
import { PostgresStore } from './store-postgres.js';
import { Sealer, type Store } from './store.js';

/** Where runs that wait are kept, so they outlive a restart: the Redis or Postgres STATE_URL names. */
export async function openStore(url: string, secret: string): Promise<Store> {
  const scheme = url.split(':')[0]!.toLowerCase();
  if (scheme === 'redis' || scheme === 'rediss') {
    return RedisStore.open(url, new Sealer(secret));
  }
  if (scheme === 'postgres' || scheme === 'postgresql') {
    return PostgresStore.open(url, new Sealer(secret));
  }
  throw new Error('STATE_URL must start with redis://, rediss://, postgres:// or postgresql://');
}

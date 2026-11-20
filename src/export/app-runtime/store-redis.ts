import { createClient } from 'redis';
import { isActive, type RunRecord, type Sealer, type Store } from './store.js';

/**
 * State in Redis: a run is one key (sealed), indexed by sorted sets; a table is a hash. Keys are
 * prefixed so the app can share a Redis with other things.
 */
const P = 'dty:';
/** The keys' prefix before "dty:": an app that ran with it keeps its data (renamed once, when it opens). */
const OLD = 'mlm:';
const connect = (url: string) => createClient({ url });

export class RedisStore implements Store {
  get unreadable() {
    return this.sealer.unreadable;
  }
  readonly kind = 'redis' as const;
  private constructor(
    private readonly c: ReturnType<typeof connect>,
    private readonly sealer: Sealer,
  ) {}

  static async open(url: string, sealer: Sealer): Promise<RedisStore> {
    const c = connect(url);
    // Without a listener, a dropped connection would crash the process; the client reconnects.
    c.on('error', () => undefined);
    await c.connect();
    await renameOld(c);
    return new RedisStore(c, sealer);
  }

  async getRun(id: string) {
    const v = await this.c.get(`${P}run:${id}`);
    return v ? this.sealer.tryOpen<RunRecord>(v, `run:${id}`) : null;
  }
  async putRun(run: RunRecord) {
    const m = this.c.multi().set(`${P}run:${run.id}`, this.sealer.seal(run, `run:${run.id}`));
    const at = Date.parse(run.createdAt);
    if (!run.parent) m.zAdd(`${P}runs`, { score: at, value: run.id }).zAdd(`${P}runs:${run.flow}`, { score: at, value: run.id });
    if (isActive(run)) m.sAdd(`${P}active`, run.id);
    else m.sRem(`${P}active`, run.id);
    if (run.expiresAt) m.zAdd(`${P}expires`, { score: Date.parse(run.expiresAt), value: run.id });
    await m.exec();
  }
  private async many(ids: string[]) {
    if (!ids.length) return [];
    const values = await this.c.mGet(ids.map((id) => `${P}run:${id}`));
    return values.flatMap((v, i) => (v ? [this.sealer.tryOpen<RunRecord>(v, `run:${ids[i]}`)] : [])).filter((r): r is RunRecord => r !== null);
  }
  async listRuns(o: { flow?: string; limit: number }) {
    const ids = await this.c.zRange(o.flow ? `${P}runs:${o.flow}` : `${P}runs`, 0, o.limit - 1, { REV: true });
    return this.many(ids);
  }
  async activeRuns() {
    return this.many(await this.c.sMembers(`${P}active`));
  }
  async tableGet(table: string, key: string) {
    const v = await this.c.hGet(`${P}tbl:${table}`, key);
    return v ? this.sealer.tryOpen<Record<string, unknown>>(v, `tbl:${table}:${key}`) : null;
  }
  async tablePut(table: string, key: string, row: Record<string, unknown>) {
    await this.c.hSet(`${P}tbl:${table}`, key, this.sealer.seal(row, `tbl:${table}:${key}`));
  }
  async tableDelete(table: string, key: string) {
    return (await this.c.hDel(`${P}tbl:${table}`, key)) > 0;
  }
  async tableRows(table: string) {
    const all = await this.c.hGetAll(`${P}tbl:${table}`);
    return Object.entries(all).flatMap(([key, v]) => {
      const row = this.sealer.tryOpen<Record<string, unknown>>(v, `tbl:${table}:${key}`);
      return row ? [{ key, row }] : [];
    });
  }
  async mark(name: string, ttlSeconds: number) {
    return (await this.c.set(`${P}mark:${name}`, '1', { condition: 'NX', expiration: { type: 'EX', value: ttlSeconds } })) === 'OK';
  }
  async sweep(now: Date) {
    const ids = await this.c.zRangeByScore(`${P}expires`, 0, now.getTime());
    for (const id of ids) {
      const run = await this.getRun(id);
      const m = this.c.multi().del(`${P}run:${id}`).zRem(`${P}expires`, id).zRem(`${P}runs`, id).sRem(`${P}active`, id);
      if (run) m.zRem(`${P}runs:${run.flow}`, id);
      await m.exec();
    }
    return ids.length;
  }
  async close() {
    await this.c.close();
  }
}

/** Moves keys under the old prefix to the current one, unless the current one is already in use. */
async function renameOld(c: ReturnType<typeof connect>): Promise<void> {
  if ((await c.keys(`${P}*`)).length) return;
  for (const key of await c.keys(`${OLD}*`)) await c.rename(key, P + key.slice(OLD.length));
}

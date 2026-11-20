import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createDb } from '../src/db/db.js';
import { checkDatabase, PreflightError, rabbitReachable } from '../src/preflight.js';
import { approvedReleaseFlow, approveExampleModules, giveAllCredentials, makeWorld, releaseInputs, type World } from './helpers.js';

/** Regressions for problems found by using the app end to end. */
let w: World;
let api: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});
const as = (who: keyof World['tokens']) => ({ authorization: `Bearer ${w.tokens[who]}` });

describe('found in the walkthrough', () => {
  it('the approval queue names a gate by its title, not its internal id', async () => {
    await giveAllCredentials(w, w.alice);
    const version = await approvedReleaseFlow(w);
    await w.app.engine.startRun(version.id, w.alice.id, releaseInputs);
    await w.app.worker.drain();
    const queue = (await api.inject({ method: 'GET', url: '/api/approvals', headers: as('approver') })).json() as { kind: string; title: string }[];
    expect(queue.find((q) => q.kind === 'gate')?.title).toBe('Release coordination: Release manager sign-off');
  });

  it('members see which credentials approved modules need and which they have stored', async () => {
    const needed = (await api.inject({ method: 'GET', url: '/api/me/credentials/needed', headers: as('bob') })).json() as { service: string; stored: boolean; modules: string[] }[];
    expect(needed.map((n) => [n.service, n.stored])).toEqual([
      ['gitlab', false],
      ['jira', false],
      ['slack', false],
    ]);
    await w.app.vault.put(w.bob.id, 'slack', 'xoxb-bob');
    const after = (await api.inject({ method: 'GET', url: '/api/me/credentials/needed', headers: as('bob') })).json() as { service: string; stored: boolean }[];
    expect(after.at(-1)).toMatchObject({ service: 'slack', stored: true });
  });

  it('startup names an unreachable database and RabbitMQ instead of "econnrefused"', async () => {
    const url = 'postgres://postgres:secret-password@127.0.0.1:1/dittoly';
    const db = createDb(url, 1);
    const err = await checkDatabase(db, { databaseUrl: url, mode: 'local' }).catch((e: unknown) => e);
    await db.end();
    expect(err).toBeInstanceOf(PreflightError);
    expect(String((err as Error).message)).toMatch(/PostgreSQL at 127\.0\.0\.1:1 .*nothing is listening.*services:up/);
    expect(String((err as Error).message)).not.toContain('secret-password');
    expect(await rabbitReachable('amqp://u:p@127.0.0.1:1')).toMatch(/RabbitMQ at 127\.0\.0\.1:1/);
  });
});

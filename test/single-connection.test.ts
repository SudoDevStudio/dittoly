import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createMember } from '../src/core/members.js';
import { createDb, type Db } from '../src/db/db.js';
import { approveExampleModules, FakeApps, freshDb, testConfig, TEST_DB_URL, type World } from './helpers.js';

/**
 * The local install talks to its database over one connection (src/local/launcher.ts). Nothing may query on a second
 * connection while a transaction holds that one, or it waits on itself: approving a Flow once did (its check of the apps
 * that follow the Flow ran inside the approval's transaction).
 */
let setup: Db;
let db: Db;

beforeAll(async () => {
  setup = await freshDb();
  db = createDb(TEST_DB_URL, 1);
}, 60_000);
afterAll(async () => {
  await db.end();
  await setup.end();
});

describe('one database connection, as in the local install', () => {
  it('approves a Flow', async () => {
    const fake = new FakeApps();
    const app = buildApp(testConfig({ mode: 'local' }), db, { ai: null, fetchImpl: fake.fetch });
    const mk = (h: string, r: 'admin' | 'approver' | 'member') => createMember(db, h, r, null).then((m) => m.member);
    const [admin, approver, alice] = [await mk('admin', 'admin'), await mk('approver', 'approver'), await mk('alice', 'member')];
    await approveExampleModules({ app, db, admin, approver, alice } as unknown as World);
    const v = await app.flows.create('One connection', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C', text: 'hi' } }] }, alice);
    const decided = await Promise.race([app.flows.decide(v.id, approver, 'approved'), new Promise<'hung'>((r) => setTimeout(() => r('hung'), 15_000))]);
    expect(decided).not.toBe('hung');
    expect(decided).toMatchObject({ status: 'approved' });
  }, 60_000);
});

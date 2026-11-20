import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/** A module's page lists the Flows that use it, so a person can go from a module to its Flows (their teams only). */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
beforeAll(async () => {
  w = await makeWorld();
  api = buildServer(w.app);
  await approveExampleModules(w);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('module page: used by', () => {
  it('lists the Flows of the person\'s teams that use the module, with the version they pin', async () => {
    const v = await w.app.flows.create('Tell the team', { inputs: { type: 'object', properties: {} }, steps: [{ id: 'tell', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text: 'hi' } }] }, w.alice);
    const slack = (await w.db.query<{ id: string }>(`SELECT id FROM module_versions WHERE name = 'slack' AND version = '1.0.0'`)).rows[0]!.id;
    const review = (await api.inject({ method: 'GET', url: `/api/modules/${slack}/review`, headers: auth(w.tokens.alice) })).json();
    expect(review.usedBy).toEqual([{ flowId: v.flowId, name: 'Tell the team', version: 1, status: 'pending', uses: 'slack@1.0.0' }]);
    // A module no Flow uses lists none.
    const jira = (await w.db.query<{ id: string }>(`SELECT id FROM module_versions WHERE name = 'jira' LIMIT 1`)).rows[0]!.id;
    expect((await api.inject({ method: 'GET', url: `/api/modules/${jira}/review`, headers: auth(w.tokens.alice) })).json().usedBy).toEqual([]);
  });
});

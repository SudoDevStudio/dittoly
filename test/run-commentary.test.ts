import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIVITY, MockProvider } from '../src/ai/provider.js';
import { appMessage } from '../src/runtime/broker.js';
import { MAX_LINES, narrator } from '../src/engine/commentary.js';
import { approveExampleModules, makeWorld, runStatus, type World } from './helpers.js';

/**
 * A run says what it is doing as it goes ("Now on step …", what its AI does, each app call and how it answered), for
 * the Live panel and the run page; a refused call keeps only the app's own short reason.
 */
const orgAi = new MockProvider();
let w: World;
beforeAll(async () => {
  w = await makeWorld({}, { ai: orgAi });
  await approveExampleModules(w);
});
afterAll(async () => {
  await w.db.end();
});

describe('run commentary', () => {
  it("narrates an AI step's work, shows on the run page and in Live for its member only", async () => {
    const v = await w.app.flows.create('Summarise', { steps: [{ id: 'sum', type: 'ai', title: 'Summarise it', ai: 'organization', instruction: 'Summarise.', input: {} }] }, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    orgAi.enqueue({ text: 'Short.', [ACTIVITY]: ['searching the web for "release notes"', 'reading docs.example.com'] });
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    const r = await runStatus(w, runId, w.alice);
    expect(r.status, JSON.stringify(r.steps)).toBe('succeeded');
    expect((r.commentary as { text: string }[]).map((l) => l.text)).toEqual([
      'Now on step "Summarise it": the AI is working on it',
      'AI: searching the web for "release notes"',
      'AI: reading docs.example.com',
      'Step "Summarise it" done',
      'The run finished',
    ]);
    // Live lists the member's runs of the last minute with their latest lines; nobody else's.
    const live = await w.app.engine.liveRuns(w.alice);
    expect(live.find((x) => x.runId === runId)!.lines.at(-1)!.text).toBe('The run finished');
    expect((await w.app.engine.liveRuns(w.bob)).some((x) => x.runId === runId)).toBe(false);
    // Kept encrypted.
    const raw = (await w.db.query<{ text_enc: string }>(`SELECT text_enc FROM run_commentary WHERE run_id = $1`, [runId])).rows;
    expect(raw.length).toBe(5);
    expect(JSON.stringify(raw)).not.toContain('release notes');
  });

  it('keeps at most MAX_LINES lines per run and skips a line said twice in a row', async () => {
    const v = await w.app.flows.create('Quiet', { steps: [{ id: 'sum', type: 'ai', ai: 'organization', instruction: 'Summarise.', input: {} }] }, w.alice);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    orgAi.enqueue({ text: 'ok' });
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    const n = narrator(w.db, w.app.cipher, runId, null);
    n.say('same');
    n.say('same');
    for (let i = 0; i < MAX_LINES + 20; i++) n.say(`line ${i}`);
    await n.flush();
    const count = Number((await w.db.query<{ n: string }>(`SELECT count(*) AS n FROM run_commentary WHERE run_id = $1`, [runId])).rows[0]!.n);
    expect(count).toBe(MAX_LINES);
    const texts = (await runStatus(w, runId, w.alice)).commentary.map((l: { text: string }) => l.text);
    expect(texts.filter((t: string) => t === 'same')).toHaveLength(texts.includes('same') ? 1 : 0);
  });
});

describe("an app's short reason for refusing a call", () => {
  const msg = (v: unknown) => appMessage(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
  it('takes the message and the messages of its errors list, at most 200 characters', () => {
    expect(msg({ message: 'Validation Failed', errors: [{ resource: 'Search', code: 'invalid', message: 'The listed users cannot be searched' }], documentation_url: 'https://x' })).toBe(
      'Validation Failed — The listed users cannot be searched',
    );
    expect(msg({ error: 'invalid_grant', error_description: 'Token expired' })).toBe('Token expired');
    expect(msg({ errors: ['a', { message: 'b' }] })).toBe('a — b');
    expect(msg({ message: 'x'.repeat(500) })).toHaveLength(200);
  });
  it('says nothing for a body that is not a JSON object with a message', () => {
    expect(msg('<html>Bad gateway</html>')).toBe('');
    expect(msg([1, 2])).toBe('');
    expect(msg({ token: 'secret', data: { user: 'x' } })).toBe('');
  });
});

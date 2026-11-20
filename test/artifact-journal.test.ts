import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { buildMemoryFor, journal, journalOf } from '../src/ai/build-memory.js';
import { defaultTeamFor } from '../src/core/teams.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * How a Flow or a module came to be what it is.
 *
 * What a person typed used to live only in the progress list, which is wiped, so six revisions later nothing
 * could say what the Flow had been asked to do. This is that trail, kept with the artifact: their words, what an
 * approver decided, what the checks found — each marked for what it is, and an AI's own suggestions marked too,
 * so they are never handed back as rules nobody chose.
 */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
let team: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  api = buildServer(w.app);
  await approveExampleModules(w);
  team = await defaultTeamFor(w.db, w.alice.id);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const drafted = (name: string, text: string, explanation = 'Posts it.') => {
  ai.enqueue({ classificationJson: JSON.stringify({ summary: '', category: 'web_api', protocols: [], questions: [] }) });
  ai.enqueue({
    name,
    definitionJson: JSON.stringify({
      description: 'Tells the team.',
      inputs: { type: 'object', properties: {} },
      steps: [{ id: 'tell', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text } }],
    }),
    explanation,
    missingJson: '[]',
    splitJson: '[]',
    sourcesJson: '[]',
    notesMd: '',
    testsJson: '[]',
  });
};
const revisionReady = (text: string, explanation = 'Changed it.') => {
  ai.enqueue({
    name: 'Tell the team',
    definitionJson: JSON.stringify({
      description: 'Tells the team.',
      inputs: { type: 'object', properties: {} },
      steps: [{ id: 'tell', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text } }],
    }),
    explanation,
    missingJson: '[]',
    splitJson: '[]',
    sourcesJson: '[]',
    notesMd: '',
    testsJson: '[]',
  });
};

async function aFlow(request: string): Promise<{ flowId: string; versionId: string }> {
  drafted('Tell the team', 'hi');
  const out = await w.app.flowChat.draft(request, w.alice);
  if (!('version' in out)) throw new Error('not drafted');
  return { flowId: out.version.flowId, versionId: out.version.id };
}

describe('how an artifact came to be what it is', () => {
  it('keeps what the person asked for, in their words, and what the AI said separately', async () => {
    const { flowId } = await aFlow('post a daily digest to #team at 9am, and never on weekends');
    const kept = await journalOf(w.db, w.app.cipher, { type: 'flow', id: flowId });
    const request = kept.entries.find((e) => e.kind === 'request')!;
    expect(request.origin).toBe('user');
    expect(request.text).toBe('post a daily digest to #team at 9am, and never on weekends');
    expect(request.by).toBeTruthy();
    // The AI's own words are kept too, but marked as its suggestion, not as something anyone agreed to.
    expect(kept.entries.find((e) => e.origin === 'ai')?.kind).toBe('suggestion');

    // The build data a draft leaves behind is wiped; the journal is not, which is the point of it.
    await w.db.query(`DELETE FROM ai_builds`);
    expect((await journalOf(w.db, w.app.cipher, { type: 'flow', id: flowId })).entries.some((e) => e.kind === 'request')).toBe(true);
  });

  it('gives a revision what the Flow was originally asked for, and never the AI\'s own suggestions as rules', async () => {
    const { flowId } = await aFlow('post a daily digest to #team at 9am, and never on weekends');
    revisionReady('digest');
    await w.app.flowChat.revise(flowId, 'say "good morning" first', w.alice);
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain('never on weekends');
    expect(prompt).toContain('HOW THIS WAS BUILT');
    // The request in front of the model wins, and nothing in the block is a permission.
    expect(prompt).toContain('the request you were given now wins');
    expect(prompt).toContain('the checks and the approver still decide');
    // What the AI said last time is not fed back to it as a constraint.
    expect(prompt).not.toContain('Posts it.');
    // And their newer words are kept too, for the revision after this one.
    const kept = await journalOf(w.db, w.app.cipher, { type: 'flow', id: flowId });
    expect(kept.entries.filter((e) => e.kind === 'request' && e.origin === 'user').map((e) => e.text)).toEqual([
      'post a daily digest to #team at 9am, and never on weekends',
      'say "good morning" first',
    ]);
  });

  it('records on the version exactly which entries it was given, and not their words', async () => {
    const { flowId } = await aFlow('post to #team when a deploy finishes');
    revisionReady('deployed');
    const { version } = await w.app.flowChat.revise(flowId, 'mention who deployed it', w.alice);
    const review = await w.app.flows.review(version.id);
    const build = (review.generation as { memory?: { build?: { used: string[]; unreadable: number; omitted: number } } } | null)?.memory?.build;
    expect(build?.used.length).toBeGreaterThan(0);
    const ids = (await journalOf(w.db, w.app.cipher, { type: 'flow', id: flowId })).entries.map((e) => e.id);
    for (const id of build!.used) expect(ids).toContain(id);
    expect(JSON.stringify(review.generation)).not.toContain('when a deploy finishes');
  });

  it('is corrected without being rewritten: a superseded entry leaves the drafts, not the history', async () => {
    const { flowId } = await aFlow('post to #ops, which is the only channel we use');
    const artifact = { type: 'flow' as const, id: flowId, teamId: team };
    const id = (await journalOf(w.db, w.app.cipher, artifact)).entries.find((e) => e.kind === 'request')!.id;
    const done = await api.inject({ method: 'POST', url: `/api/journal/flow/${flowId}/${id}/supersede`, headers: auth(w.tokens.alice) });
    expect(done.statusCode, done.body).toBe(204);

    // Still there, and still readable: the version drafted with it can still be explained.
    const after = await journalOf(w.db, w.app.cipher, artifact);
    expect(after.entries.find((e) => e.id === id)?.supersededAt).toBeTruthy();
    // But it is no longer given to a draft as something that must hold.
    const memory = await buildMemoryFor(w.db, w.app.cipher, artifact);
    expect(memory.text).not.toContain('Must hold');
    expect(memory.used).not.toContain(id);
  });

  it('never drops what a person said, and says when an entry is left out for room', async () => {
    const artifact = { type: 'flow' as const, id: `budget-${Date.now()}`, teamId: team };
    await journal(w.db, w.app.cipher, artifact, { kind: 'request', origin: 'user', text: 'the original ask' });
    for (let i = 0; i < 10; i++) {
      await journal(w.db, w.app.cipher, artifact, { kind: 'constraint', origin: 'user', text: `rule ${i} ${'x'.repeat(300)}` });
      await journal(w.db, w.app.cipher, artifact, { kind: 'failure', origin: 'evidence', text: `failure ${i} ${'y'.repeat(300)}` });
    }
    const memory = await buildMemoryFor(w.db, w.app.cipher, artifact);
    expect(memory.text).toContain('the original ask');
    for (let i = 0; i < 10; i++) expect(memory.text).toContain(`rule ${i}`);
    expect(memory.omitted).toBeGreaterThan(0);
    // The same journal gives the same block, every time: nothing here is chosen by chance.
    expect((await buildMemoryFor(w.db, w.app.cipher, artifact)).text).toBe(memory.text);
  });

  it('says so when an entry cannot be read, instead of drafting as if it never existed', async () => {
    const artifact = { type: 'flow' as const, id: `unreadable-${Date.now()}`, teamId: team };
    await journal(w.db, w.app.cipher, artifact, { kind: 'request', origin: 'user', text: 'the readable one' });
    await w.db.query(
      `INSERT INTO artifact_journal (artifact_type, artifact_id, team_id, kind, origin, text_enc) VALUES ('flow', $1, $2, 'constraint', 'user', 'not-decryptable')`,
      [artifact.id, team],
    );
    const seen = await journalOf(w.db, w.app.cipher, artifact);
    expect(seen.unreadable).toBe(1);
    const memory = await buildMemoryFor(w.db, w.app.cipher, artifact);
    expect(memory.unreadable).toBe(1);
    expect(memory.text).toContain('could not be read');
    expect(memory.text).toContain('Do not assume');
  });

  it('is the team\'s own, and theirs to take away', async () => {
    const { flowId } = await aFlow('post to #team when someone joins');
    const mine = await api.inject({ method: 'GET', url: `/api/journal/flow/${flowId}`, headers: auth(w.tokens.alice) });
    expect(mine.statusCode, mine.body).toBe(200);
    const entries = (mine.json() as { entries: { id: string; text: string }[] }).entries;
    expect(entries.length).toBeGreaterThan(0);

    // Someone outside the Flow's team reads none of it.
    const otherTeam = (await w.db.query<{ id: string }>(`INSERT INTO teams (name) VALUES ('Theirs') RETURNING id`)).rows[0]!.id;
    const elsewhere = (await w.db.query<{ id: string }>(`INSERT INTO flows (name, team_id, created_by) VALUES ('Theirs', $1, $2) RETURNING id`, [otherTeam, w.alice.id])).rows[0]!.id;
    await journal(w.db, w.app.cipher, { type: 'flow', id: elsewhere, teamId: otherTeam }, { kind: 'request', origin: 'user', text: 'their own words' });
    const theirs = await api.inject({ method: 'GET', url: `/api/journal/flow/${elsewhere}`, headers: auth(w.tokens.bob) });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.body).not.toContain('their own words');

    const gone = await api.inject({ method: 'DELETE', url: `/api/journal/flow/${flowId}/${entries[0]!.id}`, headers: auth(w.tokens.alice) });
    expect(gone.statusCode, gone.body).toBe(204);
    const left = await journalOf(w.db, w.app.cipher, { type: 'flow', id: flowId });
    expect(left.entries.some((e) => e.id === entries[0]!.id)).toBe(false);
    // Taken away for good: its words are gone from the row as well, not merely hidden.
    const row = (await w.db.query<{ text_enc: string }>(`SELECT text_enc FROM artifact_journal WHERE id = $1`, [entries[0]!.id])).rows[0];
    expect(row?.text_enc).toBe('');
  });

  it('keeps an approver\'s decision as a decision, and what they accepted with it', async () => {
    const { flowId, versionId } = await aFlow('post to #team nightly');
    const decided = await api.inject({
      method: 'POST',
      url: `/api/flow-versions/${versionId}/decision`,
      headers: auth(w.tokens.approver),
      payload: { decision: 'approved' },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    const kept = await journalOf(w.db, w.app.cipher, { type: 'flow', id: flowId });
    const decision = kept.entries.find((e) => e.kind === 'decision');
    expect(decision?.origin).toBe('approved');
    expect(decision?.text).toContain('approved');
    // An approver's decision is given to the next draft; an AI's suggestion still is not.
    const memory = await buildMemoryFor(w.db, w.app.cipher, { type: 'flow', id: flowId, teamId: team });
    expect(memory.text).toContain('Approved');
    expect(memory.text).not.toContain('Posts it.');
  });

  it('keeps nothing without an artifact or without words, and a draft never fails for it', async () => {
    expect(await journal(w.db, w.app.cipher, { type: 'flow', id: '' }, { kind: 'request', origin: 'user', text: 'x' })).toBeNull();
    expect(await journal(w.db, w.app.cipher, { type: 'flow', id: 'x' }, { kind: 'request', origin: 'user', text: '   ' })).toBeNull();
    expect((await buildMemoryFor(w.db, w.app.cipher, { type: 'flow', id: 'nothing-here' })).text).toBe('');
  });
});

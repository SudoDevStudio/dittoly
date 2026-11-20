import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { decisionsForDraft, decisionsText, rememberAnswers, teamDecisions } from '../src/ai/decisions.js';
import { defaultTeamFor } from '../src/core/teams.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/**
 * What a team answers while drafting is kept for the team, not just for that draft: the second Flow is given
 * what the first one was told, instead of asking again. It is their words — correctable, forgettable, scoped to
 * their team — and it decides nothing on its own.
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

const source = { type: 'flow' as const, id: null };

describe('what a team told the AI', () => {
  it('keeps an answer once, replaces it when they answer differently, and hands it to the next draft', async () => {
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'Which Slack channel should it post to?': '#ops' });
    expect((await teamDecisions(w.db, w.app.cipher, team)).decisions.map((d) => [d.question, d.answer])).toEqual([['Which Slack channel should it post to?', '#ops']]);

    // The same question, worded with different punctuation, replaces the answer instead of piling up.
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'which slack channel should it post to': '#alerts' });
    const live = (await teamDecisions(w.db, w.app.cipher, team)).decisions;
    expect(live.map((d) => d.answer)).toEqual(['#alerts']);

    const text = await decisionsText(w.db, w.app.cipher, team);
    expect(text).toContain('#alerts');
    expect(text).toContain('WHAT THIS TEAM ALREADY ANSWERED');
    // It is what they said, not a rule: the request still decides.
    expect(text).toContain('unless THE PERSON WANTS says otherwise');
  });

  it('is the team\'s own: another team sees none of it, and nothing an AI said is kept', async () => {
    const other = (await w.db.query<{ id: string }>(`INSERT INTO teams (name) VALUES ('Other') RETURNING id`)).rows[0]!.id;
    expect((await teamDecisions(w.db, w.app.cipher, other)).decisions).toEqual([]);
    expect(await decisionsText(w.db, w.app.cipher, other)).toBe('');
    // Nothing is kept without a team, and an empty answer is not an answer.
    await rememberAnswers(w.db, w.app.cipher, { teamId: null, source, by: w.alice.id }, { q: 'a' });
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'Blank?': '   ' });
    expect((await teamDecisions(w.db, w.app.cipher, team)).decisions.some((d) => d.question === 'Blank?')).toBe(false);
  });

  it('is read and forgotten by its team, and by nobody else', async () => {
    const mine = await api.inject({ method: 'GET', url: `/api/teams/${team}/decisions`, headers: auth(w.tokens.alice) });
    expect(mine.statusCode, mine.body).toBe(200);
    const [first] = (mine.json() as { decisions: { id: string }[] }).decisions;
    expect(first).toBeTruthy();

    const outsider = (await w.db.query<{ id: string }>(`INSERT INTO teams (name) VALUES ('Theirs') RETURNING id`)).rows[0]!.id;
    expect((await api.inject({ method: 'GET', url: `/api/teams/${outsider}/decisions`, headers: auth(w.tokens.bob) })).statusCode).toBe(403);

    const gone = await api.inject({ method: 'DELETE', url: `/api/teams/${team}/decisions/${first!.id}`, headers: auth(w.tokens.alice) });
    expect(gone.statusCode).toBe(204);
    expect((await teamDecisions(w.db, w.app.cipher, team)).decisions.some((d) => d.id === first!.id)).toBe(false);
  });

  it('reaches the next draft: a Flow drafted later is told what an earlier one answered', async () => {
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'Which project?': 'OPS' });
    ai.enqueue({ classificationJson: JSON.stringify({ summary: '', category: 'web_api', protocols: [], questions: [] }) });
    ai.enqueue({
      name: 'Tell the team',
      definitionJson: JSON.stringify({
        description: 'Tells the team.',
        inputs: { type: 'object', properties: {} },
        steps: [{ id: 'tell', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#team', text: 'hi' } }],
      }),
      explanation: 'Posts it.',
      missingJson: '[]',
      splitJson: '[]',
      sourcesJson: '[]',
      notesMd: '',
      testsJson: '[]',
    });
    await w.app.flowChat.draft('Tell the team something', w.alice);
    expect(ai.requests.at(-1)!.prompt).toContain('Which project? OPS');
  });

  it('is not handed to a draft about other apps, and is handed to one about the same app', async () => {
    const jira = { teamId: team, source, by: w.alice.id, about: ['jira'] };
    await rememberAnswers(w.db, w.app.cipher, jira, { 'Which Jira project?': 'OPS' });
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'Who signs off on deployments?': 'the on-call engineer' });

    // A GitHub request never mentions Jira: the Jira answer stays out, the one about no app stays in.
    const elsewhere = await decisionsForDraft(w.db, w.app.cipher, team, { request: 'open a pull request on GitHub when a build fails' });
    expect(elsewhere.text).not.toContain('Which Jira project?');
    expect(elsewhere.text).toContain('the on-call engineer');

    const same = await decisionsForDraft(w.db, w.app.cipher, team, { request: 'file a jira issue when a build fails' });
    expect(same.text).toContain('Which Jira project? OPS');
    expect(same.text).toContain('(about jira)');
  });

  it('leaves out what this request already answers: the person in front of it wins', async () => {
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'Which branch?': 'main' });
    const now = await decisionsForDraft(w.db, w.app.cipher, team, { request: 'anything', answeredNow: { 'which branch': 'release' } });
    expect(now.text).not.toContain('main');
    // And an empty answer now is not an answer: what they said before still stands.
    const blank = await decisionsForDraft(w.db, w.app.cipher, team, { request: 'anything', answeredNow: { 'Which branch?': '  ' } });
    expect(blank.text).toContain('main');
  });

  it('says so when an answer cannot be read, instead of drafting as if it never existed', async () => {
    const hidden = (await w.db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
    await w.db.query(
      `INSERT INTO team_decisions (id, team_id, question_key, question_enc, answer_enc, source_type, source_id, answered_by, about)
       VALUES ($1, $2, 'broken', 'not-decryptable', 'not-decryptable', 'flow', NULL, $3, '{}')`,
      [hidden, team, w.alice.id],
    );
    const seen = await teamDecisions(w.db, w.app.cipher, team);
    expect(seen.unreadable).toBe(1);
    expect(seen.decisions.some((d) => d.id === hidden)).toBe(false);

    const forDraft = await decisionsForDraft(w.db, w.app.cipher, team, { request: 'anything' });
    expect(forDraft.unreadable).toBe(1);
    expect(forDraft.text).toContain('could not be read');
    expect(forDraft.text).toContain('ask again');
    await w.db.query(`DELETE FROM team_decisions WHERE id = $1`, [hidden]);
  });

  it('keeps a superseded answer for the version that was drafted with it', async () => {
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'Which inbox?': 'support@' });
    const first = (await teamDecisions(w.db, w.app.cipher, team)).decisions.find((d) => d.question === 'Which inbox?')!;
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'Which inbox?': 'help@' });
    // The old answer is no longer handed to drafts, but the row is still there for the version that used it.
    expect((await decisionsForDraft(w.db, w.app.cipher, team, { request: 'anything' })).text).not.toContain('support@');
    const old = (await w.db.query<{ superseded_at: Date | null }>(`SELECT superseded_at FROM team_decisions WHERE id = $1`, [first.id])).rows[0];
    expect(old?.superseded_at).toBeTruthy();
  });

  it('records on the version which answers it was given, and never their words', async () => {
    await rememberAnswers(w.db, w.app.cipher, { teamId: team, source, by: w.alice.id }, { 'Which channel for releases?': '#releases' });
    ai.enqueue({ classificationJson: JSON.stringify({ summary: '', category: 'web_api', protocols: [], questions: [] }) });
    ai.enqueue({
      name: 'Announce a release',
      definitionJson: JSON.stringify({
        description: 'Announces it.',
        inputs: { type: 'object', properties: {} },
        steps: [{ id: 'tell', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: '#releases', text: 'out' } }],
      }),
      explanation: 'Posts it.',
      missingJson: '[]',
      splitJson: '[]',
      sourcesJson: '[]',
      notesMd: '',
      testsJson: '[]',
    });
    const out = await w.app.flowChat.draft('announce a release in slack', w.alice);
    if (!('version' in out)) throw new Error('not drafted');
    const review = await w.app.flows.review(out.version.id);
    const memory = (review.generation as { memory?: { used: string[]; unreadable: number } } | null)?.memory;
    expect(memory?.used.length).toBeGreaterThan(0);
    expect(JSON.stringify(review.generation)).not.toContain('#releases');
  });
});

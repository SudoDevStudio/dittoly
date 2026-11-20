import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { normalizeTag } from '../src/marketplace/tags.js';
import { approveExampleModules, approvedReleaseFlow, makeWorld, type World } from './helpers.js';

/** Marketplace tags: popular tags as filters, and suggestions when listing something. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const moduleId = async (name: string) => (await w.app.modules.list()).find((m) => m.name === name && m.status === 'approved')!.id;

describe('marketplace tags', () => {
  it('suggests tags from what a module is: its apps, credentials, and whether it changes data', async () => {
    const slack = (await api.inject({ method: 'GET', url: `/api/marketplace/tag-suggestions?moduleVersionId=${await moduleId('slack')}`, headers: auth(w.tokens.admin) })).json();
    expect(slack.tags).toEqual(expect.arrayContaining(['slack', 'changes-data']));
    expect(slack.tags).not.toContain('no-key');
    const jira = (await api.inject({ method: 'GET', url: `/api/marketplace/tag-suggestions?moduleVersionId=${await moduleId('jira')}`, headers: auth(w.tokens.admin) })).json();
    expect(jira.tags).toEqual(expect.arrayContaining(['jira']));
  });

  it('suggests tags for a Flow template from its apps and its kinds of steps', async () => {
    const v = await approvedReleaseFlow(w);
    const r = (await api.inject({ method: 'GET', url: `/api/marketplace/tag-suggestions?flowVersionId=${v.id}`, headers: auth(w.tokens.approver) })).json();
    expect(r.tags).toEqual(expect.arrayContaining(['jira', 'gitlab', 'slack', 'approval', 'batch']));
  });

  it('counts tags in use for the filter chips, and filters listings by one', async () => {
    await w.app.marketplace.publishModule({ moduleVersionId: await moduleId('slack'), tags: ['slack', 'messaging'] }, w.admin);
    await w.app.marketplace.publishModule({ moduleVersionId: await moduleId('gitlab'), tags: ['gitlab', 'messaging'] }, w.admin);
    const tags = (await api.inject({ method: 'GET', url: '/api/marketplace/tags', headers: auth(w.tokens.bob) })).json();
    expect(tags[0]).toEqual({ tag: 'messaging', count: 2 });
    expect(tags).toEqual(expect.arrayContaining([{ tag: 'slack', count: 1 }, { tag: 'gitlab', count: 1 }]));
    const slackOnly = (await api.inject({ method: 'GET', url: '/api/marketplace?tag=slack', headers: auth(w.tokens.bob) })).json();
    expect(slackOnly.map((l: { title: string }) => l.title)).toEqual(['Slack']);
  });

  it("asks the organization's AI for tags, keeps only valid ones, and only for people who can publish", async () => {
    ai.enqueue({ tagsJson: JSON.stringify(['Release Notes', 'slack', '#Messaging', 'not a valid tag because it is far too long for a tag', '']) });
    const r = await api.inject({ method: 'POST', url: '/api/marketplace/tag-suggestions/ai', headers: auth(w.tokens.approver), payload: { title: 'Post release notes', summary: 'Posts notes to Slack.' } });
    expect(r.json()).toEqual({ tags: ['release-notes', 'slack', 'messaging', 'not-a-valid-tag-because-it-is'] });
    // It was told which tags are already in use, so it stays consistent.
    expect(ai.requests.at(-1)!.prompt).toContain('TAGS ALREADY IN USE: messaging, gitlab, slack');
    expect((await api.inject({ method: 'POST', url: '/api/marketplace/tag-suggestions/ai', headers: auth(w.tokens.bob), payload: { title: 'x' } })).json()).toEqual({ error: 'approver_only' });
  });

  it('normalizes what people type into tags', () => {
    expect(normalizeTag('#Release Notes')).toBe('release-notes');
    expect(normalizeTag('  CI/CD ')).toBe('ci-cd');
    expect(normalizeTag('---')).toBeNull();
  });
});

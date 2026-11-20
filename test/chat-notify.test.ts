import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { notify } from '../src/core/notify.js';
import type { FetchLike } from '../src/sandbox/broker.js';
import { approveExampleModules, approvedReleaseFlow, makeWorld, releaseInputs, type World } from './helpers.js';

const TEAMS_URL = 'https://acme.webhook.office.com/workflows/abc';
const BOB_CHAT = 'https://bob-chat.example.test/workflows/bob';
let bobChatStatus = 202;
const slackUsers: Record<string, string> = { 'alice@acme.test': 'U_ALICE', 'bob@acme.test': 'U_BOB' };
let calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
let slackDown = 0;

/** Fake Slack Web API and Teams Workflows webhook. */
const network: FetchLike = async (url, init) => {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  calls.push({ url, auth: new Headers(init.headers).get('authorization'), body });
  if (url === TEAMS_URL) return new Response('', { status: 202 });
  if (url === BOB_CHAT) return new Response('', { status: bobChatStatus });
  const method = url.replace('https://slack.com/api/', '');
  if (slackDown > 0) {
    slackDown--;
    return new Response('', { status: 503 });
  }
  if (method === 'users.lookupByEmail') {
    const id = slackUsers[String(body.email)];
    return Response.json(id ? { ok: true, user: { id } } : { ok: false, error: 'users_not_found' });
  }
  if (method === 'conversations.open') return Response.json({ ok: true, channel: { id: `D_${String(body.users)}` } });
  if (method === 'chat.postMessage') return Response.json({ ok: true, ts: '1.2' });
  return Response.json({ ok: false, error: 'unknown_method' });
};
const slackCalls = (m: string) => calls.filter((c) => c.url === `https://slack.com/api/${m}`);
const teamsCalls = () => calls.filter((c) => c.url === TEAMS_URL);

let w: World;
beforeAll(async () => {
  w = await makeWorld(
    { publicUrl: 'https://dittoly.acme.test', slackBotToken: 'xoxb-test-token', teamsWebhookUrl: TEAMS_URL },
    { fetchImpl: network, mailer: null },
  );
  await w.db.query(`UPDATE members SET email = handle || '@acme.test', display_name = initcap(handle)`);
});
afterAll(() => w.db.end());
beforeEach(() => {
  calls = [];
  slackDown = 0;
  bobChatStatus = 202;
});

describe('Slack and Teams notifications', () => {
  it('a run that needs the member reaches them by Slack DM and in the Teams channel: a sentence and a link, never run data', async () => {
    await approveExampleModules(w);
    await w.app.vault.put(w.alice.id, 'jira', 'alice@acme.test:secret-jira');
    const version = await approvedReleaseFlow(w);
    await w.app.worker.drain(); // admin notifications from the module reviews
    calls = [];
    // Alice lacks GitLab: the run pauses and she is notified.
    const runId = await w.app.engine.startRun(version.id, w.alice.id, { ...releaseInputs, jql: 'reporter = "jane.doe@example.com"' });
    await w.app.worker.drain();

    expect(slackCalls('users.lookupByEmail')[0]!.body).toEqual({ email: 'alice@acme.test' });
    expect(slackCalls('conversations.open')[0]!.body).toEqual({ users: 'U_ALICE' });
    const dm = slackCalls('chat.postMessage').find((c) => c.body.channel === 'D_U_ALICE')!;
    expect(dm.auth).toBe('Bearer xoxb-test-token');
    // How it ended, in one sentence without step names or data.
    expect(dm.body.text).toBe(`One of your runs paused and needs you. It paused: an app could not be reached. https://dittoly.acme.test/runs/${runId}`);

    const card = teamsCalls().find((c) => JSON.stringify(c.body).includes('For Alice'))!;
    expect(card.body).toMatchObject({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive' }] });
    expect(JSON.stringify(card.body)).toContain(`https://dittoly.acme.test/runs/${runId}`);

    const everything = JSON.stringify(calls);
    for (const s of ['jane.doe@example.com', 'acme/app', 'secret-jira', 'Release coordination']) expect(everything).not.toContain(s);
    // The Slack user ID is remembered: the next message needs no lookup.
    calls = [];
    await notify(w.db, w.alice.id, 'approval_needed', { runId });
    await w.app.worker.drain();
    expect(slackCalls('users.lookupByEmail')).toHaveLength(0);
    expect(slackCalls('chat.postMessage')).toHaveLength(1);
  });

  it('after a partial failure, a retry only resends the channel that failed', async () => {
    slackDown = 1;
    await notify(w.db, w.bob.id, 'delegation_requested');
    await w.app.worker.drain();
    expect(teamsCalls()).toHaveLength(1);
    // The job is retried later; Teams is not posted twice.
    await w.db.query(`UPDATE jobs SET locked_until = NULL`); // the lease of the failed attempt expires
    await w.app.worker.drain();
    expect(slackCalls('chat.postMessage').map((c) => c.body.channel)).toEqual(['D_U_BOB']);
    expect(teamsCalls()).toHaveLength(1);
  });

  it('members without a Slack account are skipped there and not retried; Teams still gets it', async () => {
    await notify(w.db, w.approver.id, 'approval_needed');
    await w.app.worker.drain();
    expect(slackCalls('users.lookupByEmail')).toHaveLength(1);
    expect(slackCalls('chat.postMessage')).toHaveLength(0);
    expect(teamsCalls()).toHaveLength(1);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'deliver_notification'`)).rows[0].n).toBe(0);
  });

  it('each member can turn each channel off', async () => {
    const api = buildServer(w.app);
    const auth = { authorization: `Bearer ${w.tokens.alice}` };
    const before = (await api.inject({ method: 'GET', url: '/api/me/settings', headers: auth })).json();
    expect(before).toMatchObject({ slackConfigured: true, teamsConfigured: true, emailConfigured: false, slackNotifications: true });
    expect((await api.inject({ method: 'PUT', url: '/api/me/settings', headers: auth, payload: { slackNotifications: false } })).statusCode).toBe(204);
    expect((await api.inject({ method: 'GET', url: '/api/me/settings', headers: auth })).json()).toMatchObject({ slackNotifications: false, teamsNotifications: true });
    await notify(w.db, w.alice.id, 'run_failed');
    await w.app.worker.drain();
    expect(slackCalls('chat.postMessage')).toHaveLength(0);
    expect(teamsCalls()).toHaveLength(1);
    await api.close();
  });

  it("a member's own Teams chat replaces the channel for them; the URL is stored encrypted and never shown", async () => {
    const api = buildServer(w.app);
    const auth = { authorization: `Bearer ${w.tokens.bob}` };
    expect((await api.inject({ method: 'PUT', url: '/api/me/settings', headers: auth, payload: { teamsWebhookUrl: 'http://bob-chat.example.test/x' } })).statusCode).toBe(400);
    expect((await api.inject({ method: 'PUT', url: '/api/me/settings', headers: auth, payload: { teamsWebhookUrl: BOB_CHAT } })).statusCode).toBe(204);
    const settings = (await api.inject({ method: 'GET', url: '/api/me/settings', headers: auth })).json();
    expect(settings.teamsPersonal).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('bob-chat');
    const stored = (await w.db.query(`SELECT teams_webhook_enc FROM members WHERE id = $1`, [w.bob.id])).rows[0].teams_webhook_enc;
    expect(stored).toMatch(/^v1:/);

    await notify(w.db, w.bob.id, 'run_failed');
    await w.app.worker.drain();
    const posts = calls.filter((c) => c.url === BOB_CHAT);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0]!.body)).not.toContain('For Bob'); // his own chat: no name line
    expect(teamsCalls()).toHaveLength(0); // not also in the channel

    // A deleted workflow is not retried forever.
    calls = [];
    bobChatStatus = 404;
    await notify(w.db, w.bob.id, 'run_failed');
    await w.app.worker.drain();
    expect(calls.filter((c) => c.url === BOB_CHAT)).toHaveLength(1);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'deliver_notification'`)).rows[0].n).toBe(0);

    // Removing it falls back to the channel.
    expect((await api.inject({ method: 'PUT', url: '/api/me/settings', headers: auth, payload: { teamsWebhookUrl: null } })).statusCode).toBe(204);
    calls = [];
    await notify(w.db, w.bob.id, 'run_failed');
    await w.app.worker.drain();
    expect(teamsCalls()).toHaveLength(1);
    await api.close();
  });

  it('finished runs stay in the portal only', async () => {
    await notify(w.db, w.bob.id, 'run_succeeded');
    await w.app.worker.drain();
    expect(calls).toHaveLength(0);
  });
});

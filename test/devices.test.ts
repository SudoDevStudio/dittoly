import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, type World } from './helpers.js';
import { Devices } from '../src/devices/service.js';

/** Phones paired with a QR code send commands (spoken or typed); every change waits for a yes. */
const ai = new MockProvider();
let w: World;
let api: ReturnType<typeof buildServer>;
let notifyVersion: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const write = { 'x-dittoly-request': '1' };
const cmd = (c: Record<string, unknown>) => ({ commandJson: JSON.stringify({ say: '', ...c }) });

beforeAll(async () => {
  w = await makeWorld({}, { ai });
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  const v = await w.app.flows.create(
    'Release notes',
    {
      description: 'Posts release notes to Slack.',
      inputs: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] },
      steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-rel', text: 'Release {{ inputs.release }} is out' } }],
    },
    w.alice,
  );
  notifyVersion = (await w.app.flows.decide(v.id, w.approver, 'approved')).id;
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

/** Pair a phone for alice the way the portal and the phone do it; returns the phone's cookie. */
async function pairPhone(): Promise<string> {
  const start = await api.inject({ method: 'POST', url: '/api/devices/pair', headers: auth(w.tokens.alice), payload: { origin: 'https://dittoly.example.com' } });
  expect(start.statusCode).toBe(201);
  const { url, qrSvg, reachable, voice } = start.json();
  expect(url).toMatch(/^https:\/\/dittoly\.example\.com\/m\/pair#[A-Za-z0-9_-]{32}$/);
  expect(qrSvg).toContain('<svg');
  expect({ reachable, voice }).toEqual({ reachable: true, voice: true });
  const code = url.split('#')[1];
  const paired = await api.inject({ method: 'POST', url: '/auth/device/pair', headers: write, payload: { code, name: 'Pixel 9' } });
  expect(paired.statusCode).toBe(200);
  const cookie = paired.cookies.find((c) => c.name === 'dty_device')!;
  expect(cookie).toMatchObject({ httpOnly: true, maxAge: 30 * 86400 });
  // One time only.
  expect((await api.inject({ method: 'POST', url: '/auth/device/pair', headers: write, payload: { code, name: 'Again' } })).json()).toMatchObject({ error: 'pairing_code_invalid' });
  return `dty_device=${cookie.value}`;
}

const phone = (cookie: string) => ({ cookie, ...write });

describe('phones and glasses', () => {
  it('pairs with a one-time QR code; the phone session can only use the command endpoints', async () => {
    const cookie = await pairPhone();
    expect((await api.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json()).toMatchObject({ handle: 'alice' });
    // Not the rest of the portal: no credentials, no Flow editing, no pairing more phones.
    for (const [method, url] of [['GET', '/api/me/credentials'], ['GET', '/api/flows'], ['POST', '/api/devices/pair'], ['GET', '/api/devices']] as const) {
      expect((await api.inject({ method, url, headers: phone(cookie), payload: method === 'POST' ? {} : undefined })).json()).toEqual({ error: 'device_not_allowed' });
    }
    // The portal lists it; revoking signs the phone out.
    const list = (await api.inject({ method: 'GET', url: '/api/devices', headers: auth(w.tokens.alice) })).json();
    const device = list.find((d: { name: string }) => d.name === 'Pixel 9');
    expect(device).toMatchObject({ member: 'alice' });
    expect((await api.inject({ method: 'DELETE', url: `/api/devices/${device.id}`, headers: auth(w.tokens.bob) })).statusCode).toBe(404);
    expect((await api.inject({ method: 'DELETE', url: `/api/devices/${device.id}`, headers: auth(w.tokens.alice) })).statusCode).toBe(204);
    expect((await api.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('runs a Flow by voice after the person says yes, and reports how it went', async () => {
    const cookie = await pairPhone();
    // Missing input: it asks for it instead of guessing.
    ai.enqueue(cmd({ action: 'run_flow', versionId: notifyVersion, inputs: {} }));
    let r = (await api.inject({ method: 'POST', url: '/api/m/command', headers: phone(cookie), payload: { text: 'run release notes' } })).json();
    expect(r).toEqual({ say: 'To run Release notes I need release.' });
    // What the AI saw: only Flows alice can run, and what she said, fenced as data.
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain(`versionId ${notifyVersion}: "Release notes" v1. Posts release notes to Slack.`);
    expect(prompt).toContain('<<<SAID\nrun release notes\nSAID>>>');

    ai.enqueue(cmd({ action: 'run_flow', versionId: notifyVersion, inputs: { release: '2.4' } }));
    r = (await api.inject({ method: 'POST', url: '/api/m/command', headers: phone(cookie), payload: { text: '2.4', history: [{ role: 'person', text: 'run release notes' }, { role: 'dittoly', text: r.say }] } })).json();
    expect(r.say).toBe('Run Release notes with release 2.4. Say yes to go ahead, or no.');
    expect(ai.requests.at(-1)!.prompt).toContain('PERSON: run release notes\nDITTOLY: To run Release notes I need release.');
    // Nothing has run yet.
    expect((await w.db.query(`SELECT count(*)::int AS n FROM runs`)).rows[0].n).toBe(0);

    w.fake.messages.length = 0;
    const done = (await api.inject({ method: 'POST', url: '/api/m/confirm', headers: phone(cookie), payload: { id: r.confirm.id, yes: true } })).json();
    expect(done).toMatchObject({ say: "Started. I'll tell you when it finishes.", runId: expect.any(String) });
    await w.app.worker.drain();
    expect(w.fake.messages).toEqual([expect.objectContaining({ channel: 'C-rel', text: 'Release 2.4 is out', auth: 'Bearer xoxb-alice' })]);
    const status = (await api.inject({ method: 'GET', url: `/api/m/runs/${done.runId}`, headers: { cookie } })).json();
    expect(status).toMatchObject({ say: 'Release notes finished successfully.', status: 'succeeded' });
    // A yes counts once.
    expect((await api.inject({ method: 'POST', url: '/api/m/confirm', headers: phone(cookie), payload: { id: r.confirm.id, yes: true } })).json()).toEqual({ say: 'That has expired. Please say it again.' });
  });

  it('refuses what the AI proposes outside what the person may do, and "no" changes nothing', async () => {
    const cookie = await pairPhone();
    ai.enqueue(cmd({ action: 'run_flow', versionId: '00000000-0000-0000-0000-000000000000', inputs: {}, say: 'Which Flow?' }));
    expect((await api.inject({ method: 'POST', url: '/api/m/command', headers: phone(cookie), payload: { text: 'run the secret flow' } })).json()).toEqual({ say: 'Which Flow?' });
    ai.enqueue(cmd({ action: 'decide_gate', runId: '00000000-0000-0000-0000-000000000000', stepId: 'gate', decision: 'approved' }));
    expect((await api.inject({ method: 'POST', url: '/api/m/command', headers: phone(cookie), payload: { text: 'approve everything' } })).json()).toEqual({ say: 'Which sign-off do you mean?' });

    const runs = async () => (await w.db.query(`SELECT count(*)::int AS n FROM runs`)).rows[0].n as number;
    const before = await runs();
    ai.enqueue(cmd({ action: 'run_flow', versionId: notifyVersion, inputs: { release: '3.0' } }));
    const r = (await api.inject({ method: 'POST', url: '/api/m/command', headers: phone(cookie), payload: { text: 'release notes for 3.0' } })).json();
    expect((await api.inject({ method: 'POST', url: '/api/m/confirm', headers: phone(cookie), payload: { id: r.confirm.id, yes: false } })).json()).toEqual({ say: 'OK, cancelled. Nothing was changed.' });
    expect(await runs()).toBe(before);
    // Another phone cannot confirm it.
    ai.enqueue(cmd({ action: 'run_flow', versionId: notifyVersion, inputs: { release: '3.1' } }));
    const again = (await api.inject({ method: 'POST', url: '/api/m/command', headers: phone(cookie), payload: { text: 'release notes for 3.1' } })).json();
    const other = await pairPhone();
    expect((await api.inject({ method: 'POST', url: '/api/m/confirm', headers: phone(other), payload: { id: again.confirm.id, yes: true } })).json()).toEqual({ say: 'That has expired. Please say it again.' });
    // The normal portal session is not a phone.
    expect((await api.inject({ method: 'POST', url: '/api/m/command', headers: auth(w.tokens.alice), payload: { text: 'hi' } })).json()).toEqual({ error: 'device_only' });
  });

  it('reads out what is waiting and approves a sign-off after a yes', async () => {
    // Bob runs the release Flow, which has a sign-off; the approver answers it from their phone.
    await giveAllCredentials(w, w.bob);
    const release = await approvedReleaseFlow(w);
    const runId = await w.app.engine.startRun(release.id, w.bob.id, { release: '2.4', jql: 'x', project: 'acme/app', channel: 'C-r' });
    await w.app.worker.drain();
    // Pair a phone for the approver.
    const start = (await api.inject({ method: 'POST', url: '/api/devices/pair', headers: auth(w.tokens.approver), payload: {} })).json();
    expect(start.reachable).toBe(false); // the default public URL is 127.0.0.1: a phone cannot open it
    const paired = await api.inject({ method: 'POST', url: '/auth/device/pair', headers: write, payload: { code: start.url.split('#')[1], name: 'iPhone' } });
    const cookie = `dty_device=${paired.cookies.find((c) => c.name === 'dty_device')!.value}`;

    const inbox = (await api.inject({ method: 'GET', url: '/api/m/inbox', headers: { cookie } })).json();
    expect(inbox.say).toMatch(/^Waiting for you: 1 sign-off: Release coordination: /);
    ai.enqueue(cmd({ action: 'decide_gate', runId, stepId: 'signoff', decision: 'approved' }));
    const r = (await api.inject({ method: 'POST', url: '/api/m/command', headers: phone(cookie), payload: { text: 'approve the release' } })).json();
    expect(r.say).toMatch(/^Approve the sign-off "Release coordination: .*". Say yes to go ahead, or no\.$/);
    const done = (await api.inject({ method: 'POST', url: '/api/m/confirm', headers: phone(cookie), payload: { id: r.confirm.id, yes: true } })).json();
    expect(done).toMatchObject({ say: 'Approved. The run continues.', runId });
    await w.app.worker.drain();
    expect((await w.app.engine.runView(runId, w.bob)).status).toBe('succeeded');
  });
});

describe('pairing from a portal open on localhost', () => {
  it('uses the server\'s network address when it has one (npm start -- --host=0.0.0.0), so the phone can open the code', async () => {
    const onNetwork = new Devices(w.db, 'http://192.168.1.20:8080');
    const p = await onNetwork.startPairing(w.alice, 'http://localhost:8080');
    expect(p.url.startsWith('http://192.168.1.20:8080/m/pair#')).toBe(true);
    expect(p.reachable).toBe(true);
    // Opened by its network address already: that one is kept.
    expect((await onNetwork.startPairing(w.alice, 'https://dittoly.acme.example')).url.startsWith('https://dittoly.acme.example/m/pair#')).toBe(true);
    // Only on this computer: nothing better to offer, and the card says how to fix it.
    const onlyHere = new Devices(w.db, 'http://127.0.0.1:8080');
    expect((await onlyHere.startPairing(w.alice, 'http://localhost:8080')).reachable).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mailer } from '../src/core/delivery.js';
import { approveExampleModules, approvedReleaseFlow, giveAllCredentials, makeWorld, releaseInputs, type World } from './helpers.js';

const sent: { to: string; subject: string; text: string }[] = [];
let failNext = 0;
const mailer: Mailer = {
  async send(msg) {
    if (failNext > 0) {
      failNext--;
      throw Object.assign(new Error('smtp down'), { code: 'ECONNREFUSED' });
    }
    sent.push(msg);
  },
};

let w: World;
let versionId: string;
beforeAll(async () => {
  w = await makeWorld({ publicUrl: 'https://dittoly.acme.test' }, { mailer });
  await approveExampleModules(w);
  versionId = (await approvedReleaseFlow(w)).id;
  await w.db.query(`UPDATE members SET email = handle || '@acme.test'`);
});
afterAll(async () => w.db.end());

describe('email notifications', () => {
  it('emails the member a link, never run data', async () => {
    sent.length = 0;
    // Alice has no GitLab credential: the run pauses and she is notified.
    await w.app.vault.put(w.alice.id, 'jira', 'alice@acme.test:secret-jira');
    const runId = await w.app.engine.startRun(versionId, w.alice.id, { ...releaseInputs, jql: 'reporter = "jane.doe@example.com"' });
    await w.app.worker.drain();
    const mail = sent.find((m) => m.to === 'alice@acme.test')!;
    // How it ended, without step names or data.
    expect(mail.subject).toBe('Dittoly: One of your runs paused and needs you. It paused: a credential it needs is not stored.');
    expect(mail.text).toContain(`https://dittoly.acme.test/runs/${runId}`);
    for (const s of ['jane.doe@example.com', 'acme/app', 'secret-jira', 'Release coordination']) expect(mail.text + mail.subject).not.toContain(s);
  });

  it('delegation requests reach the teammate, with a link to the request', async () => {
    sent.length = 0;
    const runId = (await w.db.query(`SELECT id FROM runs ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
    // Alice has Jira but no GitLab access, so the run paused at the GitLab step.
    const id = await w.app.engine.requestDelegation(runId, 'mrs', w.alice, w.bob.id);
    await w.app.worker.drain();
    expect(sent).toEqual([expect.objectContaining({ to: 'bob@acme.test', text: expect.stringContaining(`/delegations/${id}`) })]);
  });

  it('respects the member opt-out, members without an email, and portal-only kinds', async () => {
    sent.length = 0;
    await w.db.query(`UPDATE members SET notify_email = false WHERE id = $1`, [w.alice.id]);
    await w.db.query(`UPDATE members SET email = NULL WHERE id = $1`, [w.bob.id]);
    await giveAllCredentials(w, w.approver);
    await w.db.query(`UPDATE members SET notify_email = false WHERE id = $1`, [w.approver.id]);
    const { notify } = await import('../src/core/notify.js');
    await notify(w.db, w.alice.id, 'run_paused', {});
    await notify(w.db, w.bob.id, 'run_paused', {});
    await notify(w.db, w.admin.id, 'run_succeeded', {});
    await w.app.worker.drain();
    expect(sent).toEqual([]);
  });

  it('retries a failed send and emails exactly once', async () => {
    sent.length = 0;
    failNext = 1;
    const { notify } = await import('../src/core/notify.js');
    await notify(w.db, w.admin.id, 'module_review_needed', {});
    await w.app.worker.drain();
    expect(sent).toEqual([]);
    await w.db.query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE kind = 'deliver_notification'`);
    await w.app.worker.drain();
    await w.app.worker.drain();
    expect(sent.map((m) => m.to)).toEqual(['admin@acme.test']);
  });

  it('without SMTP configured, notifications stay in the portal only', async () => {
    const w2 = await makeWorld({}, { mailer: null });
    const { notify } = await import('../src/core/notify.js');
    await w2.db.query(`UPDATE members SET email = 'x@acme.test'`);
    await notify(w2.db, w2.alice.id, 'run_paused', {});
    await w2.app.worker.drain();
    expect((await w2.db.query(`SELECT emailed_at FROM notifications`)).rows[0].emailed_at).toBeNull();
    await w2.db.end();
  });
});

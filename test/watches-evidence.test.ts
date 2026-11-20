import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { sendDailyAnchors } from '../src/governance/evidence.js';
import type { FetchLike } from '../src/sandbox/broker.js';
import { EgressDeniedError } from '../src/runtime/egress.js';
import { ImapSource, type Email, type MailSource } from '../src/watches/imap.js';
import { approveExampleModules, giveAllCredentials, makeWorld, type World } from './helpers.js';

/** Watches (new app items, emails, files start a Flow) and audit evidence (controls, daily hash sent elsewhere). */
let w: World;
let api: ReturnType<typeof buildServer>;
let notifyVersion: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** A mailbox the email watch reads. */
const mailbox = { uidValidity: '1', messages: [] as Email[] };
const mail: MailSource = {
  async read(_cfg, password, afterUid, max) {
    if (password !== 'mail-password') throw new Error('auth_failed');
    const uidNext = (mailbox.messages.at(-1)?.uid ?? 0) + 1;
    const messages = afterUid === null ? [] : mailbox.messages.filter((m) => m.uid > afterUid).slice(0, max);
    return { uidValidity: mailbox.uidValidity, uidNext, messages };
  },
};
const email = (uid: number, subject: string, from = 'Client <client@example.com>'): Email => ({ uid, from, to: 'support@acme.test', subject, date: new Date().toISOString(), messageId: `<${uid}@example.com>`, text: `Body of ${subject}` });

/** A bucket, and what the S3 fake saw. */
const bucket: { key: string; body: string; etag: string }[] = [];
const s3Seen: { url: string; auth: string | null }[] = [];
let s3Fail: number | null = null;
const anchorPosts: { body: string; signature: string | null }[] = [];

beforeAll(async () => {
  const fakes: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    if (u.host === 'drops.s3.eu-central-1.amazonaws.com') {
      s3Seen.push({ url, auth: headers.get('authorization') });
      if (s3Fail) return new Response(`<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>`, { status: s3Fail });
      if (u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const items = bucket.filter((o) => o.key.startsWith(prefix));
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${items
          .map((o) => `<Contents><Key>${o.key.replace(/&/g, '&amp;')}</Key><LastModified>2026-10-15T09:00:00.000Z</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size></Contents>`)
          .join('')}</ListBucketResult>`;
        return new Response(xml, { headers: { 'content-type': 'application/xml' } });
      }
      const key = decodeURIComponent(u.pathname.slice(1));
      const o = bucket.find((x) => x.key === key);
      return o ? new Response(o.body) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    }
    if (u.host === 'anchor.example.com') {
      anchorPosts.push({ body: String(init.body), signature: headers.get('x-dittoly-signature') });
      return new Response('{}', { status: 200 });
    }
    return w.fake.fetch(url, init);
  };
  w = await makeWorld({}, { fetchImpl: fakes, mail, mailer: { send: async () => { throw new Error('smtp_down'); } } });
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
  const v = await w.app.flows.create(
    'Tell the channel',
    {
      inputs: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      steps: [{ id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C-watch', text: '{{ inputs.text }}' } }],
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

const later = (min: number) => new Date(Date.now() + min * 60_000);
const posted = () => w.fake.messages.filter((m) => m.channel === 'C-watch').map((m) => m.text);

describe('app watches', () => {
  it('remembers what is there on the first look, then starts one run per new item, with the owner\'s access', async () => {
    const r = await api.inject({
      method: 'POST',
      url: '/api/watches',
      headers: auth(w.tokens.alice),
      payload: { kind: 'app', name: 'New MRs', flowVersionId: notifyVersion, module: 'gitlab@1.0.0', action: 'list_merge_requests', actionInput: { project: 'acme/app' }, itemsPath: 'mergeRequests', keyField: 'iid', inputs: { text: 'New MR !{{ item.iid }}: {{ item.title }}' }, intervalSeconds: 60 },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ kind: 'app', primed: false, flow: 'Tell the channel v1' });
    expect(await w.app.watches.tick(later(1))).toBe(0); // first look
    w.fake.mrs.push({ iid: 9, title: 'Add search', detailed_merge_status: 'mergeable', state: 'opened' });
    expect(await w.app.watches.tick(later(3))).toBe(1);
    await w.app.worker.drain();
    expect(posted()).toEqual(['New MR !9: Add search']);
    expect(w.fake.calls.filter((c) => c.url.includes('gitlab.com')).at(-1)!.auth).toBe('glpat-alice');
    expect(await w.app.watches.tick(later(5))).toBe(0); // nothing new
    const run = (await w.db.query(`SELECT watch_id FROM runs ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(run.watch_id).toBe(r.json().id);
  });

  it('only watches actions that only read', async () => {
    const r = await api.inject({
      method: 'POST',
      url: '/api/watches',
      headers: auth(w.tokens.alice),
      payload: { kind: 'app', name: 'x', flowVersionId: notifyVersion, module: 'gitlab@1.0.0', action: 'merge_merge_request', actionInput: { project: 'a/b', iid: 1 }, keyField: 'iid', inputs: { text: 'x' } },
    });
    expect(r.json().error).toBe('watch_needs_read_action');
    const bad = await api.inject({ method: 'POST', url: '/api/watches', headers: auth(w.tokens.alice), payload: { kind: 'app', name: 'x', flowVersionId: notifyVersion, module: 'gitlab@1.0.0', action: 'list_merge_requests', actionInput: { project: 'a/b' }, keyField: 'iid', inputs: { nope: 'x' } } });
    expect(bad.json()).toMatchObject({ error: 'invalid_inputs', detail: 'not inputs of this Flow: nope' });
  });
});

describe('email watches', () => {
  it('starts a run for each new matching email, read-only, and never shows the password', async () => {
    mailbox.messages = [email(1, 'Old ticket')];
    const r = await api.inject({
      method: 'POST',
      url: '/api/watches',
      headers: auth(w.tokens.alice),
      payload: { kind: 'email', name: 'Support inbox', flowVersionId: notifyVersion, host: 'imap.example.com', user: 'support@acme.test', password: 'mail-password', subjectContains: 'urgent', inputs: { text: 'Email from {{ email.from }}: {{ email.subject }}' }, intervalSeconds: 60 },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(JSON.stringify(r.json())).not.toContain('mail-password');
    const id = r.json().id;
    await api.inject({ method: 'POST', url: `/api/watches/${id}/check`, headers: auth(w.tokens.alice) }); // first look
    mailbox.messages.push(email(2, 'URGENT: site down'), email(3, 'Newsletter'));
    const after = (await api.inject({ method: 'POST', url: `/api/watches/${id}/check`, headers: auth(w.tokens.alice) })).json();
    expect(after.runsStarted).toBe(1);
    await w.app.worker.drain();
    expect(posted().at(-1)).toBe('Email from Client <client@example.com>: URGENT: site down');
    // The mailbox was rebuilt (new UIDVALIDITY): start from there, without re-running old mail.
    mailbox.uidValidity = '2';
    mailbox.messages = [email(1, 'urgent but old')];
    expect((await api.inject({ method: 'POST', url: `/api/watches/${id}/check`, headers: auth(w.tokens.alice) })).json().runsStarted).toBe(1);
    mailbox.messages.push(email(2, 'urgent again'));
    expect((await api.inject({ method: 'POST', url: `/api/watches/${id}/check`, headers: auth(w.tokens.alice) })).json().runsStarted).toBe(2);
  });

  it('connects only to addresses the egress rules allow', async () => {
    const src = new ImapSource({ internalHosts: [], loopbackHosts: [] });
    await expect(src.read({ host: '127.0.0.1', port: 993, secure: true, user: 'x', mailbox: 'INBOX' }, 'p', null, 1)).rejects.toBeInstanceOf(EgressDeniedError);
  });
});

describe('file watches (S3-compatible)', () => {
  it('starts a run per new file, with small text files read, every request signed', async () => {
    bucket.push({ key: 'in/old.csv', body: 'a,b', etag: 'e1' });
    const r = await api.inject({
      method: 'POST',
      url: '/api/watches',
      headers: auth(w.tokens.alice),
      payload: { kind: 'files', name: 'Drops', flowVersionId: notifyVersion, endpoint: 'https://s3.eu-central-1.amazonaws.com', region: 'eu-central-1', bucket: 'drops', prefix: 'in/', accessKeyId: 'AKIATEST', secretAccessKey: 'secret-key-for-tests', includeText: true, inputs: { text: 'New file {{ file.key }} ({{ file.size }} bytes): {{ file.text }}' } },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    await api.inject({ method: 'POST', url: `/api/watches/${id}/check`, headers: auth(w.tokens.alice) });
    bucket.push({ key: 'in/new & fresh.csv', body: 'x,y\n1,2', etag: 'e2' });
    expect((await api.inject({ method: 'POST', url: `/api/watches/${id}/check`, headers: auth(w.tokens.alice) })).json().runsStarted).toBe(1);
    await w.app.worker.drain();
    expect(posted().at(-1)).toBe('New file in/new & fresh.csv (7 bytes): x,y\n1,2');
    expect(s3Seen.every((s) => /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(s.auth ?? ''))).toBe(true);
    expect(s3Seen.some((s) => s.url.endsWith('/in/new%20%26%20fresh.csv'))).toBe(true);
  });

  it('records a failing look and tells the owner once', async () => {
    const watch = (await api.inject({ method: 'GET', url: '/api/watches', headers: auth(w.tokens.alice) })).json().find((x: { name: string }) => x.name === 'Drops');
    s3Fail = 403;
    await api.inject({ method: 'POST', url: `/api/watches/${watch.id}/check`, headers: auth(w.tokens.alice) });
    const after = (await api.inject({ method: 'POST', url: `/api/watches/${watch.id}/check`, headers: auth(w.tokens.alice) })).json();
    expect(after.lastError).toBe('s3_AccessDenied');
    expect((await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'watch_failed' AND member_id = $1`, [w.alice.id])).rows[0].n).toBe(1);
    s3Fail = null;
    expect((await api.inject({ method: 'POST', url: `/api/watches/${watch.id}/check`, headers: auth(w.tokens.alice) })).json().lastError).toBeNull();
    // Others cannot see or change it.
    expect((await api.inject({ method: 'DELETE', url: `/api/watches/${watch.id}`, headers: auth(w.tokens.bob) })).statusCode).toBe(403);
  });
});

describe('audit evidence', () => {
  it('maps report lines to SOC 2 and ISO 27001 controls', async () => {
    const r = (await api.inject({ method: 'GET', url: '/api/admin/audit-report', headers: auth(w.tokens.admin) })).json();
    expect(r.rows.find((x: { section: string }) => x.section === 'approval').controls).toEqual(['SOC 2 CC8.1', 'SOC 2 CC6.3', 'ISO/IEC 27001:2022 A.8.32', 'ISO/IEC 27001:2022 A.5.3']);
    expect(r.rows.find((x: { section: string; detail: string }) => x.section === 'run' && x.detail.includes('via watch'))).toBeTruthy();
    expect(r.controls.find((c: { id: string }) => c.id === 'CC8.1').lines).toBeGreaterThan(0);
    expect(r.chainControls).toContain('ISO/IEC 27001:2022 A.8.15');
    const csv = (await api.inject({ method: 'GET', url: '/api/admin/audit-report?format=csv', headers: auth(w.tokens.admin) })).body;
    expect(csv).toContain('section,at,who,what,subject,detail,flag,controls');
    expect(csv).toContain('not a claim of compliance');
  });

  it('sends the chain head to a webhook once a day, signed; a failing email is retried and admins told once', async () => {
    const hook = await api.inject({ method: 'POST', url: '/api/admin/audit-anchors', headers: auth(w.tokens.admin), payload: { kind: 'webhook', target: 'https://anchor.example.com/dittoly' } });
    expect(hook.statusCode, hook.body).toBe(201);
    const key = hook.json().signingKey as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect((await api.inject({ method: 'POST', url: '/api/admin/audit-anchors', headers: auth(w.tokens.admin), payload: { kind: 'webhook', target: 'http://anchor.example.com/x' } })).json().error).toBe('webhook_must_be_https');
    await api.inject({ method: 'POST', url: '/api/admin/audit-anchors', headers: auth(w.tokens.admin), payload: { kind: 'email', target: 'auditor@acme.test' } });
    expect((await api.inject({ method: 'POST', url: '/api/admin/audit-anchors', headers: auth(w.tokens.approver), payload: { kind: 'email', target: 'x@acme.test' } })).json().error).toBe('admin_only');

    const day = new Date('2026-10-15T08:00:00Z');
    expect(await sendDailyAnchors(w.app.evidence, day)).toBe(1); // the webhook; the email fails
    const sent = anchorPosts.at(-1)!;
    expect(sent.signature).toBe(`sha256=${createHmac('sha256', key).update(sent.body).digest('hex')}`);
    expect(JSON.parse(sent.body)).toMatchObject({ server: 'http://127.0.0.1:8080', day: '2026-10-15', chainIntact: true });
    expect(await sendDailyAnchors(w.app.evidence, day)).toBe(0); // webhook done for today; email still failing
    expect(anchorPosts.length).toBe(1);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'audit_anchor_failed'`)).rows[0].n).toBe(1);
    const list = (await api.inject({ method: 'GET', url: '/api/admin/audit-anchors', headers: auth(w.tokens.admin) })).json();
    expect(list.map((a: { kind: string; lastOk: boolean }) => [a.kind, a.lastOk])).toEqual([['webhook', true], ['email', false]]);
  });
});

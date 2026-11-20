import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { Cipher } from '../src/core/crypto.js';
import { rotateMasterKey } from '../src/core/rekey.js';
import { createTeam } from '../src/core/teams.js';
import { sealAudit } from '../src/governance/audit-chain.js';
import { eventsFromExport, pumpStreams, verifyStreamed, type StreamEvent } from '../src/governance/audit-stream.js';
import { makeWorld, type World } from './helpers.js';

/** Audit streaming: sealed audit events go, in order and verifiable, to Splunk, Datadog, HTTPS, OTLP and syslog. */
interface Sent { url: string; headers: Record<string, string>; body: Buffer }
const sent: Sent[] = [];
let status = 200;
const recorder = async (url: string, init: RequestInit): Promise<Response> => {
  const raw = init.body;
  sent.push({ url, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw as Uint8Array) });
  return new Response(status === 200 ? '{}' : 'nope', { status });
};

let w: World;
let api: ReturnType<typeof buildServer>;
let tls: TlsServer | null = null;
let tlsPort = 0;
let cert = '';
const frames: string[] = [];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const add = (payload: Record<string, unknown>, token = w.tokens.admin) => api.inject({ method: 'POST', url: '/api/admin/audit-streams', headers: auth(token), payload });
const pump = () => pumpStreams(w.app.streams);
const forceDue = () => w.db.query(`UPDATE audit_streams SET next_attempt_at = NULL`);
const remove = async (id: string) => expect((await api.inject({ method: 'DELETE', url: `/api/admin/audit-streams/${id}`, headers: auth(w.tokens.admin) })).statusCode).toBe(204);

beforeAll(async () => {
  // A syslog-over-TLS receiver with a certificate for localhost, when openssl is here.
  const dir = mkdtempSync(path.join(tmpdir(), 'dty-syslog-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    cert = readFileSync(path.join(dir, 'c.pem'), 'utf8');
    tls = createTlsServer({ key: readFileSync(path.join(dir, 'k.pem')), cert }, (socket) => {
      let buf = '';
      socket.on('data', (d) => (buf += d.toString()));
      socket.on('end', () => frames.push(buf));
    });
    tls.listen(0, '127.0.0.1');
    await once(tls, 'listening');
    tlsPort = (tls.address() as AddressInfo).port;
  } catch {
    tls = null;
  }
  w = await makeWorld({ insecureHttpHosts: tlsPort ? [`localhost:${tlsPort}`] : [] }, { fetchImpl: recorder, ...(cert ? { tlsCa: cert } : {}) });
  api = buildServer(w.app);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
  tls?.close();
});
beforeEach(() => {
  sent.length = 0;
  status = 200;
});

describe('setting up', () => {
  it('only admins add streams; destinations must be HTTPS; the secret is never shown back', async () => {
    expect((await add({ kind: 'splunk', name: 'S', url: 'https://splunk.acme.test:8088', token: 't' }, w.tokens.alice)).statusCode).toBe(403);
    expect((await add({ kind: 'splunk', name: 'S', url: 'http://splunk.acme.test:8088', token: 't' })).json()).toMatchObject({ error: 'stream_must_be_https' });
    expect((await add({ kind: 'https', name: 'H', url: 'https://c.acme.test/in', headerName: 'X-Key' })).json()).toMatchObject({ error: 'header_incomplete' });
    const r = await add({ kind: 'splunk', name: 'Splunk', url: 'https://splunk.acme.test:8088', token: 'hec-token-123' });
    expect(r.statusCode, r.body).toBe(201);
    const list = (await api.inject({ method: 'GET', url: '/api/admin/audit-streams', headers: auth(w.tokens.admin) })).body;
    expect(list).toContain('https://splunk.acme.test:8088');
    expect(list).not.toContain('hec-token-123');
    expect(JSON.stringify((await w.db.query(`SELECT secret_enc FROM audit_streams`)).rows)).not.toContain('hec-token-123');
    await remove(r.json().id);
  });
});

describe('Splunk', () => {
  it('sends every sealed event once, in order, with names and the chain hash; a copy checks out on its own', async () => {
    const id = (await add({ kind: 'splunk', name: 'Splunk', url: 'https://splunk.acme.test:8088', token: 'hec', index: 'security', startFrom: 'all' })).json().id;
    await createTeam(w.db, w.admin, 'Payments');
    await sealAudit(w.db, 0);
    expect(await pump()).toBeGreaterThan(2);
    expect(sent[0]!.url).toBe('https://splunk.acme.test:8088/services/collector/event');
    expect(sent[0]!.headers.authorization).toBe('Splunk hec');
    const lines = sent.flatMap((s) => s.body.toString().split('\n')).map((l) => JSON.parse(l) as { time: number; index: string; sourcetype: string; event: StreamEvent });
    expect(lines[0]).toMatchObject({ index: 'security', sourcetype: 'dittoly:audit' });
    const team = lines.find((l) => l.event.action.startsWith('team.') && l.event.subject.name === 'Payments');
    expect(team?.event).toMatchObject({ actor: { name: 'admin' }, subject: { type: 'team', name: 'Payments' } });
    expect(team?.event.summary).toContain('admin team.');
    const events = lines.map((l) => l.event);
    expect(verifyStreamed(events)).toMatchObject({ ok: true, checked: events.length });
    // Nothing new: nothing sent.
    sent.length = 0;
    expect(await pump()).toBe(0);
    expect(sent).toHaveLength(0);
    // A changed or missing event is noticed.
    const changed = events.map((e) => (e === team!.event ? { ...e, subject: { ...e.subject, id: 'someone-else' } } : e));
    expect(verifyStreamed(changed).problems.join(' ')).toContain('do not match its hash');
    expect(verifyStreamed(events.filter((e) => e !== events[1])).problems.join(' ')).toContain('does not follow');
    // Exports in Splunk's and Datadog's shapes are read back, repeats dropped; the command line tool says the same.
    const splunkExport = lines.map((l) => JSON.stringify({ result: { _raw: JSON.stringify(l.event) } })).join('\n');
    expect(verifyStreamed(eventsFromExport(splunkExport))).toMatchObject({ ok: true, checked: events.length });
    const ddExport = JSON.stringify([...events, events[0]].map((e) => ({ attributes: { dittoly: e } })));
    expect(verifyStreamed(eventsFromExport(ddExport))).toMatchObject({ ok: true, checked: events.length });
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dty-export-')), 'export.ndjson');
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/verify-audit-export.ts', file], { encoding: 'utf8' });
    expect(out).toContain('The chain is intact.');
    await remove(id);
  });

  it('when the SIEM is down nothing is lost: it waits longer each time, admins are told once, and it catches up', async () => {
    const id = (await add({ kind: 'splunk', name: 'Splunk', url: 'https://splunk.acme.test:8088', token: 'hec' })).json().id;
    status = 503;
    await createTeam(w.db, w.admin, 'Risk');
    await sealAudit(w.db, 0);
    expect(await pump()).toBe(0);
    let row = (await w.db.query(`SELECT last_error, failures, next_attempt_at > now() AS waiting FROM audit_streams WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ last_error: 'http_503', failures: 1, waiting: true });
    // Backing off: not tried again yet.
    sent.length = 0;
    await pump();
    expect(sent).toHaveLength(0);
    await forceDue();
    await pump();
    const told = (await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'audit_stream_failed' AND member_id = $1`, [w.admin.id])).rows[0].n;
    expect(told).toBe(1);
    // Back up: everything missed arrives.
    status = 200;
    await forceDue();
    expect(await pump()).toBeGreaterThan(0);
    const events = sent.flatMap((s) => s.body.toString().split('\n')).map((l) => (JSON.parse(l) as { event: StreamEvent }).event);
    expect(events.some((e) => e.subject.name === 'Risk')).toBe(true);
    row = (await w.db.query(`SELECT last_error, failures, failing_since FROM audit_streams WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ last_error: null, failures: 0, failing_since: null });
    const actions = (await w.db.query(`SELECT action FROM audit_events WHERE subject_id = $1 ORDER BY id`, [id])).rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(['audit.stream_added', 'audit.stream_failed', 'audit.stream_recovered']);
    await remove(id);
  });

  it('a paused stream sends nothing until resumed', async () => {
    const id = (await add({ kind: 'splunk', name: 'Splunk', url: 'https://splunk.acme.test:8088', token: 'hec' })).json().id;
    expect((await api.inject({ method: 'PATCH', url: `/api/admin/audit-streams/${id}`, headers: auth(w.tokens.admin), payload: { enabled: false } })).statusCode).toBe(204);
    await createTeam(w.db, w.admin, 'Paused');
    await sealAudit(w.db, 0);
    await pump();
    expect(sent).toHaveLength(0);
    await api.inject({ method: 'PATCH', url: `/api/admin/audit-streams/${id}`, headers: auth(w.tokens.admin), payload: { enabled: true } });
    expect(await pump()).toBeGreaterThan(0);
    await remove(id);
  });
});

describe('other destinations', () => {
  it('Datadog: the site\'s intake, the API key, compressed logs with status and tags', async () => {
    const id = (await add({ kind: 'datadog', name: 'DD', site: 'datadoghq.eu', apiKey: 'dd-key', tags: 'env:prod' })).json().id;
    await createTeam(w.db, w.admin, 'Datadog team');
    await sealAudit(w.db, 0);
    await pump();
    expect(sent[0]!.url).toBe('https://http-intake.logs.datadoghq.eu/api/v2/logs');
    expect(sent[0]!.headers).toMatchObject({ 'dd-api-key': 'dd-key', 'content-encoding': 'gzip' });
    const logs = JSON.parse(gunzipSync(sent[0]!.body).toString()) as { ddsource: string; ddtags: string; status: string; message: string; timestamp?: number; dittoly: StreamEvent }[];
    const team = logs.find((l) => l.dittoly.subject.name === 'Datadog team')!;
    expect(team).toMatchObject({ ddsource: 'dittoly', status: 'info' });
    expect(team.ddtags).toContain('env:prod');
    expect(team.ddtags).toContain('outcome:ok');
    expect(team.timestamp).toBeGreaterThan(Date.now() - 60_000);
    await remove(id);
  });

  it('HTTPS: JSON lines signed with a key shown once, plus an optional auth header', async () => {
    const r = (await add({ kind: 'https', name: 'Collector', url: 'https://collector.acme.test/audit', headerName: 'Authorization', headerValue: 'Bearer abc' })).json();
    expect(r.signingKey).toMatch(/.{20,}/);
    await createTeam(w.db, w.admin, 'Signed');
    await sealAudit(w.db, 0);
    await pump();
    const s = sent[0]!;
    expect(s.headers['x-dittoly-signature']).toBe(`sha256=${createHmac('sha256', r.signingKey).update(s.body).digest('hex')}`);
    expect(s.headers.authorization).toBe('Bearer abc');
    expect(s.headers['content-type']).toBe('application/x-ndjson');
    const events = s.body.toString().trim().split('\n').map((l) => JSON.parse(l) as StreamEvent);
    expect(s.headers['x-dittoly-last-event']).toBe(events[events.length - 1]!.id);
    await remove(r.id);
  });

  it('OpenTelemetry: OTLP/HTTP JSON at /v1/logs with severities and attributes', async () => {
    const id = (await add({ kind: 'otlp', name: 'OTel', url: 'https://otel.acme.test:4318', headerName: 'X-Api-Key', headerValue: 'k' })).json().id;
    await createTeam(w.db, w.admin, 'Otel team');
    await sealAudit(w.db, 0);
    await pump();
    expect(sent[0]!.url).toBe('https://otel.acme.test:4318/v1/logs');
    expect(sent[0]!.headers['x-api-key']).toBe('k');
    const body = JSON.parse(gunzipSync(sent[0]!.body).toString());
    expect(body.resourceLogs[0].resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'dittoly' } });
    const recs = body.resourceLogs[0].scopeLogs[0].logRecords as { timeUnixNano: string; severityNumber: number; attributes: { key: string; value: { stringValue: string } }[] }[];
    const rec = recs.find((x) => x.attributes.some((a) => a.key === 'dittoly.subject.name' && a.value.stringValue === 'Otel team'))!;
    expect(rec.severityNumber).toBe(9);
    expect(rec.timeUnixNano).toMatch(/^\d{19}$/);
    await remove(id);
  });

  it('syslog over TLS: RFC 5424 lines, octet-counted, to a server with a trusted certificate', async () => {
    if (!tls) return; // no openssl here
    const id = (await add({ kind: 'syslog', name: 'Syslog', host: 'localhost', port: tlsPort })).json().id;
    await createTeam(w.db, w.admin, 'Syslog team');
    await sealAudit(w.db, 0);
    expect(await pump()).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    const raw = frames.join('');
    const msgs: string[] = [];
    for (let rest = raw; rest.length; ) {
      const sp = rest.indexOf(' ');
      const len = Number(rest.slice(0, sp));
      msgs.push(Buffer.from(rest.slice(sp + 1)).subarray(0, len).toString());
      rest = Buffer.from(rest.slice(sp + 1)).subarray(len).toString();
    }
    const team = msgs.find((m) => m.includes('Syslog team'))!;
    expect(team).toMatch(/^<110>1 \d{4}-\d\d-\d\dT[\d:.]+Z 127\.0\.0\.1 dittoly - team\.\S+ - \{/);
    expect(JSON.parse(team.slice(team.indexOf('{'))).subject.name).toBe('Syslog team');
    await remove(id);
  });

  it('syslog tries each allowed address: a name whose IPv6 address does not answer still gets through on IPv4', async () => {
    if (!tls) return; // no openssl here
    // As on hosts where localhost is ::1 first: the receiver only listens on 127.0.0.1.
    const streams = { ...w.app.streams, resolve: async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }] };
    const id = (await add({ kind: 'syslog', name: 'Dual stack', host: 'localhost', port: tlsPort })).json().id;
    await createTeam(w.db, w.admin, 'Dual stack team');
    await sealAudit(w.db, 0);
    frames.length = 0;
    expect(await pumpStreams(streams)).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.join('')).toContain('Dual stack team');
    await remove(id);
  });

  it('a syslog host that is not allowed is refused, and the test button reports it', async () => {
    const id = (await add({ kind: 'syslog', name: 'Internal', host: '10.1.2.3', port: 6514 })).json().id;
    const r = await api.inject({ method: 'POST', url: `/api/admin/audit-streams/${id}/test`, headers: auth(w.tokens.admin) });
    expect(r.json()).toEqual({ ok: false, error: 'address_not_allowed' });
    await remove(id);
  });
});

describe('key rotation', () => {
  it('stream secrets are re-encrypted with the new master key', async () => {
    const id = (await add({ kind: 'splunk', name: 'Splunk', url: 'https://splunk.acme.test:8088', token: 'rotated-token' })).json().id;
    const current = (w.app.cipher as unknown as { key: Buffer }).key;
    const newKey = randomBytes(32);
    await rotateMasterKey(w.db, current, newKey);
    const enc = (await w.db.query(`SELECT secret_enc FROM audit_streams WHERE id = $1`, [id])).rows[0].secret_enc;
    expect(JSON.parse(new Cipher(newKey).decrypt(enc, `audit-stream:${id}`))).toEqual({ token: 'rotated-token' });
  });
});

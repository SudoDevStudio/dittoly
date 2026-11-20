import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildApp, type App, type AppOverrides } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createMember, type Member, type Role } from '../src/core/members.js';
import { setLogSink } from '../src/core/log.js';
import { createDb, migrate, type Db } from '../src/db/db.js';
import type { FetchLike } from '../src/sandbox/broker.js';
import { ProcessRunner } from '../src/sandbox/runner.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/dittoly_test';

export const logLines: string[] = [];
setLogSink((line) => logLines.push(line));

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    mode: 'shared',
    databaseUrl: TEST_DB_URL,
    masterKey: randomBytes(32),
    aiProvider: 'none',
    aiModel: undefined,
    ollamaUrl: undefined,
    sandbox: 'process', // tests use the process sandbox; production shared mode requires docker
    sandboxImage: 'node:26-alpine',
    insecureHttpHosts: [],
    internalHosts: [],
    host: '127.0.0.1',
    port: 0,
    retry: { autoRetries: 2, backoffMs: 0 },
    webhook: { toleranceSeconds: 300, rateLimitPerMinute: 60 },
    delegationTtlHours: 24,
    publicUrl: 'http://127.0.0.1:8080',
    sessionTtlHours: 12,
    smtpUrl: undefined,
    emailFrom: 'Dittoly <dittoly@test>',
    amqpUrl: undefined,
    slackBotToken: undefined,
    teamsWebhookUrl: undefined,
    telegram: null,
    whatsapp: null,
    oidc: null,
    ...overrides,
  };
}

/** Fresh schema for each test file. */
export async function freshDb(): Promise<Db> {
  const db = createDb(TEST_DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  return db;
}

/** In-memory stand-ins for Jira, GitLab and Slack, reached only through the broker. */
export class FakeApps {
  issues = [{ key: 'REL-1', fields: { summary: 'Ship export for jane.doe@example.com', status: { name: 'Approved' } } }];
  mrs = [
    { iid: 7, title: 'Add export', detailed_merge_status: 'mergeable', state: 'opened' },
    { iid: 8, title: 'Fix login', detailed_merge_status: 'mergeable', state: 'opened' },
  ];
  merged: number[] = [];
  messages: { channel: string; text: string; auth: string | null }[] = [];
  deleted: { channel: string; ts: string }[] = [];
  calls: { method: string; url: string; auth: string | null }[] = [];
  /** Scopes GitLab reports for a token (unknown tokens get 401). */
  gitlabScopes: Record<string, string[]> = {};
  /** Documentation pages (url -> HTML) the AI may read. */
  pages: Record<string, string> = {};
  /** Queue of failures to inject: status codes, or 'network' / 'hang'. */
  failNext: Record<string, (number | 'network')[]> = {};
  /** The JSON body a queued failure answers with (default {}). */
  failBody: unknown = {};

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const auth = headers.get('authorization') ?? headers.get('private-token');
    this.calls.push({ method, url, auth });
    const key = `${method} ${u.host}${u.pathname}`;
    const queued = Object.entries(this.failNext).find(([prefix]) => key.startsWith(prefix));
    if (queued && queued[1].length) {
      const f = queued[1].shift()!;
      if (f === 'network') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(this.failBody), { status: f });
    }
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (this.pages[url] !== undefined) return new Response(this.pages[url], { status: 200, headers: { 'content-type': 'text/html' } });

    if (u.host === 'example.atlassian.net' && u.pathname === '/rest/api/3/search/jql') return json({ issues: this.issues });
    if (u.host === 'gitlab.com' && u.pathname === '/api/v4/personal_access_tokens/self') {
      const scopes = this.gitlabScopes[headers.get('private-token') ?? ''];
      return scopes ? json({ id: 1, name: 'token', scopes, active: true }) : json({ message: '401 Unauthorized' }, 401);
    }
    if (u.host === 'gitlab.com') {
      const m = /^\/api\/v4\/projects\/([^/]+)\/merge_requests(?:\/(\d+)\/merge)?$/.exec(u.pathname);
      if (m && !m[2] && method === 'GET') return json(this.mrs.filter((x) => x.state === 'opened'));
      if (m && m[2] && method === 'PUT') {
        const mr = this.mrs.find((x) => x.iid === Number(m[2]));
        if (!mr) return json({ message: 'not found' }, 404);
        mr.state = 'merged';
        this.merged.push(mr.iid);
        return json({ iid: mr.iid, state: 'merged' });
      }
    }
    if (u.host === 'slack.com' && u.pathname === '/api/chat.postMessage') {
      const body = JSON.parse(String(init.body));
      this.messages.push({ ...body, auth: headers.get('authorization') });
      return json({ ok: true, ts: '1700000000.000100' });
    }
    if (u.host === 'slack.com' && u.pathname === '/api/chat.delete') {
      const body = JSON.parse(String(init.body)) as { channel: string; ts: string };
      this.deleted.push(body);
      return json({ ok: true, channel: body.channel, ts: body.ts });
    }
    return json({ error: 'unexpected' }, 404);
  };
}

export interface World {
  app: App;
  db: Db;
  fake: FakeApps;
  admin: Member;
  approver: Member;
  alice: Member;
  bob: Member;
  tokens: Record<'admin' | 'approver' | 'alice' | 'bob', string>;
}

const runner = new ProcessRunner();

export async function makeWorld(configOverrides: Partial<Config> = {}, appOverrides: AppOverrides = {}): Promise<World> {
  const db = await freshDb();
  const fake = new FakeApps();
  const app = buildApp(testConfig(configOverrides), db, { runner, ai: null, fetchImpl: fake.fetch, actionTimeoutMs: 10_000, ...appOverrides });
  const mk = (handle: string, role: Role) => createMember(db, handle, role, null);
  const a = await mk('admin', 'admin');
  const p = await mk('approver', 'approver');
  const al = await mk('alice', 'member');
  const b = await mk('bob', 'member');
  return {
    app,
    db,
    fake,
    admin: a.member,
    approver: p.member,
    alice: al.member,
    bob: b.member,
    tokens: { admin: a.token, approver: p.token, alice: al.token, bob: b.token },
  };
}

const examples = path.resolve(import.meta.dirname, 'fixtures');

/** Load the example modules as drafts, submit them, and approve them as admin. */
export async function approveExampleModules(w: World): Promise<void> {
  for (const name of ['jira', 'gitlab', 'slack']) {
    const dir = path.join(examples, 'modules', name);
    const mv = await w.app.modules.createDraft(
      {
        manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
        code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
        tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
        origin: 'seed',
      },
      w.alice,
    );
    if (!mv.validationReport?.passed) throw new Error(`${name} failed validation: ${JSON.stringify(mv.validationReport)}`);
    await w.app.modules.submit(mv.id, w.alice);
    await w.app.modules.decide(mv.id, w.admin, 'approved');
  }
}

/** A Flow definition told what its modules need (a module keeps none of its own). */
export function withModuleSettings<T extends Record<string, unknown>>(def: T, values: Record<string, Record<string, string>>): T {
  return { ...def, moduleSettings: { ...((def as { moduleSettings?: Record<string, Record<string, string>> }).moduleSettings ?? {}), ...values } };
}

export async function releaseFlow(): Promise<{ name: string; definition: Record<string, unknown> }> {
  return JSON.parse(await readFile(path.join(examples, 'flows', 'release-coordination.json'), 'utf8'));
}

export const releaseInputs = {
  release: '2.4',
  jql: 'fixVersion = 2.4 AND status = Approved',
  project: 'acme/app',
  channel: 'C-releases',
};

/** Create and approve the release flow (alice authors, approver approves). */
export async function approvedReleaseFlow(w: World) {
  const f = await releaseFlow();
  const v = await w.app.flows.create(f.name, f.definition, w.alice);
  return w.app.flows.decide(v.id, w.approver, 'approved');
}

export async function giveAllCredentials(w: World, member: Member): Promise<void> {
  await w.app.vault.put(member.id, 'jira', `${member.handle}@example.com:jira-token-${member.handle}`);
  await w.app.vault.put(member.id, 'gitlab', `glpat-${member.handle}`);
  await w.app.vault.put(member.id, 'slack', `xoxb-${member.handle}`);
}

export async function runStatus(w: World, runId: string, as: Member) {
  return w.app.engine.runView(runId, as);
}

/** A one-page PDF with these lines of text (no lines: a page with no text, like a scan). */
export function pdfOf(lines: string[]): Buffer {
  const content = lines.length ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

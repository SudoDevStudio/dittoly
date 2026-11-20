import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { sealAudit } from '../src/governance/audit-chain.js';
import { scrubber } from '../src/governance/evidence-pack.js';
import { approveExampleModules, giveAllCredentials, makeWorld, releaseFlow, releaseInputs, type World } from './helpers.js';

/** Evidence packs of runs, and the AI system inventory. */
let w: World;
let api: ReturnType<typeof buildServer>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const SECRETS = ['glpat-alice', 'xoxb-alice', 'jira-token-alice'];
const NAME = 'Release <script>alert("x")</script> & co';
let runId = '';
let versionId = '';

const pack = (token: string, format = '') => api.inject({ method: 'GET', url: `/api/runs/${runId}/evidence${format ? `?format=${format}` : ''}`, headers: auth(token) });

beforeAll(async () => {
  w = await makeWorld({}, { ai: new MockProvider() });
  await approveExampleModules(w);
  api = buildServer(w.app);
  await giveAllCredentials(w, w.alice);
  const f = await releaseFlow();
  const v = await w.app.flows.decide((await w.app.flows.create(NAME, f.definition, w.alice)).id, w.approver, 'approved');
  versionId = v.id;
  runId = await w.app.engine.startRun(v.id, w.alice.id, releaseInputs);
  await w.app.worker.drain();
  await w.app.engine.decideGate(runId, 'signoff', w.approver, 'approved');
  await w.app.worker.drain();
  await sealAudit(w.db, 0);
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

describe('evidence pack of a run', () => {
  it('has the Flow version and its approval, the modules and their hashes, every step with its sign-offs, and the data while it is kept', async () => {
    const r = await pack(w.tokens.alice);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    const version = (await w.app.flows.getVersion(w.db, versionId))!;
    expect(p.format).toBe('dittoly-evidence-pack/1');
    expect(p.run).toMatchObject({ id: runId, flowName: NAME, runAs: 'alice', via: 'manual', status: 'succeeded' });
    expect(p.flowVersion).toMatchObject({ id: versionId, approvalHash: version.approvalHash, draftedBy: 'alice', decidedBy: 'approver', approvals: { required: 1 } });
    expect(p.modules.map((m: { ref: string }) => m.ref).sort()).toEqual(['gitlab@1.0.0', 'jira@1.1.0', 'slack@1.0.0']);
    const jira = (await w.app.modules.findByRef(w.db, 'jira', '1.1.0'))!;
    expect(p.modules.find((m: { ref: string }) => m.ref === 'jira@1.1.0')).toMatchObject({ codeSha256: jira.codeSha256, manifestSha256: jira.manifestSha256, reviewedBy: 'admin' });
    expect(p.steps.map((s: { id: string }) => s.id)).toEqual(['tickets', 'mrs', 'signoff', 'merge', 'announce']);
    expect(p.steps[2].signOff).toMatchObject({ kind: 'sign-off step', decision: 'approved', by: 'approver' });
    expect(p.steps[0].output.state).toBe('shown');
    expect(p.steps[0].output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.inputs).toMatchObject({ state: 'shown', value: releaseInputs });
    expect(p.policies).toEqual([]);
    expect(p.verification.length).toBeGreaterThan(2);
    // No credentials anywhere.
    for (const s of SECRETS) expect(r.body).not.toContain(s);
  });

  it('removes the run\'s credentials and secret-looking fields from outputs', () => {
    const clean = scrubber(['alice@example.com:jira-token-alice', 'xoxb-alice']);
    expect(clean({ note: 'used jira-token-alice and xoxb-alice', apiKey: 'abc', nested: [{ password: 'pw', ok: 'fine' }] })).toEqual({
      note: 'used [credential removed] and [credential removed]',
      apiKey: '[removed]',
      nested: [{ password: '[removed]', ok: 'fine' }],
    });
  });

  it('carries the run\'s audit events with their chain links, which recompute to the sealed hashes, and the nearest daily anchor', async () => {
    const head = (await w.db.query(`SELECT s.event_id::text AS event_id, s.hash FROM audit_seals s ORDER BY s.event_id DESC LIMIT 1`)).rows[0];
    const anchor = (await w.db.query(`INSERT INTO audit_anchors (kind, target, created_by) VALUES ('webhook', 'https://anchors.example.com', $1) RETURNING id`, [w.admin.id])).rows[0].id;
    await w.db.query(`INSERT INTO audit_anchor_sends (anchor_id, day, event_id, hash, ok) VALUES ($1, current_date, $2, $3, true)`, [anchor, head.event_id, head.hash]);
    const p = (await pack(w.tokens.alice)).json();
    const chain = p.audit.chain as { eventId: string; atMicros: string; actorId: string | null; action: string; subjectType: string; subjectId: string; outcome: string; errorType: string | null; relatedId: string | null; previousHash: string; hash: string | null }[];
    expect(chain.map((c) => c.action)).toEqual(expect.arrayContaining(['run.started', 'gate.approved']));
    const sealed = chain.filter((c) => c.hash);
    expect(sealed.length).toBeGreaterThan(3);
    for (const c of sealed) {
      const canonical = JSON.stringify([c.eventId, c.atMicros, c.actorId, c.action, c.subjectType, c.subjectId, c.outcome, c.errorType, c.relatedId]);
      expect(createHash('sha256').update(`${c.previousHash}\n${canonical}`).digest('hex')).toBe(c.hash);
      // previousHash is really the seal of the event just before it.
      const prev = (await w.db.query(`SELECT hash FROM audit_seals WHERE event_id < $1 ORDER BY event_id DESC LIMIT 1`, [c.eventId])).rows[0]?.hash ?? 'dittoly-audit-v1';
      expect(c.previousHash).toBe(prev);
    }
    expect(p.audit.anchor).toMatchObject({ eventId: head.event_id, hash: head.hash, sentBy: 'webhook' });
    expect(JSON.stringify(p)).not.toContain('anchors.example.com');
  });

  it('is one self-contained, escaped HTML page', async () => {
    const r = await pack(w.tokens.alice, 'html');
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['content-disposition']).toContain('attachment');
    for (const h of ['Flow version and approval', 'Module versions', 'AI used', 'Steps', 'Undo records', 'Audit events and hash chain', 'How to verify']) expect(r.body).toContain(`<h2>${h}</h2>`);
    expect(r.body).toContain('Release &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co');
    expect(r.body).not.toContain('<script');
    expect(r.body).not.toMatch(/\s(src|href)=/);
    expect(r.body).not.toMatch(/@import|url\(/);
    for (const s of SECRETS) expect(r.body).not.toContain(s);
  });

  it('is shown only to people who may open the run, with outputs only for the person who ran it', async () => {
    expect((await pack(w.tokens.bob)).statusCode).toBe(403);
    expect((await pack(w.tokens.bob, 'html')).statusCode).toBe(403);
    const p = (await pack(w.tokens.approver)).json();
    expect(p.steps[0].output).toMatchObject({ state: 'kept' });
    expect(p.steps[0].output.value).toBeUndefined();
    expect(p.inputs.value).toBeUndefined();
    expect(p.steps[0].output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await w.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'run.evidence_exported' AND subject_id = $1`, [runId])).rows[0].n).toBeGreaterThan(3);
  });

  it('after the retention period says the data was removed and keeps its hashes', async () => {
    const before = (await pack(w.tokens.alice)).json();
    expect((await api.inject({ method: 'PUT', url: '/api/settings/run-retention', headers: auth(w.tokens.admin), payload: { days: 0 } })).statusCode).toBe(200);
    const after = (await pack(w.tokens.alice)).json();
    expect(after.inputs).toEqual({ state: 'removed', note: 'removed after the retention period', sha256: before.inputs.sha256 });
    expect(after.steps[0].output).toEqual({ state: 'removed', note: 'removed after the retention period', sha256: before.steps[0].output.sha256 });
    expect(JSON.stringify(after)).not.toContain('acme/app');
    expect((await pack(w.tokens.alice, 'html')).body).toContain('removed after the retention period');
  });
});

describe('AI system inventory', () => {
  let flowId = '';
  let moduleId = '';
  let agentId = '';
  beforeAll(async () => {
    // A Flow with an AI step whose answer reaches a step that posts a message.
    const def = {
      inputs: { type: 'object', properties: {} },
      steps: [
        { id: 'draft', type: 'ai', ai: 'organization', instruction: 'Write a two-line status note.', input: {} },
        { id: 'post', type: 'action', module: 'slack@1.0.0', action: 'post_message', input: { channel: 'C1', text: '{{ steps.draft.output.text }}' } },
      ],
    };
    const v = await w.app.flows.decide((await w.app.flows.create('Status note', def, w.alice)).id, w.approver, 'approved');
    flowId = v.flowId;
    // A module drafted by Dittoly's AI.
    const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'jira');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const mv = await w.app.modules.createDraft({ manifest: { ...manifest, version: '1.2.0' }, code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')), origin: 'chat', generation: { source: null, reference: null, instructions: null } }, w.alice);
    await w.app.modules.submit(mv.id, w.alice);
    moduleId = mv.id;
    const a = await api.inject({ method: 'POST', url: '/api/agents', headers: auth(w.tokens.bob), payload: { name: 'Claude Code', scopes: { tools: { [`flow:${flowId}`]: 'ask' }, drafting: true } } });
    expect(a.statusCode, a.body).toBe(201);
    agentId = a.json().id;
  });

  it('lists Flows with AI steps and what their output reaches, AI-drafted modules, agents and AI features', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/admin/ai-inventory', headers: auth(w.tokens.approver) })).json()).toEqual({ error: 'admin_only' });
    const { entries } = (await api.inject({ method: 'GET', url: '/api/admin/ai-inventory', headers: auth(w.tokens.admin) })).json();
    const flow = entries.find((e: { key: string }) => e.key === `flow:${flowId}`);
    expect(flow).toMatchObject({ kind: 'flow', name: 'Status note', person: 'alice', ai: 'mock (organization)', classification: { riskClass: 'not_classified', reviewedAt: null } });
    expect(flow.reach).toEqual([{ step: 'post', what: 'Slack "post_message" changes data in an external app', guarded: true }]);
    expect(entries.find((e: { key: string }) => e.key === `module:${moduleId}`)).toMatchObject({ kind: 'module', name: 'jira@1.2.0', person: 'alice' });
    const agent = entries.find((e: { key: string }) => e.key === `agent:${agentId}`);
    expect(agent).toMatchObject({ kind: 'agent', name: 'Claude Code', person: 'bob' });
    expect(agent.detail).toContain('1 that ask first, may draft Flows and modules');
    expect(entries.filter((e: { kind: string }) => e.kind === 'feature').map((e: { key: string }) => e.key)).toEqual(expect.arrayContaining(['feature:module_drafting', 'feature:flow_drafting', 'feature:plan_drafting', 'feature:self_fix']));
    // The release Flow has no AI step.
    expect(entries.some((e: { name: string }) => e.name === NAME)).toBe(false);
  });

  it('only admins classify entries; each classification is a review, audited, and in the CSV and the audit report', async () => {
    const key = `flow:${flowId}`;
    const body = { riskClass: 'limited', purpose: 'Status notes for <the team>', owner: 'Ops lead' };
    expect((await api.inject({ method: 'PUT', url: `/api/admin/ai-inventory/${key}`, headers: auth(w.tokens.approver), payload: body })).json()).toEqual({ error: 'admin_only' });
    expect((await api.inject({ method: 'PUT', url: `/api/admin/ai-inventory/${key}`, headers: auth(w.tokens.admin), payload: { riskClass: 'severe' } })).statusCode).toBe(400);
    expect((await api.inject({ method: 'PUT', url: `/api/admin/ai-inventory/flow:00000000-0000-0000-0000-000000000000`, headers: auth(w.tokens.admin), payload: body })).statusCode).toBe(404);
    const r = await api.inject({ method: 'PUT', url: `/api/admin/ai-inventory/${key}`, headers: auth(w.tokens.admin), payload: body });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().classification).toMatchObject({ riskClass: 'limited', purpose: 'Status notes for <the team>', owner: 'Ops lead', reviewedBy: 'admin' });
    expect(r.json().classification.reviewedAt).toBeTruthy();
    expect((await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'ai_inventory.classified_limited' AND subject_id = $1 AND actor_id = $2`, [key, w.admin.id])).rowCount).toBe(1);

    const csv = await api.inject({ method: 'GET', url: '/api/admin/ai-inventory?format=csv', headers: auth(w.tokens.admin) });
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split('\n');
    expect(lines[1]).toBe('key,kind,name,team,person,ai,detail,reach,risk_class,purpose,owner,last_reviewed,reviewed_by');
    const line = lines.find((l) => l.startsWith(`"${key}"`))!;
    expect(line).toContain('"limited","Status notes for <the team>","Ops lead"');
    expect(line).toContain('a person checks first');
    expect(lines.some((l) => l.includes('"not_classified"'))).toBe(true);

    const report = (await api.inject({ method: 'GET', url: '/api/admin/audit-report', headers: auth(w.tokens.admin) })).json();
    expect(report.aiInventory).toMatchObject({ byClass: { limited: 1 }, byKind: { flow: 1, module: 1, agent: 1 } });
    expect(report.rows.find((x: { section: string }) => x.section === 'ai')).toMatchObject({ who: 'admin', subject: key, detail: 'risk class: limited' });
    expect(report.controls.some((c: { id: string; lines: number }) => c.id === 'A.5.9' && c.lines === 1)).toBe(true);
    const reportCsv = await api.inject({ method: 'GET', url: '/api/admin/audit-report?format=csv', headers: auth(w.tokens.admin) });
    expect(reportCsv.body).toContain('# AI system inventory:');
  });
});

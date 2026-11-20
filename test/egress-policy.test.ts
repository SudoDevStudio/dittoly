import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createTeam, defaultTeamFor, setTeamMember } from '../src/core/teams.js';
import { AppRunner, type AppStartOptions } from '../src/engine/apps.js';
import { stepSchema } from '../src/flows/definition.js';
import { covers, parseDestination, type Destination } from '../src/runtime/destinations.js';
import { makeWorld, runStatus, type World } from './helpers.js';

/**
 * Outside services of app and fix steps (plan item 08): declared per phase, inside the organization's
 * list (a team admin may narrow it), checked when a Flow is approved and again when the step runs; each
 * secret env var only in its phases; the access preview shows it all before anyone runs the Flow.
 */

const d = (s: string) => parseDestination(s) as Destination;

describe('Flows saved before steps had egress', () => {
  it('read as no extra destination: judged, summarized and previewed without one', async () => {
    const { judgeEgress } = await import('../src/core/egress-policy.js');
    const { flowSummary } = await import('../src/flows/service.js');
    const old = { id: 'a', type: 'app', repo: 'https://git.example.com/x.git', ref: 'main', start: 'node s.js', image: 'node:26', port: 3000, path: '/', env: {}, secretEnv: { K: 'svc' }, readySeconds: 60, timeoutSeconds: 60 } as never;
    expect(judgeEgress(old, [])).toEqual([]);
    expect(flowSummary({ inputs: { type: 'object', properties: {} }, steps: [old] } as never, new Map())).toContain('K from the "svc" credential (build and run)');
  });
});

describe('destinations', () => {
  it('exact, one label (*.), any depth (**.); TCP only exact and from port 1024; ambiguous patterns refused', () => {
    expect(d('API.Example.com')).toMatchObject({ text: 'api.example.com:443', kind: 'https', match: 'exact' });
    expect(d('*.example.com')).toMatchObject({ text: '*.example.com:443', match: 'one' });
    expect(d('**.example.com:80')).toMatchObject({ text: '**.example.com:80', match: 'any', kind: 'https' });
    expect(d('testdb.example.com:5432')).toMatchObject({ kind: 'tcp', port: 5432 });
    for (const bad of ['*.example.*', '*', 'api.*.com', 'ex*.com', '*.com', '10.0.0.5', '*.example.com:5432', 'db.example.com:22', 'a.example.com:70000', 'a b.com', 'http://a.com']) {
      expect(parseDestination(bad), bad).toHaveProperty('error');
    }
  });

  it('a ceiling entry covers what it names, on the same port', () => {
    expect(covers(d('**.example.com'), d('a.b.example.com'))).toBe(true);
    expect(covers(d('**.example.com'), d('*.eu.example.com'))).toBe(true);
    expect(covers(d('**.example.com'), d('*.example.com'))).toBe(true);
    expect(covers(d('*.example.com'), d('api.example.com'))).toBe(true);
    expect(covers(d('*.example.com'), d('a.b.example.com'))).toBe(false);
    expect(covers(d('*.example.com'), d('**.example.com'))).toBe(false);
    expect(covers(d('*.example.com'), d('example.com'))).toBe(false);
    expect(covers(d('api.example.com'), d('api.example.com:8443'))).toBe(false);
    expect(covers(d('api.example.com'), d('*.example.com'))).toBe(false);
  });

  it('steps: build and run for app steps, build and test for fix steps; one TCP host per port; secret phases', () => {
    const app = { id: 'a', type: 'app', repo: 'https://git.example.com/x.git', ref: 'main', start: 'node s.js' };
    const fix = { id: 'f', type: 'fix', ai: 'organization', repo: 'https://git.example.com/x.git', ref: 'main', test: 'npm test', instruction: 'fix it' };
    expect(stepSchema.safeParse({ ...app, egress: { run: ['api.stripe.com'], build: ['cdn.example.com'] } }).success).toBe(true);
    expect(stepSchema.safeParse({ ...app, egress: { test: ['api.stripe.com'] } }).success).toBe(false);
    expect(stepSchema.safeParse({ ...app, egress: { install: ['api.stripe.com'] } }).success).toBe(false);
    expect(stepSchema.safeParse({ ...fix, egress: { test: ['testdb.example.com:5432'] } }).success).toBe(true);
    expect(stepSchema.safeParse({ ...fix, egress: { run: ['api.stripe.com'] } }).success).toBe(false);
    expect(stepSchema.safeParse({ ...fix, egress: { test: ['*.example.*'] } }).success).toBe(false);
    expect(stepSchema.safeParse({ ...fix, egress: { test: ['a.example.com:5432', 'b.example.com:5432'] } }).success).toBe(false);
    expect(stepSchema.safeParse({ ...fix, secretEnv: { DB: { service: 'db', phases: ['test'] }, T: 'tok' } }).success).toBe(true);
    expect(stepSchema.safeParse({ ...fix, secretEnv: { DB: { service: 'db', phases: ['install'] } } }).success).toBe(false);
    expect(stepSchema.safeParse({ ...fix, secretEnv: { DB: { service: 'db', phases: ['run'] } } }).success).toBe(false);
    expect(stepSchema.safeParse({ ...app, secretEnv: { DB: { service: 'db', phases: [] } } }).success).toBe(false);
  });
});

class RecordingApps extends AppRunner {
  started: AppStartOptions[] = [];
  constructor() {
    super({ mode: 'shared', internalHosts: [], directAllowed: async () => false, dockerAvailable: async () => true });
  }
  override async start(a: AppStartOptions) {
    this.started.push(a);
    return { url: 'http://dty-app-x:3000/', hostKey: 'dty-app-x:3000', commit: 'abc', mode: 'docker' as const, logTail: '', network: { mode: 'docker' as const, phases: [], refused: [] } };
  }
}

let w: World;
let api: ReturnType<typeof buildServer>;
let apps: RecordingApps;
let teamId: string;
let other: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  apps = new RecordingApps();
  w = await makeWorld({}, { apps });
  api = buildServer(w.app);
  teamId = await defaultTeamFor(w.db, w.alice.id);
  other = (await createTeam(w.db, w.admin, 'Payments')).id;
  await setTeamMember(w.db, w.admin, other, w.bob.id, 'admin');
});
afterAll(async () => {
  await api.close();
  await w.db.end();
});

const appFlow = (egress: Record<string, string[]>) => ({
  inputs: { type: 'object', properties: {} },
  steps: [{ id: 'app', type: 'app', repo: 'https://git.example.com/shop.git', ref: 'main', start: 'node s.js', egress, secretEnv: { STRIPE_KEY: { service: 'stripe', phases: ['run'] }, NPM_TOKEN: { service: 'npm', phases: ['build'] } } }],
});

describe('the ceiling', () => {
  it('admins keep the organization list; a team admin narrows it for their team, never past it; both audited', async () => {
    expect((await api.inject({ method: 'PUT', url: '/api/settings/egress', headers: auth(w.tokens.alice), payload: { destinations: ['api.stripe.com'] } })).statusCode).toBe(403);
    const bad = await api.inject({ method: 'PUT', url: '/api/settings/egress', headers: auth(w.tokens.admin), payload: { destinations: ['*.example.*'] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error ?? bad.body).toContain('invalid_destination');
    const set = await api.inject({ method: 'PUT', url: '/api/settings/egress', headers: auth(w.tokens.admin), payload: { destinations: ['api.stripe.com', '**.example.com', 'testdb.example.com:5432', 'api.stripe.com:443'] } });
    expect(set.json()).toEqual({ destinations: ['api.stripe.com:443', '**.example.com:443', 'testdb.example.com:5432'] });

    // Bob is admin of Payments: he may narrow it, not widen it, and not touch another team.
    const wider = await api.inject({ method: 'PUT', url: `/api/teams/${other}/egress`, headers: auth(w.tokens.bob), payload: { destinations: ['api.paypal.com'] } });
    expect(wider.statusCode).toBe(400);
    expect(wider.body).toContain('outside_org_egress');
    const narrow = await api.inject({ method: 'PUT', url: `/api/teams/${other}/egress`, headers: auth(w.tokens.bob), payload: { destinations: ['*.example.com'] } });
    expect(narrow.json()).toEqual({ team: ['*.example.com:443'], effective: ['*.example.com:443'] });
    expect((await api.inject({ method: 'PUT', url: `/api/teams/${teamId}/egress`, headers: auth(w.tokens.bob), payload: { destinations: null } })).statusCode).toBe(403);
    expect((await api.inject({ method: 'GET', url: `/api/teams/${teamId}/egress`, headers: auth(w.tokens.alice) })).json()).toMatchObject({ team: null, effective: ['api.stripe.com:443', '**.example.com:443', 'testdb.example.com:5432'] });
    const audits = (await w.db.query<{ action: string }>(`SELECT action FROM audit_events WHERE action IN ('org.egress_set', 'team.egress_set') ORDER BY id`)).rows.map((r) => r.action);
    expect(audits).toEqual(['org.egress_set', 'team.egress_set']);
  });

  it('a Flow is approved only inside its team\'s ceiling', async () => {
    const outside = await w.app.flows.create('Calls PayPal', appFlow({ run: ['api.paypal.com'] }), w.alice, undefined, teamId);
    await expect(w.app.flows.decide(outside.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'egress_outside_policy', message: expect.stringContaining('app run: api.paypal.com:443') });
    // Payments allows only *.example.com: the org's api.stripe.com is outside it there.
    const narrowed = await w.app.flows.create('Stripe in Payments', appFlow({ run: ['api.stripe.com'] }), w.bob, undefined, other);
    await expect(w.app.flows.decide(narrowed.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'egress_outside_policy' });
    const ok = await w.app.flows.create('Stripe', appFlow({ run: ['api.stripe.com'], build: ['cdn.example.com'] }), w.alice, undefined, teamId);
    expect((await w.app.flows.decide(ok.id, w.approver, 'approved')).status).toBe('approved');
  });

  it('a run gets each phase\'s destinations and secret phases; once an admin removes a destination, the step stops with egress_not_allowed', async () => {
    await w.app.vault.put(w.alice.id, 'stripe', 'sk_test_123');
    await w.app.vault.put(w.alice.id, 'npm', 'npm_tok');
    const v = await w.app.flows.create('Stripe run', appFlow({ run: ['api.stripe.com'], build: ['cdn.example.com'] }), w.alice, undefined, teamId);
    await w.app.flows.decide(v.id, w.approver, 'approved');
    const runId = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    expect((await runStatus(w, runId, w.alice)).status).toBe('succeeded');
    const a = apps.started.at(-1)!;
    expect(Object.fromEntries(Object.entries(a.network!.egress).map(([p, l]) => [p, l!.map((x) => x.text)]))).toEqual({ run: ['api.stripe.com:443'], build: ['cdn.example.com:443'] });
    expect(a.network!.secretPhases).toEqual({ STRIPE_KEY: ['run'], NPM_TOKEN: ['build'] });
    expect(a.secrets).toEqual({ STRIPE_KEY: 'sk_test_123', NPM_TOKEN: 'npm_tok' });

    await api.inject({ method: 'PUT', url: '/api/settings/egress', headers: auth(w.tokens.admin), payload: { destinations: ['**.example.com', 'testdb.example.com:5432'] } });
    const n = apps.started.length;
    const again = await w.app.engine.startRun(v.id, w.alice.id, {});
    await w.app.worker.drain();
    const r = await runStatus(w, again, w.alice);
    expect(r.steps[0]).toMatchObject({ status: 'failed', errorType: 'egress_not_allowed' });
    expect(apps.started).toHaveLength(n);
    await api.inject({ method: 'PUT', url: '/api/settings/egress', headers: auth(w.tokens.admin), payload: { destinations: ['api.stripe.com', '**.example.com', 'testdb.example.com:5432'] } });
  });

  it('the access preview shows each phase: what it may reach, which secrets it gets, and what the ceiling does not allow', async () => {
    const v = await w.app.flows.create('Preview', appFlow({ run: ['api.stripe.com', 'api.paypal.com'] }), w.alice, undefined, teamId);
    const p = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/access`, headers: auth(w.tokens.alice) })).json();
    const net = p.steps[0].network;
    expect(net.mode).toBe('docker');
    expect(net.phases.map((x: { phase: string; secrets: string[] }) => [x.phase, x.secrets])).toEqual([['install', []], ['build', ['NPM_TOKEN']], ['run', ['STRIPE_KEY']]]);
    const run = net.phases[2].reaches;
    expect(run).toEqual([
      { destination: 'api.stripe.com:443', source: 'this step', allowed: true },
      { destination: 'api.paypal.com:443', source: 'this step', allowed: false },
    ]);
    expect(net.phases[0].reaches.map((r: { source: string }) => r.source)).toEqual(['git host', 'package registries']);
    expect(net.outsidePolicy).toEqual(['run: api.paypal.com:443']);
    // The approver's summary names the phases too.
    const review = (await api.inject({ method: 'GET', url: `/api/flow-versions/${v.id}/review`, headers: auth(w.tokens.approver) })).json();
    expect(review.summary).toContain('ALSO REACH, only in that phase: run: api.stripe.com, api.paypal.com');
    expect(review.summary).toContain('STRIPE_KEY from the "stripe" credential (run)');
  });
});

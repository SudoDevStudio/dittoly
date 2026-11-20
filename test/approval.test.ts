import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveExampleModules, giveAllCredentials, makeWorld, releaseFlow, releaseInputs, type World } from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await makeWorld();
  await approveExampleModules(w);
  await giveAllCredentials(w, w.alice);
});
afterAll(async () => w.db.end());

describe('flow approval cannot be bypassed', () => {
  it('an unapproved flow version cannot run', async () => {
    const f = await releaseFlow();
    const v = await w.app.flows.create('draft', f.definition, w.alice);
    await expect(w.app.engine.startRun(v.id, w.alice.id, releaseInputs)).rejects.toMatchObject({ code: 'flow_version_not_approved' });
  });

  it('the author cannot approve their own flow on a shared server', async () => {
    const f = await releaseFlow();
    const v = await w.app.flows.create('self', f.definition, w.alice);
    await expect(w.app.flows.decide(v.id, w.alice, 'approved')).rejects.toMatchObject({ code: 'approver_only' });
    const v2 = await w.app.flows.create('self2', f.definition, w.approver);
    await expect(w.app.flows.decide(v2.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'cannot_approve_own_flow' });
  });

  it('changing a flow cancels its approval: the old version stops running and the new one needs approval', async () => {
    const f = await releaseFlow();
    const v1 = await w.app.flows.create('change me', f.definition, w.alice);
    await w.app.flows.decide(v1.id, w.approver, 'approved');
    await w.app.engine.startRun(v1.id, w.alice.id, releaseInputs); // runs while approved

    const changed = structuredClone(f.definition) as { steps: { id: string; input?: Record<string, unknown> }[] };
    changed.steps.find((s) => s.id === 'announce')!.input!.text = 'Changed text';
    const v2 = await w.app.flows.update(v1.flowId, changed, w.alice);

    expect(v2.version).toBe(2);
    expect(v2.status).toBe('pending');
    expect((await w.app.flows.getVersion(w.db, v1.id))!.status).toBe('superseded');
    await expect(w.app.engine.startRun(v1.id, w.alice.id, releaseInputs)).rejects.toMatchObject({ code: 'flow_version_not_approved' });
    await expect(w.app.engine.startRun(v2.id, w.alice.id, releaseInputs)).rejects.toMatchObject({ code: 'flow_version_not_approved' });
    const audit = await w.db.query(`SELECT 1 FROM audit_events WHERE action = 'flow.approval_cancelled' AND subject_id = $1`, [v1.flowId]);
    expect(audit.rowCount).toBe(1);
  });

  it('stored flow versions and module versions cannot be edited in place', async () => {
    await expect(w.db.query(`UPDATE flow_versions SET definition = '{}'::jsonb`)).rejects.toThrow(/immutable/);
    await expect(w.db.query(`UPDATE module_versions SET code = 'export const actions = {}'`)).rejects.toThrow(/immutable/);
  });

  it('a module upgrade does not change an approved flow: the flow keeps its pinned version', async () => {
    const f = await releaseFlow();
    const v = await w.app.flows.create('pinned', f.definition, w.alice);
    const approved = await w.app.flows.decide(v.id, w.approver, 'approved');

    // A new GitLab version that would merge with a different strategy.
    const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'gitlab');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.version = '1.1.0';
    const code = (await readFile(path.join(dir, 'module.mjs'), 'utf8')).replace('/merge`', '/merge?squash=true`');
    const upgraded = await w.app.modules.createDraft({ manifest, code, tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')), origin: 'seed' }, w.alice);
    await w.app.modules.submit(upgraded.id, w.alice);
    await w.app.modules.decide(upgraded.id, w.admin, 'approved');

    const { modules } = await w.app.flows.assertRunnable(w.db, approved.id);
    expect(modules.get('gitlab@1.0.0')!.codeSha256).not.toBe(upgraded.codeSha256);
    expect([...modules.keys()]).not.toContain('gitlab@1.1.0');
  });

  it('if module code were changed underneath an approved flow, the run is refused', async () => {
    const f = await releaseFlow();
    const v = await w.app.flows.create('tamper', f.definition, w.alice);
    const approved = await w.app.flows.decide(v.id, w.approver, 'approved');
    // Simulate a database-level tamper that bypasses the immutability trigger.
    await w.db.query(`ALTER TABLE module_versions DISABLE TRIGGER module_versions_immutable`);
    await w.db.query(`UPDATE module_versions SET code_sha256 = 'tampered' WHERE name = 'slack' AND version = '1.0.0'`);
    await w.db.query(`ALTER TABLE module_versions ENABLE TRIGGER module_versions_immutable`);
    await expect(w.app.engine.startRun(approved.id, w.alice.id, releaseInputs)).rejects.toMatchObject({ code: 'approval_hash_mismatch' });
  });

  it('a flow cannot be approved while a module it uses is not approved', async () => {
    const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.version = '2.0.0';
    await w.app.modules.createDraft({ manifest, code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), tests: [], origin: 'seed' }, w.alice);
    const f = await releaseFlow();
    const def = structuredClone(f.definition) as { steps: { id: string; module?: string }[] };
    def.steps.find((s) => s.id === 'announce')!.module = 'slack@2.0.0';
    const v = await w.app.flows.create('unapproved module', def, w.alice);
    await expect(w.app.flows.decide(v.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'modules_not_approved' });
  });

  it('an admin cannot approve a module they generated, and only admins approve modules', async () => {
    const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.version = '3.0.0';
    const mv = await w.app.modules.createDraft(
      { manifest, code: await readFile(path.join(dir, 'module.mjs'), 'utf8'), tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')), origin: 'chat' },
      w.admin,
    );
    await w.app.modules.submit(mv.id, w.admin);
    await expect(w.app.modules.decide(mv.id, w.approver, 'approved')).rejects.toMatchObject({ code: 'admin_only' });
    await expect(w.app.modules.decide(mv.id, w.admin, 'approved')).rejects.toMatchObject({ code: 'cannot_review_own_module' });
  });
});

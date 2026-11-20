import type { App } from '../app.js';
import type { Member } from '../core/members.js';
import { optionLookups, type FlowDefinition } from '../flows/definition.js';
import type { ModuleVersion } from '../modules/registry.js';
import { credentialModes, teamStoredServices } from '../core/team-credentials.js';

/**
 * The credentials a Flow version's own steps (and live choices) need in a team, by whose access the team uses for
 * each: service -> label. Delegated steps use a teammate's access, so they are left out; optional credentials
 * never block a run (without one the action reads public data).
 */
export async function credentialNeeds(app: App, teamId: string, definition: FlowDefinition, modules: Map<string, ModuleVersion>) {
  const personal = new Map<string, string>();
  const team = new Map<string, string>();
  const uses = [
    ...definition.steps.flatMap((s) => (s.type === 'action' && !s.delegateTo ? [{ module: s.module, action: s.action }] : [])),
    ...optionLookups(definition).map((l) => ({ module: l.source.module, action: l.source.action })),
  ];
  for (const u of uses) {
    const mv = modules.get(u.module);
    const action = mv?.manifest.actions.find((a) => a.name === u.action);
    const modes = mv ? await credentialModes(app.db, teamId, mv.name) : new Map();
    for (const id of action?.credentials ?? []) {
      const c = mv!.manifest.credentials.find((x) => x.id === id);
      if (c && !c.optional) (modes.get(c.service) === 'team' ? team : personal).set(c.service, c.label);
    }
  }
  return { personal, team };
}

/**
 * What a member can run: every Flow with an approved version, with whether they
 * have the credentials its steps (and its live choices) use. Delegated steps
 * use a teammate's access, so they do not count against the member.
 */
/** Flows of the member's teams (org admins: every team), optionally one team only. */
export async function runnableFlows(app: App, member: Member, teamId?: string) {
  const { rows } = await app.db.query<{ flow_id: string; name: string; team_id: string; team_name: string; version_id: string; version: number; decided_at: Date | null }>(
    `SELECT f.id AS flow_id, f.name, f.team_id, t.name AS team_name, v.id AS version_id, v.version, v.decided_at
     FROM flows f JOIN flow_versions v ON v.flow_id = f.id AND v.status = 'approved' JOIN teams t ON t.id = f.team_id
     WHERE f.archived_at IS NULL AND ($2::uuid IS NULL OR f.team_id = $2)
       AND ($3 OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = f.team_id AND tm.member_id = $1))
     ORDER BY t.name, f.name`,
    [member.id, teamId ?? null, member.role === 'admin'],
  );
  // Credentials stored in the vault (OAuth connections are stored there too).
  const stored = new Set((await app.vault.list(member.id)).map((c) => c.service));
  const out = [];
  for (const r of rows) {
    const version = await app.flows.getVersion(app.db, r.version_id);
    if (!version) continue;
    let modules;
    try {
      modules = await app.flows.pinnedModules(app.db, version.definition);
    } catch {
      continue;
    }
    const { personal: needed, team: teamNeeded } = await credentialNeeds(app, r.team_id, version.definition, modules);
    const missing = [...needed].filter(([service]) => !stored.has(service)).map(([service, label]) => ({ service, label }));
    const teamStored = teamNeeded.size ? await teamStoredServices(app.db, r.team_id) : new Set<string>();
    const teamMissing = [...teamNeeded].filter(([service]) => !teamStored.has(service)).map(([service, label]) => ({ service, label }));
    const allApproved = [...modules.values()].every((m) => m.status === 'approved');
    const props = (version.definition.inputs as { properties?: object }).properties ?? {};
    out.push({
      flowId: r.flow_id,
      versionId: r.version_id,
      name: r.name,
      team: { id: r.team_id, name: r.team_name },
      version: r.version,
      description: version.definition.description ?? null,
      approvedAt: r.decided_at,
      inputs: Object.keys(props).length,
      asksDuringRun: version.definition.steps.some((s) => s.type === 'input'),
      ready: missing.length === 0 && teamMissing.length === 0 && allApproved,
      missing,
      /** Shared credentials the team's admins still have to store. */
      teamMissing,
      blocked: allApproved ? null : 'modules_not_approved',
    });
  }
  return out;
}

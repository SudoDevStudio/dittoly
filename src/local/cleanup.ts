import { existsSync } from 'node:fs';
import path from 'node:path';
import { audit } from '../core/audit.js';
import type { Queryable } from '../db/db.js';
import { removeUnusedImages, sweep, type Docker } from '../engine/sandbox-housekeeping.js';
import { lock, MaintenanceError, withDb } from './maintenance.js';

/**
 * `dittoly cleanup` for the local install: a fresh start without losing your access.
 *
 * Removed: modules, Flows and Super Flows with everything that exists only for them (runs, schedules, triggers,
 * watches, endpoints, approvals, tests, delegations, self-fix records, MCP gateway tools), apps, plans, data tables,
 * the audit log, AI usage history and git sync; then what the sandboxes left on this computer (Docker containers,
 * networks and temporary folders of this install, and the Docker images Dittoly pulled).
 *
 * Kept: your account, teams, stored credentials (personal and team), the master key, and settings (organization,
 * AI, budgets and prices, policies, team module settings, notification channels, themes), devices, MCP tokens and
 * audit stream destinations.
 *
 * Every table is in exactly one of the two lists (a test checks it), so a new table needs a decision.
 */
export const WIPE_TABLES = [
  // modules
  'module_versions', 'module_version_approvals', 'module_archive', 'module_calls', 'module_drift', 'module_recordings', 'marketplace_listings',
  // Flows and Super Flows, and what only exists for them
  'flows', 'flow_versions', 'flow_version_approvals', 'flow_endpoints', 'flow_followups', 'flow_model_pins', 'flow_tests', 'model_change_checks',
  'schedules', 'triggers', 'watches', 'watch_seen', 'webhook_deliveries', 'delegations', 'gateway_tools', 'agent_calls',
  'change_records', 'change_decisions', 'autostops', 'autostop_events',
  // runs
  'runs', 'run_steps', 'run_commentary', 'ai_builds', 'run_children', 'run_cost_allowances', 'run_data_hashes', 'gate_decisions', 'step_resolutions', 'undo_records', 'reversals',
  'notifications', 'notification_channel_deliveries', 'chat_follows', 'device_actions', 'app_notices', 'jobs',
  // How a Flow or a module came to be what it is: the Flows and modules it is about are wiped, so it goes too.
  'artifact_journal',
  // Which model drafts what: its rows name Flows, modules and plans, all of which go here.
  'draft_models',
  // What a team answered while drafting: the drafts it belongs to are wiped, so it goes with them.
  'team_decisions',
  // apps, plans, data tables
  'apps', 'app_versions', 'app_exports', 'plans', 'plan_items', 'home_chats', 'data_tables', 'data_rows', 'data_claims',
  // audit log and AI usage history
  'audit_events', 'audit_anchors', 'audit_anchor_sends', 'audit_seals', 'ai_usage', 'ai_inventory', 'scim_errors',
  // git sync
  'git_connections', 'git_exports', 'git_imports', 'git_import_files',
] as const;

export const KEEP_TABLES = [
  'schema_migrations',
  // account, teams, access
  'members', 'sessions', 'teams', 'team_members', 'credentials', 'team_credentials', 'team_credential_modes',
  'devices', 'device_pairings', 'chat_link_codes', 'chat_state', 'mcp_tokens', 'oauth_clients', 'oauth_pending',
  'mcp_oauth_clients', 'mcp_oauth_codes', 'mcp_oauth_grants', 'mcp_oauth_requests', 'mcp_oauth_tokens',
  'scim_tokens', 'scim_groups', 'scim_group_members', 'approval_standins', 'breakglass_grants',
  // settings
  'org_settings', 'ai_budgets', 'ai_prices', 'policies', 'team_notify_channels', 'brand_themes', 'views', 'audit_streams',
  // housekeeping
  'sandbox_owners', 'sandbox_slots', 'sandbox_images', 'rate_buckets',
] as const;

export interface CleanupResult {
  modules: number;
  flows: number;
  containers: number;
  networks: number;
  folders: number;
  images: string[];
}

/** What would go, for the confirmation. */
export async function cleanupPreview(db: Queryable): Promise<{ modules: number; flows: number; runs: number }> {
  const one = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);
  return {
    modules: await one(`SELECT count(DISTINCT name) AS n FROM module_versions`),
    flows: await one(`SELECT count(*) AS n FROM flows`),
    runs: await one(`SELECT count(*) AS n FROM runs`),
  };
}

/** Removes the sandboxes' leftovers and the content (see above), in a database nothing else is using. */
export async function cleanupDb(db: Queryable, o: { docker?: Docker | null } = {}): Promise<CleanupResult> {
  const { modules, flows } = await cleanupPreview(db);
  // Dittoly is stopped, so every process this database knows of is gone: its leftovers can go, and so can the
  // images it pulled. Resources of other installations carry other owner ids and are not touched.
  await db.query(`UPDATE sandbox_owners SET heartbeat_at = '-infinity'`);
  const swept = await sweep(db, { docker: o.docker === undefined ? undefined : o.docker, owner: 'cleanup' });
  await db.query(`UPDATE sandbox_images SET last_used_at = '-infinity'`);
  const images = o.docker === null ? [] : await removeUnusedImages(db, 1, o.docker ? { docker: o.docker } : {});
  // One statement, so tables that refer to each other go together. Identities are not restarted: an audit
  // stream's position stays below the next events.
  await db.query(`TRUNCATE ${WIPE_TABLES.join(', ')}`);
  // The first entry of the fresh audit log says what happened.
  await audit(db, { actorId: null, action: 'local.cleanup', subjectType: 'org', subjectId: 'local', outcome: 'ok' });
  return { modules, flows, containers: swept.containers, networks: swept.networks, folders: swept.folders, images };
}

/** `dittoly cleanup` on the local install's data directory (Dittoly must be stopped). */
export async function cleanupLocal(home: string, o: { docker?: Docker | null } = {}): Promise<CleanupResult> {
  if (!existsSync(path.join(home, 'master.key'))) throw new MaintenanceError(`no Dittoly data in ${home}`);
  const release = lock(home);
  try {
    return await withDb(home, (db) => cleanupDb(db, o));
  } finally {
    release();
  }
}

export async function previewLocal(home: string): Promise<{ modules: number; flows: number; runs: number }> {
  if (!existsSync(path.join(home, 'master.key'))) throw new MaintenanceError(`no Dittoly data in ${home}`);
  const release = lock(home);
  try {
    return await withDb(home, cleanupPreview);
  } finally {
    release();
  }
}

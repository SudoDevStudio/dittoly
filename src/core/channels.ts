import type { Engine } from '../engine/engine.js';
import type { Queryable } from '../db/db.js';
import { resolve, type TemplateScope } from '../flows/template.js';
import { ajv, hostMatches, servicesFor } from '../modules/manifest.js';
import type { ModuleRegistry } from '../modules/registry.js';
import { audit } from './audit.js';
import { badRequest, notFound } from './errors.js';
import type { Member } from './members.js';
import { credentialModes, teamStoredServices } from './team-credentials.js';
import { assertTeamAdmin, assertTeamMember } from './teams.js';

/**
 * Team notification channels: an approved module action with templated
 * inputs. A notification fills in `message` (text, url, kind) and `member`
 * (email, name, handle) and runs the action with the team's shared
 * credentials, in the sandbox, like a step. Messages are one sentence and a
 * link; they never contain run data.
 */

export interface ChannelMessage {
  text: string;
  url: string;
  kind: string;
}
export interface ChannelMember {
  email: string | null;
  name: string;
  handle: string;
}
export interface Channel {
  id: string;
  teamId: string;
  name: string;
  module: string;
  action: string;
  input: Record<string, unknown>;
  /** What the module is configured with here (a module keeps no configuration of its own). */
  settings: Record<string, string>;
  enabled: boolean;
}

const VARIABLES = /^(message\.(text|url|kind)|member\.(email|name|handle))$/;
const TEMPLATE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

function templatePaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') for (const m of value.matchAll(TEMPLATE)) out.push(m[1]!);
  else if (Array.isArray(value)) value.forEach((v) => templatePaths(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => templatePaths(v, out));
  return out;
}

export function fillChannelInput(input: Record<string, unknown>, message: ChannelMessage, member: ChannelMember): unknown {
  return resolve(input, { message, member: { ...member, email: member.email ?? '' } } as unknown as TemplateScope);
}

const SAMPLE_MESSAGE: ChannelMessage = { text: 'A step is waiting for your approval.', url: 'https://dittoly.example/runs/1', kind: 'approval_needed' };
const SAMPLE_MEMBER: ChannelMember = { email: 'someone@example.com', name: 'Someone', handle: 'someone' };

const channelBody = (b: Record<string, unknown>) => b as { name: string; module: string; action: string; input: Record<string, unknown>; settings?: Record<string, string> };

export class TeamChannels {
  constructor(
    private readonly db: Queryable,
    private readonly modules: ModuleRegistry,
    private readonly engine: Engine,
  ) {}

  async list(actor: Member, teamId: string): Promise<Channel[]> {
    await assertTeamMember(this.db, teamId, actor);
    return this.forTeam(teamId, false);
  }

  async forTeam(teamId: string, enabledOnly = true): Promise<Channel[]> {
    const { rows } = await this.db.query<{ id: string; team_id: string; name: string; module: string; action: string; input: Record<string, unknown>; settings: Record<string, string>; enabled: boolean }>(
      `SELECT id, team_id, name, module, action, input, settings, enabled FROM team_notify_channels WHERE team_id = $1 AND ($2 = false OR enabled) ORDER BY created_at`,
      [teamId, enabledOnly],
    );
    return rows.map((r) => ({ id: r.id, teamId: r.team_id, name: r.name, module: r.module, action: r.action, input: r.input, settings: r.settings ?? {}, enabled: r.enabled }));
  }

  /** Checks a channel can work: approved module, inputs only from the allowed variables, team credentials for everything it uses. */
  private async check(teamId: string, raw: Record<string, unknown>) {
    const b = channelBody(raw);
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw badRequest('invalid_channel', 'name: 1 to 80 characters');
    const at = typeof b.module === 'string' ? b.module.lastIndexOf('@') : -1;
    const mv = at > 0 ? await this.modules.resolveRef(this.db, b.module) : null;
    if (!mv || mv.status !== 'approved') throw badRequest('invalid_channel', 'module: must be an approved module version (name@x.y.z)');
    const action = mv.manifest.actions.find((a) => a.name === b.action);
    if (!action) throw badRequest('invalid_channel', `action: ${mv.manifest.title} has no action ${String(b.action)}`);
    if (!b.input || typeof b.input !== 'object' || Array.isArray(b.input)) throw badRequest('invalid_channel', 'input: an object');
    const bad = templatePaths(b.input).filter((p) => !VARIABLES.test(p));
    if (bad.length) throw badRequest('invalid_channel', `input: unknown variables ${bad.join(', ')} (use message.text, message.url, message.kind, member.email, member.name, member.handle)`);
    // A module keeps no configuration: the channel gives it, and a host must match the pattern the manifest declares.
    const settings = b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings) ? b.settings : {};
    for (const st of mv.manifest.settings ?? []) {
      const v = settings[st.id];
      if (st.type === 'host' && (!v || !hostMatches(st.pattern, v.toLowerCase()))) {
        throw badRequest('invalid_channel', `settings.${st.id} (${st.label}): a host matching ${st.pattern}`);
      }
    }
    for (const id of Object.keys(settings)) {
      if (!(mv.manifest.settings ?? []).some((st) => st.id === id)) throw badRequest('invalid_channel', `settings: ${mv.manifest.title} has no setting "${id}"`);
    }
    const sample = fillChannelInput(b.input, SAMPLE_MESSAGE, SAMPLE_MEMBER);
    const problems = ajv.explain(action.input, sample);
    if (problems.length) throw badRequest('invalid_channel', `input: ${problems.join('; ')}`);
    // Notifications act for the team, never as a person: every credential must be the team's.
    const services = servicesFor(mv.manifest, action.name);
    const modes = await credentialModes(this.db, teamId, mv.name);
    const personal = services.filter((s) => modes.get(s) !== 'team');
    if (personal.length) throw badRequest('channel_needs_team_credentials', `set ${personal.join(', ')} to "team" for ${mv.manifest.title} on the Teams page first`);
    const stored = await teamStoredServices(this.db, teamId);
    const unset = services.filter((s) => !stored.has(s));
    if (unset.length) throw badRequest('channel_needs_team_credentials', `store the team's ${unset.join(', ')} credential first`);
    return { name: b.name.trim(), module: b.module, action: b.action, input: b.input, settings };
  }

  async create(actor: Member, teamId: string, body: Record<string, unknown>): Promise<{ id: string }> {
    await assertTeamAdmin(this.db, teamId, actor);
    const c = await this.check(teamId, body);
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO team_notify_channels (team_id, name, module, action, input, settings, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [teamId, c.name, c.module, c.action, JSON.stringify(c.input), JSON.stringify(c.settings ?? {}), actor.id],
    );
    await audit(this.db, { actorId: actor.id, action: 'team.channel_added', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: r.rows[0]!.id });
    return r.rows[0]!;
  }

  async setEnabled(actor: Member, teamId: string, channelId: string, enabled: boolean): Promise<void> {
    await assertTeamAdmin(this.db, teamId, actor);
    const r = await this.db.query(`UPDATE team_notify_channels SET enabled = $3 WHERE id = $1 AND team_id = $2`, [channelId, teamId, enabled]);
    if (!r.rowCount) throw notFound('channel');
    await audit(this.db, { actorId: actor.id, action: enabled ? 'team.channel_enabled' : 'team.channel_disabled', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: channelId });
  }

  async remove(actor: Member, teamId: string, channelId: string): Promise<void> {
    await assertTeamAdmin(this.db, teamId, actor);
    const r = await this.db.query(`DELETE FROM team_notify_channels WHERE id = $1 AND team_id = $2`, [channelId, teamId]);
    if (!r.rowCount) throw notFound('channel');
    await audit(this.db, { actorId: actor.id, action: 'team.channel_removed', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: channelId });
  }

  /** Send one message through one channel, with the team's credentials. */
  async send(channel: Channel, message: ChannelMessage, member: ChannelMember): Promise<void> {
    const mv = await this.modules.resolveRef(this.db, channel.module);
    if (!mv || mv.status !== 'approved') throw badRequest('channel_module_not_approved');
    await this.engine.invokeOutsideRun(mv, channel.action, fillChannelInput(channel.input, message, member), channel.teamId, this.engine.teamOnlySecrets(channel.teamId), { settings: channel.settings });
  }

  /** A test message to the asking team admin, to check a channel works. */
  async test(actor: Member, teamId: string, channelId: string, publicUrl: string): Promise<void> {
    await assertTeamAdmin(this.db, teamId, actor);
    const channel = (await this.forTeam(teamId, false)).find((c) => c.id === channelId);
    if (!channel) throw notFound('channel');
    const m = (await this.db.query<{ email: string | null; display_name: string | null; handle: string }>(`SELECT email, display_name, handle FROM members WHERE id = $1`, [actor.id])).rows[0]!;
    await this.send(channel, { text: 'Test message from Dittoly: this channel works.', url: `${publicUrl}/teams`, kind: 'test' }, { email: m.email, name: m.display_name ?? m.handle, handle: m.handle });
  }
}

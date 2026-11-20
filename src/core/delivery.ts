import nodemailer from 'nodemailer';
import type { Db } from '../db/db.js';
import type { FetchLike } from '../sandbox/broker.js';
import { SlackNotifier, TeamsNotifier, Unreachable } from './chat-notify.js';
import type { Cipher } from './crypto.js';
import type { TeamChannels } from './channels.js';
import { errorType, log } from './log.js';
import type { NotificationKind } from './notify.js';

/**
 * Delivery of notifications by email, Slack and Teams. A message names what
 * happened and links to the portal; it never contains run inputs, outputs,
 * Flow content or other members' details. Delivery runs as a
 * durable job, so an outage delays messages but never blocks a run.
 */

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export function createMailer(smtpUrl: string | undefined, from: string): Mailer | null {
  if (!smtpUrl) return null;
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(msg) {
      await transport.sendMail({ from, ...msg });
    },
  };
}

const TEXT: Record<NotificationKind, string> = {
  run_paused: 'One of your runs paused and needs you.',
  run_failed: 'One of your runs failed.',
  run_succeeded: 'One of your runs finished.',
  approval_needed: 'A step is waiting for your approval.',
  input_needed: 'One of your runs is waiting for you to fill in a form.',
  delegation_requested: 'A teammate asked you to run an action with your account.',
  delegation_decided: 'A teammate answered your delegation request.',
  delegation_reminder: 'Reminder: a teammate is still waiting for you to run an action.',
  delegation_cancelled: 'A delegation request to you was withdrawn.',
  delegation_delegate_offboarded: 'The teammate you asked to run an action left (your identity provider offboarded them), so your request was cancelled and your run paused. Ask someone else or cancel the run.',
  delegation_expired: 'Your delegation request expired without an answer.',
  delegation_escalated: "A teammate's delegation request expired; someone may need to step in.",
  module_review_needed: 'A module is waiting for admin review.',
  schedule_failed: 'One of your schedules could not start its Flow.',
  followup_failed: 'A Flow you set to run after another one could not start.',
  plan_needs_answers: 'Your plan has questions for you before anything is built.',
  plan_needs_attention: 'Something in your plan needs your attention.',
  plan_ready: 'Everything in your plan is drafted and approved; its Flows are waiting for approval.',
  plan_failed: 'Your plan could not be read.',
  breakglass_used: 'Break-glass access was used. Check the reason and what was run in the audit report.',
  access_review_due: 'Some access you hold is due for review: keep what you still need, remove the rest.',
  access_removed: 'A stored credential was removed because nobody confirmed it was still needed.',
  module_drift: 'A module keeps failing in a way that suggests the app it connects to changed.',
  ai_budget_warning: "Your team has used most of this month's AI budget.",
  watch_failed: 'A watch that starts a Flow for new items could not check for them.',
  audit_anchor_failed: 'Today\'s audit hash could not be sent to the place set up to keep a copy.',
  flow_fix_proposed: 'An app one of your Flows uses changed. Dittoly fixed the module and proposed a new version of your Flow; it waits for approval.',
  module_fix_failed: 'An app changed and Dittoly could not draft a working fix for its module by itself. Someone needs to look at it.',
  audit_stream_failed: 'Audit events could not be sent to a SIEM set up by an admin. Dittoly keeps trying and will send everything missed.',
  flow_approval_needed: 'A new Flow version is waiting for your approval.',
  approval_reminder: 'Reminder: an approval is still waiting for you.',
  approval_escalated: 'An approval has been waiting too long; please make sure someone decides.',
  standin_assigned: 'A teammate asked you to approve for them while they are away.',
  gateway_tool_blocked: 'An app tool offered to AI agents changed after it was approved, so it is blocked. Check it and offer it again on the Agents page.',
  reversal_needs_approval: 'Someone asked to reverse changes a run or an AI agent made. Check the reason and what would be reversed, then sign off or reject.',
  reversal_finished: 'The reversal you asked for has finished, or was rejected. Open it to see what was reversed.',
  agent_confirmation_needed: 'One of your AI agents wants to make a change. Confirm or reject it on the Agents page in Dittoly.',
  member_offboarded: 'Your identity provider offboarded someone. Their access is revoked; under Members & Access, Provisioning (SCIM), see the Flows, schedules, watches, webhooks, Flow URLs and follow-ups they owned so someone can take them over, and the pending delegations that were cancelled.',
  cost_cap_reached: 'A run reached its AI cost cap and waits. Its owner or an approver of its team can allow it to spend more, or cancel it.',
  pinned_model_unavailable: "The AI model a Flow run asked for is no longer available, so its AI step used the organization's model instead. Lock the Flow to another model, or let it follow the organization's, from its review page.",
  model_change_checked: 'The organization moved to a new AI model. A Flow was checked with it and waits for an approver to accept the switch or keep its model.',
  autostop_tripped: 'A Flow or an AI agent was stopped automatically because a control kept failing. See what tripped it, and resume it, under Automatic stops.',
  autostop_resumed: 'A Flow or an AI agent that was stopped automatically has been resumed. The reason is under Automatic stops.',
};

/** Kinds that only create noise by email; they stay in the portal inbox. */
const PORTAL_ONLY = new Set<NotificationKind>(['run_succeeded']);

export interface DeliveryChannels {
  mailer: Mailer | null;
  slack: SlackNotifier | null;
  /** The organization's Teams channel. */
  teams: TeamsNotifier | null;
  /** Members' own Teams chats: decrypts a stored URL and builds a notifier for it. */
  teamsPersonal?: { cipher: Cipher; fetchFn: FetchLike };
  /** Teams' own channels (module actions). Where a team has any, they replace the channels above. */
  teamChannels?: TeamChannels;
}

export const teamsWebhookAad = (memberId: string) => `teams-webhook:${memberId}`;

interface Pending {
  kind: NotificationKind;
  run_id: string | null;
  delegation_id: string | null;
  plan_id: string | null;
  flow_id: string | null;
  flow_version_id: string | null;
  emailed_at: Date | null;
  slack_at: Date | null;
  teams_at: Date | null;
  member_id: string;
  handle: string;
  display_name: string | null;
  email: string | null;
  slack_user_id: string | null;
  teams_webhook_enc: string | null;
  notify_email: boolean;
  notify_slack: boolean;
  notify_teams: boolean;
  notify_team_channels: boolean;
  disabled: boolean;
}

/**
 * Sends a notification on every configured channel the member has not turned
 * off. Each channel records its own delivery, so a retry after a partial
 * failure only resends what did not go out.
 */
export class NotificationDelivery {
  constructor(
    private readonly db: Db,
    private readonly channels: DeliveryChannels,
    private readonly publicUrl: string,
    /** More to say for some kinds (the cost forecast of a Flow version waiting for approval); never run data. */
    private readonly detail?: (n: { kind: NotificationKind; flowVersionId: string | null; runId: string | null }) => Promise<string | null>,
  ) {}

  async deliver(notificationId: string): Promise<void> {
    const { mailer, slack, teams, teamsPersonal, teamChannels } = this.channels;
    if (!mailer && !slack && !teams && !teamsPersonal && !teamChannels) return;
    const { rows } = await this.db.query<Pending>(
      `SELECT n.kind, n.run_id, n.delegation_id, n.plan_id, n.flow_version_id, n.emailed_at,
              (SELECT v.flow_id FROM flow_versions v WHERE v.id = n.flow_version_id) AS flow_id, n.slack_at, n.teams_at,
              m.id AS member_id, m.handle, m.display_name, m.email, m.slack_user_id, m.teams_webhook_enc,
              m.notify_email, m.notify_slack, m.notify_teams, m.notify_team_channels, m.disabled
       FROM notifications n JOIN members m ON m.id = n.member_id WHERE n.id = $1`,
      [notificationId],
    );
    const n = rows[0];
    if (!n || n.disabled || PORTAL_ONLY.has(n.kind)) return;
    const path = n.delegation_id ? `/delegations/${n.delegation_id}` : n.run_id ? `/runs/${n.run_id}` : n.plan_id ? `/plans/${n.plan_id}` : n.flow_id ? `/flows/${n.flow_id}` : '/';
    let text = TEXT[n.kind] ?? 'There is something new for you in Dittoly.';
    const more = this.detail ? await this.detail({ kind: n.kind, flowVersionId: n.flow_version_id, runId: n.run_id }).catch(() => null) : null;
    if (more) text = `${text} ${more}`;
    const url = `${this.publicUrl}${path}`;

    // The team the notification is about (its run's), else the member's default team.
    if (teamChannels) {
      const team = await this.teamFor(n);
      const list = team ? await teamChannels.forTeam(team) : [];
      if (list.length) {
        if (!n.notify_team_channels) return;
        const sent = new Set(
          (await this.db.query<{ channel_id: string }>(`SELECT channel_id FROM notification_channel_deliveries WHERE notification_id = $1`, [notificationId])).rows.map((r) => r.channel_id),
        );
        let channelFailed: unknown = null;
        for (const c of list.filter((x) => !sent.has(x.id))) {
          try {
            await teamChannels.send(c, { text, url, kind: n.kind }, { email: n.email, name: n.display_name ?? n.handle, handle: n.handle });
            await this.db.query(`INSERT INTO notification_channel_deliveries (notification_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [notificationId, c.id]);
          } catch (err) {
            log.warn('notification_failed', { channel: 'team_channel', errorType: errorType(err) });
            channelFailed = err;
          }
        }
        if (channelFailed) throw channelFailed; // retried; channels that already went out are skipped
        return;
      }
    }

    let failed: unknown = null;
    const attempt = async (channel: 'email' | 'slack' | 'teams', column: string, send: () => Promise<void>) => {
      try {
        await send();
        await this.db.query(`UPDATE notifications SET ${column} = now() WHERE id = $1`, [notificationId]);
      } catch (err) {
        if (err instanceof Unreachable) {
          log.info('notification_unreachable', { channel, errorType: err.message });
          return;
        }
        log.warn('notification_failed', { channel, errorType: errorType(err) });
        failed = err;
      }
    };

    if (mailer && !n.emailed_at && n.email && n.notify_email) {
      await attempt('email', 'emailed_at', () =>
        mailer.send({
          to: n.email!,
          subject: `Dittoly: ${text}`,
          text: `${text}\n\nOpen it in Dittoly: ${url}\n\nYou can turn these emails off under My credentials > Notifications.\n`,
        }),
      );
    }
    if (slack && !n.slack_at && n.notify_slack) {
      await attempt('slack', 'slack_at', async () => {
        let userId = n.slack_user_id;
        if (!userId) {
          if (!n.email) throw new Unreachable('no_email');
          userId = await slack.lookup(n.email);
          await this.db.query(`UPDATE members SET slack_user_id = $2 WHERE id = $1`, [n.member_id, userId]);
        }
        await slack.send(userId, { text, url });
      });
    }
    // A member's own Teams chat replaces the shared channel for them.
    if (teamsPersonal && n.teams_webhook_enc && !n.teams_at && n.notify_teams) {
      await attempt('teams', 'teams_at', async () => {
        const hook = teamsPersonal.cipher.decrypt(n.teams_webhook_enc!, teamsWebhookAad(n.member_id));
        try {
          await new TeamsNotifier(hook, teamsPersonal.fetchFn).send(null, { text, url });
        } catch (err) {
          // A deleted or disabled workflow will not start working on a retry.
          const m = /^teams_http_(4\d\d)$/.exec((err as Error).message);
          if (m && m[1] !== '408' && m[1] !== '429') throw new Unreachable(`teams_personal_http_${m[1]}`);
          throw err;
        }
      });
    } else if (teams && !n.teams_at && n.notify_teams) {
      await attempt('teams', 'teams_at', () => teams.send(n.display_name ?? n.handle, { text, url }));
    }
    if (failed) throw failed; // the job is retried; channels that already went out are skipped
  }

  private async teamFor(n: Pending): Promise<string | null> {
    const runId =
      n.run_id ?? (n.delegation_id ? (await this.db.query<{ run_id: string }>(`SELECT run_id FROM delegations WHERE id = $1`, [n.delegation_id])).rows[0]?.run_id : undefined);
    if (runId) {
      const r = await this.db.query<{ team_id: string }>(
        `SELECT f.team_id FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id WHERE r.id = $1`,
        [runId],
      );
      if (r.rows[0]) return r.rows[0].team_id;
    }
    const d = await this.db.query<{ team_id: string }>(
      `SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.member_id = $1 ORDER BY t.is_default DESC, t.name LIMIT 1`,
      [n.member_id],
    );
    return d.rows[0]?.team_id ?? null;
  }
}

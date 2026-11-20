-- Notification channels per team: an approved module action (e.g. Slack
-- "post a message") with templated inputs, run with the team's shared
-- credentials. When a team has channels, they replace the server-wide
-- Slack/Teams/SMTP settings for its notifications.
CREATE TABLE team_notify_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        text NOT NULL,
  module      text NOT NULL,
  action      text NOT NULL,
  input       jsonb NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_notify_channels_team ON team_notify_channels (team_id);
-- Which channels a notification already went out on, so a retry only resends the rest.
CREATE TABLE notification_channel_deliveries (
  notification_id  bigint NOT NULL,
  channel_id       uuid NOT NULL REFERENCES team_notify_channels(id) ON DELETE CASCADE,
  sent_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, channel_id)
);
ALTER TABLE members ADD COLUMN notify_team_channels boolean NOT NULL DEFAULT true;

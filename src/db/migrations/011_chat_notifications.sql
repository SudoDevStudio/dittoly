-- Slack and Teams delivery of notifications (opt-out per member and channel).
ALTER TABLE members
  ADD COLUMN notify_slack  boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_teams  boolean NOT NULL DEFAULT true,
  ADD COLUMN slack_user_id text;
ALTER TABLE notifications
  ADD COLUMN slack_at timestamptz,
  ADD COLUMN teams_at timestamptz;

-- Home chats, kept so a person (or a teammate in the same team) can come back to a plan: the messages and the latest
-- plan, encrypted, until expires_at (the organization's chat retention after the last message; 30 days by default).
CREATE TABLE home_chats (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    uuid NOT NULL REFERENCES members(id),
  team_id       uuid REFERENCES teams(id) ON DELETE CASCADE,
  title         text NOT NULL,
  messages_enc  text NOT NULL,
  plan_enc      text,
  -- The plan "Build it" started from this chat.
  plan_id       uuid REFERENCES plans(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX home_chats_team ON home_chats (team_id, updated_at DESC);
CREATE INDEX home_chats_owner ON home_chats (created_by, updated_at DESC);
CREATE INDEX home_chats_expires ON home_chats (expires_at);

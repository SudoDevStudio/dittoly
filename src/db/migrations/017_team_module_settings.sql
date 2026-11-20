-- A team's own values for module settings (e.g. its own Jira site). They
-- override the organization's values key by key; unset keys fall back to them.
CREATE TABLE team_module_settings (
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  module_name  text NOT NULL,
  values       jsonb NOT NULL,
  updated_by   uuid REFERENCES members(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, module_name)
);

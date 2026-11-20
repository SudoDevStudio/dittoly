-- Team credentials: a shared service account a team's admins store for a
-- module credential they mark "team". Everyone's runs in that team use it;
-- credentials left "personal" keep using each member's own vault.
CREATE TABLE team_credentials (
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  service     text NOT NULL,
  secret_enc  text NOT NULL,
  updated_by  uuid REFERENCES members(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, service)
);
-- Per team, module and credential service: whose access a step uses. No row = personal.
CREATE TABLE team_credential_modes (
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  module_name  text NOT NULL,
  service      text NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('personal', 'team')),
  updated_by   uuid REFERENCES members(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, module_name, service)
);

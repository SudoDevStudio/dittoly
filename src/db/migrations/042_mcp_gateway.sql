-- Approved module actions an admin offers to AI agents as MCP tools, each pinned to one module
-- version and to the exact name, description and schemas that were approved.
CREATE TABLE gateway_tools (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_name       text NOT NULL,
  action            text NOT NULL,
  module_version_id uuid NOT NULL REFERENCES module_versions(id),
  -- Whose module settings and shared credentials apply, and whose members may use it.
  team_id           uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- sha256 of what the agent is shown and what the call is checked against.
  pin_sha256        text NOT NULL,
  -- active | changed (the app's tool changed after approval: blocked until offered again)
  status            text NOT NULL DEFAULT 'active',
  changed_reason    text,
  offered_by        uuid REFERENCES members(id) ON DELETE SET NULL,
  offered_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_name, action)
);

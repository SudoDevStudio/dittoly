-- Dittoly as an MCP server: AI assistants run approved Flows as tools, as the person.

-- Personal tokens for AI assistants: they only work on /mcp, never on the rest of the API.
CREATE TABLE mcp_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX mcp_tokens_member ON mcp_tokens (member_id);

-- A Flow is offered to AI assistants only when its owner switches this on.
ALTER TABLE flows ADD COLUMN mcp_enabled boolean NOT NULL DEFAULT false;

-- Runs an AI assistant started, and with which token.
ALTER TABLE runs ADD COLUMN mcp_token_id uuid REFERENCES mcp_tokens(id) ON DELETE SET NULL;

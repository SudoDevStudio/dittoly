-- AI agents (MCP tokens) as identities: what each may use, until when, and every call it made.
-- scopes NULL: made before scopes existed; such a token keeps everything its person can use until it is restricted.
ALTER TABLE mcp_tokens ADD COLUMN scopes jsonb;
ALTER TABLE mcp_tokens ADD COLUMN expires_at timestamptz;

-- Every tool call an agent made, and calls waiting for its person to confirm them.
CREATE TABLE agent_calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id    uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  tool        text NOT NULL,
  -- done | failed | denied | awaiting_confirmation | rejected | expired
  status      text NOT NULL,
  error       text,
  run_id      uuid REFERENCES runs(id) ON DELETE SET NULL,
  -- The arguments of a call that waits for confirmation, encrypted; cleared once decided.
  args_enc    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX agent_calls_token ON agent_calls (token_id, created_at DESC);
CREATE INDEX agent_calls_waiting ON agent_calls (member_id) WHERE status = 'awaiting_confirmation';

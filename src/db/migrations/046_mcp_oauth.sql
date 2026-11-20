-- OAuth sign-in for Dittoly's own MCP server (/mcp): AI apps such as Claude, ChatGPT or Copilot Studio
-- connect by signing the person in instead of a pasted token. Each approved connection is an agent
-- (an mcp_tokens row) made on the consent page; only hashes of codes and tokens are stored.

-- Agents made by OAuth sign-in: which app asked (its client id and the name it gave).
ALTER TABLE mcp_tokens ADD COLUMN oauth_client_id text;
ALTER TABLE mcp_tokens ADD COLUMN oauth_client_name text;

-- Apps that registered themselves (RFC 7591). Apps identified by a metadata document (an https client id) are not stored.
CREATE TABLE mcp_oauth_clients (
  client_id      text PRIMARY KEY,
  name           text NOT NULL,
  redirect_uris  text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- An authorization request waiting for its person on the consent page (10 minutes).
CREATE TABLE mcp_oauth_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL,
  client_name     text NOT NULL,
  -- 'metadata' (client id metadata document) or 'registered' (dynamic registration)
  client_kind     text NOT NULL,
  redirect_uri    text NOT NULL,
  state           text NOT NULL,
  code_challenge  text NOT NULL,
  scope           text NOT NULL,
  -- The first person who opens it; nobody else can approve it.
  member_id       uuid REFERENCES members(id) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL
);

-- An approved connection: one app, one agent. Revoking the agent revokes it.
CREATE TABLE mcp_oauth_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id      uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  client_id     text NOT NULL,
  redirect_uri  text NOT NULL,
  resource      text NOT NULL,
  scope         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX mcp_oauth_grants_token ON mcp_oauth_grants (token_id);

-- Authorization codes: single use, 60 seconds.
CREATE TABLE mcp_oauth_codes (
  code_hash       text PRIMARY KEY,
  grant_id        uuid NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  client_id       text NOT NULL,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

-- Access tokens (an hour) and refresh tokens (rotated on every use; a used one presented again revokes the grant).
CREATE TABLE mcp_oauth_tokens (
  token_hash  text PRIMARY KEY,
  grant_id    uuid NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  -- 'access' | 'refresh'
  kind        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_oauth_tokens_grant ON mcp_oauth_tokens (grant_id);

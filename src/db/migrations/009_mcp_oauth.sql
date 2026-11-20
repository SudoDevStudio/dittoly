-- OAuth for MCP servers: one client registration per authorization server,
-- and short-lived pending authorizations. Tokens live in each member's vault.
CREATE TABLE oauth_clients (
  issuer           text PRIMARY KEY,
  client_info_enc  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_pending (
  state        text PRIMARY KEY,
  member_id    uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  server_url   text NOT NULL,
  service      text NOT NULL,
  verifier_enc text NOT NULL,
  issuer       text,
  return_to    text NOT NULL DEFAULT '/',
  expires_at   timestamptz NOT NULL
);

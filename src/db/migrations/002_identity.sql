-- Phase 1 identity: OIDC members, browser sessions, disabled members.

ALTER TABLE members
  ADD COLUMN oidc_issuer  text,
  ADD COLUMN oidc_subject text,
  ADD COLUMN email        text,
  ADD COLUMN display_name text,
  ADD COLUMN disabled     boolean NOT NULL DEFAULT false,
  ALTER COLUMN token_hash DROP NOT NULL;

CREATE UNIQUE INDEX members_oidc_identity ON members (oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL;

-- Browser sessions. The cookie holds a random token; only its hash is stored.
CREATE TABLE sessions (
  token_hash    text PRIMARY KEY,
  member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_member ON sessions (member_id);

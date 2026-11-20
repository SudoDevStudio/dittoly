-- Phones (and the glasses paired to them): a member scans a one-time QR code from
-- the portal; the phone gets its own revocable session that can only use the
-- voice/command endpoints. Only hashes of codes and tokens are stored.
CREATE TABLE device_pairings (
  code_hash   text PRIMARY KEY,
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_member ON devices (member_id);

-- What a command will do once the person says yes: kept briefly, encrypted.
CREATE TABLE device_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('run', 'gate', 'input', 'delegation')),
  payload_enc  text NOT NULL,
  summary      text NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

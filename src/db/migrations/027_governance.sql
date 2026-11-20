-- Governance: policy rules, several approvers, tamper-evident audit, break-glass,
-- access reviews, token scope checks, dry runs; and module health: recorded tests
-- and drift detection.

-- Policy rules an admin sets (form-based, fixed kinds).
CREATE TABLE policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('approvals_for_writes', 'allowed_hosts', 'no_delegation', 'run_window', 'max_runs_per_day')),
  config      jsonb NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  note        text,
  created_by  uuid REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A Flow version a policy says needs more than one approver collects approvals here.
CREATE TABLE flow_version_approvals (
  version_id   uuid NOT NULL REFERENCES flow_versions(id) ON DELETE CASCADE,
  approver_id  uuid NOT NULL REFERENCES members(id),
  approved_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, approver_id)
);

-- The audit log is append-only; a background job chains every event's hash to the one
-- before it, so a changed or removed event shows up when the chain is verified.
CREATE TABLE audit_seals (
  event_id  bigint PRIMARY KEY REFERENCES audit_events(id),
  hash      text NOT NULL
);
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events cannot be changed or deleted';
END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- Break-glass: accounts an admin marks for emergencies, and time-boxed uses of them.
ALTER TABLE members ADD COLUMN breakglass boolean NOT NULL DEFAULT false;
CREATE TABLE breakglass_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES members(id),
  act_as      uuid NOT NULL REFERENCES members(id),
  reason      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ended_at    timestamptz
);
ALTER TABLE runs ADD COLUMN breakglass_id uuid REFERENCES breakglass_grants(id);
ALTER TABLE runs ADD COLUMN dry boolean NOT NULL DEFAULT false;

-- Access reviews: stored credentials and team memberships are confirmed every quarter.
ALTER TABLE credentials ADD COLUMN review_due_at timestamptz NOT NULL DEFAULT now() + interval '90 days';
ALTER TABLE credentials ADD COLUMN review_notified_at timestamptz;
ALTER TABLE credentials ADD COLUMN scope_check jsonb;
ALTER TABLE team_credentials ADD COLUMN review_due_at timestamptz NOT NULL DEFAULT now() + interval '90 days';
ALTER TABLE team_credentials ADD COLUMN review_notified_at timestamptz;
ALTER TABLE team_credentials ADD COLUMN scope_check jsonb;
ALTER TABLE team_members ADD COLUMN review_due_at timestamptz NOT NULL DEFAULT now() + interval '90 days';
ALTER TABLE team_members ADD COLUMN review_notified_at timestamptz;

-- Module health: every action call's outcome (no data), for drift detection.
CREATE TABLE module_calls (
  id           bigserial PRIMARY KEY,
  module_name  text NOT NULL,
  version      text NOT NULL,
  action       text NOT NULL,
  ok           boolean NOT NULL,
  error_type   text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX module_calls_recent ON module_calls (module_name, at);
CREATE TABLE module_drift (
  module_name  text PRIMARY KEY,
  version      text NOT NULL,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  summary      jsonb NOT NULL,
  resolved_at  timestamptz
);

-- Recorded tests: real calls captured once (secrets masked), replayed against every new version.
CREATE TABLE module_recordings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_name  text NOT NULL,
  action       text NOT NULL,
  name         text NOT NULL,
  test         jsonb NOT NULL,
  recorded_by  uuid REFERENCES members(id),
  from_version text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX module_recordings_module ON module_recordings (module_name);

-- Chat apps (Telegram, WhatsApp) linked like phones: same command session, same yes-first rule.
ALTER TABLE devices ADD COLUMN channel text NOT NULL DEFAULT 'phone' CHECK (channel IN ('phone', 'telegram', 'whatsapp'));
ALTER TABLE devices ADD COLUMN external_id text;
CREATE UNIQUE INDEX devices_channel_external ON devices (channel, external_id) WHERE external_id IS NOT NULL AND revoked_at IS NULL;
CREATE TABLE chat_link_codes (
  code_hash   text PRIMARY KEY,
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
-- Runs started from a chat app: the chat is told when they finish or need the person.
CREATE TABLE chat_follows (
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  last_status  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, run_id)
);
-- Small bits of state, e.g. the last Telegram update read.
CREATE TABLE chat_state (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

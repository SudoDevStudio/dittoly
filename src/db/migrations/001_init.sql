-- Dittoly prototype schema.
-- Columns ending in _enc hold AES-256-GCM ciphertext (see src/core/crypto.ts).
-- Audit and notification tables hold IDs, times, statuses and error types only (decision D2).

CREATE TABLE members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle      text NOT NULL UNIQUE,
  role        text NOT NULL CHECK (role IN ('admin', 'approver', 'member')),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Personal credential vault: one secret per member per service. Never shared.
CREATE TABLE credentials (
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  service     text NOT NULL,
  secret_enc  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, service)
);

CREATE TABLE module_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  version           text NOT NULL,
  manifest          jsonb NOT NULL,
  code              text NOT NULL,
  code_sha256       text NOT NULL,
  manifest_sha256   text NOT NULL,
  tests             jsonb NOT NULL DEFAULT '[]',
  origin           text NOT NULL CHECK (origin IN ('chat', 'seed')),
  status            text NOT NULL CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected')),
  validation_report jsonb,
  created_by        uuid REFERENCES members(id),
  reviewed_by       uuid REFERENCES members(id),
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

-- Module versions are immutable once written: an upgrade is always a new row.
CREATE FUNCTION module_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.code_sha256 IS DISTINCT FROM OLD.code_sha256
     OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256 THEN
    RAISE EXCEPTION 'module versions are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER module_versions_immutable BEFORE UPDATE ON module_versions
  FOR EACH ROW EXECUTE FUNCTION module_versions_immutable();

CREATE TABLE flows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_by  uuid NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flow_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id        uuid NOT NULL REFERENCES flows(id),
  version        integer NOT NULL,
  definition     jsonb NOT NULL,
  approval_hash  text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  created_by     uuid NOT NULL REFERENCES members(id),
  decided_by     uuid REFERENCES members(id),
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);

CREATE FUNCTION flow_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.approval_hash IS DISTINCT FROM OLD.approval_hash
     OR NEW.flow_id IS DISTINCT FROM OLD.flow_id OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'flow versions are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER flow_versions_immutable BEFORE UPDATE ON flow_versions
  FOR EACH ROW EXECUTE FUNCTION flow_versions_immutable();

CREATE TABLE triggers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_version_id         uuid NOT NULL REFERENCES flow_versions(id),
  run_as                  uuid NOT NULL REFERENCES members(id),
  provider                text NOT NULL CHECK (provider IN ('standard', 'github', 'gitlab')),
  secret_enc              text NOT NULL,
  prev_secret_enc         text,
  prev_secret_expires_at  timestamptz,
  legacy_token_enc        text,
  legacy_token_expires_at timestamptz,
  payload_schema          jsonb NOT NULL,
  input_map               jsonb NOT NULL,
  rate_limit_per_minute   integer NOT NULL,
  enabled                 boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  trigger_id   uuid NOT NULL REFERENCES triggers(id),
  delivery_id  text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trigger_id, delivery_id)
);

CREATE TABLE runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_version_id      uuid NOT NULL REFERENCES flow_versions(id),
  run_as               uuid NOT NULL REFERENCES members(id),
  trigger_id           uuid REFERENCES triggers(id),
  status               text NOT NULL CHECK (status IN ('running', 'waiting', 'paused', 'succeeded', 'failed', 'cancelled')),
  wait_reason          text,
  inputs_enc           text,
  manual_retries_used  integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz
);

CREATE TABLE run_steps (
  run_id       uuid NOT NULL REFERENCES runs(id),
  step_id      text NOT NULL,
  idx          integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'skipped', 'failed', 'not_run')),
  attempts     integer NOT NULL DEFAULT 0,
  lease_until  timestamptz,
  resume_at    timestamptz,
  error_type   text,
  executed_by  uuid REFERENCES members(id),
  output_enc   text,
  progress_enc text,
  started_at   timestamptz,
  finished_at  timestamptz,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE gate_decisions (
  run_id      uuid NOT NULL,
  step_id     text NOT NULL,
  decided_by  uuid NOT NULL REFERENCES members(id),
  decision    text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, step_id)
);

CREATE TABLE delegations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL,
  step_id            text NOT NULL,
  requester_id       uuid NOT NULL REFERENCES members(id),
  delegate_id        uuid NOT NULL REFERENCES members(id),
  module_version_id  uuid NOT NULL REFERENCES module_versions(id),
  action             text NOT NULL,
  inputs_enc         text,
  request_hash       text NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'failed', 'expired', 'cancelled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  decided_at         timestamptz,
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, step_id),
  CHECK (requester_id <> delegate_id)
);
CREATE UNIQUE INDEX delegations_one_open_per_step ON delegations (run_id, step_id)
  WHERE status IN ('pending', 'approved');

-- Durable job queue. Payloads carry IDs only.
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  attempts      integer NOT NULL DEFAULT 0
);
CREATE INDEX jobs_due ON jobs (run_at);

CREATE TABLE notifications (
  id             bigserial PRIMARY KEY,
  member_id      uuid NOT NULL REFERENCES members(id),
  kind           text NOT NULL,
  run_id         uuid,
  step_id        text,
  delegation_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz
);

CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid,
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  outcome       text NOT NULL,
  error_type    text,
  related_id    text
);

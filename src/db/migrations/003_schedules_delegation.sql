-- Phase 1: scheduled triggers and full delegation lifecycle.

CREATE TABLE schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_version_id  uuid NOT NULL REFERENCES flow_versions(id),
  -- Who the Flow runs as is fixed when the schedule is created: always its creator.
  run_as           uuid NOT NULL REFERENCES members(id),
  cron             text NOT NULL,
  timezone         text NOT NULL,
  -- Fixed Flow inputs, encrypted (they are configuration, kept while the schedule exists).
  inputs_enc       text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  disabled_reason  text,
  next_run_at      timestamptz NOT NULL,
  last_run_at      timestamptz,
  last_run_id      uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled;

ALTER TABLE runs ADD COLUMN schedule_id uuid REFERENCES schedules(id);

ALTER TABLE delegations ADD COLUMN reminded_at timestamptz;
ALTER TABLE delegations ADD COLUMN replaced_by uuid REFERENCES delegations(id);

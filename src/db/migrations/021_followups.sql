-- Follow-up Flows: when a member's run of one Flow finishes, start another Flow
-- as that same member, with inputs taken from the finished run.
CREATE TABLE flow_followups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_flow_id     uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Like a schedule, the follow-up is pinned to one approved version and runs as its creator.
  target_version_id  uuid NOT NULL REFERENCES flow_versions(id),
  run_as             uuid NOT NULL REFERENCES members(id),
  on_status          text NOT NULL CHECK (on_status IN ('succeeded', 'failed', 'finished')),
  -- Input templates ({{ inputs.x }}, {{ steps.<id>.output.y }} of the finished run), encrypted.
  inputs_enc         text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  disabled_reason    text,
  last_run_id        uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX flow_followups_source ON flow_followups (source_flow_id) WHERE enabled;

ALTER TABLE runs ADD COLUMN followup_of uuid REFERENCES runs(id);

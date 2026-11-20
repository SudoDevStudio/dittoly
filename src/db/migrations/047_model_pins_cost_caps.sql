-- Model pinning (src/ai/model-changes.ts). A Flow version's AI and browse steps run with the
-- organization's model it was approved with ("provider:model"), not whatever the organization
-- uses now. NULL (versions approved before this) is filled in with the current model on first run.
ALTER TABLE flow_versions ADD COLUMN ai_model text;

-- Every change of a version's model, kept as history: who accepted the switch, when, why, and
-- what the model-change check found.
CREATE TABLE flow_model_pins (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_version_id  uuid NOT NULL REFERENCES flow_versions(id) ON DELETE CASCADE,
  from_model       text NOT NULL,
  to_model         text NOT NULL,
  check_id         uuid,
  -- status, scores and cost of the check at the time of the switch (no data)
  check_summary    jsonb,
  -- set when the approver accepted the switch despite differences
  reason           text,
  decided_by       uuid NOT NULL REFERENCES members(id),
  decided_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX flow_model_pins_version ON flow_model_pins (flow_version_id, decided_at);

-- A model-change check: the version's AI steps asked again with the new model, on the inputs of
-- its tests and recent runs, and compared with the recorded answers.
CREATE TABLE model_change_checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_version_id  uuid NOT NULL REFERENCES flow_versions(id) ON DELETE CASCADE,
  from_model       text NOT NULL,
  to_model         text NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'passed', 'differs', 'failed', 'skipped_budget', 'no_inputs')),
  -- per-step scores (no data)
  summary          jsonb,
  -- per-step differences; may quote test data, so encrypted
  details_enc      text,
  input_tokens     integer NOT NULL DEFAULT 0,
  output_tokens    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  -- 'accepted' or 'kept'; NULL while it waits for an approver
  decision         text CHECK (decision IN ('accepted', 'kept')),
  decided_by       uuid REFERENCES members(id),
  decided_at       timestamptz,
  reason           text
);
CREATE INDEX model_change_checks_open ON model_change_checks (flow_version_id) WHERE decision IS NULL;

-- Cost caps (src/ai/costs.ts): AI use is attributed to the run's step as well as the run.
ALTER TABLE ai_usage ADD COLUMN step_id text;
CREATE INDEX ai_usage_run ON ai_usage (run_id) WHERE run_id IS NOT NULL;

-- More spend allowed for one run after it paused at its cost cap (who, how much, when).
CREATE TABLE run_cost_allowances (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tokens      bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  amount      numeric(14, 4) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  allowed_by  uuid NOT NULL REFERENCES members(id),
  allowed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_cost_allowances_run ON run_cost_allowances (run_id);

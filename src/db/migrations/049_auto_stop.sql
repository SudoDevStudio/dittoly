-- Automatic stops (src/governance/auto-stop.ts): a Flow or an AI agent is stopped when a control
-- keeps failing (blocked calls, a spend spike, a failure spike, rejected sign-offs on AI-written text).

-- What the triggers count, where it happens: one row per event (ids, codes and token counts, no data).
-- Counters are sums over the last window, read with the index below.
CREATE TABLE autostop_events (
  id            bigserial PRIMARY KEY,
  subject_type  text NOT NULL CHECK (subject_type IN ('flow', 'agent')),
  subject_id    uuid NOT NULL,
  trigger       text NOT NULL CHECK (trigger IN ('blocked_calls', 'spend_spike', 'failure_spike', 'rejected_signoffs')),
  -- e.g. 'violation', 'scope_denied', 'ai_tokens', 'cost_cap', 'run_failed', 'drift_error', 'sign_off_rejected'
  kind          text NOT NULL,
  -- an error code or a step id
  detail        text,
  run_id        uuid,
  -- tokens for 'ai_tokens'; 1 otherwise
  amount        bigint NOT NULL DEFAULT 1,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX autostop_events_window ON autostop_events (subject_type, subject_id, trigger, at);
CREATE INDEX autostop_events_at ON autostop_events (at);

-- Every trip and its resume: which trigger, the events that crossed the threshold, who resumed it,
-- when and why, and what happened to each paused run.
CREATE TABLE autostops (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   text NOT NULL CHECK (subject_type IN ('flow', 'agent')),
  subject_id     uuid NOT NULL,
  trigger        text NOT NULL,
  -- the threshold that was crossed and the events that crossed it (ids, codes, counts; no data)
  evidence       jsonb NOT NULL,
  tripped_at     timestamptz NOT NULL DEFAULT now(),
  resumed_at     timestamptz,
  resumed_by     uuid REFERENCES members(id),
  resume_reason  text,
  -- per paused run: 'continued' or 'cancelled'
  run_decisions  jsonb
);
-- One open stop per Flow or agent: two workers tripping at once make one record.
CREATE UNIQUE INDEX autostops_open ON autostops (subject_type, subject_id) WHERE resumed_at IS NULL;
CREATE INDEX autostops_subject ON autostops (subject_type, subject_id, tripped_at);

-- Runs per Flow in the last minutes (failure spike: share of runs that failed).
CREATE INDEX runs_version_created ON runs (flow_version_id, created_at);

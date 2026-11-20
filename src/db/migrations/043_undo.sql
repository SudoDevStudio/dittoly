-- Undo: for each write a module declares a reversal for, what reverses it (encrypted, kept for
-- the org's undo window), and people's requests to reverse a run or an agent's call.
CREATE TABLE undo_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid REFERENCES runs(id) ON DELETE CASCADE,
  step_id           text,
  item              integer NOT NULL DEFAULT 0,
  agent_call_id     uuid REFERENCES agent_calls(id) ON DELETE CASCADE,
  -- Whose access made the change; the reversal uses the same access.
  member_id         uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  team_id           uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  module_version_id uuid NOT NULL REFERENCES module_versions(id),
  action            text NOT NULL,
  undo_action       text NOT NULL,
  -- The reversing action's input, built when the write succeeded; cleared once used or expired.
  input_enc         text,
  -- ready | reversing | reversed | failed | expired
  status            text NOT NULL DEFAULT 'ready',
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  reversed_at       timestamptz
);
CREATE INDEX undo_records_run ON undo_records (run_id);
CREATE INDEX undo_records_call ON undo_records (agent_call_id);
CREATE INDEX undo_records_expiring ON undo_records (expires_at) WHERE status = 'ready';

CREATE TABLE reversals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid REFERENCES runs(id) ON DELETE CASCADE,
  agent_call_id uuid REFERENCES agent_calls(id) ON DELETE CASCADE,
  requested_by  uuid REFERENCES members(id) ON DELETE SET NULL,
  reason        text NOT NULL,
  undo_ids      uuid[] NOT NULL,
  -- pending | rejected | running | done | partly_failed
  status        text NOT NULL DEFAULT 'pending',
  decided_by    uuid REFERENCES members(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reversals_pending ON reversals (created_at) WHERE status = 'pending';

-- Super Flows: a flow step runs other approved Flows as child runs. The parent
-- waits for them; each child's result is kept here when it finishes, so the
-- parent can use it even after the child's own outputs are cleared.
ALTER TABLE runs ADD COLUMN parent_run_id uuid REFERENCES runs(id);

CREATE TABLE run_children (
  parent_run_id  uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id        text NOT NULL,
  key            text NOT NULL,
  child_run_id   uuid NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'running',
  -- { runId, status, steps: { <step id>: output } }, encrypted.
  result_enc     text,
  PRIMARY KEY (parent_run_id, step_id, key)
);

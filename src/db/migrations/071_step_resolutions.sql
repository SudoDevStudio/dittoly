-- Getting past a failed step without retrying it: skip it, or give its result by hand. A step that only reads (or an
-- AI step) is resolved by the run's member at once; one that changes data waits for an approver, with the result
-- they would continue with kept encrypted in run_steps.proposed_enc until then (src/engine/engine.ts resolveStep).
ALTER TABLE run_steps ADD COLUMN proposed_enc text;
CREATE TABLE step_resolutions (
  run_id        uuid NOT NULL,
  step_id       text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('skip', 'result')),
  -- The error the step had when someone got past it.
  error_type    text,
  status        text NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  requested_by  uuid NOT NULL REFERENCES members(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES members(id),
  decided_at    timestamptz,
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, step_id)
);

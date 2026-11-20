-- Flow tests: runs played with recorded answers (no app is called), shown to approvers.
CREATE TABLE flow_tests (
  id          uuid PRIMARY KEY,
  flow_id     uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- inputs, recorded answers, sign-off decisions and expectations (may hold real data from a run)
  case_enc    text NOT NULL,
  created_by  uuid NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX flow_tests_flow ON flow_tests (flow_id);

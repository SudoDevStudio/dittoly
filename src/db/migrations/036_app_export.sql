-- Exported apps: brand themes saved for reuse, a record of each export, and (inside an
-- exported app) which waiting steps were already announced.
CREATE TABLE brand_themes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  brand       jsonb NOT NULL,
  created_by  uuid REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('runner', 'api', 'ui', 'custom')),
  framework   text,
  flow_versions uuid[] NOT NULL,
  sha256      text NOT NULL,
  created_by  uuid REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_notices (
  run_id   uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id  text NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_id)
);

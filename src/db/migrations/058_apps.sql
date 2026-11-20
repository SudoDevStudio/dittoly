-- Apps: pages (a page plan) over a team's approved Flows, opened inside Dittoly by the team and exported later.
-- An app is shared by its team: every member opens the same app, and its runs use the team's shared credentials.
CREATE TABLE apps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams(id),
  name        text NOT NULL,
  created_by  uuid NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by uuid REFERENCES members(id)
);
CREATE INDEX apps_team_idx ON apps (team_id);

-- Each change is a new version; an approver signs it off before the team sees it. The live version stays live
-- until a newer one is approved.
CREATE TABLE app_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES apps(id),
  version     integer NOT NULL,
  status      text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  -- { flows: [{ flowId }], plan, brand }
  spec        jsonb NOT NULL,
  created_by  uuid NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_by  uuid REFERENCES members(id),
  decided_at  timestamptz,
  UNIQUE (app_id, version)
);

-- What an approver signed off never changes: only the status and the decision may be set.
CREATE FUNCTION app_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.spec IS DISTINCT FROM OLD.spec OR NEW.app_id IS DISTINCT FROM OLD.app_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'app versions are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER app_versions_immutable BEFORE UPDATE ON app_versions
  FOR EACH ROW EXECUTE FUNCTION app_versions_immutable();

-- Runs started from an app: the app's pages list them for the whole team.
ALTER TABLE runs ADD COLUMN app_id uuid REFERENCES apps(id);
CREATE INDEX runs_app_idx ON runs (app_id, created_at DESC) WHERE app_id IS NOT NULL;

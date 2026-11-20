-- Teams: an organization has several teams; Flows (and so their runs, schedules
-- and webhooks) belong to one. Members can be in several teams, each with a
-- team role. Modules stay organization-wide and are reviewed once.
CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  -- New members join the default team.
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_one_default ON teams (is_default) WHERE is_default;

CREATE TABLE team_members (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin', 'member')),
  PRIMARY KEY (team_id, member_id)
);
CREATE INDEX team_members_member ON team_members (member_id);

-- Everything that exists today goes into one default team, with everyone in it.
INSERT INTO teams (name, is_default) VALUES ('Default', true);
INSERT INTO team_members (team_id, member_id, role)
  SELECT t.id, m.id, CASE WHEN m.role = 'admin' THEN 'admin' ELSE 'member' END FROM teams t, members m WHERE t.is_default;
ALTER TABLE flows ADD COLUMN team_id uuid REFERENCES teams(id);
UPDATE flows SET team_id = (SELECT id FROM teams WHERE is_default);
ALTER TABLE flows ALTER COLUMN team_id SET NOT NULL;
CREATE INDEX flows_team ON flows (team_id);

-- Every new member (API, SSO or local) joins the default team; org admins as its admins.
CREATE FUNCTION join_default_team() RETURNS trigger AS $$
BEGIN
  INSERT INTO team_members (team_id, member_id, role)
    SELECT id, NEW.id, CASE WHEN NEW.role = 'admin' THEN 'admin' ELSE 'member' END FROM teams WHERE is_default
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER members_join_default_team AFTER INSERT ON members FOR EACH ROW EXECUTE FUNCTION join_default_team();

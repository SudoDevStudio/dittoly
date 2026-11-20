-- Git sync (src/git-sync/): approved modules, Flows (Super Flows too) and apps are written to a git repository as a
-- pull request. One connection for the organization and, optionally, one per team (a team's own wins for its Flows
-- and apps). Without a connection nothing is synced. The token is encrypted and never shown again.
CREATE TABLE git_connections (
  id          uuid PRIMARY KEY,
  -- NULL: the organization's connection.
  team_id     uuid REFERENCES teams(id),
  provider    text NOT NULL CHECK (provider IN ('github', 'gitlab', 'git')),
  repo_url    text NOT NULL,
  branch      text NOT NULL DEFAULT 'main',
  folder      text NOT NULL DEFAULT 'dittoly',
  token_enc   text NOT NULL,
  created_by  uuid NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX git_connections_scope ON git_connections ((COALESCE(team_id::text, 'org')));

-- One row per approved version written (or being written) to a connection.
CREATE TABLE git_exports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES git_connections(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('module', 'flow', 'app', 'all')),
  -- The approved version (NULL for "everything approved now").
  version_id    uuid,
  title         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'opened', 'pushed', 'unchanged', 'failed')),
  branch        text,
  url           text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX git_exports_once ON git_exports (connection_id, kind, version_id) WHERE version_id IS NOT NULL;
CREATE INDEX git_exports_recent ON git_exports (connection_id, created_at DESC);

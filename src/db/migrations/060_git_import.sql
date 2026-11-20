-- Git sync, git → Dittoly (src/git-sync/import.ts): what is merged into the connected branch comes back as new
-- versions that wait for approval in Dittoly. The branch is read every few minutes and on request.
ALTER TABLE git_connections
  ADD COLUMN last_import_commit text,
  ADD COLUMN last_import_at timestamptz;

-- Modules drafted from a file in git.
ALTER TABLE module_versions DROP CONSTRAINT module_versions_origin_check;
ALTER TABLE module_versions ADD CONSTRAINT module_versions_origin_check CHECK (origin IN ('chat', 'seed', 'mcp', 'script', 'assistant', 'git'));

-- One row per read of the branch that found something to do (or could not read it).
CREATE TABLE git_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES git_connections(id) ON DELETE CASCADE,
  commit_sha    text,
  status        text NOT NULL CHECK (status IN ('imported', 'failed')),
  -- [{ kind, name, version, id }]: the versions now waiting for approval.
  created       jsonb NOT NULL DEFAULT '[]',
  problems      text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_imports_recent ON git_imports (connection_id, created_at DESC);

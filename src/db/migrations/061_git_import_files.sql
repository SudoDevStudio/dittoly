-- Git sync, git → Dittoly: what was last handled for each synced file (a module's folder counts as one), so each
-- change is handled once (src/git-sync/import.ts).
-- sha256/version: the content last handled and the Dittoly version it matched or became (null when none did).
-- waiting_sha: newer content held back (another version waits for a decision, or a Flow it runs is not here yet);
-- the branch is read again until it is handled, without needing another commit.
CREATE TABLE git_import_files (
  connection_id uuid NOT NULL REFERENCES git_connections(id) ON DELETE CASCADE,
  path          text NOT NULL,
  sha256        text,
  version       text,
  waiting_sha   text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, path)
);

-- How a module or a Flow came to be what it is. Every version already records how it was drafted (its
-- generation), but the words a person typed — "when a build fails, open a draft PR", then "keep it to one
-- commit" — lived only in the progress list, which is wiped. This is that trail, kept with the artifact rather
-- than with one of its versions: the original request, what people later asked for, what the checks found, what
-- an approver decided, and what an AI suggested, each marked for what it is.
--
-- Append-only in use: an entry is superseded or deleted, never rewritten, so the version drafted with it can
-- still be explained. Encrypted, because a request names channels, repositories and people.
CREATE TABLE artifact_journal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_type text NOT NULL CHECK (artifact_type IN ('module', 'flow')),
  -- A module's name (its versions come and go) or a Flow's id. A Super Flow is a Flow.
  artifact_id   text NOT NULL,
  -- The Flow's team, for who may read it. Modules belong to the organization, as their versions do: NULL.
  team_id       uuid REFERENCES teams(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('request', 'constraint', 'decision', 'failure', 'fix', 'open', 'suggestion')),
  -- Who it came from, which decides what it may do: a person's words, an approver's decision, what the checks
  -- found, or an AI's suggestion — which is never a constraint.
  origin        text NOT NULL CHECK (origin IN ('user', 'approved', 'evidence', 'ai')),
  text_enc      text NOT NULL,
  -- The version it came from or applies to ("1.0.2", or a flow version id), when there is one.
  version_ref   text,
  created_by    uuid REFERENCES members(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  deleted_at    timestamptz
);
CREATE INDEX artifact_journal_live ON artifact_journal (artifact_type, artifact_id, created_at) WHERE deleted_at IS NULL;

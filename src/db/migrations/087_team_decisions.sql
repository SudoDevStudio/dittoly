-- What a team has already told Dittoly. Drafting asks the questions it cannot decide ("which channel?", "which
-- project?"), and until now each answer lived only with the draft that asked it, so the next draft asked again.
-- These are the answers, kept for the team that gave them, superseded when they answer differently, and deleted
-- when they want. Encrypted: an answer names channels, projects and people.
CREATE TABLE team_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- A hash of the question, so the same question asked again replaces its answer instead of piling up.
  question_key  text NOT NULL,
  question_enc  text NOT NULL,
  answer_enc    text NOT NULL,
  -- Where it was answered: a Flow, a module or a plan, for the person who wants to see why Dittoly thinks this.
  source_type   text NOT NULL CHECK (source_type IN ('flow', 'module', 'plan')),
  source_id     text,
  answered_by   uuid REFERENCES members(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);
CREATE INDEX team_decisions_live ON team_decisions (team_id, created_at DESC) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX team_decisions_one_live ON team_decisions (team_id, question_key) WHERE superseded_at IS NULL;

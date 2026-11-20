-- Plans: a member uploads a PDF describing what they want automated. The
-- organization's AI reads its text, asks what it cannot decide, and drafts the
-- modules; each Flow is drafted once the modules it needs are approved.
-- Everything drafted still goes through the usual admin review.
CREATE TABLE plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by     uuid NOT NULL REFERENCES members(id),
  -- The team the drafted Flows go to.
  team_id        uuid REFERENCES teams(id) ON DELETE SET NULL,
  title          text NOT NULL,
  file_name      text NOT NULL,
  status         text NOT NULL CHECK (status IN ('reading', 'needs_answers', 'drafting', 'waiting', 'done', 'failed')),
  error          text,
  pages          integer NOT NULL,
  pdf_sha256     text NOT NULL,
  pdf_bytes      integer NOT NULL,
  -- The uploaded file and its extracted text, encrypted.
  pdf_enc        text NOT NULL,
  text_enc       text NOT NULL,
  -- The AI's breakdown (summary, questions, modules, Flows) and the person's answers.
  analysis_enc   text,
  answers_enc    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_by_creator ON plans (created_by, created_at DESC);

CREATE TABLE plan_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  position           integer NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('module', 'flow')),
  -- The key the AI gave a module; Flows list the keys they need in `needs`.
  key                text NOT NULL,
  title              text NOT NULL,
  -- The request the AI wrote for this item (from the plan), encrypted.
  request_enc        text NOT NULL,
  needs              text[] NOT NULL DEFAULT '{}',
  -- module: queued -> drafting -> in_review -> approved | rejected | needs_attention | failed
  -- flow:   waiting -> queued -> drafting -> drafted | blocked | failed
  status             text NOT NULL,
  error              text,
  -- The module's name once drafted: any approved version of it counts (revisions keep the name).
  module_name        text,
  module_version_id  uuid REFERENCES module_versions(id) ON DELETE SET NULL,
  flow_id            uuid REFERENCES flows(id) ON DELETE SET NULL,
  flow_version_id    uuid REFERENCES flow_versions(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, kind, key)
);
CREATE INDEX plan_items_module ON plan_items (module_name) WHERE module_name IS NOT NULL;

ALTER TABLE notifications ADD COLUMN plan_id uuid;

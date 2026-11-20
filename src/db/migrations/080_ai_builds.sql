-- What the AI is building now outside a plan (a module or Flow drafted from chat, a revision, an AI fix from a run, a
-- self-fix): one row while it builds, deleted when it ends. The Builds page and the Live panel show them. The title
-- (the request) and the AI's latest activity are encrypted.
CREATE TABLE ai_builds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid REFERENCES members(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  source      text NOT NULL,
  title_enc   text NOT NULL,
  link        text,
  step        text,
  percent     int NOT NULL DEFAULT 0,
  detail_enc  text,
  detail_at   timestamptz,
  step_at     timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_builds_member ON ai_builds (member_id, started_at);

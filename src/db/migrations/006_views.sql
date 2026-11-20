-- Phase 1: chat-driven custom views. A view is display configuration only;
-- it never changes a Flow or what a run does.
CREATE TABLE views (
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  page        text NOT NULL,
  config      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, page)
);

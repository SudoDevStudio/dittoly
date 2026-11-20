-- Which model drafts what. A Flow, a Super Flow, a module or a plan can be drafted by a different model than the
-- organization's: whoever drafts it picks, and the choice stays with that thing until someone changes it. A member's
-- own row is their default for whatever they start next. No row anywhere: the organization's model, as before.
CREATE TABLE draft_models (
  subject_type text NOT NULL CHECK (subject_type IN ('flow', 'module', 'plan', 'member')),
  -- A Flow's, plan's or member's id; a module's name (versions are immutable, the choice is not).
  subject_id   text NOT NULL,
  provider     text,
  model        text NOT NULL,
  effort       text,
  set_by       uuid REFERENCES members(id),
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_type, subject_id)
);

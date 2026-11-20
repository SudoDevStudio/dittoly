-- A plan item that could not be drafted says why in words (detail), can ask the person what
-- the AI needs to know (questions), and drafts again with their answers and notes.
ALTER TABLE plan_items ADD COLUMN detail_enc text;
ALTER TABLE plan_items ADD COLUMN questions_enc text;
ALTER TABLE plan_items ADD COLUMN answers_enc text;
ALTER TABLE plan_items ADD COLUMN notes_enc text;

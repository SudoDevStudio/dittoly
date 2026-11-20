-- How far drafting a plan item has come (a step and a percentage), shown on the plan while the AI works on it.
-- Cleared when drafting ends (src/plans/service.ts, src/core/progress.ts).
ALTER TABLE plan_items ADD COLUMN progress_step text, ADD COLUMN progress_percent smallint;

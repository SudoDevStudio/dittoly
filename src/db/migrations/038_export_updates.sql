-- Re-exporting when a Flow gets a newer approved version: what each export was asked for,
-- and what it contained (Flow versions and steps, modules, settings), to show what changed.
-- Exports made before this have neither and are not offered for re-export.
ALTER TABLE app_exports ADD COLUMN request jsonb;
ALTER TABLE app_exports ADD COLUMN snapshot jsonb;

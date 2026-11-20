-- A module version the AI drafted from a run's failure ("Have the AI fix <module>"): the run, and the module version it
-- replaces. Once approved, the run's Flow gets a new version that uses it (src/modules/run-fix.ts).
ALTER TABLE module_versions ADD COLUMN fix_for_run uuid REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE module_versions ADD COLUMN fix_from text;

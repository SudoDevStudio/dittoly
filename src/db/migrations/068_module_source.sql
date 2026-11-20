-- A module's TypeScript source, kept with the JavaScript compiled from it (`code`, what the sandbox runs).
-- Versions written before modules were TypeScript, and modules written as JavaScript, have no source.
ALTER TABLE module_versions ADD COLUMN source text, ADD COLUMN source_sha256 text;
ALTER TABLE module_versions ADD CONSTRAINT module_versions_source_hash CHECK ((source IS NULL) = (source_sha256 IS NULL));

-- The source is as immutable as the code: an approval covers both.
CREATE OR REPLACE FUNCTION module_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.code_sha256 IS DISTINCT FROM OLD.code_sha256
     OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256 THEN
    RAISE EXCEPTION 'module versions are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

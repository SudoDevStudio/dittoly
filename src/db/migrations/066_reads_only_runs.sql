-- A run an App starts on a Flow version it pins after a newer version was approved (src/team-apps/service.ts):
-- its read steps run, its steps that change data fail with pinned_version_retired.
ALTER TABLE runs ADD COLUMN reads_only boolean NOT NULL DEFAULT false;

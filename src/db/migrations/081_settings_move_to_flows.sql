-- Modules keep no configuration: whoever calls an action gives it. A Flow holds it in its definition
-- ("moduleSettings" and a step's own "settings"); the other callers of a single action keep their own.
ALTER TABLE team_notify_channels ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE gateway_tools ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
-- The organization's and the teams' module settings are gone: Flows carry their own values now.
DROP TABLE IF EXISTS team_module_settings;
DELETE FROM org_settings WHERE key LIKE 'module:%';

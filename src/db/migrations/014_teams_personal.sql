-- A member's own Teams Workflows webhook ("post to a chat"), so notifications
-- reach them personally instead of the shared channel. The URL works as a
-- credential, so it is stored encrypted and never returned.
ALTER TABLE members ADD COLUMN teams_webhook_enc text;

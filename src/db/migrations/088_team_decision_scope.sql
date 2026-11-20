-- What each remembered answer was about: the modules (apps) in play when it was given. An answer about Jira is
-- not an answer about GitHub, and a draft that mentions neither gets only the answers that name no app at all.
-- Module names are plaintext everywhere else (manifests, definitions), so they are plaintext here too.
ALTER TABLE team_decisions ADD COLUMN about text[] NOT NULL DEFAULT '{}';

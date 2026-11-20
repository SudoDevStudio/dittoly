-- Why a step was refused, in the words of the check that refused it ("/files/0/path must match pattern ..."), so
-- "input invalid" is readable. Encrypted (a path can name a file); it holds the rule, never the data. Gone with
-- the run's data.
ALTER TABLE run_steps ADD COLUMN detail_enc text;

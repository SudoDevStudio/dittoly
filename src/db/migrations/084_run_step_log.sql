-- What a failed fix or app step printed before it failed (the install, build and test output, secrets redacted), so
-- "installing the project failed" can be read instead of guessed. Encrypted (build output can carry file paths and
-- names); cleared when the step succeeds, and gone with the run's data.
ALTER TABLE run_steps ADD COLUMN log_enc text;

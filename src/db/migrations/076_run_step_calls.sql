-- What a failed step called before it failed ("GET api.github.com/search/issues -> 422"), so the person sees why and
-- the AI can be asked to fix the module. Encrypted (paths can carry names); cleared when the step succeeds.
ALTER TABLE run_steps ADD COLUMN calls_enc text;

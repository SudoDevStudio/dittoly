-- What the AI actually answered, kept with an answer that could not be read, so a person can see why.
ALTER TABLE plans ADD COLUMN error_raw_enc text;
ALTER TABLE plan_items ADD COLUMN raw_enc text;

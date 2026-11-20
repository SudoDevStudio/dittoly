-- Finished runs keep their (encrypted) inputs and step outputs until this time,
-- so people can see what each step returned; then maintenance deletes them.
-- NULL: nothing kept (deleted at the end of the run, or already purged).
ALTER TABLE runs ADD COLUMN data_expires_at timestamptz;
CREATE INDEX runs_data_expires ON runs (data_expires_at) WHERE data_expires_at IS NOT NULL;

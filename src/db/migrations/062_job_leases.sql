-- The job queue (src/engine/jobs.ts): each claim gets a new token. Renewing or finishing a job needs the token of
-- the claim that holds it, so a worker whose lease ran out cannot touch a job another worker took since.
-- A job that keeps failing is kept with the reason (an error type, never a message) instead of being deleted, until
-- an admin retries it.
ALTER TABLE jobs
  ADD COLUMN lease_token uuid,
  ADD COLUMN last_error text,
  ADD COLUMN failed_at timestamptz;
CREATE INDEX jobs_exhausted ON jobs (failed_at) WHERE failed_at IS NOT NULL;

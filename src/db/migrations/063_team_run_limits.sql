-- Run capacity (src/engine/jobs.ts): an admin may cap how many runs a team has going at once. NULL: no cap.
ALTER TABLE teams ADD COLUMN run_limit integer CHECK (run_limit BETWEEN 1 AND 100);

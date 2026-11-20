-- Writes recorded in one transaction share now() as their time: a sequence keeps "newest first" exact.
ALTER TABLE undo_records ADD COLUMN seq bigserial;
CREATE INDEX undo_records_seq ON undo_records (run_id, seq);

-- A plan can be cancelled: everything not yet finished stops (items can still be resumed one by one).
ALTER TABLE plans DROP CONSTRAINT plans_status_check;
ALTER TABLE plans ADD CONSTRAINT plans_status_check CHECK (status IN ('reading', 'needs_answers', 'drafting', 'waiting', 'done', 'failed', 'cancelled'));

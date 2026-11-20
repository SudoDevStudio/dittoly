-- Email delivery of notifications (opt-out per member).
ALTER TABLE members ADD COLUMN notify_email boolean NOT NULL DEFAULT true;
ALTER TABLE notifications ADD COLUMN emailed_at timestamptz;

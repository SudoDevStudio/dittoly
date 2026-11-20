-- GitHub signs only the body, not X-GitHub-Delivery, so a captured delivery can
-- be resent under a new delivery id. GitHub deliveries are therefore also
-- deduplicated on a hash of the body (redeliveries keep their id and body).
ALTER TABLE webhook_deliveries ADD COLUMN body_sha256 text;
CREATE UNIQUE INDEX webhook_deliveries_body ON webhook_deliveries (trigger_id, body_sha256) WHERE body_sha256 IS NOT NULL;

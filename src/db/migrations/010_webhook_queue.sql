-- Webhooks on a shared server go through RabbitMQ, which may deliver a message
-- more than once. The run a delivery started is recorded with it, in the same
-- transaction that creates the run, so a delivery never starts two runs.
ALTER TABLE webhook_deliveries ADD COLUMN run_id uuid;

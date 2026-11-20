-- Shared webhook rate limiting (works across server processes).
CREATE TABLE rate_buckets (
  key         text PRIMARY KEY,
  tokens      double precision NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);

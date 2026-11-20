-- Audit streaming: every sealed audit event is sent, in order, to SIEMs set up by org admins.
CREATE TABLE audit_streams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('splunk', 'datadog', 'https', 'syslog', 'otlp')),
  name             text NOT NULL,
  -- Where and how to send; never secret.
  settings         jsonb NOT NULL DEFAULT '{}',
  -- Token, API key, header value or signing key, encrypted.
  secret_enc       text,
  enabled          boolean NOT NULL DEFAULT true,
  -- The last audit event id delivered; the next send starts after it.
  cursor           bigint NOT NULL DEFAULT 0,
  sent             bigint NOT NULL DEFAULT 0,
  last_sent_at     timestamptz,
  last_error       text,
  failing_since    timestamptz,
  failures         integer NOT NULL DEFAULT 0,
  -- Not tried again before this time (backoff, or a send in progress).
  next_attempt_at  timestamptz,
  created_by       uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

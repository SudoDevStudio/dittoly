-- Token webhooks: for senders that cannot sign (Datadog monitor webhooks, Grafana contact points,
-- Vector, Fluent Bit). The trigger's secret token is sent in a header; replay is limited by
-- delivery dedupe and, optionally, a payload id and time (token_options).
ALTER TABLE triggers DROP CONSTRAINT triggers_provider_check;
ALTER TABLE triggers ADD CONSTRAINT triggers_provider_check CHECK (provider IN ('standard', 'github', 'gitlab', 'token'));
ALTER TABLE triggers ADD COLUMN token_options jsonb;

-- Flow URLs: a unique URL per Flow that other systems call with an
-- x-sflow-token header to start a run. The run is the creator's, with their own
-- access, like a schedule or a webhook. Only a hash of each token is stored.
CREATE TABLE flow_endpoints (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id                uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- The pinned version; NULL follows the Flow's latest approved version.
  flow_version_id        uuid REFERENCES flow_versions(id),
  run_as                 uuid NOT NULL REFERENCES members(id),
  name                   text NOT NULL,
  token_hash             text NOT NULL,
  -- After a rotation with overlap, the previous token keeps working until then.
  prev_token_hash        text,
  prev_expires_at        timestamptz,
  expires_at             timestamptz,
  enabled                boolean NOT NULL DEFAULT true,
  rate_limit_per_minute  integer NOT NULL,
  last_used_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX flow_endpoints_flow ON flow_endpoints (flow_id);

ALTER TABLE runs ADD COLUMN endpoint_id uuid REFERENCES flow_endpoints(id) ON DELETE SET NULL;

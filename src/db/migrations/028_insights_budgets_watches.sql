-- Run insights: how long a run of a Flow would take by hand (set by its owner), for "time saved".
ALTER TABLE flows ADD COLUMN manual_minutes integer CHECK (manual_minutes BETWEEN 1 AND 10000);

-- AI use: every call's tokens (no prompts, no answers), for budgets and estimated cost.
CREATE TABLE ai_usage (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  team_id        uuid REFERENCES teams(id) ON DELETE SET NULL,
  member_id      uuid REFERENCES members(id) ON DELETE SET NULL,
  -- what it was for: 'step' (AI or browse step), 'module', 'flow', 'plan', 'command', 'other'
  purpose        text NOT NULL,
  -- whose key: the organization's, or the runner's own
  key_owner      text NOT NULL CHECK (key_owner IN ('organization', 'runner')),
  provider       text NOT NULL,
  model          text NOT NULL,
  input_tokens   integer NOT NULL,
  output_tokens  integer NOT NULL,
  run_id         uuid
);
CREATE INDEX ai_usage_team_month ON ai_usage (team_id, at);
-- Monthly token budgets per team (organization key only; runners' own keys are their own business).
CREATE TABLE ai_budgets (
  team_id         uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  monthly_tokens  bigint NOT NULL CHECK (monthly_tokens > 0),
  -- at this share of the budget, team admins are warned once a month
  warn_percent    integer NOT NULL DEFAULT 80 CHECK (warn_percent BETWEEN 1 AND 100),
  warned_month    text,
  updated_by      uuid REFERENCES members(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Prices per million tokens, entered by an admin (prices change; nothing is built in).
CREATE TABLE ai_prices (
  provider             text NOT NULL,
  model                text NOT NULL,
  input_per_million    numeric(12, 4) NOT NULL CHECK (input_per_million >= 0),
  output_per_million   numeric(12, 4) NOT NULL CHECK (output_per_million >= 0),
  currency             text NOT NULL DEFAULT 'USD',
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model)
);

-- Watches: start a Flow for each new item an app shows, each new email, or each new file.
CREATE TABLE watches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_version_id  uuid NOT NULL REFERENCES flow_versions(id),
  run_as           uuid NOT NULL REFERENCES members(id),
  kind             text NOT NULL CHECK (kind IN ('app', 'email', 'files')),
  name             text NOT NULL,
  -- non-secret settings (module and action, mailbox and filters, bucket and prefix)
  config           jsonb NOT NULL,
  -- the password or secret key, encrypted (email and files)
  secret_enc       text,
  -- Flow inputs, as templates over the new item ({{ item.x }}, {{ email.subject }}, {{ file.key }})
  input_map        jsonb NOT NULL,
  interval_seconds integer NOT NULL CHECK (interval_seconds >= 60),
  enabled          boolean NOT NULL DEFAULT true,
  disabled_reason  text,
  -- false until the first look: what exists then is remembered, not run
  primed           boolean NOT NULL DEFAULT false,
  -- the mailbox's UIDVALIDITY and the last UID seen (email)
  cursor           jsonb,
  next_check_at    timestamptz NOT NULL DEFAULT now(),
  last_checked_at  timestamptz,
  last_error       text,
  runs_started     integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watches_due ON watches (next_check_at) WHERE enabled;
CREATE TABLE watch_seen (
  watch_id  uuid NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  item_key  text NOT NULL,
  seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watch_id, item_key)
);
ALTER TABLE runs ADD COLUMN watch_id uuid REFERENCES watches(id) ON DELETE SET NULL;

-- Audit evidence: where the daily audit chain head is sent, and when it last went.
CREATE TABLE audit_anchors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('email', 'webhook')),
  target      text NOT NULL,
  -- webhook: HMAC key for X-Dittoly-Signature, encrypted
  secret_enc  text,
  enabled     boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_anchor_sends (
  id          bigserial PRIMARY KEY,
  anchor_id   uuid NOT NULL REFERENCES audit_anchors(id) ON DELETE CASCADE,
  day         date NOT NULL,
  event_id    bigint,
  hash        text,
  ok          boolean NOT NULL,
  error       text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (anchor_id, day)
);

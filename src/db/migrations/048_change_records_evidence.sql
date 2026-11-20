-- Change records: every self-fix is one governed change, tying together the drift evidence, the AI
-- request, what it produced, the tests, the Flow versions proposed and every decision people made.
CREATE TABLE change_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL DEFAULT 'self_fix' CHECK (kind IN ('self_fix')),
  module_name        text NOT NULL,
  from_version_id    uuid REFERENCES module_versions(id),
  from_version       text NOT NULL,
  -- The fixed module version the AI drafted (authored by "Dittoly (self-fix)").
  module_version_id  uuid REFERENCES module_versions(id),
  -- The new Flow versions proposed with it, pinned to the fix.
  flow_version_ids   uuid[] NOT NULL DEFAULT '{}',
  status             text NOT NULL CHECK (status IN ('proposed', 'partly_approved', 'approved', 'rejected', 'superseded', 'failed')),
  -- Who asked for it: the admin who pressed "Propose a fix", or the one who turned self-fixing on.
  -- They may never approve any part of it. NULL: self-fixing was on by default.
  requested_by       uuid REFERENCES members(id) ON DELETE SET NULL,
  requested_how      text NOT NULL CHECK (requested_how IN ('automatic', 'by_hand')),
  -- { detectedAt, summary: { calls, failures, errors, actions, since } }
  drift              jsonb NOT NULL,
  -- { provider, model, inputTokens, outputTokens, cost: { amount, currency } | null }
  ai                 jsonb NOT NULL,
  -- { changes: [sentences], code: { added, removed }, widening: [sentences] }
  diff               jsonb NOT NULL,
  widens_access      boolean NOT NULL DEFAULT false,
  -- Different admins the module part needs (more than one when it widens access).
  approvals_needed   integer NOT NULL DEFAULT 1,
  -- { module: { total, passed, failing }, recorded: { total, passed, failing }, flows: [{ flowId, name, total, passed }] }
  tests              jsonb NOT NULL,
  -- Per affected Flow: { flowId, name, versionId?, status: 'proposed' | 'needs_person', reason? }
  flows              jsonb NOT NULL DEFAULT '[]',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_records_module ON change_records (module_version_id);
CREATE INDEX change_records_flows ON change_records USING gin (flow_version_ids);

-- Each decision on a part of a change: the module or one of its Flow versions.
CREATE TABLE change_decisions (
  id          bigserial PRIMARY KEY,
  change_id   uuid NOT NULL REFERENCES change_records(id) ON DELETE CASCADE,
  part        text NOT NULL CHECK (part IN ('module', 'flow')),
  subject_id  uuid NOT NULL,
  decision    text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  -- false: one approval of several; the part still waits for more.
  final       boolean NOT NULL,
  decided_by  uuid NOT NULL REFERENCES members(id),
  decided_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_decisions_change ON change_decisions (change_id);

-- Approvals of a module version that needs several different admins.
CREATE TABLE module_version_approvals (
  version_id   uuid NOT NULL REFERENCES module_versions(id),
  approver_id  uuid NOT NULL REFERENCES members(id),
  approved_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, approver_id)
);

-- Hashes of a run's inputs and step outputs, kept when retention deletes the data itself,
-- so an evidence pack can still show what was there. step_id '' is the run's inputs.
CREATE TABLE run_data_hashes (
  run_id   uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id  text NOT NULL,
  sha256   text NOT NULL,
  PRIMARY KEY (run_id, step_id)
);

-- AI system inventory: an admin's classification of each place AI is used.
CREATE TABLE ai_inventory (
  entry_key    text PRIMARY KEY,
  risk_class   text NOT NULL DEFAULT 'not_classified' CHECK (risk_class IN ('not_classified', 'minimal', 'limited', 'high', 'prohibited_check')),
  purpose      text,
  owner        text,
  reviewed_by  uuid REFERENCES members(id) ON DELETE SET NULL,
  reviewed_at  timestamptz
);

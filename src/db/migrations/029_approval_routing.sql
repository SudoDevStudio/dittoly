-- Approval routing: holiday stand-ins, deadlines with reminders and escalation, and approval by team.

-- Two new organization rules: only a Flow's own team approves it, and how long approvals may wait.
ALTER TABLE policies DROP CONSTRAINT policies_kind_check;
ALTER TABLE policies ADD CONSTRAINT policies_kind_check
  CHECK (kind IN ('approvals_for_writes', 'allowed_hosts', 'no_delegation', 'run_window', 'max_runs_per_day', 'team_approvals', 'approval_deadlines'));

-- "While I'm away, Sam approves for me": between the two dates, the stand-in may approve
-- whatever the member could, and gets the member's approval notifications.
CREATE TABLE approval_standins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  standin_id    uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  note          text,
  created_by    uuid NOT NULL REFERENCES members(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz,
  CHECK (member_id <> standin_id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX approval_standins_member ON approval_standins (member_id, ends_at);
CREATE INDEX approval_standins_standin ON approval_standins (standin_id, ends_at);

-- Who an approval was given for, when a stand-in gave it, and when an org admin outside the team did.
ALTER TABLE gate_decisions ADD COLUMN on_behalf_of uuid REFERENCES members(id);
ALTER TABLE gate_decisions ADD COLUMN outside_team boolean NOT NULL DEFAULT false;
ALTER TABLE flow_version_approvals ADD COLUMN on_behalf_of uuid REFERENCES members(id);
ALTER TABLE flow_version_approvals ADD COLUMN outside_team boolean NOT NULL DEFAULT false;
ALTER TABLE flow_versions ADD COLUMN decided_for uuid REFERENCES members(id);
ALTER TABLE flow_versions ADD COLUMN decided_outside_team boolean NOT NULL DEFAULT false;

-- Deadlines: when the reminder and each escalation went out, so each goes out once.
ALTER TABLE run_steps ADD COLUMN reminded_at timestamptz;
ALTER TABLE run_steps ADD COLUMN escalated_at timestamptz;
ALTER TABLE run_steps ADD COLUMN escalated_org_at timestamptz;
ALTER TABLE flow_versions ADD COLUMN reminded_at timestamptz;
ALTER TABLE flow_versions ADD COLUMN escalated_at timestamptz;
ALTER TABLE flow_versions ADD COLUMN escalated_org_at timestamptz;

-- Notifications about a Flow version waiting for approval link to it.
ALTER TABLE notifications ADD COLUMN flow_version_id uuid;

-- Organization-wide settings (for now: standing instructions for AI generation), set by admins.
CREATE TABLE org_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES members(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- What a chat-built draft was generated from (API source, organization instructions),
-- so reviewers can see it. Set once at insert; not part of the approval hash.
ALTER TABLE module_versions ADD COLUMN generation jsonb;
ALTER TABLE flow_versions ADD COLUMN generation jsonb;

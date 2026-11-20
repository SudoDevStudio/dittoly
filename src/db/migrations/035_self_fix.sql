-- Self-fixing Flows: when a module drifts, Dittoly drafts the fix and proposes new versions of the Flows that use it.
ALTER TABLE module_drift ADD COLUMN fix_attempted_at timestamptz;
ALTER TABLE module_drift ADD COLUMN fix_version_id uuid REFERENCES module_versions(id) ON DELETE SET NULL;
ALTER TABLE module_drift ADD COLUMN fix_error text;
-- Per affected Flow: { flowId, name, versionId?, status: 'proposed' | 'needs_person', reason? }
ALTER TABLE module_drift ADD COLUMN fix_flows jsonb NOT NULL DEFAULT '[]';

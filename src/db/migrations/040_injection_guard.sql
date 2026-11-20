-- Prompt-injection containment (src/flows/injection.ts). An approver may accept a path from
-- model-written text to a step that changes something, with a reason; the other paths' steps
-- wait for a person's sign-off at run time. guarded_steps is computed when a version is
-- approved; NULL (versions approved before this) is computed at run time, with nothing accepted.
ALTER TABLE flow_versions ADD COLUMN injection_accepted jsonb NOT NULL DEFAULT '[]';
ALTER TABLE flow_versions ADD COLUMN guarded_steps text[];

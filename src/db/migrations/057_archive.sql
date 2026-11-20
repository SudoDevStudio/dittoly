-- Deleting a Flow or a module archives it: it leaves the lists and can never run again, while its versions,
-- runs, approvals and audit events stay readable (and an admin can restore it).
ALTER TABLE flows ADD COLUMN archived_at timestamptz, ADD COLUMN archived_by uuid REFERENCES members(id);

-- Modules are archived by name: every version of it.
CREATE TABLE module_archive (
  name        text PRIMARY KEY,
  archived_by uuid REFERENCES members(id),
  archived_at timestamptz NOT NULL DEFAULT now()
);

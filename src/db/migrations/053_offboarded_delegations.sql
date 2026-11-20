-- SCIM offboarding cancels the pending delegations the person asked for or was asked to run.
-- cancelled_for names the offboarded member, so the admins' Provisioning page lists them.
ALTER TABLE delegations ADD COLUMN cancelled_for uuid REFERENCES members(id);
CREATE INDEX delegations_cancelled_for ON delegations (cancelled_for) WHERE cancelled_for IS NOT NULL;

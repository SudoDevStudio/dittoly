-- Outside destinations of app and fix steps (src/core/egress-policy.ts): the organization's list is in
-- org_settings ('egress_destinations'); a team admin may narrow it for the team. NULL: the organization's list.
ALTER TABLE teams ADD COLUMN egress_allow text[];

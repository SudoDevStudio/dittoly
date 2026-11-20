-- SCIM 2.0 provisioning (RFC 7643/7644): the identity provider (Okta, Entra ID) creates,
-- updates and offboards people, and pushes groups that become teams. See docs/scim.md.

-- The bearer token the identity provider uses. Only a hash is stored; one is active at a time.
CREATE TABLE scim_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  created_by    uuid REFERENCES members(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX scim_tokens_one_active ON scim_tokens ((true)) WHERE revoked_at IS NULL;

-- A member the identity provider manages has a SCIM userName. The SCIM id is the member id.
ALTER TABLE members
  ADD COLUMN scim_user_name    text,
  ADD COLUMN scim_external_id  text,
  -- name.givenName / familyName / formatted, as the identity provider sent them
  ADD COLUMN scim_name         jsonb,
  ADD COLUMN scim_updated_at   timestamptz,
  -- Disabled because the identity provider deactivated (or deleted) them; only then does it re-enable.
  ADD COLUMN scim_disabled     boolean NOT NULL DEFAULT false,
  -- Deleted by the identity provider: kept (disabled) for history, no longer a SCIM resource.
  ADD COLUMN scim_deleted_at   timestamptz,
  -- Set while a SCIM group mapping raised the role: the role an admin gave by hand, which it falls back to.
  ADD COLUMN manual_role       text CHECK (manual_role IN ('admin', 'approver', 'member'));
CREATE UNIQUE INDEX members_scim_user_name ON members (lower(scim_user_name)) WHERE scim_user_name IS NOT NULL;
CREATE UNIQUE INDEX members_scim_external_id ON members (scim_external_id) WHERE scim_external_id IS NOT NULL;

-- Each pushed group is a team: one it created, or an existing team an admin linked it to.
-- An admin may map a group to the admin or approver role.
CREATE TABLE scim_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  external_id   text,
  team_id       uuid NOT NULL REFERENCES teams(id),
  -- The group made this team (so renaming the group renames it); false once an admin links another team.
  owns_team     boolean NOT NULL DEFAULT true,
  grants_role   text CHECK (grants_role IN ('admin', 'approver')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scim_groups_name ON scim_groups (lower(display_name));
CREATE UNIQUE INDEX scim_groups_team ON scim_groups (team_id);

CREATE TABLE scim_group_members (
  group_id    uuid NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- Whether SCIM put them in the team (false: they were in it already, so leaving the group keeps them).
  added_team  boolean NOT NULL,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX scim_group_members_member ON scim_group_members (member_id);

-- Requests the identity provider sent that failed, for the admin page (codes only, never payloads).
CREATE TABLE scim_errors (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  method       text NOT NULL,
  resource     text NOT NULL,
  status       integer NOT NULL,
  scim_type    text,
  code         text NOT NULL
);

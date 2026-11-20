# Provisioning with SCIM (Okta, Microsoft Entra ID)

Your identity provider can manage who is in Dittoly: it creates people when you assign them the app, keeps their names and emails current, offboards them when they leave, and pushes groups that become teams. Dittoly speaks SCIM 2.0 ([RFC 7643](https://www.rfc-editor.org/rfc/rfc7643) schema, [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644) protocol). People still sign in with single sign-on (OIDC); SCIM only provisions.

## What you need

- A shared server with OIDC sign-in set up (`DITTOLY_OIDC_ISSUER` and friends) and a public URL your identity provider can reach over HTTPS.
- An org admin, to create the SCIM token.

In the portal, **Members & Access → Provisioning (SCIM)** shows:

- the **SCIM base URL**, `https://<your server>/scim/v2`, to paste into the identity provider;
- **Create token / Rotate token / Revoke token**. The token is shown once; only its hash is stored. Rotating stops the old token at once. Creating, rotating and revoking are audited (`scim.token_created`, `scim.token_rotated`, `scim.token_revoked`);
- the groups the identity provider pushed, the team each one is, and the role it grants;
- **Link an existing account** (see [Linking](#how-accounts-are-linked));
- people offboarded by the identity provider and what they owned;
- the last sync time and recent errors (codes only, never what was sent).

The SCIM token works only on `/scim/v2`; personal API tokens, sessions and MCP tokens do not work there. Requests are limited to 1,200 a minute; refused tokens are audited (`scim.auth_refused`).

## Okta

1. In the Okta Admin Console, open your Dittoly app integration (the OIDC app people sign in with). Under **General → App Settings**, set **Provisioning** to **SCIM** and save.
2. On the **Provisioning** tab, **Integration**, **Edit**:
   - **SCIM connector base URL**: the base URL from Dittoly.
   - **Unique identifier field for users**: `userName`.
   - **Supported provisioning actions**: Push New Users, Push Profile Updates, Push Groups.
   - **Authentication Mode**: HTTP Header. **Authorization**: the token from Dittoly (Okta adds `Bearer`).
   - **Test Connector Configuration**, then save.
3. **Provisioning → To App**, **Edit**: enable **Create Users**, **Update User Attributes** and **Deactivate Users**.
4. Attribute mappings (**To App**): keep `userName` = the Okta username (an email address), plus `givenName`, `familyName` and `email`. `externalId` is optional; if you map it, map it to the Okta user id (the `sub` people sign in with).
5. **Assignments**: assign people or groups. **Push Groups**: push the groups that should be teams.

What Okta sends, and what Dittoly does with it: it looks people up with `GET /Users?filter=userName eq "..."` before creating them; updates them with `PUT /Users/{id}` (apps built with the App Integration Wizard always use PUT); deactivates with `active: false` (by PUT, or a PATCH without a path) and never deletes users; pushes groups with `POST /Groups` and changes members and names with `PATCH /Groups/{id}`.

## Microsoft Entra ID

1. In the Entra admin center, **Enterprise applications →** your Dittoly app **→ Provisioning → Get started**. **Provisioning Mode**: Automatic.
2. **Admin Credentials**:
   - **Tenant URL**: the base URL from Dittoly. You may append `?aadOptscim062020`, Microsoft's flag for RFC-compliant PATCH requests; Dittoly accepts requests with and without it.
   - **Secret Token**: the token from Dittoly.
   - **Test Connection**, then save.
3. **Mappings → Provision Microsoft Entra ID Users**:
   - `userName` ← `userPrincipalName` (matching attribute; keep it);
   - `externalId` ← **`objectId`** (recommended: Dittoly links the first sign-in by the ID token's `oid` claim, which is the object id; Entra's `sub` differs per app);
   - `active` ← `Switch([IsSoftDeleted], , "False", "True", "True", "False")` (the default);
   - `displayName`, `name.givenName`, `name.familyName`, `emails[type eq "work"].value` ← `mail`.
   Other attributes Entra maps by default (job title, department, manager, phone numbers) are accepted and not stored.
4. **Mappings → Provision Microsoft Entra ID Groups**: `displayName` (matching attribute), `externalId` ← `objectId`, `members`.
5. **Settings → Scope**: "Sync only assigned users and groups". Assign people and groups to the app, then **Start provisioning**.

What Entra sends, and what Dittoly does with it: it looks people up with `filter=userName eq "..."` (and groups with `displayName eq "..."`, asking `excludedAttributes=members`); changes them with PATCH, where `op` comes in mixed case ("Replace", "Add", "Remove") and, without the flag, `active` is the string `"False"`/`"True"`; removes group members either with `path: "members"` and a list, or one at a time with `path: "members[value eq \"<id>\"]"`; disables people who are unassigned or soft-deleted with `active` false, and sends `DELETE /Users/{id}` when they are deleted for good.

## Supported requests

| | |
|---|---|
| Discovery | `GET /ServiceProviderConfig`, `/ResourceTypes`, `/ResourceTypes/{id}`, `/Schemas`, `/Schemas/{id}` |
| Users | `GET /Users` (`filter`, `startIndex`, `count`, `excludedAttributes=groups`), `GET /Users/{id}`, `POST`, `PUT`, `PATCH`, `DELETE` |
| Groups | `GET /Groups` (`filter`, `startIndex`, `count`, `excludedAttributes=members`), `GET /Groups/{id}`, `POST`, `PUT`, `PATCH`, `DELETE` |
| Filters | `eq`, joined with `and`. Users: `userName` (case-insensitive), `externalId`, `emails.value` (also `emails[type eq "work"].value`), `displayName`, `id`, `active`. Groups: `displayName` (case-insensitive), `externalId`, `id`, `members`. Anything else is refused with `invalidFilter`. |
| Paging | `startIndex` is 1-based; `count` defaults to 100, at most 200; `count=0` returns only `totalResults`. |
| Bodies | `application/scim+json` or `application/json`. Answers are `application/scim+json`. No bulk, sorting or ETags. |

Errors use the SCIM error schema: `{"schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "409", "scimType": "uniqueness", "detail": "..."}`. All endpoints, discovery included, need the token.

## People

- A person created by SCIM is a **member** (no API token) and joins the default team, like anyone signing in. A group mapped to a role can raise that (see below).
- Their handle is made from the userName (the part before `@`, lowercased, only letters, digits, `.`, `_`, `-`); names are stored without control or invisible characters, at most 120 characters. The handle does not change later.
- The identity provider only sees the people it manages: those it created, and accounts an admin linked to it. Everyone else is invisible to it and cannot be changed through SCIM.
- Every change is audited with the SCIM token as the actor and the member (or team) as the subject: `scim.member_created`, `scim.member_updated`, `scim.member_deactivated`, `scim.member_reactivated`, `scim.member_deleted`, `scim.group_created`, `scim.group_member_added`, `scim.role_granted`, ... These show in the audit report's access section, the audit chain and audit streams, so access reviews cover provisioning too.

## How accounts are linked

SSO sign-in matches accounts by the identity provider's issuer and subject, never by email. SCIM keeps it that way:

1. **A person SCIM created** has no SSO identity until they first sign in. At that first sign-in, through the configured OIDC issuer, Dittoly links the sign-in to them if:
   - their SCIM `externalId` equals the ID token's subject (`sub`) or Entra's object id (`oid`), or
   - their SCIM `userName` equals the ID token's email **and** the token says the email is verified (`email_verified: true`).
   Only members SCIM created (or an admin linked) that have **never** signed in can be linked this way. Once linked, the account is matched by issuer and subject only; another identity with the same email never takes it over. A sign-in that matches no one gets a new account, as before.
2. **An account that already exists** (someone signed in before provisioning started) is never taken over by email. When the identity provider creates a User whose email belongs to such an account, Dittoly refuses with `409 uniqueness` (`existing_account_not_linked`, audited as `scim.member_create_refused`). Either:
   - an admin links the account under **Provisioning → Link an existing account** to the person's userName (audited `scim.member_linked`); the identity provider then finds it by `userName` and manages it; or
   - the identity provider sends `externalId` = the subject the account signs in with (for example Okta's user id). Because that subject at the configured issuer proves it is the same identity, Dittoly links it.

Why: an email address alone does not prove who someone is. An attacker who could get an identity with someone else's email (an unverified email claim, a guest account, a renamed mailbox) must not inherit their account. The subject, or a verified email at the organization's own identity provider for an account that has never been used, is safe to trust.

## Offboarding

When the identity provider deactivates someone (`active: false`) or deletes them (`DELETE /Users/{id}`):

- the account is **disabled**, never deleted: their runs, approvals and audit history stay;
- at once, their portal sessions, paired phones and chats, API token and every MCP token and AI agent are revoked (pending agent calls are rejected);
- their unfinished runs (running, waiting or paused) are cancelled through the engine, audited as `run.cancel_requested` by the SCIM token;
- their pending delegations are cancelled, audited as `delegation.cancelled_offboarded` by the SCIM token: a request they made tells the teammate it was withdrawn (`delegation_cancelled`); a request someone asked them to run tells the requester (`delegation_delegate_offboarded`), whose run pauses (`delegate_offboarded`) so they can ask someone else;
- org admins are notified (`member_offboarded`), and **Provisioning → Offboarded** lists the Flows, schedules, watches, webhooks, Flow URLs and follow-ups they owned, so someone can take them over, and the pending delegations that were cancelled (the action, the Flow and the other person). Those stop working on their own, since they run as a disabled member.

A DELETE also removes them from their SCIM groups and makes them invisible to SCIM (`GET /Users/{id}` answers 404). If the identity provider later creates a User with the same userName, it is the same member again (history kept), enabled.

**Reactivation** (`active: true`) re-enables the account. It does **not** restore revoked tokens, agents or phones; the person creates new ones. An account an admin disabled by hand stays disabled until an admin enables it. An admin enabling an account by hand also ends a SCIM deactivation.

The **last enabled admin** cannot be deactivated, deleted or lose the admin role through SCIM: Dittoly answers `409` (`scimType: mutability`, detail "Dittoly keeps at least one enabled admin...") and audits the refusal (`scim.member_deactivate_refused`, `scim.member_delete_refused`, `scim.role_remove_refused`). Make someone else an admin first.

## Groups and teams

- Each pushed group becomes a **team** named after it (characters team names do not allow are dropped; a taken name gets a number). Its members join the team as team members.
- An admin can **link** a group to an existing team instead (Provisioning → Groups, teams and roles). The members move with it: they join the linked team and leave the one the group made.
- Leaving the group removes the person from its team, with two exceptions, both audited as `scim.team_member_kept`: someone is never left in no team at all (`only_team`), and a team keeps its last team admin (`last_team_admin`). Someone who was in the team before the group listed them (added by hand) stays in it.
- Renaming a group renames the team it made, not a team an admin linked.
- Deleting a group removes its members from the team as if they left the group; the team and its Flows stay.

## Roles from groups

An admin maps chosen groups to the **admin** or **approver** role. Membership in a mapped group grants the role; leaving it removes it. Only what SCIM granted is removed: Dittoly remembers the role an admin set by hand and falls back to it, so an approver an admin appointed who is also in an admin group goes back to approver, not member, when they leave the group. Changing someone's role by hand makes that their own role again. Changing a group's mapping applies to its members at once.

## Verified against

The identity providers' behaviour above was checked on 2026-10-19 against Okta's "Okta and SCIM Version 2.0" guide and SCIM FAQ (developer.okta.com), and Microsoft's "Develop and plan provisioning for a SCIM endpoint" tutorial and "Known issues with SCIM 2.0 protocol compliance" (learn.microsoft.com). Test both against a trial tenant before rolling out: identity providers change their requests over time, and failed requests show under Provisioning → Recent sync errors.

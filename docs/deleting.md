# Deleting Flows and modules

Deleting a Flow (a Super Flow too) or a module **archives** it:

- It leaves the lists, the catalog the AI drafts from, the approval queue and the AI assistants' tools.
- It never runs again. Its Flow URLs, webhooks, schedules, watches and follow-ups start nothing (`409 flow_archived`
  or `module_archived`). A deleted module gets no new versions or approvals.
- Its versions, runs, approvals and audit events stay, so evidence packs and the audit chain are unchanged. Each delete
  and restore is audited (`flow.archived`, `flow.restored`, `module.archived`, `module.restored`).
- An admin can restore it.

## Who, and when it is refused

| | Who deletes | Refused while |
|---|---|---|
| Flow or Super Flow | its owner (who made it) or an admin | another Flow runs it (a flow step in an approved or pending version), or a run of it is still running, waiting or paused |
| Module (every version of it) | an admin | a Flow uses one of its actions (in an approved or pending version) |

The refusal (`409 flow_in_use` or `module_in_use`) lists what uses it, for example
`"Notify ops" is used by "Release train"; 1 run still active (cancel or let them finish)`. Delete or change those
first, or cancel the runs. Deleted Flows do not count as users.

## In the portal

- **A Flow's page** → **Delete this Flow** → **Delete Flow**.
- **A module's page** (admins) → **Delete this module** → **Delete module**.
- **Restore** (admins): Flows → **Deleted Flows** → Show → **Restore**; Modules → status filter **Deleted** →
  **Restore**.

## API

| Call | Does |
|---|---|
| `DELETE /api/flows/:id` | Deletes (archives) a Flow. `204`; `403 not_flow_owner`; `409 flow_in_use` |
| `POST /api/flows/:id/restore` | Restores it (admins) |
| `GET /api/flows?archived=true` | Deleted Flows (admins; others get none) |
| `GET /api/flows/:id/archived` | `{name, archived}` |
| `DELETE /api/modules/by-name/:name` | Deletes (archives) every version of a module (admins). `409 module_in_use` |
| `POST /api/modules/by-name/:name/restore` | Restores it (admins) |

`GET /api/modules` marks each version of a deleted module with `archived: true`.

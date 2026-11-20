# Data tables

A team keeps small tables that its Flows read and write, so Flows can remember things between runs: tickets already handled, how many times something happened, a list of on-call people someone keeps up to date.

## Tables

On the **Teams** page, under **Data tables**:

- **Team admins** create a table: a name, a **key column** (what tells rows apart, e.g. `ticket`) and other columns, each text, number, yes/no or date. They can change the columns later (values of a removed column are dropped) or remove the table.
- **Team members** see the rows, filter them, and add, change or delete rows.
- Limits: 50 tables per team, 30 columns, 10,000 rows per table, keys of up to 300 characters, rows of up to 64 KB.

Rows are stored encrypted, like run outputs. A row is found by a keyed hash of its key, so keys such as email addresses are not stored readable either. Rotating the master key re-encrypts the rows and recomputes those hashes. Every change in the portal is in the audit log; a change a run made records that run.

## The table step

A Flow uses its own team's tables with a `table` step:

| `op` | Fields | Output |
|---|---|---|
| `get` | `key` | `found`, `row` (the key column plus every column, or null) |
| `put` | `key`, `values` (column → value or template), optional `ifRevision` | `row`, `created`. Only the given columns change; the row is added if needed. With `ifRevision` the write happens only if the row is still the one this run read (the `revision` a `get` returned, or `0` for "only if it does not exist yet"); otherwise the step stops with `row_changed` instead of overwriting another run's work. |
| `delete` | `key` | `deleted` |
| `increment` | `key`, `column` (a number column), `by` (default 1) | `value`, `row`. Atomic, so parallel runs never lose a count. |
| `claim` | `key`, `hours` (1–168, default 6) | `claimed`, `until`. Reserves the key for this run until it ends, at most `hours`. Of runs claiming the same key at the same time exactly one gets `claimed: true`; give later steps the condition `steps.<id>.output.claimed`. The row itself is not changed. Not available in exported apps. |
| `list` | optional `where: { column, equals }`, `limit` (1–500, default 100) | `rows` (newest first), `count` |

```json
{ "id": "seen", "type": "table", "table": "Handled tickets", "op": "get", "key": "{{ inputs.ticket }}" }
{ "id": "work", "type": "action", "when": { "isTrue": "steps.seen.output.found" }, ... }
{ "id": "remember", "type": "table", "table": "Handled tickets", "op": "put", "key": "{{ inputs.ticket }}", "values": { "status": "handled" } }
```

A Flow that reads a row, works something out from it and writes it back says so, and two runs no longer overwrite
each other: the second stops with `row_changed`, having changed nothing.

```json
{ "id": "look", "type": "table", "table": "Budgets", "op": "get", "key": "{{ inputs.team }}" }
{ "id": "spend", "type": "table", "table": "Budgets", "op": "put", "key": "{{ inputs.team }}",
  "values": { "left": "{{ steps.look.output.row.left }}" }, "ifRevision": "{{ steps.look.output.row.revision }}" }
```

Values are converted to the column's type (`"2"` to 2, `"yes"` to true, dates as `YYYY-MM-DD`); one that cannot be fails the step with `invalid_value`. A Flow can only name tables and columns its team has, or that it declares in its definition's `tables` (approving the Flow creates them in its team); the approver's summary says which steps read a table and which **change** one. A dry run reads tables but skips `put`, `delete`, `increment` and `claim`.

The AI drafting a Flow sees the team's tables (names and columns, never rows) and can use them. In the visual editor, the team's tables are in the list of steps: drag one in, pick what it does (read, add or change, add to a number, delete, list), and fill in the row's key and values, using the run form or earlier steps' results.

## Modules keep no data

Modules are stateless: a module declares what each action needs (its input) and returns what it found (its
output). It has no access to data tables and keeps nothing between runs. What must last between runs, the Flow
keeps with its table steps and passes to the module as input; for "only what is new since last time", the action
takes the last cursor, id or time as input and returns the new one, and the Flow remembers it.

---
name: save-ai-work
description: How an AI assistant turns a task it just did into a Dittoly Flow (and new modules) with the save_as_flow tool, so the task repeats without an AI. Given to assistants over MCP by get_flow_guide.
---
# Saving a task you did as a Flow

You (an AI assistant connected to Dittoly over MCP) just did a task for the person, such as gathering tickets,
posting a summary or updating records. Turn that work into a Flow, so next time it runs the same way, as often as
needed, without an AI and without spending tokens. People review and approve it before it can run.

How to do it:
1. Write down the steps you actually took, in order. Name the app and the action for each one (read or change
   something), and the values you used.
2. Decide what changes from one run to the next. Those values become run-form inputs, such as a project key, a date
   range or a channel. Values that always stay the same are written into the steps. Never put secrets, tokens or
   passwords in a Flow: each person's access comes from their own stored credentials.
3. Map each step to an approved action from the catalog that get_flow_guide gave you, using the exact module
   `name@version` and action name. Prefer existing approved actions and Flows over new modules.
4. Only when no approved module can do a step, draft a new module for that app, following the module rules (manifest,
   code, sandbox tests). Keep each module to one app and only the actions this Flow needs. Dittoly tests it in a
   sandbox and an admin approves it. Reference it from the Flow as `name@version`, exactly as in your manifest;
   Dittoly renumbers it if that version is taken and updates the Flow to match.
5. Put an approval step before steps that change data. Keep the Flow's AI steps to work that really needs judgment
   each time. Everything that can be a plain action should be one: that is what makes the repeat free.
6. Add a test: the inputs you used, and the answers each app actually gave you (trimmed to what the Flow uses), as
   recorded answers. Approvers see the test pass, and Dittoly uses it to check later versions and fixes. Use made-up
   but realistic values in place of personal data.
7. Report what the task cost you, if you know: your input and output tokens for doing it this time, and your provider
   and model. This is the baseline for the savings Dittoly shows. Give your best estimate; say nothing rather than
   guess wildly.
8. Write an explanation for the approver: what the Flow does, what it changes, and what it will not do.

What happens next: save_as_flow checks everything. If something is wrong, nothing is saved and you get the problems;
fix them and call it again. When it is saved, the Flow and any new modules wait for approval, and the person gets
links to them. Tell the person it is waiting for approval; do not say it is ready to run.

You must not:
- Save a Flow that does more than the task you did, or reaches apps the task did not need.
- Copy personal data, secrets or whole app responses into the Flow, its explanation or its tests.
- Try to get around approval, rules or limits (for example by splitting one change into several Flows).

## save_as_flow arguments

- `name`: a short Flow name. `explanation`: two to five sentences for the approver.
- `definition`: the Flow definition (the JSON described in the Flow rules).
- `teamId` (optional): the team it belongs to, from get_flow_guide; by default the person's default team.
- `flowId` (optional): save as a new version of a Flow the person owns, instead of a new Flow.
- `modules` (optional, at most 5): `[{ "manifest": {...}, "code": "...", "tests": [...] }]`, new modules as in the module rules (`code` is TypeScript).
- `tests` (optional, at most 10): `[{ "name": "...", "case": { "inputs": {...}, "answers": { "<step id>": { "output": ... } }, "decisions": { "<approval step id>": "approved" }, "expect": { "status": "succeeded" } } }]`.
  `answers` holds what each action, AI, browser, form or table step gave back (`output`), or `{ "fail": "<error_type>" }` (lowercase, such as `not_found`).
  Steps that loop with forEach take `{ "outputs": [ ... one per item ... ] }`. `expect` may also list `steps`
  (`{ "<step id>": "succeeded" | "skipped" | "failed" | "not_run" }`) and `values` (`[{ "path": "steps.x.output.y", "equals": ... }]`).
- `aiUsage` (optional): `{ "inputTokens": n, "outputTokens": n, "provider": "anthropic", "model": "..." }`.
- `assistant` (optional): your product name, such as "Claude Code" or "Cursor", shown to the approver.

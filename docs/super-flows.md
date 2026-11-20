# Super Flows

A **Flow** is one process: steps that call module actions, ask people, wait, check pages and so on. A **Super Flow** connects Flows: it is a Flow with one or more **flow steps**, each of which runs other approved Flows. It works the same way a Super-Module connects one app.

A Super Flow is still a Flow, so it gets everything Flows have: approval, versions, schedules, webhooks, Flow URLs, follow-ups, the run form and the run view.

## Making one

- **Super Flows** (left sidebar): pick approved Flows and put them in stages. This page lists Super Flows separately from regular Flows in the AI Studio.
  - Stages run one after another.
  - The Flows in one stage run **at the same time**.
  - Each child input starts as a Super Flow input of the same name, so a value several Flows need is asked once. You can type a fixed value instead, or use a result from an earlier stage, for example `{{ steps.stage_1.output.ticket_qa.steps.report.markdown }}`.
- **AI Flow Synthesizer:** describe what to combine, for example "run Ticket QA, then notify Slack and Teams together". The AI sees the approved Flows you can use and wires them together with flow steps.
- **JSON:** write the steps yourself (below).

## Export and import

Open a Flow or Super Flow, select a version, and choose **Export JSON**. The file contains its name, definition, and the names and pinned versions of any child Flows. It excludes approval records, credentials, endpoints, schedules, and execution history.

Use **Import a Flow from JSON** in Flow Studio or **Import a Super Flow from JSON** on the Super Flows page. Choose the file, confirm its name, and import it as a new draft in the selected team. Existing example files with `{ name, definition }` and raw definitions are also accepted. The server applies its normal definition, access, module, and child-input validation.

The destination must already have the required modules. Super Flow exports reference child Flows rather than bundling their definitions: import and approve missing children first, then choose an approved destination version for each child reference. The importer remaps those references while preserving stage IDs, child IDs, input templates, and stage order. The imported parent requires its own approval before execution; prior acceptance of model-to-write paths does not transfer.

## The flow step

```json
{
  "id": "notify",
  "type": "flow",
  "title": "Tell everyone",
  "runs": [
    { "id": "slack", "flow": "<flow id>", "version": 3, "input": { "text": "{{ steps.qa.output.qa.steps.report.slack }}" } },
    { "id": "teams", "flow": "<flow id>", "version": 1, "input": { "text": "{{ steps.qa.output.qa.steps.report.plain }}" } }
  ]
}
```

- Every Flow in `runs` starts at once, as a child run. Up to 10 per step.
- The step waits for all of them and then continues.
- Its output holds each child's result, keyed by its `id`: `steps.<step>.output.<run id>.status` and `.steps.<child step id>.<field>`.
- `when` works as on any step.

## Pinned versions and approval

- A Super Flow pins each Flow to one version, as it pins modules.
- The approver sees which Flows and versions it runs (each one reviewed and approved on its own).
- It cannot be approved while a Flow it runs is not approved.
- When a Flow it runs gets a new version, the old version stops counting as approved. The Super Flow then refuses to start (`child_flow_not_approved`) until someone updates it to the new version, and that update needs approval again. The Super Flow's page lists the newer version under *newer versions available*.

## Who runs what

- Child runs belong to the person running the Super Flow and use their own access, exactly as if they had started each Flow themselves.
- They must be allowed to run each child Flow (be in its team).
- Delegation, approval gates and input steps inside a child work as usual.

## When something goes wrong

- If a child fails and pauses, the Super Flow keeps waiting. Retry the child from its run page, or cancel it.
- If a child is cancelled or fails, the flow step fails and the Super Flow pauses.
  - **Retry** on the Super Flow starts that step's Flows again.
  - Cancelling the Super Flow cancels the children still running.
- If a child cannot even start (not approved, wrong inputs, not in its team), the ones already started in that step are cancelled and the step fails with the reason.
- Super Flows can run Super Flows, up to 5 levels deep. Pinned versions make loops impossible: a Flow can only pin versions that already existed when it was saved.

## Results and retention

A child's result is kept with the Super Flow when the child finishes. Later steps can use it even after the child's own outputs are cleared. It is encrypted, follows the Super Flow's retention period, and is covered by master-key rotation.

On the run page, a flow step links to each child run, and a child run links back to its Super Flow.

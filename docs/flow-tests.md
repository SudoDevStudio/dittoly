# Flow tests

A Flow test plays a run with **recorded answers** instead of the real apps: nothing is called and nothing changes. Each version's page shows how every test of its Flow does on that version, so an approver sees what a change breaks before approving it.

## What a test checks

- the test's inputs fit the Flow's run form;
- each step that calls an app would send **inputs the app's action accepts** (checked against the action's schema, item by item for steps that run once per item), and each recorded answer is **what the action promises to return**;
- `when` conditions, loops, templates between steps, reports;
- sign-offs, approved or rejected as the test says (approved when it says nothing);
- what comes out: the run's outcome, each step's status, and values such as `steps.notify.output.text` (equal to, containing, not empty).

A failing test says which step and why, e.g. *"step merge item 1 would send merge_merge_request inputs it does not accept: /iid must be integer"*.

## Making tests

- **From a run:** on a finished (not dry) run of your own, **Save as a test**. It keeps the run's inputs, every step's actual output as the recorded answer, how its sign-offs were decided, and its outcome and step statuses as what to expect. It may hold real data from that run, so tests are stored encrypted and only people who can see the Flow see them.
- **By hand:** on the Flow's page, **Tests → Write a test**: a form with the run form's values, each step's recorded answer (filled in with the shape of what the step returns) or an error, each sign-off's decision, and what to expect. The same test as JSON (**Write or edit a test as JSON**):

```json
{
  "inputs": { "project": "acme/app" },
  "answers": {
    "mrs": { "output": { "mergeRequests": [] } },
    "notify": { "fail": "rate_limited" }
  },
  "decisions": { "signoff": "rejected" },
  "expect": {
    "status": "failed",
    "steps": { "merge": "not_run" },
    "values": [{ "path": "steps.mrs.output.mergeRequests", "equals": [] }]
  }
}
```

Steps that call apps, AI, browser and build steps, other Flows, forms and data tables need a recorded answer (`output`, or `outputs` for a step run once per item, or `fail` with an error code). Sign-offs, delays and reports need none.

The Flow's owner, its team's admins and org admins add and remove tests; up to 50 per Flow. Tests do not block approval: the approver sees the results and decides.

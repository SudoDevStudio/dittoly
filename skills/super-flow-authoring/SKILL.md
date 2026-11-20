---
name: super-flow-authoring
description: How a Dittoly Super Flow connects approved Flows with flow steps, what runs in parallel, how outputs pass between them, and the limits. Loaded when the AI drafts or revises a Flow or Super Flow.
---
# Super Flows

A Super Flow is a WRAPPER: for one request it runs several approved Flows, connects them (each one's output is the
next one's input), and returns the result. It adds no step a child Flow already does, keeps no state of its own
(each child Flow keeps what it needs), and, like any Flow, must run on any AI model.

SUPER FLOWS:
- { "type": "flow", "runs": [ { "id": "snake_case", "flow": "<flow id from APPROVED FLOWS>", "version": <its version>,
      "input": { ...the child Flow's inputs, templates allowed... } }, ... ] }
    runs whole approved Flows (each a reviewed process of its own) as the same person, ALL AT THE SAME TIME, and waits
    for all of them. Output: steps.<id>.output.<run id>.status and .steps.<child step id>.<field>. Use it to connect
    existing Flows into a Super Flow (e.g. run "Ticket QA", then run "Notify Slack" and "Notify Teams" together) instead
    of rebuilding their steps. Put Flows that depend on each other in separate flow steps, in order; independent ones in
    the same step. Give each child Flow all of its required inputs.

How to connect Flows:
- Reuse before rebuilding: when an approved Flow already does part of the job, run it with a flow step instead of
  copying its steps. Its own approval, sign-offs and forms stay as they are.
- Order by dependency: a later flow step may use an earlier one's outputs, e.g.
  "{{ steps.qa.output.ticket_qa.steps.report.plain }}" (flow step id, then run id, then the child's step id).
- Built-in steps (approval, input, report, delay, action) may sit between flow steps, e.g. a sign-off after a
  check and before the Flows that change data.

Limits:
- A flow step runs 1-10 Flows; run ids are unique snake_case within the step.
- Only Flows in APPROVED FLOWS, with their exact id and version, that the person can see. A child Flow that is no
  longer approved when the Super Flow runs stops the run.
- Each run gets its child Flow's required inputs; "item" (forEach) is not available in a flow step.
- If one child Flow fails, the flow step fails. Child Flows run as the same person, with that person's access.
- Super Flows may nest (a Super Flow running a Super Flow) up to 5 levels deep. Do not try to run the Flow you are
  drafting from inside itself.
- Approving a Super Flow is refused while any child Flow version is not approved.

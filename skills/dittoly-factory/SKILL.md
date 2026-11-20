---
name: dittoly-factory
description: The departments that build in Dittoly (planner, module builder, Flow builder, Super Flow builder, checker) and what each hands the next. Loaded with every drafting request, so each department knows what the others do, not how.
---
# The factory: who does what

Dittoly builds like a factory. Each department has its own instructions and does only its own job; it knows what
the others do and what they hand on, not how they do it. You are one of them (your own instructions say which).
Hand the next department exactly what it needs, and never do another department's job.

1. PLANNER (requirement understanding). Reads what the person wants (a plan document or a chat), asks only what
   blocks, and breaks it into modules to build or extend, Flows to build or reuse, and a Super Flow when one Flow
   cannot do it all. Hands on: one request per module and per Flow, each self-contained.
2. MODULE BUILDER (raw material). Builds or extends one connector per app: the manifest (actions, each read or
   write, with input and output), its own TypeScript on the Dittoly base (the same tested code for every kind:
   http, db, smtp, amqp, mqtt, ws, sse), and a config that says what each action is and does. Hands on: a module whose MODULE.md says what each
   action does, needs and returns.
3. FLOW BUILDER (building products). Chains approved actions and built-in steps into one Flow with one start. Uses
   only actions the catalog lists; when one is missing it names it (the module builder makes it), and when one Flow
   cannot do it all it names the Flows to build instead (a Super Flow runs them). Hands on: a Flow whose FLOW.md
   says what starts it, what it needs, its steps and what it changes.
4. SUPER FLOW BUILDER (assembly). Connects approved Flows, pinned to their versions, in order or at the same time,
   passing outputs on. Builds no steps a child Flow already does. Hands on: a Super Flow whose FLOW.md is the whole
   process: every Flow it runs, what each does, and the modules underneath (the factory manager's view).
5. CHECKER (verifying products). Dittoly itself: the manifest and config checks, the sandbox tests, the Flow
   validator. Then people review and approve each version before anything runs. A department that gets problems
   back fixes exactly those.

What each department reads from the others: the module catalog (each module's actions with their MODULE.md notes),
the approved Flows (each with its FLOW.md), and the request it was handed. Trust those as the contract; do not
re-derive another department's work or second-guess an approved version.

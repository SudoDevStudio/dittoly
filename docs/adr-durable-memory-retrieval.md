# Durable memory and retrieval in Dittoly

**Status:** accepted · **Date:** 2026-11-18

## What was asked

A durable memory and retrieval layer: structured facts, a knowledge index, lexical search, optionally embeddings
and a vector database, with context assembled per draft and a manifest of what went in.

## What the repository already does

Before adding anything, the existing code was read. Most of the proposal is already here under other names:

- **Per-draft memory.** Every stored version carries its `generation`: the AI instructions in force with their
  hash, the classification (including the person's own answers), the web pages the AI read, the builder's notes,
  the exact model that answered and what the draft cost. Plans keep their PDF and extracted text; home chats keep
  the whole transcript and the plan; modules keep the condensed API reference they were written from.
- **Authoritative state.** Approved modules and Flow versions are immutable rows with approvals, hashes and an
  audit chain. A draft can never overwrite them.
- **Capability retrieval.** Drafting is already given the exact catalogue it may use: every approved module
  action with its input and output schema, the team's data tables, and the approved Flows a Super Flow may run.
  This is exact, authorized and version-pinned — the job a retrieval index would be doing, done deterministically.
- **Task-specific instructions.** `SKILL_SETS` loads 3–7 skills per task, not everything.
- **Checks and repair.** JSON Schema output, OWASP and performance validators, sandbox tests, secret scanning,
  and repair rounds that feed the exact failures back.

## Decisions

1. **No vector database, no embeddings service, no new infrastructure.** Nothing measured here needs one, and the
   capability catalogue already answers "what can I use" exactly.
2. **No Postgres full-text index over stored content.** Dittoly encrypts what it keeps — chat transcripts, plan
   text, run inputs and outputs, module references, and now team answers — with per-row associated data. A
   `tsvector` index over those columns would mean storing the plaintext beside them, which trades the product's
   privacy model for a convenience. Lexical search, where it is wanted later, can run over what is already
   plaintext: module manifests, Flow definitions, names and guides.
3. **The real gap was cross-draft memory of what people answered.** Drafting asks what it cannot decide, and the
   answer lived only with the draft that asked. The second Flow asked again. That is fixed (`src/ai/decisions.ts`,
   migration `087`): the answers are kept for the team, superseded when answered differently, and handed to later
   drafts as what the team already said.
4. **What is kept, and what is not.** Only what a person typed. Nothing a model inferred, nothing an app or a
   webhook sent — those stay untrusted data (`src/flows/injection.ts`) and would otherwise be a way to teach
   Dittoly a "fact" from outside.
5. **It decides nothing.** The answers are context, not policy: a request that says otherwise wins, nothing in
   them widens what a Flow may do, and every version still goes through its checks and its approver. They are
   encrypted, team-scoped, listed on the Teams page, and anyone in the team may forget one.
6. **Failure is not silent.** Remembering never fails a draft; a row this key cannot read is left out rather than
   breaking the page; and nothing here is a source of truth — the approved versions still are.

## When to revisit

Add retrieval beyond this when a measurement says so, on `bench:tasks`: drafts that fail because a fact existed
somewhere and was not given to the model. If that shows up for long documents, index the plaintext artefacts
first (names, manifests, definitions, guides), and only then consider embeddings — inside the database already in
use (pgvector for Postgres), never as a separate service, and never as the source of any policy or gate.

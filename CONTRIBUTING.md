# Contributing to Dittoly

Thank you for wanting to help. Dittoly runs other people's work with their own credentials, so a change here can
reach their apps: that is why this page is more exact than most.

**Security problems do not go in an issue or a pull request.** Report them privately — see [SECURITY.md](SECURITY.md).

## What makes a change easy to accept

- It does one thing, and the pull request says what it does and why.
- It keeps the invariants below. A change that cannot keep one of them should say so and explain why.
- It comes with a test that fails without it. For a bug, the test reproduces the bug.
- It leaves the docs true: a change in behaviour changes `docs/` in the same pull request.

## The invariants

These are the promises Dittoly makes to the person who approves a Flow. Most of them have a test guarding them, and
a change that breaks one will fail the suite:

- **An approval is for an exact version.** A Flow version and the module versions it pins are frozen; database
  triggers reject edits to those rows. Any change through the product is a new pending version.
- **Nothing runs as a hidden account.** Every call runs as the runner, as a team's stored credential, or as a
  teammate for one step. Modules never hold a token: the broker attaches it outside their code.
- **A module reaches only the hosts it declares**, and runs in the sandbox with no network of its own.
- **Untrusted text is traced, not judged.** Paths from model-written or app-supplied text to a step that changes
  something are worked out from the definition, the same way every time, and gated where the rules say.
- **Durable content is encrypted** with per-row AAD. A new `*_enc` column goes in `ENCRYPTED_COLUMNS`
  (`src/core/rekey.ts`) and a new table in `WIPE_TABLES` or `KEEP_TABLES` (`src/local/cleanup.ts`). Two tests check
  this, so a missing entry fails the suite rather than losing data on a rekey.
- **Running a Flow needs no AI.** Drafting uses a model; execution does not.

## Running it

Node.js 26 is required — Node.js 22 cannot enforce the process sandbox's network restrictions.

```bash
npm ci
npm run setup:local        # .env with a persistent master key
npm run services:up        # Postgres on 5433 and RabbitMQ on 5672, in Docker
npm run build && npm start
```

Before you open a pull request:

```bash
npm run typecheck
npm run web:build          # the portal test drives the built portal
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/dittoly_test npm test
```

[docs/development.md](docs/development.md) has the rest: running one portal test on its own, what a failed portal
test leaves behind, the container sandbox tests, and what CI runs.

## Pull requests

- Branch from `main`, and keep the branch to one subject.
- Write the title and body as a sentence a reviewer can check, not a list of files. Say what changes for the person
  using Dittoly.
- CI (typecheck, build, the full suite with Postgres, RabbitMQ, Chromium and the Docker sandbox) must be green.
- A change to a sandbox, a credential path, an approval rule or the audit log gets a closer read, and may be asked
  for more tests. That is not distrust; it is the part that cannot be fixed afterwards.

## Releases

Every merge to `main` that changes more than documentation is released on its own: a Git tag, a GitHub release whose
notes list the merged pull requests, and the server image `ghcr.io/sudodevstudio/dittoly:<version>`. A label on the
pull request decides the version:

| Label | Version |
| --- | --- |
| *(none)* | patch: 0.1.0 → 0.1.1 |
| `release:minor` | minor: 0.1.0 → 0.2.0 — new behaviour |
| `release:major` | major: 1.0.0 → 2.0.0 — something that worked before needs a change by the people running it |
| `release:skip` | no release |

Nothing is published before it is checked: the image is pushed as a candidate, started with `compose.server.yml`,
and only promoted to its version when it passes. The version lives in the tag and the image; `package.json` in the
repository is not bumped. Add what changed for users to `CHANGELOG.md` in the same pull request.

## Modules and Flows

A module in `test/fixtures/` is an example others copy: give it a complete manifest (declared hosts, declared
credentials, `effect` and `idempotent` on every action, an `undo` where the change can be taken back) and sandbox
tests, including one that expects bad input to be refused.

## Reporting a bug

Say what you did, what you expected, what happened, and the version. Include the run's report if the problem is in a
run — but **never paste a credential, a token or a secret value**, and check the output for them before you post.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, as the rest of the
project is ([LICENSE](LICENSE)).

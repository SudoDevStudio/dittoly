---
name: dittoly-project
description: Understand, develop, debug, or review the Dittoly repository using its architecture, execution invariants, and project-specific validation commands. Use for changes to this codebase, not for authoring workflows inside a running Dittoly instance.
---

# Working on Dittoly

These instructions are shared by Codex and Claude Code. Paths in backticks are relative to the repository root. Use the current implementation as the source of truth.

## Find the relevant path

Dittoly is a self-hosted TypeScript orchestration platform. AI proposes modules and Flows; people approve versioned artifacts; an engine executes pinned steps using the runner's credentials, explicit team credentials, or an approved delegate's access.

The server is a modular monolith: Fastify serves a React/Vite portal and API, PostgreSQL stores application state and durable jobs, and isolated runners execute module/project code. The packaged local launcher uses PGlite. Exported applications have a separate runtime and identity model.

| Working on | Read first |
|---|---|
| Startup, configuration, deployment | `src/config.ts`, `src/main.ts`, `src/serve.ts`, `src/local/launcher.ts`, relevant Compose file |
| Service wiring or test dependencies | `src/app.ts` (`buildApp`, `AppOverrides`) |
| Module contracts and review | `src/modules/manifest.ts`, `registry.ts`, `validate.ts`, `chat.ts` |
| Flow definitions and approval | `src/flows/definition.ts`, `service.ts`, `template.ts`, `injection.ts` |
| Runs, retries, delegation, child Flows | `src/engine/engine.ts`, `jobs.ts`, `scheduler.ts` |
| Credentials, teams, identity | `src/core/vault.ts`, `team-credentials.ts`, `members.ts`, `teams.ts`, `src/api/auth.ts` |
| Network and sandbox behavior | `src/runtime/broker.ts`, `egress.ts`, `src/sandbox/runner.ts`, `broker.ts`, `sandbox-runtime/` |
| Browser checks or code fixes | `src/sandbox/browser.ts`, `live.ts`, `src/engine/apps.ts`, `fix.ts`, `fix-limits.ts`, `workspace-files.ts`; remote code runner: `src/engine/remote-runner.ts`, `src/runner/` |
| AI authoring or model/cost behavior | `src/ai/`, `src/runtime/ai-*.ts`, `src/ai/skills.ts` |
| Event ingress | `src/webhooks/`, `src/endpoints/`, `src/watches/` |
| MCP integration or agents | `src/mcp/server.ts`, `mcp.ts`, `gateway.ts`, `authserver.ts`, `agents.ts` |
| Policies, approvals, evidence | `src/governance/`, `src/core/audit.ts` |
| Schema or persistence | `src/db/db.ts`, `src/db/migrations/`, `test/helpers.ts` |
| Portal | `web/src/main.tsx`, `router.tsx`, `api.ts`, relevant page/component |
| Exported applications | `src/export/bundle.ts`, `codegen/compile.ts`, `app-runtime/`, `src/runtime/` |

Use `AppOverrides` and existing fake integrations to isolate external dependencies.

## The architecture

Three layers, and no change may blur them:

- **Module: one app, no state.** A module talks to one app/service and keeps nothing of its own: no data, no
  database, no memory between runs, no AI. It offers whatever operations the request needs (create, read, update,
  delete, list, search), each an action whose input carries every value it needs and whose output carries what it
  found. Never give modules storage again (`ctx.tables` was removed; a manifest declaring `tables` is refused in
  `src/modules/manifest.ts`).
- **Flow: the state and the configuration.** A Flow chains approved actions and built-in steps, keeps what must
  last in the team's data tables (`table` steps, and the tables a definition declares, created when it is
  approved), holds the configuration in its step inputs and run form, and passes those to the modules.
- **Super Flow: a wrapper.** It runs several approved Flows for one request, passes each one's output on, and
  returns the result. It keeps no state of its own and repeats no child Flow's steps.

- **Any Flow runs on any model.** Which model an AI, browse or fix step uses is decided at run time: the
  organization's model, a model an approver locked the version to (`flow_versions.model_locked`), or one chosen for
  a single run (`runs.ai_model`); a model that is gone falls back to the organization's (`src/ai/models.ts`). So no
  definition, prompt, skill, module or test may depend on one model or provider, and nothing may require naming a
  model to work.

## Preserve the product's contracts

- **Approval:** Database triggers protect versioned content. Approval binds the definition and pinned module content; edits supersede approvals. Repair proposals have a distinct path. Keep run-start and review checks consistent.
- **Module source:** AI (chat, revisions, self-fixes, MCP `save_as_flow`) and git write modules in TypeScript (`source`); `src/modules/source.ts` compiles it with the pinned esbuild into `code`, the JavaScript that is validated, hashed (`code_sha256`) and run. Both are immutable (trigger, migration 068). Modules stored as JavaScript (`source` null: examples, browser-script imports, older versions) keep working. Git sync writes `module.ts` or `module.mjs`, never both, plus the repository's TypeScript project (`src/git-sync/scaffold.ts`, types in `sandbox-runtime/dittoly-module.d.ts`); keep its esbuild pin equal to `package.json`'s.
- **Identity:** Authorize the actual runner/delegate. Personal credentials are default; team access is explicit. Delegation freezes/hashes inputs. Keep executor/requester attribution separate; enforce API/service authorization, not just UI visibility.
- **Sandbox:** Preserve broker capabilities, declared hosts, action effects, credential placement and connection-time egress checks. Browser/app/fix execution has separate rules: app and fix steps get one egress proxy per phase (install, build, test/run) with the step's `egress` inside the org/team ceiling (`src/core/egress-policy.ts`, checked at approval and at run time), TCP forwards via `--add-host`, and each secret env var only in its phases; the install gets neither. Every phase is a new container: toolchain caches live in the step's own home (`/dty-home`), Java gets `user.home` and the proxy in `JAVA_TOOL_OPTIONS`, Maven a read-only `~/.m2/settings.xml`; registries are `PACKAGE_REGISTRIES` in `src/engine/apps.ts` (toolchains in test/fixtures/flows/toolchains.json). Every sandbox container, network and temp folder carries the process's owner id (`src/sandbox/owner.ts`); `src/engine/sandbox-housekeeping.ts` sweeps those of stale owners of this database, caps concurrent app/fix steps with `sandbox_slots` (`sandbox_busy` wait), and removes step images Dittoly pulled after the TTL. App and fix steps reach code only through `CodeRunner` (`src/engine/apps.ts`): `AppRunner` on this machine, or with `DITTOLY_CODE_RUNNER=remote` `RemoteCodeRunner`, which drives `src/runner/server.ts` on another machine (no database; same sandboxes; per-app tunnel token; docs/code-runner.md). A fix step touches its clone only through `Workspace.files`, never the local filesystem. Shared mode requires Docker and blocks CLI AI; local mode allows self-approval. Check effective Compose overrides.
- **State:** Use existing Cipher and row-specific associated data. Logs, audit and jobs carry identifiers/outcomes. Include sensitive data in retention/key rotation. Remote writes and SQL transactions are not atomic: preserve uncertain_outcome, retry limits, checkpoints and declared undo actions. Only a write action its manifest marks `idempotent` (it finds what an earlier call made) is repeated after a lost answer or a worker crash, in the engine and in exported apps alike. Jobs are fenced by their claim token (`extendLease`/`complete` take the `Job`); a handler that gets `LeaseLost` stops and records nothing. Exhausted jobs are kept (`failed_at`) for an audited admin retry, never deleted. `Workers` runs a quick lane (`laneKinds.quick`) and a run lane with `config.runWorkers` slots; slots of one run are safe because steps hold their own leases under `FOR UPDATE`.
- **Exports:** Platform and exported runtimes have different identity/persistence. Update both implementations for shared contracts, or explicitly reject unsupported exports with appropriate checks.

Deliberate contract changes must be explicit in implementation, tests and documentation.

## Think before coding

- Inspect the working tree, relevant source and tests; preserve unrelated edits.
- State material assumptions. If a plan, module contract or Flow requirement is unclear, name the uncertainty, present meaningful options and ask before implementing dependent behavior. Continue independent work.
- Surface tradeoffs and suggest a simpler solution when it meets the goal. Do not silently choose between materially different interpretations or ask again for decisions already made.

## Use current, verified information

- Do not rely on memory for library, framework, runtime, API or model details that change. Before adding or upgrading a dependency, or calling an external API, read the newest official documentation or release notes for the version in use; check their dates and that they apply to this version and environment. Never rely only on search snippets or summaries.
- New dependencies and templates pin exact, current stable versions (no ranges, betas or deprecated packages); keep `package.json`, lockfiles and the export templates' pinned versions consistent. Prefer a version released at least two weeks ago.
- Example modules and product skills target the service's current stable API version, not deprecated endpoints.
- When current information cannot be confirmed, say so and ask before depending on it.

## Simplicity and performance

- Implement only the requested behavior with the smallest clear change. Reuse existing services; avoid speculative features, configuration and single-use abstractions.
- Handle real failures at trust and I/O boundaries; skip defenses for impossible internal states. Rewrite code that is more complex than the problem requires.
- Bound work, outputs and concurrency. Batch database/network operations, avoid N+1 queries and repeated scans, and use indexed queries and appropriate data structures. Parallelize independent work only; preserve ordering and rate limits.
- Measure suspected bottlenecks before optimizing. Compare representative workloads for performance changes; report latency, resource use or call counts. Preserve correctness and authorization.

## Workflow discipline

1. Confirm the outcome, constraints and observable acceptance checks before editing. Trace the trigger through its service and persistence/execution boundary.
2. Change the owning service and callers together using existing transactions, validation and error conventions. Add the next migration for schema changes; check compatibility. Pass held transactions through helpers: local mode may have only one database connection.
3. For new steps, protocols or widgets, cover schemas, execution, UI, exports and product skills (`test/skills.test.ts`). Preserve the contracts above.
4. Reproduce bugs before fixing where practical. Run focused and required broader checks; visually inspect UI/document changes. Avoid tests that merely repeat implementation wording.
5. Review the final diff for scope and complexity. Update affected guidance and the authoritative plan when applicable. Report changes, checks and remaining limitations; never claim unrun checks passed.

## Runtime and verification

Use Node from `.nvmrc`/`package.json` (currently 26); confirm `node --version` in the test shell. With nvm, use `nvm use` (`nvm install` if missing). Passing --allow-net cannot upgrade an older runtime.

```sh
npm run typecheck
npm run build
npm test -- test/<affected-area>.test.ts
```

Sandbox/module-contract checks: `test/sandbox.test.ts`, `test/validate.test.ts`, `test/skills.test.ts`.

**Database tests destroy their configured schema:** freshDb/makeWorld in `test/helpers.ts` run DROP SCHEMA public CASCADE. Set TEST_DATABASE_URL to a disposable database before running them; never use application data.

See `docs/development.md` and `.github/workflows/ci.yml` for service-backed checks. Sandbox or toolchain changes: `DTY_TOOLCHAINS=<ids|all> npx vitest run test/toolchains-docker.test.ts` (Docker; `.github/workflows/toolchains.yml`); the error-to-fix test Flows per language (test/fixtures/flows) come from `node scripts/error-to-fix-templates.mjs`. Some require RabbitMQ, Docker, Chromium or other databases. Report focused versus full-suite results accurately.

`npm start` loads .env/PostgreSQL; `npm run local` uses PGlite. Setup/container commands mutate configuration or start services; run them only when relevant.

## Keep guidance in the right place

- This is the canonical Codex/Claude development skill. `.claude/skills/dittoly-project/SKILL.md` is the adapter; AGENTS.md and CLAUDE.md are entry points. Keep detailed instructions here.
- Root `skills/` is product prompt data loaded by `src/ai/skills.ts`, not coding-agent configuration. Keep its contracts aligned with supported features.
- Read relevant [development guidance](../../../docs/development.md) and feature docs only as needed. Verify historical claims against source; update documentation when behavior changes.

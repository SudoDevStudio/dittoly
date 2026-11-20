# AI, browser-check, fix and report steps

Kinds of Flow step that Dittoly runs itself, without a module. Like every
step they take earlier steps' outputs through templates, and their results are
outputs later steps use. The Flow decides the order: for example Jira ticket →
AI plan → person approves → browser check → report → Slack, Teams, a GitLab or
Jira comment, or only some of these.

## Flow instructions

A Flow can carry `"instructions"`: guidance every AI step of it follows, such as a tone, rules,
or context ("write in a friendly tone", "skip videos shorter than a minute"). Set it in the visual
editor ("Instructions for its AI steps") or in the definition, up to 4000 characters. Each AI step
gets it before its own instruction, in runs, model-change checks, cost forecasts and exported apps.
Approvers read it in the Flow's summary. It is part of the version, so changing it makes a new
version that needs approval. It guides answers only: it cannot add, skip or change steps.

## Whose AI

Each AI and browse step says whose AI it uses, and the approver reads it:

- `"ai": "organization"`: the provider an admin configured for Dittoly
  (`DITTOLY_AI_PROVIDER`), billed to the organization.
- `"ai": "runner", "provider": "openai" | "anthropic"`: the key the person running
  the Flow stored in their vault under that name. Without it the step pauses
  with `missing_credential`.

## `ai`

```json
{ "id": "plan", "type": "ai", "ai": "runner", "provider": "openai", "output": "checklist",
  "instruction": "Write browser checks for this ticket.", "input": { "ticket": "{{ steps.issue.output.description }}" } }
```

`output: "text"` gives `{ text }`; `"checklist"` gives `{ checks: [{ check, expect }] }`; `"json"` gives `{ data }`,
an answer in the shape the step's `schema` (a JSON Schema, up to 8000 characters) sets:

```json
{ "id": "review", "type": "ai", "ai": "organization", "output": "json",
  "instruction": "Review the diff. One finding per real problem.", "input": { "files": "{{ steps.pr.output.files }}" },
  "schema": { "type": "object", "required": ["findings"], "properties": { "findings": { "type": "array", "maxItems": 20,
    "items": { "type": "object", "required": ["path", "line", "body"],
      "properties": { "path": { "type": "string" }, "line": { "type": "integer" }, "body": { "type": "string" } } } } } } }
```

A later step can then run once per finding with `"forEach": "{{ steps.review.output.data.findings }}"`. An answer
that is not JSON, or does not match the schema, is asked for once more, told which fields are wrong (never their
values); a second one fails the step (`ai_answer_not_matching`). An answer over 200,000 characters fails it
(`ai_answer_too_large`). The schema is checked when the Flow is saved.

For issue understanding and source-aware bug/noise triage, use `text` and pass the actual error and source evidence as step inputs. Checklist output is intended for browser checks. A configuration-blocker checklist does not process the submitted issue or implement a fix workflow.

Malformed structured answers receive one repair retry with the same input and response schema. A second malformed answer fails the step. A missing text field is an invalid answer; empty text is a real answer and gives `{ text: "" }`. The model-change check does not retry, so every malformed answer counts as a failure there. Authentication, refusal, and budget errors do not enter this format-repair retry. Each call still uses the existing AI usage and budget controls.
The data is fenced off as information, never as instructions, so a ticket that
says "ignore previous instructions" stays text. The answer does nothing by itself.

## Approving a plan: `checklist` fields

An input step field can start from an earlier output and be edited before the
run continues:

```json
{ "id": "approve", "type": "input", "fields": [
  { "name": "checks", "label": "Checks", "widget": "checklist", "required": true, "default": "{{ steps.plan.output.checks }}" } ] }
```

The person changes, reorders, adds or removes rows, then presses *Continue the run*.

## `browse`

```json
{ "id": "check", "type": "browse", "ai": "runner", "provider": "openai",
  "url": "https://staging.example.com/", "hosts": ["staging.example.com"],
  "checks": "{{ steps.approve.output.checks }}", "maxActions": 15 }
```

For each check the AI reads the page (its accessibility tree), clicks, types,
presses keys or navigates, up to `maxActions` times, and decides pass or fail
with a one-line note; a screenshot is taken. Output:
`{ passed, url, checks: [{ check, expect, status: "pass" | "fail" | "blocked", note, screenshot }] }`.

- Pages load only from `hosts` (plus any public https page with `"publicWeb": "read"`),
  enforced per request and by the egress proxy, as for browser modules.
- It sends no credentials. When a person must act (sign in, captcha) it asks the
  person running the Flow in the live view and waits up to 15 minutes; what they
  type is never shown to the AI's later steps' outputs.
- The run's member can watch it live on the run page.
- The AI is told not to change data unless a check needs it, but it does click
  and type on the site: point it at a test or staging environment.

## Which model: pinned per Flow version

A Flow version's AI and browse steps that use the organization's AI run with the model the version was approved with,
not whatever the organization uses now. When a version is approved, its model is recorded as `provider:model` (for
example `anthropic:claude-opus-5-5`; the [organization model](#changing-the-organization-model) an admin chose, else
`DITTOLY_AI_PROVIDER` and `DITTOLY_AI_MODEL`, or the provider's own default when no model is set). The review page shows it under **AI model**, with every switch since. Versions approved before
pinning existed get the model in use when they first run.

- Every call asks the provider for the pinned model, whatever the server is configured with (Anthropic, OpenAI,
  Ollama and the Claude and Codex CLIs all take a model per call).
- A pin to another provider the server still has (see below) is asked there.
- If the provider no longer has that model (it answers "model not found"; for the Claude and Codex CLIs, their error
  output says the model does not exist or the account cannot use it), or the server no longer has the pin's provider,
  the step fails with `pinned_model_unavailable`. The run pauses as usual, the team's approvers are told,
  and the Flow is listed under **Model changes**, where an approver can check it with the current model.
- Steps that use the runner's own key are not pinned: they use that provider's default model.

### Changing the organization model

Admins change the organization's model on the **Admin** page (**Organization AI model**), without a restart: a model
name and, when the server has more than one provider, the provider. The choice is stored with the organization's
settings and takes precedence over `DITTOLY_AI_MODEL` (and `DITTOLY_AI_PROVIDER`) until an admin goes back to the
server configuration. It applies at once to new work (drafts, checks, versions approved from now on); other servers of
the organization pick it up on their next maintenance pass (within a minute). It starts the model-change checks
below right away, and is audited (`ai.model_chosen` with the new model, `ai.model_choice_removed`).

The providers offered are `DITTOLY_AI_PROVIDER` and those listed in `DITTOLY_AI_PROVIDERS` (comma separated:
`anthropic`, `openai`, and in the local install `claude-cli`, `codex-cli`), each with its own key or login as for
`DITTOLY_AI_PROVIDER`. Flows pinned to a provider the server still has keep running there.

API: `GET /api/ai/model`, `PUT /api/ai/model` (`{choice: {provider?, model} | null}`; admins).

### Model-change check

When the organization's model changes (an admin chose another one, or the server configuration changed; Dittoly
compares it right after an admin's change, at startup and on each maintenance pass with the last model it saw), every approved Flow with organization AI steps stays on its model and gets a **model-change check**,
in the background:

- **Inputs:** each AI step is asked with the inputs of the Flow's tests (where the test reaches the step), then of its
  most recent successful runs, while [retention](getting-started.md) still holds their data; at most five inputs per
  step. Runs whose data was deleted are not used.
- **Repeats:** each input is asked three times with the new model.
- **Comparison** with the recorded answer (the test's, or what the old model answered in the run): the answer must
  parse and match the step's output (`text` or `checklist`); fields are compared one by one, exactly for numbers,
  booleans and choices, and by normalized text similarity for strings (the share of words in common, ignoring case and
  punctuation). An input agrees at 80% or more.
- **Consistency:** how alike the three answers are to each other, the same way.
- **Result per Flow:** `passed` (every AI step agrees and is consistent), `differs` (with the fields that differ per
  step; values are shown for tests only, never for runs), `failed` (an answer did not parse or match the output, or
  the model could not be called), `no_inputs` (no test and no kept run reaches an AI step), or `skipped_budget`.
  Browse steps are not asked again: they need live pages.
- **Cost:** the check's tokens count against the Flow's team, like its runs, and stop at the team's monthly budget:
  the check is then `skipped_budget`, and an approver can run it again once the budget allows it.

The team's approvers are told when a check finishes. On **Model changes** (approvers and admins) each Flow shows its
check: results per AI step, the consistency score, the differences and what the check cost. An approver of the
Flow's team (or a stand-in, or an org admin from outside the team, as for approvals) then:

- **Switch** with one click when the check passed;
- **Switch anyway** with a reason of at least 10 characters when it did not;
- **Keep** the old model.

A switch creates no new version: the definition did not change. It is recorded on the version (from, to, who, when,
the reason and the check's results; shown on the review page) and audited (`flow.model_switched`,
`flow.model_switched_despite_differences`, `flow.model_kept`). Until then, runs stay on the pinned model. In shared
mode the Flow's author cannot switch it, as they cannot approve it.

API: `GET /api/model-changes`, `POST /api/model-changes/:checkId/decision` (`{decision: 'accept' | 'keep', reason?}`),
`POST /api/flow-versions/:id/model-check` (check again).

## Cost caps per run

A Flow can limit what one run spends on AI, and each AI or browse step can limit its own share:

```json
{ "costCap": { "tokens": 200000, "amount": 2.5 },
  "steps": [ { "id": "check", "type": "browse", "costCap": { "tokens": 120000 }, "...": "..." } ] }
```

`tokens`, `amount` (in the price table's currency) or both. Without its own cap a run gets the organization's default,
if an admin set one (Members & Access, **AI cost cap per run**). What happens when a run reaches it is in
[insights.md](insights.md#cost-caps-pause-and-ask).

## `report`

```json
{ "id": "report", "type": "report", "heading": "Triage complete",
  "items": "{{ steps.check.output.checks }}", "link": "{{ inputs.issueUrl }}" }
```

Output: `markdown` (GitLab: a task list), `jira` (Jira text formatting), `slack`, `plain`
(Teams, email), `summary` ("1 of 2 checks passed."), `passed`, `counts` and
`screenshots`. Post it with the destinations' own actions, e.g.
`"text": "{{ steps.report.output.slack }}"`.

## `app`: build and run a branch

```json
{ "id": "build", "type": "app", "repo": "https://gitlab.com/acme/shop.git", "ref": "{{ steps.mr.output.sourceBranch }}",
  "credential": "gitlab", "image": "node:26", "install": "npm ci", "build": "npm run build", "start": "npm start",
  "port": 3000, "path": "/", "env": { "NODE_ENV": "test" } }
```

Then check it: `{ "type": "browse", "app": "build", "url": "{{ steps.build.output.url }}", ... }`.

This step **runs the branch's code** (install scripts, build tools, the app), and
the approver's summary says so in capitals.

1. The server clones the branch (`git clone --depth 1`, https only, public
   addresses unless listed in `DITTOLY_INTERNAL_HOSTS`). It uses the runner's
   own token from their vault (`credential`), passed to git in the environment
   and never given to the project's code.
2. **With Docker** (preferred, required on shared servers), install and build run
   in containers on an internal network of the step's own (removed when it
   stops), as an unprivileged user (65534). Their only way out is the
   egress proxy, which allows the git host and the package registries of each supported toolchain (npm, Yarn,
   JSR, PyPI, RubyGems, Maven Central, the Gradle plugin portal and distributions, the Go proxy and checksum
   database, crates.io, NuGet, Packagist, GitHub; the list is `PACKAGE_REGISTRIES` in `src/engine/apps.ts`). Each
   phase is a new container, so the toolchains' downloads (Maven's `~/.m2`, Gradle, Go's module cache, Cargo,
   Bundler, pip's user site, NuGet, Composer, Deno) stay in a home folder of the step's own, mounted at
   `/dty-home` and removed with the step. Java reads neither `HOME` nor the proxy variables, so the JVM gets them
   as `JAVA_TOOL_OPTIONS`, and Maven gets the proxy in a read-only `~/.m2/settings.xml`. The app then runs on that
   network with a read-only root filesystem, reachable only by its run's browser. Limits: no capabilities,
   2 GB of memory, 2 CPUs, no host files except the clone.
3. **Without Docker**, on a local install whose admin switched on *Run project
   code directly* (Members & Access → Building apps from code), the commands
   run in a temporary folder as your user, with full network access, as if you
   ran the branch yourself.
4. Readiness: the step waits up to `readySeconds` for `path` to answer.
   Output: `{ url, hostKey, commit, mode, logTail, network }` (`network`: see below).
5. Apps stop when their run ends (or after two hours, or when Dittoly stops).
   A restart of Dittoly while a run waits loses its app, so the browse step then
   fails with `app_not_running`; retry the run.

### Secret env vars (`secretEnv`)

`env` holds plain settings and is part of the definition everyone can read. A secret the app (or a fix step's tests)
needs goes in `secretEnv`, which names a credential, never a value:

```json
{ "type": "app", "...": "...", "secretEnv": { "DATABASE_URL": "team-db", "STRIPE_KEY": "stripe-test" } }
```

- **Where the value comes from:** when the step runs, the team's stored credential for that service (Teams → shared
  credentials) if it has one, else the runner's own from their vault. Neither: the step fails with `missing_credential`,
  as an action does. The review page and the access preview show each variable and the credential it comes from.
- **Who gets it:** by default every phase but the install: the build, the app and a fix step's test commands (package
  install scripts are the least trusted code that runs). To narrow it, name the phases:
  `"DATABASE_URL": { "service": "team-db", "phases": ["test"] }` (app steps: `build`, `run`; fix steps: `build`,
  `test`). The install never gets one.
- **How:** in docker mode in an `--env-file` (mode 0600, outside the clone, deleted once the container started), never
  on the command line; in direct mode in the process environment.
- **Never shown:** each value is removed from logs, step outputs, what a fix step's AI sees, the run page and evidence
  packs, as written and in its URL-encoded and base64 forms (and a URL's password on its own).
- Each use is audited as `app.secret_env_used`, with the variable's name only.
- The project's code (and, in a fix step, test files the AI wrote) can read the value and print it in another form
  that is not recognised; in docker mode it can send it nowhere but the git host, the package registries and that
  phase's own destinations. Give these steps test credentials, never production ones.

### Outside services (`egress`)

In docker mode each phase has its own egress proxy, started when the phase starts and stopped before the next, so what
one phase may reach another cannot:

| Phase | Reaches |
| --- | --- |
| install | the git host and the package registries, nothing else |
| build | the same, plus the step's `egress.build` |
| test (fix steps: test, reproduce and test-file commands) | the same, plus `egress.test` |
| run (app steps: the running app) | only `egress.run`; nothing outside without it |

The container's own addresses — `localhost`, `127.0.0.1`, `::1`, `0.0.0.0` — never go through the proxy, so a
project whose tests start its server on a loopback port and call it works here as it does anywhere else. The
machine Dittoly runs on is reached by another name and stays blocked.


```json
{ "type": "fix", "...": "...",
  "egress": { "test": ["testdb.internal.example.com:5432", "sandbox.api.example.com"] },
  "secretEnv": { "DATABASE_URL": { "service": "team-db", "phases": ["test"] } } }
```

- **Destinations:** `api.example.com` (port 443), `api.example.com:8443`, `*.example.com` (any ONE label in front:
  `eu.example.com`, not `a.b.example.com` and not `example.com`), `**.example.com` (one or more labels). Anything else
  with a star (`*.example.*`, `api.*.com`) and IP addresses are refused when the Flow is saved.
- **Ports 80 and 443** go through the phase's HTTP(S) proxy (`HTTPS_PROXY`, `HTTP_PROXY` and, for Node's own `fetch`,
  `NODE_USE_ENV_PROXY=1`). **Any other port** is a plain TCP forward, e.g. a test database: it must be one exact host
  and a port from 1024; the container resolves that name to the proxy (`--add-host`), which connects to the real host
  when each connection arrives. One TCP host per port in a phase.
- **Addresses:** the proxy resolves every name when it connects and refuses loopback, link-local, metadata and private
  addresses, unless the host is in `DITTOLY_INTERNAL_HOSTS` (a test database on the company network must be listed
  there, with its port). A redirect is a new request and is checked again.
- **The ceiling:** an org admin lists the destinations steps may declare (Admin → *Outside services for app and fix
  steps*); a team admin may narrow it for their team (Teams page), never widen it. Empty by default. A Flow declaring
  anything outside its team's list is not approved (`egress_outside_policy`); if an admin removes a destination later,
  the step stops with `egress_not_allowed` before it clones anything.
- **Evidence:** the step's output `network` lists, per phase, what it could reach and which secret env vars it got,
  and what each proxy refused, with the reason (`not_allowed`, `unresolved`, `private_address`). The access preview
  (*Before you run*) shows the same per phase before anyone runs the Flow, with any destination the ceiling no longer
  allows.
- **Direct mode** has this machine's full network in every phase: the lists hold only in a container, and the preview
  says so.

## Fix and verify

The `"type": "fix"` step, for an error → fix Flow: an error from your logs (a Datadog or Grafana module's read
action), then a fix step that checks in a sandbox copy of the app whether it is a real bug and drafts a fix, then a
step that opens a draft merge or pull request with the change.

```json
{ "id": "fix", "type": "fix", "ai": "organization",
  "repo": "https://gitlab.com/acme/shop.git", "ref": "main", "credential": "gitlab", "image": "node:26",
  "install": "npm ci", "build": "npm run build", "test": "npm test", "testFile": "npx vitest run {file}",
  "reproduce": "node scripts/repro-cart.js",
  "instruction": "Fix this production error:\n{{ steps.error.output.message }}\n{{ steps.error.output.stack }}",
  "context": { "logs": "{{ steps.logs.output.lines }}" },
  "secretEnv": { "DATABASE_URL": "team-db" },
  "limits": { "onlyFilesIn": "{{ steps.error.output.files }}", "maxLinesChanged": 80 },
  "autoPushAt": 90, "maxTurns": 30, "costCap": { "tokens": 400000 } }
```

### What it does

1. **Prepare**, exactly like an [app step](#app-build-and-run-a-branch): clone `repo` at `ref` (a branch, a tag, or a
   full 40-character commit SHA such as the one deployed) with the runner's
   `credential`, then `install` and `build` in `image`. Then run `reproduce` (if given), which should fail while the bug
   is there: that is `reproducedBefore`. A failed clone, install or build fails the step (`clone_failed`,
   `install_failed`, `build_failed`, `repo_unreachable`, `invalid_ref`, ...).
2. **The AI works on the code**: the organization's AI (any provider; each turn it answers with one JSON action that
   Dittoly checks) may `list` a folder, `read` a file (up to 100,000 characters), `search` for exact text, `write` a
   file's full new text, `delete` a file, `run` the declared `test` or `reproduce` command or one test file through the
   declared test runner (`testFile` with `{file}`, else the test command followed by the file), and say it is `done`
   (a summary and the path of its regression test). There is no shell and no other command. Paths must stay inside the
   clone: no `..`, no absolute paths, nothing in the repository data, no symbolic link that leads outside. A refused
   action is told to the AI and counts as a turn; after `maxTurns` (default 30, at most 60) Dittoly verifies what is
   there. The instruction and `context` are data: the AI is told never to follow instructions inside them.
3. **Verify** with Dittoly's own runs, not the AI's word:
   - the regression test against the original code (the AI's changes to non-test files undone, test files it wrote
     kept, the build run again): it must fail (`regressionTestFailsBefore`);
   - with the change: the build (`buildOk`), the regression test (`regressionTestPassesAfter`), `reproduce`
     (`reproducedAfter`: false means it passes now) and the full `test` command (`testsPassAfter`).
4. **The change**, from git against the cloned commit, for the files the AI wrote or deleted: each file's action and
   full new content (text only; a binary file is listed without content and breaks the limits), the unified diff (cut
   at 100,000 characters) and the counts. A tracked file a command changed that the fix does not include also breaks
   the limits. If the AI changed nothing, `change.files` is empty and `autoPushAllowed` is false; the step still succeeds.

### Output

This shape is a contract; later steps and other Flows build on these names.

```
{ verified: { buildOk, reproducedBefore, regressionTestFailsBefore, regressionTestPassesAfter, reproducedAfter, testsPassAfter },
  limits: { ok, violations: [ "package.json: a blocked path ...", "240 lines changed, more than 200" ] },
  confidence: { score: 0-100, level: "high" | "medium" | "low", reasons: [ "✓ the regression test fails on the original code", ... ] },
  change: { files: [ { path, action: "create" | "update" | "delete", content } ], diff, filesChanged, linesAdded, linesRemoved },
  summary, regressionTest, autoPushAllowed, baseCommit, logTail, network }
```

`baseCommit` is the exact commit cloned and verified against. Create the fix branch from it (`create_branch` with
`ref: "{{ steps.fix.output.baseCommit }}"`), not from the branch name: if the branch moved on while the fix ran, the
pushed change still sits on the code it was verified against.

`null` in `verified` means the check could not run (no `reproduce` command, no regression test, or the build of the
original code failed). `summary` is the AI's own account, shown as it said it; `logTail` is the end of what Dittoly
ran, with secrets removed.

When the step **fails** instead — the install, the build or the tests — that same output is kept with the failed
step and shown on the run page under **What it printed** (and on the panel that says why the run stopped), with its
last lines in the live commentary. The run's member and approvers can read it; it is stored encrypted, holds no
secrets, and is deleted with the rest of the run's data. The same goes for an app step that cannot install or build.

### How confidence is scored

From `verified` and `limits` only; what the AI says about its fix never raises it.

| Level | Score | When |
|---|---|---|
| high | 95, or 100 when both `reproduce` and the regression test showed the bug | there is a change, `buildOk`, the bug was shown to exist (`reproducedBefore` or `regressionTestFailsBefore` true), every check that showed it passes now (a regression test that failed before passes; a reproduce that failed before passes), at least one check passes now (`regressionTestPassesAfter` true or `reproducedAfter` false), `testsPassAfter`, and `limits.ok` |
| medium | 50, or 40 outside the limits | there is a change, the build works and the tests pass, but the bug was never shown to exist, a check that showed it still fails, or the limits are broken |
| low | 10 for each of: a change, the build works, the tests pass (at most 30) | anything else |

`reasons` lists each fact with ✓, ✗ or ? (could not be checked).

`autoPushAllowed` is true only when `autoPushAt` is set and: there is a change, `confidence.score >= autoPushAt`,
`limits.ok`, `testsPassAfter`, and evidence of the bug (`regressionTestFailsBefore` or `reproducedBefore` true).
Without `autoPushAt` it is always false.

### Limits

Dittoly checks the change against them; the AI is told about them but cannot loosen them. Defaults:

- **Blocked paths:** CI/CD (`.gitlab-ci.yml`, `.github/workflows/**`, `.circleci/**`, `Jenkinsfile`,
  `azure-pipelines.yml`, `bitbucket-pipelines.yml`); dependency manifests and lockfiles (`package.json`,
  `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `deno.json`,
  `deno.jsonc`, `deno.lock`, `requirements*.txt`, `Pipfile*`, `poetry.lock`, `uv.lock`, `pyproject.toml`, `setup.py`,
  `setup.cfg`, `go.mod`, `go.sum`, `go.work`, `go.work.sum`, `Cargo.toml`, `Cargo.lock`, `Gemfile*`, `*.gemspec`,
  `composer.json`, `composer.lock`, `pom.xml`, `build.gradle*`, `settings.gradle*`, `gradle.properties`,
  `gradle/libs.versions.toml`, `gradle/wrapper/**`, `.mvn/**`, `mvnw`, `gradlew`, `*.csproj`, `*.fsproj`, `*.vbproj`,
  `*.sln`, `*.slnx`, `Directory.Build.*`, `Directory.Packages.props`, `packages.lock.json`, `NuGet.Config`,
  `nuget.config`, `global.json`); build and infrastructure
  (`Dockerfile*`, `docker-compose*`, `Makefile`, `*.tf`, `**/k8s/**`, `**/helm/**`, `.env*`, `scripts/**`). A rule
  without `/` is a file name and matches at any depth (`package.json` also blocks `web/package.json`); a rule with `/`
  starts at the repository root. `*` is any text without `/`, `**` any text, `?` one character.
- **`maxFiles`** 5 and **`maxLinesChanged`** 200 (added plus removed).
- **`onlyFilesIn`** (optional; a list or a template, e.g. the files of a stack trace; one path per line or comma, line
  and column numbers dropped; a folder ends in `/`; an absolute path from a stack trace matches the file it ends with).
  The regression test the fix names is always allowed when it sits in a test folder (`test/`, `tests/`, `__tests__/`,
  `spec/`, Maven's and Gradle's `src/test/`, a .NET `*.Tests` project) or is named like a test (`cart.test.ts`,
  `cart_test.go`, `test_cart.py`, `cart_spec.rb`, `CartTest.java`, `CartTests.cs`, `CartTest.php`).
- Always: **no binary files**, **no file mode changes**.

A Flow can tighten them (`addBlockedPaths`, lower numbers, `onlyFilesIn`) or set its own list (`blockedPaths`, which
replaces the defaults). A `blockedPaths` that leaves out a CI/CD or dependency rule is refused unless the step says
`"allowRiskyPaths": true`, which the approver sees in capitals. Approved versions keep running as approved when the
default list grows; saving a new version of a Flow with its own list asks for the new rules too. A change outside its limits is still reported in full,
with `limits.ok` false and each violation, and is never pushed automatically.

### Pushing the change, and the evidence gate

The fix step changes nothing outside its sandbox. A later write action (a GitLab or GitHub module's "create merge
request" action, say) pushes `{{ steps.fix.output.change.files }}`; open it as a draft. Because the change is
model-written, that step [waits for a sign-off](governance.md#prompt-injection-containment), unless:

```json
{ "id": "open_mr", "type": "action", "module": "gitlab@1.2.0", "action": "create_merge_request",
  "input": { "...": "...", "files": "{{ steps.fix.output.change.files }}", "draft": true },
  "autoApproveWhen": "steps.fix.output.autoPushAllowed" }
```

With `autoApproveWhen` (only this exact form, naming a fix step before it) the sign-off is released automatically when
`autoPushAllowed` is true at run time; otherwise it waits for a person as before. The review page says so in large type:
*pushes automatically when the fix is verified; otherwise asks a person*. Each automatic release is recorded on the run
page, audited (`guard.auto_released`, with the confidence) and listed in the evidence pack with its evidence. See
[Evidence-gated release](governance.md#evidence-gated-release).

An AI step before the fix step (a triage that decides whether it runs, or is in its `context`) is a path to the fix
step itself: the approver accepts it, or each fix attempt waits for a sign-off. It does not hold the push's gate shut,
because past the fix step only its verified change goes on. Text from that AI step put into the push step's own input
does: the push then always asks a person.

### De-duplicating errors: `fingerprint()`

`{{ fingerprint(steps.error.output.message) }}` gives a 16-character hash of the text with timestamps, UUIDs, hex ids,
quoted values and numbers (line numbers too) replaced, case and spacing ignored: the same error from another request
gets the same value. Use it as a team table's key to skip errors a run already handled. It is the only function a
template can call.

### Where things run

| | docker mode (preferred; required on shared servers) | direct mode (local installs, admin opt-in) |
|---|---|---|
| clone | on the Dittoly server, with the runner's token (passed to git in the environment) | same |
| install, build, test, reproduce, test files | each in a container on the step's own internal network, as an unprivileged user: no capabilities, 2 GB, 2 CPUs, only the clone mounted; out only through its phase's egress proxy to the git host, package registries and that phase's `egress` | in a temporary folder, as your user, with full network |
| the AI's file actions | on the server, inside the clone | same |
| git (the change, the original files) | on the server, on repository data moved out of the clone before any project code ran | same (project code could reach it, as it could reach anything of yours) |
| secret env vars | `--env-file` per phase, 0600, deleted after the step | process environment of their phases |

A database the tests need must be reachable from there: in docker mode, declare it in `egress.test` (see *Outside
services*). Each command may take `timeoutSeconds` (default 900). The workspace is deleted when the step ends.

### Cost

Every AI turn is metered like an AI step's call: counted for the run and the step, against the team's monthly budget,
and stopped at the run's or the step's `costCap` (the run then waits for more to be allowed; the step starts over when
it goes on). A dry run skips fix steps. A Flow version's fix step uses the model it was approved with.

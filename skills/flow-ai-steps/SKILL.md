---
name: flow-ai-steps
description: The built-in Flow steps that ask an AI, drive a browser, build and run an app from a branch, fix and verify code, or format a report, and their limits. Loaded when the AI drafts or revises a Flow or Super Flow.
---
# AI, browser and report steps

ANY MODEL: a step never names a model. "ai" picks whose key is used ("organization" or "runner"), never which model:
Dittoly runs it with the organization's model, the model the Flow is locked to, or the one chosen for that run, and
that can change between runs of the same approved version. Write each instruction so any capable model can follow it
(say the task, the input and the exact answer shape; use output "json" with a schema when later steps read fields),
and never rely on one provider's wording, tool calling, JSON mode or context length. "provider" (only with "runner")
says which of the person's own keys to use, not which model.

AI, BROWSER AND REPORT STEPS:
- { "type": "ai", "ai": "organization" | "runner", "provider": "openai" | "anthropic" (only with "runner"),
    "instruction": "what to do", "input": { ...data from earlier steps, templates allowed... }, "output": "text" | "checklist" | "json",
    "schema": { JSON Schema of the answer; only and always with "json" } }
    asks an AI; output steps.<id>.output.text, or .checks ([{ check, expect }]) for "checklist" (e.g. plan browser checks
    from a ticket's description), or .data for "json": the answer, checked against "schema" (an answer that does not
    match is asked for once more, then the step fails). Use "json" whenever later steps need fields or a list from the
    answer, e.g. review findings to post one by one: "schema": { "type": "object", "required": ["findings"], "properties":
    { "findings": { "type": "array", "maxItems": 20, "items": { "type": "object", "required": ["path", "line", "body"],
    "properties": { "path": { "type": "string" }, "line": { "type": "integer" }, "body": { "type": "string" } } } } } },
    then "forEach": "{{ steps.<id>.output.data.findings }}" on the step that acts on each. Bound arrays with maxItems. "organization" = the AI an admin set up for Dittoly; "runner" = the person's own key, falling back to the organization's AI when they have none.
    Use "runner" unless the request says the organization's AI. Never put secrets in "input".
    For issue understanding and bug/noise triage use output "text", not a browser checklist. Supply the actual
    submitted error and source evidence as input. Judgement on the answer (is this the same issue as an existing
    comment, is this finding worth posting) is the AI step's job: give it the existing items as input and ask for
    only the new ones. A check that must be exact against the app (this exact comment is already on this line)
    belongs in that app's write action, never in a separate module.
    A static configuration-blocker checklist does not implement error triage or the requested fix pipeline.
    Malformed structured output is retried once with the same schema and data; repeated failure stops the step.
- { "type": "browse", "ai": ..., "provider": ..., "url": "https://app.example.com/ or a template", "hosts": ["app.example.com"],
    "checks": "{{ steps.<id>.output.checks }}" or [{ "check": "...", "expect": "..." }], "maxActions": 15 }
    an AI drives a headless browser through each check and returns steps.<id>.output.passed, .url and .checks
    ([{ check, expect, status: pass|fail|blocked, note, screenshot }]). "hosts" are the only sites it may open
    (add "publicWeb": "read" only when it must read arbitrary public sites). It asks the person when it must sign in.
- { "type": "app", "repo": "https://gitlab.com/acme/shop.git or a template", "ref": "branch or template", "credential": "gitlab",
    "image": "node:26", "install": "npm ci", "build": "npm run build", "start": "npm start", "port": 3000, "path": "/" }
    builds and starts the app from a branch (it RUNS that code, isolated); output steps.<id>.output.url. A browse step
    checks it with "app": "<app step id>" and "url": "{{ steps.<app id>.output.url }}" (no "hosts" needed for the app).
    Use it only when the request asks to build or run the code; otherwise check a deployed URL.
    Secrets the app needs go in "secretEnv": { "DATABASE_URL": "<credential service>" }, never in "env".
- { "type": "fix", "ai": "organization", "repo": "...", "ref": "main", "credential": "gitlab", "image": "node:26",
    "install": "npm ci", "build": "npm run build", "test": "npm test", "testFile": "npx vitest run {file}",
    "reproduce": "optional command that fails while the bug is there",
    "instruction": "Fix this error: {{ steps.<log step>.output.message }}", "context": { "logs": "{{ ... }}" },
    "secretEnv": { "DATABASE_URL": "team-db" }, "limits": { "onlyFilesIn": "{{ ... files from the stack trace ... }}" },
    "autoPushAt": 80 }
    For another language use its own image and commands (Maven, Gradle, pip and pytest, Go, Cargo, .NET, Bundler,
    Composer, Bun, Deno), e.g. "image": "golang:1.27", "install": "go mod download",
    "build": "go build ./...", "test": "go test ./...", "testFile": "go test \"./$(dirname {file})\"".
    fix and verify: the organization's AI changes a copy of the repository and adds a regression test; Dittoly then
    runs the checks itself. Output steps.<id>.output.verified ({ buildOk, reproducedBefore, regressionTestFailsBefore,
    regressionTestPassesAfter, reproducedAfter, testsPassAfter }), .limits ({ ok, violations }), .confidence ({ score
    0-100, level high|medium|low, reasons }), .change ({ files: [{ path, action create|update|delete, content }], diff,
    filesChanged, linesAdded, linesRemoved }), .summary, .regressionTest, .autoPushAllowed and .logTail. It pushes
    nothing: a later action step opens the merge or pull request with .change (as a draft unless the request says
    otherwise). Use it only when the request asks to fix code. Leave out "autoPushAt" unless the request asks for
    automatic pushes when the fix is verified.
  The action that commits them must take that exact shape: files: [{ path, action create|update|delete, content }].
  A Flow cannot reshape a value, so an action whose input refuses "action" (or wants a field a fix does not give)
  can never run with a fix's files — Dittoly refuses such a Flow before anybody reviews it. When no approved action
  takes that shape, say so in missingJson ("commit a fix step's files: [{path, action, content}]") instead of
  drafting a Flow that cannot run.
- Evidence gate: a write action that uses a fix step's .change waits for a person's sign-off, like any step an AI's
  text reaches. To let it go on by itself when Dittoly verified the fix, give that action step
  "autoApproveWhen": "steps.<fix id>.output.autoPushAllowed" (exactly this form, naming a fix step before it). Only
  when the request asks for automatic pushes; text from any other AI step reaching it still asks a person.
- To recognise the same error again (e.g. remember it in a data table and skip it next time), use
  "{{ fingerprint(steps.<id>.output.<error text>) }}" as the table key: a short hash that ignores numbers, ids,
  times and quoted values.
- { "type": "report", "heading": "Triage complete", "items": "{{ steps.<browse id>.output.checks }}", "link": "optional URL template" }
    formats results; steps.<id>.output.markdown (GitLab), .jira (Jira comments), .slack (Slack), .plain (Teams, email),
    .summary, .passed and .screenshots.
    Give report items explicit observed status (pass, fail, blocked) or a passed boolean. A filename or an
    unexecuted checklist is not a passing check; missing and unknown statuses are reported as blocked.
A plan an AI writes that will drive a browser should be shown to the person first: an input step with a field
{ "name": "checks", "widget": "checklist", "default": "{{ steps.<ai id>.output.checks }}", "required": true } lets them
edit and approve it; the browse step then uses "{{ steps.<input id>.output.checks }}". Post the report with the
destinations' own actions (Slack, Teams, a GitLab or Jira comment), each only if the request asks for it.
What an AI or browse step writes can carry instructions hidden in what it read (a ticket, a page, an email). A step
that changes something (a write action, a table write, an app build, a fix, a Flow that writes) and uses that text, in its
input, "when" or "forEach", waits for a person's sign-off when the Flow runs: the approver sees that step's exact values
and approves exactly those. An approval step earlier in the Flow does not replace it, so do not add one only for this.
Only an input step whose answers the later step uses (a person edits or confirms the AI's text) stops the path.

Limits:
- ai: "instruction" 1-4000 characters. The data it gets is cut to 60,000 characters and a text answer to 20,000; a
  checklist keeps at most 30 checks. Data sent to an AI goes to that AI provider: send only what the task needs.
- browse: "url" up to 2000 characters; "hosts" up to 20 (exact host[:port] or *.domain); a browse step needs "hosts",
  "app" or "publicWeb"; "checks" is a template or up to 30 checks of up to 500 characters; "maxActions" 1-40.
- app: "repo" is an https URL without a user name, password, query or fragment, on a public address; "ref" is a
  branch, tag or commit name (letters, digits, . _ / -); "install" and "build" up to 500 characters; "start" is
  required; "env" names are UPPER_CASE with values up to 500 characters and must not hold secrets; the app is
  stopped after at most 2 hours. "secretEnv": up to 20 UPPER_CASE names, each a credential service name (lowercase,
  digits, - and _), not also in "env"; or { "service": "...", "phases": [...] } to give it only to those phases (app:
  "build", "run"; fix: "build", "test"; never the install). "egress": outside services per phase, only when the
  request names them: app { "build": [...], "run": [...] }, fix { "build": [...], "test": [...] }; each
  "api.example.com", "api.example.com:8443", "*.example.com" (one label) or "**.example.com" (any depth); a database
  is "testdb.example.com:5432" (one exact host, port from 1024). They must be in the organization's allowed list, or
  the Flow is not approved: ask which services and phases when the request is vague, never guess a host.
- fix: "ai" is always "organization"; "test" is required (up to 500 characters); "testFile" must contain {file};
  "instruction" 1-8000 characters; "maxTurns" 1-60 (default 30); "autoPushAt" 0-100; "timeoutSeconds" 30-3600.
  "limits": "maxFiles" (1-50, default 5), "maxLinesChanged" (1-5000, default 200), "onlyFilesIn" (a template or up to
  50 paths; the regression test in a test folder is always allowed), "addBlockedPaths" (more path rules), and
  "blockedPaths" (replaces the defaults: CI/CD files, dependency manifests and lockfiles, Dockerfiles, docker-compose,
  Makefile, *.tf, k8s, helm, .env files and scripts/). Leaving out CI/CD or dependency files needs
  "allowRiskyPaths": true; do not write it unless the request explicitly asks. Path rules are relative, without "..".
  No binary files and no file mode changes, ever.
- report: "heading" 1-200 characters, "items" is one whole template, "link" up to 2000 characters.

# Dittoly documentation

**Dittoly: orchestrate anything.** Super-Modules + Super Flows, approved by people, run with your own access.

Dittoly is a self-hosted orchestration platform for teams. **Super-Modules** connect your apps, **Flows** automate a process, and **Super Flows** connect Flows into bigger ones. One idea runs through it: your access stays yours.

- People describe a multi-app process in plain language, for example *"gather approved Jira tickets, merge ready MRs, notify the channel"*.
- The AI drafts a workflow. A human approves it.
- The engine then runs exactly the approved version, nothing else.

## The architecture

- **Super-Module:** one app, and no state of its own. It offers the operations you need there (create, read,
  update, delete, list, search); everything it needs comes in as an action's input, and what it found comes back
  as that action's output.
- **Flow:** the process. It chains approved actions and built-in steps, keeps what must last in the team's data
  tables, holds the configuration, and passes both to the modules.
- **Super Flow:** a wrapper that runs several approved Flows for one request, passes their results along, and
  returns the answer.
- **Any Flow runs on any AI model.** The model is chosen when a run starts: the organization's, one an approver
  locked the Flow to, or one picked for that run. Nothing in a Flow or a module is written for one model or
  provider, and a model that disappears falls back to the organization's.

## What sets it apart

1. **Per-action delegation.** If you lack access to an app, a teammate approves and runs that one Action with their own account. Both names are recorded.
2. **Isolated credentials.** Each member keeps their own credentials in a personal vault. Sharing a Flow or module never shares credentials.
3. **Integrations without developers.** Integrations (Super-Modules) are generated through chat, each with a manifest that the runtime enforces: declared hosts and credentials only, nothing else.
4. **Approval that can't be bypassed.** Any change to a Flow cancels its approval, and Flows pin module versions.

## Status

Phase 1 (Steps 2–4 of the build plan) is built: a web portal, SSO sign-in, chat-built Flows and modules, delegation, schedules and webhooks, an organization marketplace, MCP import, chat-driven custom views, and both deployment modes. It has not been run against real Jira/GitLab/Slack accounts or a real identity provider yet, and the open Step 0 decisions still use provisional defaults.

## Pages

- [getting-started.md](getting-started.md) – from an empty workspace to your first run, step by step; the home page's checklist and a 1.25× video
- [demo-videos.md](demo-videos.md) – seven short captioned videos of Dittoly end to end, and how to record them again
- [install.md](install.md) – every way to install (Node.js, Docker, from source) and the settings
- [server.md](server.md) – running a shared server with Docker step by step: system requirements, HTTPS, upgrades, backups, sizing
- [api.md](api.md) – the HTTP API
- [protocols.md](protocols.md) – what modules can connect to (HTTPS, SMTP, AMQP, MQTT, WebSocket, SSE, MCP) and how requests are classified first
- [phone-and-glasses.md](phone-and-glasses.md) – connect a phone with a QR code and give commands by voice, through Meta glasses (with a Ray-Ban Display layout), or in Telegram and WhatsApp
- [governance.md](governance.md) – rules, several approvers, approval by team, stand-ins while away, approval deadlines, access preview and dry runs, token scopes, the sealed audit log and report, break-glass, access reviews
- [audit-streaming.md](audit-streaming.md) – stream every audit event to Splunk, Datadog, an HTTPS collector, syslog over TLS or OpenTelemetry, in order and checkable
- [module-safety.md](module-safety.md) – what changed between versions, tests recorded against the real app, drift warnings, and self-fixing Flows (fixes drafted and Flow versions proposed automatically when an app changes)
- [git-sync.md](git-sync.md) – write approved modules, Flows, Super Flows and apps to a git repository as pull requests, and bring merged changes back as versions waiting for approval (organization or team repository; GitHub, GitLab or any git host)
- [apps.md](apps.md) – apps inside Dittoly: pages over a team's approved Flows, shared by the team, run on the team's keys, approved per version, exported later
- [app-export.md](app-export.md) – export approved Flows as an app of their own: a TypeScript project with the Flows as code and no database (runner, headless API, simple UI, or a React/Next.js/Angular/Astro/Vue frontend laid out from your Flows), a Docker image configured by environment variables
- [visual-editor.md](visual-editor.md) – build and change Flows by dragging steps
- [insights.md](insights.md) – run insights (failures, waits on people, time saved), what Flows saved by not asking an AI every time, and AI usage, budgets and estimated cost
- [watches.md](watches.md) – start a Flow for each new app item, email or file
- [super-flows.md](super-flows.md) – connect Flows into a Super Flow: flow steps run approved Flows, in parallel, pinned to a version
- [flow-tests.md](flow-tests.md) – tests that play a Flow with recorded answers, shown to approvers on every version
- [data-tables.md](data-tables.md) – team tables Flows read and write to remember things between runs
- [undo.md](undo.md) – reverse what a run or an AI agent changed: undo declared per module action, an approver's sign-off, an admin-set undo window
- [mcp-server.md](mcp-server.md) – AI assistants (Claude, Cursor, ...) run your approved Flows as tools, as you, and save tasks they did as Flows for approval
- [deleting.md](deleting.md) – deleting (archiving) Flows, Super Flows and modules, and restoring them
- [flow-urls.md](flow-urls.md) – a unique URL per Flow that other systems call with an `x-sflow-token`
- [plans.md](plans.md) – upload a plan as a PDF; the AI asks its questions and drafts modules and Flows for review
- [ai-steps.md](ai-steps.md) – AI, browser-check and report steps in Flows
- [code-runner.md](code-runner.md) – build, test and run app and fix steps on a separate machine (`DITTOLY_CODE_RUNNER=remote`), so project code never runs where Dittoly and its database are
- [ai-skills.md](ai-skills.md) – the skill files the AI follows when it drafts modules, Flows, Super Flows and plans: what is allowed and what is not
- [browser-scripts.md](browser-scripts.md) – browser modules and Playwright scripts
- [development.md](development.md) – running the tests
- [capacity-baseline.md](capacity-baseline.md) – measured throughput and memory of the background worker, and how to measure your own host

# The map: what lives where

Four pictures of the same thing. The first says how a request becomes a run; the second, where the AI and its
skills sit; the third, what a run may touch; the last names every directory, so a file can be found from the
picture.

The rule all of them obey: **a module keeps nothing, the Flow holds the configuration and the state, a Super Flow
is only a wrapper, and nothing runs until a person approves a version.**

## 1. From a request to a run

```mermaid
flowchart TB
  classDef person fill:#0c1d30,stroke:#37d5c3,color:#d7e5fb
  classDef store fill:#071829,stroke:#20354a,color:#91a3b8
  classDef gate fill:#352a18,stroke:#f5bd4f,color:#f5bd4f

  member["A person<br/>(member, approver, admin)"]:::person
  agent["An AI assistant<br/>over MCP"]:::person
  app_["Another system<br/>(a webhook, a Flow URL)"]:::person

  subgraph ways["Ways in"]
    portal["Portal<br/><code>web/src</code>"]
    mcp["MCP server<br/><code>src/mcp</code>"]
    hooks["Webhooks<br/><code>src/webhooks</code>"]
    urls["Flow URLs<br/><code>src/endpoints</code>"]
    sched["Schedules & watches<br/><code>src/engine/scheduler.ts</code>, <code>src/watches</code>"]
  end

  api["HTTP API<br/><code>src/api/server.ts</code> + <code>src/api/*</code>"]
  wiring["Everything wired together<br/><code>src/app.ts</code>, <code>src/config.ts</code>, <code>src/main.ts</code>"]

  subgraph build["Build (drafting)"]
    plans["Plans & home chat<br/><code>src/plans</code>"]
    modchat["Module drafting<br/><code>src/modules/chat.ts</code>"]
    flowchat["Flow drafting<br/><code>src/flows/chat.ts</code>"]
  end

  subgraph keep["What is kept"]
    registry["Module registry<br/><code>src/modules/registry.ts</code>"]
    flows["Flow service<br/><code>src/flows/service.ts</code>"]
    tables["Team data tables<br/><code>src/tables</code>"]
  end

  gov["Approval, policies, change records<br/><code>src/governance</code>"]:::gate
  engine["Engine: runs, steps, retries<br/><code>src/engine/engine.ts</code>"]
  jobs["Durable job workers<br/><code>src/engine/jobs.ts</code>"]
  db[("PostgreSQL / PGlite<br/><code>src/db</code>, encrypted columns")]:::store

  member --> portal
  agent --> mcp
  app_ --> hooks
  app_ --> urls
  portal --> api
  mcp --> api
  hooks --> api
  urls --> api
  sched --> jobs
  api --> wiring
  wiring --> build
  wiring --> keep
  build --> gov
  gov -->|"a version a person approved"| keep
  keep --> engine
  api --> engine
  engine <--> jobs
  engine --> db
  keep --> db
  jobs --> db
```

## 2. Where the AI sits, and what it is told

The skills in `skills/` are the standing rules. They are files, not prompts scattered in code: one set per kind of
drafting, read by `src/ai/skills.ts` and put in front of every request, whichever model runs.

```mermaid
flowchart LR
  classDef skill fill:#112e45,stroke:#8cceff,color:#d7e5fb

  subgraph skills["skills/ — the standing rules"]
    basics["dittoly-basics<br/>what a module, Flow and Super Flow are"]:::skill
    factory["dittoly-factory"]:::skill
    modauth["module-authoring<br/>module-protocols<br/>secure-modules<br/>performant-modules<br/>browser-scripts"]:::skill
    flowauth["flow-authoring<br/>flow-ai-steps<br/>super-flow-authoring"]:::skill
    planning["plan-breakdown<br/>plan-chat<br/>save-ai-work"]:::skill
  end

  sets["Which skills each request gets<br/><code>src/ai/skills.ts</code> (SKILL_SETS)"]
  catalog["What it may build with:<br/>approved actions, Flows, data tables,<br/>and what each module must be told"]

  subgraph draft["Drafting"]
    genmod["Module draft<br/><code>src/ai/generate-module.ts</code>"]
    genflow["Flow draft<br/><code>src/ai/generate-flow.ts</code>"]
    genplan["Plan<br/><code>src/ai/plan.ts</code>, <code>plan-chat.ts</code>"]
    classify["What it needs first<br/><code>src/ai/classify.ts</code>"]
  end

  provider["Any model, one interface<br/><code>src/ai/provider.ts</code>, <code>src/runtime/ai-*.ts</code><br/>Anthropic · OpenAI · Ollama · Claude CLI · Codex CLI"]
  checks["Checked before anyone sees it:<br/>manifest parser, TypeScript compiler,<br/>Flow validator, sandbox tests"]
  review["A person approves the version<br/><code>src/governance</code>"]

  basics --> sets
  factory --> sets
  modauth --> sets
  flowauth --> sets
  planning --> sets
  sets --> draft
  catalog --> draft
  draft <--> provider
  draft --> checks
  checks -->|"passes"| review
  checks -->|"fails"| draft
```

## 3. What a run may touch

Every call leaves through the broker, which allows only what the approved manifest declares. The module itself
holds nothing: the Flow passes it everything, per step.

```mermaid
flowchart TB
  classDef gate fill:#352a18,stroke:#f5bd4f,color:#f5bd4f
  classDef store fill:#071829,stroke:#20354a,color:#91a3b8

  run["A run of one approved Flow version<br/><code>src/engine/engine.ts</code>"]
  steps["Built-in steps: ai · browse · fix · app · table ·<br/>approval · input · delay · report · flow<br/><code>src/engine/builtin.ts</code>, <code>src/runtime/ai-step.ts</code>"]
  told["What the module is told<br/>(the Flow's moduleSettings, the step's own)<br/><code>src/flows/definition.ts</code>"]
  state[("The Flow's state:<br/>the team's data tables<br/><code>src/tables</code>")]:::store
  vault[("The runner's own credentials<br/><code>src/core/vault.ts</code>")]:::store

  sandbox["Sandbox: the module's code runs here<br/><code>src/sandbox/runner.ts</code> (process or docker)"]
  broker["Broker: every call out<br/><code>src/sandbox/broker.ts</code>, <code>src/runtime/broker.ts</code>"]:::gate
  manifest["What the manifest allows:<br/>hosts, credentials, endpoints, actions<br/><code>src/modules/manifest.ts</code>"]:::gate
  apps["The apps themselves<br/>(HTTPS, databases, queues, mail, MQTT)"]

  run --> steps
  run --> told
  told --> sandbox
  state <--> run
  vault -->|"only the declared service"| broker
  run --> sandbox
  sandbox --> broker
  manifest --> broker
  broker -->|"allowed"| apps
  broker -.->|"refused: an undeclared host"| run
  run --> commentary["What it is doing, line by line<br/><code>src/engine/commentary.ts</code>"]
  run --> outcome["What came of it<br/><code>src/engine/outcome.ts</code>, <code>next-steps.ts</code>"]
```

## 4. Every directory, in one place

| Where | What it is |
|---|---|
| `skills/` | The AI's standing rules, one folder per skill. Shipped with Dittoly, the same for every model. |
| `src/main.ts`, `src/app.ts`, `src/config.ts` | Start-up: read the settings, build every service once, serve. |
| `src/api/` | The HTTP API: `server.ts` plus a file per area (auth, governance, tables, watches, exports…). |
| `web/src/` | The portal people use: pages, the Live panel, the Flow graph, the approval rows. |
| `src/flows/` | What a Flow is: `definition.ts` (the schema), `service.ts` (checks, versions, approval), `chat.ts` (drafting), `template.ts`, `injection.ts`, `tests.ts`. |
| `src/modules/` | What a module is: `manifest.ts` (what it may do), `registry.ts` (versions), `chat.ts` (drafting), `health.ts` (drift), `run-fix.ts`. |
| `src/engine/` | Running: `engine.ts` (steps, retries, resolution), `jobs.ts` (durable workers), `builtin.ts` (ai/browse/fix/app steps), `scheduler.ts`, `commentary.ts`, `outcome.ts`. |
| `src/sandbox/` | Where module code runs and how it reaches the world: `runner.ts`, `broker.ts`, `browser.ts`, `live.ts`. |
| `src/runtime/` | The part that also ships inside an exported app: manifests, templates, transports, databases, the AI step, the providers. |
| `src/ai/` | Drafting with any model: `skills.ts`, `generate-module.ts`, `generate-flow.ts`, `plan.ts`, `provider.ts`, `models.ts`, costs and metering. |
| `src/governance/` | Who may approve what, policies, change records, allowed hosts. |
| `src/plans/` | A plan (a PDF or the home chat) becomes modules and Flows, built in order. |
| `src/core/` | The things everything uses: members, teams, the vault, crypto, audit, notifications, logging. |
| `src/db/` | The connection and the migrations (`src/db/migrations/*.sql`). |
| `src/tables/` | The teams' data tables: the Flow's own state between runs. |
| `src/mcp/` | Dittoly as an MCP server (agents use approved actions) and as an MCP client (imported tools). |
| `src/webhooks/`, `src/endpoints/`, `src/watches/` | The three ways another system starts a Flow: a webhook, a Flow URL, a watched inbox or feed. |
| `src/export/` | An approved Flow written out as a small app that runs without Dittoly. |
| `src/marketplace/`, `src/team-apps/`, `src/views/`, `src/insights/` | Sharing templates, the pages a team builds over a Flow, saved views, what it all saved. |
| `src/local/`, `src/cli/`, `src/runner/`, `src/devices/`, `src/git-sync/` | The local install (PGlite, launcher, cleanup), command-line tools, the remote code runner, devices, git export. |
| `test/`, `scripts/bench/` | The whole suite (including the browser end-to-end tests) and the benchmarks: capacity, and whether a model can do this work. |
| `docs/` | These pages. `install.md`, `server.md`, `governance.md`, `module-safety.md`, `super-flows.md`, `app-export.md`, and the rest. |

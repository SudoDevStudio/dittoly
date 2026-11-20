# AI skills

The rules the AI follows when it drafts modules, Flows, Super Flows and plans live in plain Markdown files in [`skills/`](../skills), one folder per skill with a `SKILL.md`. Dittoly loads them as the AI's instructions for every provider (Anthropic, OpenAI, Ollama, the Claude CLI), so any model gets the same rules, and people can read exactly what the AI is told.

| Skill | What it covers | Used for |
|---|---|---|
| `dittoly-basics` | How Dittoly works (draft, validate, review, approve, pinned versions) and what the AI may and may not do | Everything below, always first |
| `module-authoring` | The manifest, public access and keys, settings, code rules, sandbox tests, the limits the sandbox enforces | Modules |
| `module-protocols` | SMTP, AMQP, MQTT, WebSocket, SSE endpoints and what is not supported | Modules |
| `performant-modules` | Fewest calls, small parallel batches, capped pagination, small outputs, efficient queries; matched by the "Performance P1-P9" review checks | Modules |
| `browser-scripts` | Browser modules (a Playwright subset), canned-page tests, asking a person for help | Modules |
| `flow-authoring` | The definition, run form, step types, templates, conditions and the validator's limits | Flows and Super Flows |
| `flow-ai-steps` | AI, browser-check, build-and-run and report steps | Flows and Super Flows |
| `super-flow-authoring` | Flow steps that run approved Flows, in parallel, passing outputs on | Flows and Super Flows |
| `save-ai-work` | How an AI assistant turns a task it just did into a Flow (inputs, tests from what apps answered, cost baseline) with `save_as_flow`; given to assistants over MCP with the Flow skills | Assistants over MCP ([mcp-server.md](mcp-server.md)) |
| `plan-breakdown` | Breaking an uploaded plan into new modules, new Flows, reused Flows and a Super Flow, with questions | Plans |

Which skills make up each prompt is set in `src/ai/skills.ts`.

**Current versions.** The AI drafts Flows (and plans and saved AI work) from a catalog that lists only each module's **newest approved version**, so new steps never pin an older release; Flows already approved keep the versions they were approved with. The skills tell it to use the newest stable API version a reference documents, never a deprecated endpoint, and to say which API version an action targets when it relies on its own knowledge. A fix step uses the library versions the repository locks.

**Which model drafts what.** The organization's model (Admin, or `DITTOLY_AI_MODEL`) is the default for every

**What the team already answered.** Drafting asks what it cannot decide — which channel, which project, which
branch. Those answers are kept for the team that gave them and handed to later drafts, so the second Flow is not
asked what the first one was. They are what people typed, never what a model inferred or an app sent; they decide
nothing on their own (a request that says otherwise wins, and every version still goes through its checks and its
approver); and the team sees them, and can forget any of them, on the Teams page.
draft. Whoever may draft a thing may give it its own: a picker on the Flow review (a Super Flow too), the module
review, a plan, and on **Create** for whatever you start next. The choice stays with that thing — its next
revision, "Draft it again", a module fix, a plan's items — until someone changes it or puts it back to the
organization's. It decides who writes the draft and nothing else: a run's AI steps follow the model the Flow was
approved with (**Model changes**), which is a separate decision with its own approvals. What each version records
afterwards is the model that actually answered, so **Model comparison** adds the choices up.

**Fixed, not per organization.** The skill files ship with Dittoly and an organization cannot edit them, so its admins cannot weaken a safety rule by accident. To add an organization's own rules (naming, preferred API versions, "never add delete actions"), admins use **Admin → AI instructions**; those come after the skills, and the skills win where they conflict.

**The skills are not the control.** They help the AI get a draft right the first time. What runs is still decided by validation, the sandbox, the broker and the people who review and approve. The limits written in the skills are the ones those enforce; `test/skills.test.ts` fails when the code gains a step type, form widget or protocol the skills do not mention.

Changing a skill changes what every model is told, so after editing one, run the tests.

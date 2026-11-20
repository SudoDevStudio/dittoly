# Insights and AI usage

**Insights** (in the sidebar) shows, for the last 7, 30 or 90 days and the selected team:

- **Per Flow:**
  - runs (dry runs counted apart) and the share that succeeded;
  - median and 90th-percentile run time;
  - how long runs waited on people;
  - the steps it fails at most, with their error types.
- **Waiting on people:** how many sign-offs, forms and teammate requests were answered, with the median and the longest wait.
- **Time saved:** a Flow's owner (or an admin) enters how long one run would take by hand. Successful real runs are multiplied by that. Flows without a time are not counted, and the page says how many there are.

Members see their teams' Flows; approvers and admins see every team's. Only counts and times are used; no run data.

## Saved by not asking an AI every time

The **Saved by not asking an AI every time** card puts a number on Dittoly's promise: you do a task with AI once, and from then on it repeats without spending tokens.

- **Baseline per Flow:** what doing the Flow's task with an AI cost once, in tokens. It comes from one of three places:
  - **reported by the AI assistant** that saved the Flow over MCP (`aiUsage` in `save_as_flow`, see [mcp-server.md](mcp-server.md));
  - **what drafting it cost** with the organization's AI, for Flows drafted in chat or from a plan. This is a stand-in, usually lower than doing the task itself;
  - **set by its owner** (or an admin) on the card: tokens in and out, and optionally the provider and model. The owner's value is never overwritten. Clearing it leaves the Flow without a baseline.
- **Tokens not spent:** each successful real run (not dry runs) saves the baseline, minus the tokens that run's own AI steps used (with any key).
- **Money saved:** the same, priced with the price table under **AI usage**. A baseline that names only a model uses any provider's price for that model. Models without a price show tokens only and are listed.
- **AI spent on fixes:** the organization's AI calls for [self-fixing](module-safety.md#self-fixing-flows) modules. They are subtracted, so the money figure is net. Only approvers and admins see this, for all teams.
- **Per team and per Flow** tables. Flows with no baseline are counted apart and listed last, so owners can set one.
- **Time saved** is the same as above: each Flow's time by hand × its successful runs.
- **AI cost per successful run:** everything the Flow's real runs spent on AI in the period (retries, failed and
  cancelled runs included, with any key) divided by its successful runs, in tokens and, where the models have a price,
  money. It shows what a result really costs.

API: `GET /api/insights/savings?days=30&team=`, `PUT /api/flows/:id/ai-baseline` (`{baseline: {inputTokens, outputTokens, provider?, model?} | null}`).

## AI usage and budgets

Every call to an AI records its tokens: who (team and person), what for (step, module, Flow, plan, command), whose key, provider and model. **Prompts and answers are never kept.**

- **Budgets:** organization admins can give a team a monthly token budget for the **organization's** AI.
  - Calls stop when it is used up. The person sees "Your team has used this month's AI budget"; a run's AI step pauses with `ai_budget_exhausted` and can be retried once the budget is raised.
  - Team admins (or organization admins, for a team without its own admins) are told once a month when the team passes the warning share (80% unless set otherwise).
- **Runners' own keys** (AI steps set to use the runner's own OpenAI or Anthropic key) are counted but never limited.
- **Estimated cost:** admins enter prices per million input and output tokens per provider and model. Dittoly has none built in, because prices change. Models without a price are listed so nobody mistakes the estimate for the full cost.
- Tokens come from what each provider reports:
  - Anthropic and OpenAI usage fields;
  - Ollama's `prompt_eval_count` / `eval_count`;
  - the Claude CLI's JSON usage.

  The Codex CLI reports none, so its calls are not counted.

Where a call cannot be tied to a team (for example some background drafting), it is listed as "Not attributed" and counts against no budget.

## Cost caps: pause and ask

Every AI call of a run is recorded against the run and its step. A run's spend can be capped:

- **Caps:** a Flow can set `costCap` for one run, and each AI or browse step its own (`{tokens, amount}`: tokens, money
  in the price table's currency, or both; see [ai-steps.md](ai-steps.md#cost-caps-per-run)). Admins can set a default
  cap per run under Members & Access, used for Flows that set none.
- **When it is reached:** before an AI or browse step starts, and before each call while it runs (a browse step makes
  many), Dittoly adds up what the run (or the step) spent so far. Once that reaches the cap, the run **waits like for a
  sign-off**: the step shows "cost cap reached: spent X of Y", and the run's owner and the team's approvers are told.
  It is in their approvals queue.
- **Allow more or cancel:** the run's owner or an approver of its team allows more for that run (tokens and/or money;
  this raises the run's cap and any step cap by that much, and is recorded and audited) and the run goes on at once; or
  they cancel it. Nobody else can.
- Money counts only calls whose model has a price; calls without one count as tokens only. Calls with the runner's own
  key count too.
- **Dry runs** have no caps. **Team monthly budgets** stay a hard stop: a call over the budget fails with
  `ai_budget_exhausted` whatever the cap.

API: `POST /api/runs/:id/allow-spend` (`{tokens?, amount?}`), `POST /api/runs/:id/cancel`, `GET/PUT /api/ai/run-cap`
(`{cap: {tokens?, amount?} | null}`, admins). The run view has `aiSpend` and, while it waits, `costCap`.

## Cost forecast at approval

The Flow review page (where approvers decide) shows **AI cost per run**, and the request approvers get for a new Flow
version (email, Slack or Teams, and its reminders) says it in a sentence: the estimate, how it was made, the real runs'
median and the cap.

- **From the Flow's tests:** recorded token counts do not exist, so each AI step is estimated from its prompt (the
  instruction and the data the test gives it, about four characters a token) and its recorded answer (or, without one,
  a typical answer for its output: a text or a check list). A browse step counts four page looks per check, of about
  3,000 tokens each. A fix step counts all its `maxTurns` turns at a typical turn (about 4,000 tokens sent plus its
  instruction and context, 400 back), until it has real runs: then the median of what that step spent in them (same
  runs as below). The largest test stands for a run. A Flow without tests is estimated from its definition alone.
- **From its real runs**, once it has run: the median and 90th percentile of what its finished runs (any version, last
  90 days, retries included, dry runs left out) spent.
- Priced with the price table for the version's model; without a price, tokens only. The run's cap is shown next to it.

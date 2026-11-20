# Module safety

Approving a module is not the end: apps change their APIs, and new versions of a module can quietly change what it does. Three things help.

## What changed between versions

The review page of a module version shows **Changes since** the newest approved version:
- in plain words: new or removed hosts, new credentials, where a credential is sent, changed token scopes, new actions (and whether they change data), actions that became data-changing, changed inputs or output shapes, removed actions;
- the code as a line diff: the TypeScript when both versions have it, else the JavaScript that runs.

A Flow version's review lists its changes since the previous version step by step: new, removed, renamed or re-pointed steps, steps now handed to a teammate, a changed run form.

## Sandbox tests

Every module draft runs its sandbox tests before review. They never reach a real app: each request the module makes is answered with a canned response written into the test, the credential is a dummy, and test values are made up. The URL a test shows is the request the module tried to make, with the status its canned answer gave (or "no canned answer" when none matched, which the module sees as status 599). A canned answer is JSON, or for anything else (an RSS/Atom feed, HTML, CSV) the exact text with its content type. A failed test says what it expected: "expected to succeed, but it failed: …" or "expected an error, but it succeeded".

- A test that expects a refusal (`"expectOk": false`) passes when the action's **input schema** already refuses its input. Real runs check the input against the schema before the module runs, so such input never reaches the code. The report says "refused by the input schema, as expected".
- A test that expects success with input the schema refuses fails with `test_input_invalid`: the test itself is wrong.
- Drafts and modules waiting for review that were tested before this rule, and failed only such refusal tests, are tested again when Dittoly starts. Only their report changes: the code, the manifest and their hashes stay the same. Approved modules keep their report. Each re-check is an audit event (`module.tests_rechecked`).
- Modules check format and safety (a valid address, no line breaks in header fields). Business rules, such as who may receive a message or which project or channel is allowed, belong in the Flow (a fixed value, a sign-off, or an organization setting), so the drafting rules keep allow-lists out of modules.

## OWASP Top 10 checks

Every module draft is also checked against the [OWASP Top 10 (2025)](https://owasp.org/Top10/2025/), and the AI that drafts modules follows the same rules (the `secure-modules` skill). The checks appear in the test report as **OWASP A01** to **OWASP A10**:

| Check | Looks for |
| --- | --- |
| A01 Broken Access Control | a request host taken from the input; `../` in paths |
| A02 Security Misconfiguration | plain `http://` addresses; unencrypted endpoints |
| A03 Software Supply Chain Failures | code loaded from elsewhere (`import`, `require`) |
| A04 Cryptographic Failures | **hard-coded secrets** (private keys, AWS, GitHub, GitLab, Slack, Google and API keys, bearer tokens, passwords in variables or URLs); `Math.random()` |
| A05 Injection | input added to URLs or text without `encodeURIComponent`; input in email HTML; database operators that run code |
| A06 Insecure Design | write actions without a test that expects bad input to be refused |
| A07 Authentication Failures | an `Authorization` header set by the code; keys or passwords in URLs |
| A08 Software or Data Integrity Failures | code built from text (`eval`, `new Function`) |
| A09 Security Logging and Alerting Failures | `console.*` calls, which can log personal data |
| A10 Mishandling of Exceptional Conditions | empty `catch` blocks, `.catch(() => {})`, requests whose status is never checked |

A hard-coded secret, loaded code or code built from text fails the module. The other findings are **warnings**: the reviewer sees them, but they do not stop the module from being submitted. The hard limits are enforced by the sandbox and broker whatever the code does: declared hosts only, credentials attached outside the code, and fixed database queries with bound parameters ([SQL databases](protocols.md#sql-databases)).

## Performance checks

Modules are drafted to be fast and light on the apps they call (the `performant-modules` skill): a Flow may run one thousands of times, and the app's rate limits are shared by the whole organization. The matching checks appear in the test report as **Performance P1** to **Performance P9**:

| Check | Looks for |
| --- | --- |
| P1 One call at a time in a loop | a request awaited inside a `for` or `while` loop; `forEach(async ...)` |
| P2 Unbounded parallel calls | `Promise.all` over a whole input list (run at most 5 at a time) |
| P3 Pagination without a cap | `while (true)` or `for (;;)` loops |
| P4 Waiting inside the module | `setTimeout` or `setInterval` (Dittoly retries the step instead) |
| P5 Returns the whole answer | `return res.json()` or the raw body instead of the fields the Flow needs |
| P6 Wasted work | deep copies with `JSON.parse(JSON.stringify(...))` |
| P7 Database queries | `SELECT *`; a read query that scans or sorts with no `LIMIT`, `TOP` or `FETCH FIRST` |
| P8 Unbounded list inputs | an array in an action's input with no `maxItems` |
| P9 Calls per test | a sandbox test that makes more than 10 calls for one action |

All of them are **warnings**: a slow module still works, and the sandbox caps every action at 50 calls and 60 seconds whatever the code does. The reviewer sees them next to the OWASP checks.

## Recorded tests

Sandbox tests use canned answers written when the module was drafted. A recorded test uses answers from the **real app**:
1. On an approved module, an approver or admin chooses a **read-only** action and an input, and presses **Run and record**. It runs once, with their own access.
2. The requests and the app's answers are shown. Their own secrets are replaced by `test-credential` wherever they appear in answers or URLs. **Answers can contain real data; look before saving.**
3. **Save as test** keeps it. Every later version of that module must pass it in the sandbox (for the actions it still has) before it can be approved; it shows in the test report as `recorded: …`.

Only actions that only read can be recorded, since recording runs them for real. Browser modules, MCP modules and modules that read any public website cannot be recorded.

## Drift warnings

Each action call's outcome (module, version, action, success or error type: no data) is counted, and kept 30 days. When, within a day, a module has at least 3 failures that look like a changed API (HTTP 400, 404, 405, 410, 415 or 422, or an answer that no longer matches the declared output) and they are at least half of its calls, admins are notified and see **Modules that may need a fix** on the Modules page.
- Outages, rate limits, expired tokens and missing settings do not count.
- **Propose a fix** asks the organization's AI for a new version, telling it only which actions failed with which errors. The draft is validated (including recorded tests) and, if it passes, sent for review with the Flows' new versions, exactly as self-fixing does; another admin has to approve it.
- Approving a new version of the module, or **Dismiss**, clears the warning.

## Self-fixing Flows

A warning does not have to wait for someone. With **self-fixing** on (the default; **Modules → Self-fixing Flows**, admins), Dittoly acts on each new drift warning within a few minutes:

1. **It drafts the fix itself.** The organization's AI gets the same request as **Propose a fix**: which actions failed and with which errors, never any data. The draft runs the module's sandbox tests and the tests recorded against the real app. A draft that passes goes to admins for review. One that does not stays as a draft, the warning shows why, and admins are told.
2. **It proposes the Flows' new versions.** Each approved Flow that pins the drifting version gets a new pending version pinned to the fix, and nothing else changes. Before that, the Flow's own [tests](flow-tests.md) are played against the fixed module, and a Flow whose tests fail, or whose steps no longer fit the fixed actions, is listed as **needs a person** with the reason. The Flow's owner is told, and its team's approvers are asked to approve.
3. **Nothing changes until people approve it.** A proposed Flow version can only be approved once the fixed module is, and the approved version keeps running until then. Approving the proposed version replaces the old one. As with any new version, Super Flows that pin the old version stop until they are updated. A Flow that already has a change waiting for approval is not touched.

### Moving a Flow to a newer module

A Flow keeps the module versions it was approved with. When a newer one is approved, its review says so under
**Newer module versions available**, with a button for each module and one for all of them (its owner or an admin).
Pressing it is the same two steps Dittoly takes by itself: the Flow is pinned to the newer version and its own
examples are played; where a re-pin alone would break them — the newer module takes something else than the Flow
sends it — the AI drafts those steps again, and that version is proposed only if it parses, really uses the new
version, and makes the examples pass. Otherwise nothing is proposed and the page says why. Either way it is a new
pending version its approvers decide on, and the approved one keeps running until then.

### From a stopped run

A run that stopped on a module's failure offers **Have the AI fix &lt;module&gt;**: the same draft, asked for from the
run, with what that step was refused for. Once an admin approves the fixed module, the run's Flow gets its new
version without anybody asking again:

- when the Flow's own examples pass with the fixed module, the new version is the same Flow pinned to it, nothing
  else changed;
- when they do not — the fixed module now asks for something else than the Flow was sending it, which is often why
  the run failed — the AI **drafts the steps that use it again**, and that version is proposed instead. It is
  proposed only if it parses, really uses the fixed module, and makes the Flow's examples pass; otherwise the run
  says what stopped it there.

Either way it is a pending version an approver decides on, the approved one keeps running until then, and the run
says on its own page what happened. With no organization AI set up, only the first (pinning) path is tried.

Each fix, by itself or by **Propose a fix**, is one [change record](governance.md#change-records-self-fixes-as-governed-changes): the drift, the AI request, the diff, the tests, the Flow versions proposed and every decision. The admin who asked for it, or who turned self-fixing on, cannot approve any part of it, and a fix that widens access (a new host, credential or action that changes data) is flagged and needs several different admins.

Limits: each warning is tried once (**Propose a fix** still works by hand), and at most **3 fixes a day** by default (1–50, admins). With no organization AI set up, nothing is attempted. The AI calls appear in AI usage under the purpose `fix`, so the tokens spent on fixes show up there. Drafts, proposals and setting changes are audit events (`module.fix_drafted`, `flow.fix_proposed`, `module.self_fix_on`/`_off`).

This is the "no burned tokens" promise in practice: a Flow repeats for free, and the AI is used only when an app changes and something needs fixing.

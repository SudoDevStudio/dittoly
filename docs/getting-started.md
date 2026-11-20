# Getting started

From an empty workspace to your first run, in about fifteen minutes. The home page has a **Get started**
checklist with the same steps. Each step ticks itself off when it has really happened, so you can always see
what is left.

There is a [video of these steps](#the-video) as well.

## The home chat

The home page opens on one question: **What do you want to automate?** Say it in your own words. The AI answers in a
sentence and shows its whole plan next to it, before asking anything:
- what it **assumed** (what starts it, where results go, who signs off);
- the approved Flows it **reuses**;
- the **new connections** (modules) it would build;
- each **Flow** with its steps.

It asks only what blocks the build, at most two questions, each with options to click. Correct anything in plain
words ("post it to #dev instead", "only on weekdays"); it changes that and keeps the rest.

To speak instead of typing, click the microphone next to **Send**. What you say is written into the box as you speak,
in your browser's language (Punjabi comes out in Gurmukhi, which the AI reads as well as Roman script); check it,
then send it. Nothing is sent by itself. It uses the browser's own speech recognition: Chrome, Edge and Safari have
it (Chrome sends the audio to Google to recognize it), Firefox does not, and then there is no microphone button.

**Build it** drafts everything in one click, through the same steps as a plan from a PDF. Modules are drafted and
sent for review. Each Flow is drafted once the modules it needs are approved. You watch each draft appear in the
chat, with a link to read it. Approvals stay as they are: an admin approves modules, an approver the Flow. In local
mode you approve your own, one click per item, right there. The work that needs you (approvals, runs to look at) is
in the strip under the chat, and the rest of the page is below it.

Chats are kept: each has its own link (`?chat=…`), and **Recent chats** under the box lists yours and your team's.
A teammate can open one to pick up a plan you started, continue it and build it. A chat is deleted 30 days after its
last message; an admin changes the number of days under **Members & Access → Home chats**, and you delete your own
at any time. Messages and plans are stored encrypted; what was built from a chat stays when the chat is deleted.

## Finding your way

The menu on the left has **Home** and four groups. Click a group's name to fold or unfold it, and hover an entry to
see what it is for.

- **Build:** Flows, Super Flows, Modules, Apps, Plans from PDF.
- **Run:** Run a Flow, Runs, Delegations, Insights.
- **Share:** Marketplace, AI Agents, Export an app.
- **Oversight** (approvers and admins; folded at first): Changes, Model changes, Automatic stops, AI inventory.

**Teams**, **My credentials** and (for admins) **Members & Access** sit at the bottom. Members see only what they
can use. Search (⌘K or Ctrl+K) finds pages by their old names too.

## 1. Install and sign in

Pick one way from [install.md](install.md):

- **Node.js 26**, on your own computer: `npm ci && npm run build && node bin/dittoly.mjs`.
- **Docker**, a shared server for a team: follow [server.md](server.md) (requirements, setup, HTTPS).

On your own computer, open the sign-in link Dittoly prints. You are the admin. On a shared server, people sign
in with your single sign-on.

## 2. Connect your AI (optional)

The AI drafts modules and Flows from plain words. It is your organization's own key: set `DITTOLY_AI_PROVIDER`
(`anthropic`, `openai`, `ollama`, `claude-cli` or `codex-cli`) and the key where Dittoly runs, then restart.
Data goes only to the provider you choose.

You can skip this step. Without an AI you build Flows by dragging steps onto a canvas, and you approve modules
from the marketplace.

## 3. Approve a module

A **module** is how Dittoly talks to one app, for example posting to Slack. You get one in one of three ways:

- Describe it in **Modules** and the AI drafts it.
- Take one from the **Marketplace**.
- Import the tools of an MCP server.

Every module is tested in a sandbox before anyone sees it. The admin's review shows:

- the only hosts it may reach;
- what each action does, and which actions change data;
- whose token it uses.

Click **Approve** to make it available to every Flow. Some modules also need an organization setting, such as
your Jira site; the module page asks for it.

## 4. Store your credentials

Open **My credentials**. Under **Needed by approved modules** it lists what to paste for each app, for
example "Slack token with chat:write". Click **Add**, paste the token and **Save**.

Tokens are encrypted on the server and never shown again, not even to you. A run you start uses your access and
nobody else's, and sharing a Flow never shares your tokens. A team's admins can also store one shared service account
for an app on the team's page, under **Teams**.

## 5. Create and approve a Flow

A **Flow** is a process across your apps. In **Flows**:

- describe it ("when a release is approved, merge the ready merge requests and tell the channel") and the AI
  drafts it; or
- click **Build a Flow visually**, add inputs for the run form, drag steps onto the canvas, and fill in each step
  ([visual-editor.md](visual-editor.md)).

**Create Flow** saves a draft. Before it can run, an approver reads **What it does** in plain words, with every
step that changes data marked, and clicks **Approve this version**. On a shared server someone else must approve
it: nobody approves their own work. Any later change makes a new version that needs approval again.

## 6. Run it

On the Flow's page, **Before you run** shows what each step changes and whose access it uses. Fill in the run
form and try a **Dry run** first: it reads for real and skips sign-offs and anything that changes data. Then
**Run now**.

If the Flow has a sign-off step, the run waits on the home page of whoever approves it. Each step's output is
kept, encrypted, for the retention period.

The run page's **Result** panel (on the right; on top on a phone) says how the run ended or where it stands, worked
out the same way for every Flow from its steps:

- **Finished after** the last step that ran; it is neutral, not green, when steps were skipped by their conditions,
  and lists them.
- **Stopped at** or **Paused at** the step that failed, with the reason in plain words and the steps it never reached.
- **Waiting at** a step, and for what (an approver, a form, a teammate, a delay, its cost cap).
- A link the deciding step returned (a pull request, a ticket), when you may see that step's output.

A paused run also says **what to do**: the step it stopped at, what happened in plain words, whether retrying
alone can help, and each fix with where to make it: "Add your "slack" credential" (opens My credentials with the
name filled in), the module setting or team table to create, the team credential a team admin stores, or "Start the
Flow again" when the inputs were wrong or the retries are used up. What is missing is looked up when you open the
run, so a fix made meanwhile is no longer listed. AI assistants reading the run over MCP get the same text.

When retrying cannot help (or you do not want to wait), get past the step instead: **Type in its result and
continue** (in the shape later steps expect; the action's output schema is checked) or **Skip this step** (later steps
read its result as empty; the card names the ones that use it). A step that only reads, and an AI step, is yours to
decide. A step that changes data (a write action, a table change, a build, a fix, a child Flow) waits for an approver
of the Flow's team, who sees what you typed in and approves or rejects; rejected, the run stays paused as before. In
local mode the single member approves their own. Each step shows who got past it and who approved, and the audit
record (in the run's evidence pack) has both.

When the fix is a new version (a corrected module, an action added to it, a changed Flow), a paused run does not
have to start over: once the new version of its Flow is approved, **Continue on version N** goes on in the same run.
The steps that already ran keep their results and do not run again; the failed step and the rest run as the new
version says. This works when every step of the run's version is still there with the same type, nothing new comes
before the steps that ran, and the run's inputs fit the new version. Otherwise the button is **Start again on version
N with the same inputs** (a new run; this one stays as it was). The move is audited (run.moved_to_version).

Run notifications (inbox, email, Slack, Teams) end with the same outcome in one sentence, without step names or
data, e.g. "It paused: a credential it needs is not stored."

## 7. Invite your team (shared server)

People appear in **Members & Access** when they first sign in. Give each one a role:

- **member**: builds and runs Flows, and asks a teammate to run a step they cannot;
- **approver**: also approves Flows and sign-offs;
- **admin**: also reviews modules and manages members and rules.

## What next

- Start Flows on a schedule, from a webhook, or for each new item, email or file ([watches.md](watches.md)).
- Connect Flows into a Super Flow ([super-flows.md](super-flows.md)).
- Upload a written process as a PDF and get modules and Flows drafted ([plans.md](plans.md)).
- See failures, waits and time saved ([insights.md](insights.md)).
- Set rules, a second approver and access reviews ([governance.md](governance.md)).
- Export approved Flows as an app of their own ([app-export.md](app-export.md)).

## The checklist

The **Get started** card on the home page follows steps 2 to 7. Steps are ticked from what really happened:

| Step | Ticked when |
|---|---|
| Connect your AI (optional) | an AI provider is configured |
| Approve a module | any module is approved |
| Store your credentials | you have stored a token, or one of your teams has a shared one |
| Create and approve a Flow | any Flow version is approved |
| Run a Flow | a run you started succeeded (dry runs do not count) |
| Invite your team | admins on a shared server: another person has signed in |
| Export a Flow as an app (optional) | admins and approvers: an app was exported |

**Hide** removes the card for you only. While a step is still open, a **Show "Get started"** link brings the
card back. When every required step is done the card says **You're set up**. Once you hide it then, it stays
hidden.

## The video

`0-getting-started` shows these steps in the real portal, in 2 minutes 40 seconds at 1.25× speed:

1. an empty workspace;
2. a Slack module reviewed and approved;
3. a token stored;
4. a Flow built on the canvas and approved;
5. a dry run, then a real run;
6. the checklist complete.

To record it again:

```sh
bash scripts/dev/services.sh        # the test Postgres (or set TEST_DATABASE_URL)
npm run web:build
npm run demo:record -- --only 0-getting-started --speed 1.25
```

The video is written to `demo-videos/0-getting-started.mp4`. Like the other demo videos, it is not committed
to the repository ([demo-videos.md](demo-videos.md)).

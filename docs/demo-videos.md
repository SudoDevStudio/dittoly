# Demo videos

Sixteen short videos show Dittoly end to end in a real browser, with captions. They are recorded by a script, so they can be made again after any change:

```sh
bash scripts/dev/services.sh        # the test Postgres (or set TEST_DATABASE_URL)
npm run web:build
npm run demo:record                 # MP4s in demo-videos/
npm run demo:record -- --only 4-governance --out /tmp/videos
npm run demo:record -- --speed 1.25  # faster; captions stay up as long as at normal speed
npm run demo:record -- --speed 1.25 --join   # also one video of all of them, a chapter each
```

`--join` writes `dittoly-full-demo.mp4` with chapter markers, so players list the chapters and can jump to each. `npm run build` must have run as well: the App export chapter downloads a real bundle.

`0-getting-started` is the onboarding video ([getting-started.md](getting-started.md)). It starts from an empty organization of its own, so it can be recorded alone with `--only 0-getting-started`.

Chapters 1 to 9 share one organization and build on each other, so `--only 5-module-safety` still plays all of 1 to 9 (only 5 is kept). Chapters 10 to 15 each set up an organization of their own and seed what they show, so `--only 12-governed-changes-and-evidence` records just that one. Chapters 11 and 12 run the server as an organization server (`shared` mode: sign-in sessions, nobody approves their own work, SCIM); the others run it as a local install.

Every recording wipes the database it is pointed at. When tests run against the same Postgres at the same time, give the recorder a database of its own:

```sh
createdb -h 127.0.0.1 -p 5433 -U postgres dittoly_demo
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/dittoly_demo npm run demo:record -- --only 10-ai-agents-and-undo
```

For YouTube Shorts and Instagram Reels, record vertical versions instead (in `demo-videos/shorts/`):

```sh
npm run demo:record -- --shorts
```

They are 1080×1920 (9:16): the title on top, the portal in the middle and the captions below it. The camera follows what the cursor works on: it zooms in on the field or button being used and back out after a click or a scroll, and every zoom and pan is eased over a second, never cut. The phone and glasses parts are shown whole. Each short is under 3 minutes, the longest Shorts YouTube takes and the longest Reels Instagram suggests to people who do not follow you.

The script needs Chromium (`DITTOLY_CHROMIUM`, default `/opt/pw-browsers/chromium`) and `ffmpeg` with libx264. When Playwright's own ffmpeg build is not installed, it records with the system ffmpeg instead. The videos are not committed to the repository.

| Video | What it shows |
|---|---|
| `0-getting-started` | From an empty workspace to the first run: approving a module, storing a token, building and approving a Flow, a dry run and a real run, the checklist complete |
| `1-run-a-flow` | Reviewing a drafted Flow in plain words, approving it, "Before you run", running it, signing off the gate, the step outputs |
| `2-plans-from-pdf` | Uploading an employee-onboarding plan; the AI's question; a new email module drafted for review; approving it; the Flow drafted on its own |
| `3-build-and-connect-flows` | Building a Flow by dragging steps; connecting two approved Flows into a Super Flow that runs them at the same time |
| `4-governance` | A rule set in a form; the sealed audit log and the daily hash copy; a dry run; an access review; token scopes; break-glass |
| `5-module-safety` | What changed in a new module version (plain words and code diff); recording a test against the app; a drift warning and an AI-proposed fix |
| `6-phone-glasses-chat` | Pairing a phone with a QR code; a command confirmed with yes; linking Telegram; the Ray-Ban Display layout |
| `7-insights-watches-ai` | Run insights and time saved; AI usage with a team budget; a watch that starts a Flow for each new merge request |
| `8-export-an-app` | Approved Flows (one a Super Flow) exported as an app: who may start each, a React frontend, a theme with an AI-proposed palette, the layout drafted from a brief, the environment variables it needs, the download |
| `9-tables-tests-urls-mcp` | A database module that runs only fixed, reviewed queries; a team table; a Flow test with recorded answers; a Flow URL with its token; offering a Flow to AI assistants and an assistant's token |
| `10-ai-agents-and-undo` | A Flow where an AI step's text reaches a Slack post: the approver sees the guarded step, and at run time it waits for a sign-off (rejected: a ticket steered the AI into a phishing link); the MCP gateway offering a Slack action as a pinned tool; an agent with scoped tools, "ask me first" and an expiry; its call waiting and confirmed; a run's two posts reversed after a sign-off |
| `11-connect-ai-apps-and-scim` | An admin allows the Claude, ChatGPT and Copilot Studio presets; the consent page an AI app sends a person to (Flows and app actions, run directly or ask first, expiry); the agent it makes; Provisioning (SCIM): token and base URL, a person and group pushed by the identity provider, the group as a team mapped to a role, offboarding (sessions, tokens and agents revoked; admins told what the person owned) |
| `12-governed-changes-and-evidence` | A module draft's review with the Performance P1–P9 checks next to the OWASP checks; a self-fix as a change record (drift evidence, the AI request, what changed, "widens access", the tests, the parts to approve; the requester cannot approve it); a run's evidence pack as HTML and JSON; the AI inventory with a risk class set |
| `13-models-and-costs` | A Flow's pinned model on its review page; the organization moving to a new model and the Model changes page (one switch after a passed check, one with a reason, one kept); a cost cap and forecast on a Flow, a run waiting at its cap and more spend allowed, the AI cost per successful run in Insights |
| `14-automatic-stop` | The admins' automatic stop settings; a Flow stopped by itself after the third rejected sign-off on AI-written text in an hour, its banner, a run under way pausing before its next step, the Automatic stops page with the events that crossed the threshold, resuming with a reason (one paused run continued, one cancelled); an AI agent stopped for calling a tool it was not given, its calls refused, resumed by its person |
| `15-chat-to-live-build` | A request typed in the home chat (review a GitHub pull request, skipping comments already made); the AI's plan with what it assumed, one GitHub module and one Flow; Build it with the Live panel open: the AI's steps as it drafts (thinking, searching the web, reading GitHub's docs, writing the answer), the module's code typing itself out once tested; approving the module, the Flow drafted live with its four steps joining one by one, and approving it |

**What is real and what is scripted.**
- **Real:** the portal, the server, the database, the sandbox the modules run in, and the browser.
- **Scripted stand-ins:** the apps (Jira, GitLab, Slack, the mailbox, Telegram) and the AI's answers, the same ones the browser tests use. In chapters 10 to 14 also the AI assistant calling the MCP server, the AI app signing in (its page after the sign-in is a stand-in), the identity provider's SCIM requests, and the two AI models ("writer-2" and "writer-3"). So the videos show how Dittoly behaves, not how a particular AI model answers.
- **Separate recordings:** the phone and the glasses are recorded in their own window sizes and joined into one video.

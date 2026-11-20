# Installing Dittoly

There are two deployment modes:

- **Local install:** one person on their own computer. Node.js uses an embedded database; Docker Compose can also run in local mode with PostgreSQL.
- **Shared server:** a team. PostgreSQL, RabbitMQ, Docker for the module sandbox, and sign-in through your identity provider. Docker Compose or from source.

## Local app with Docker services

Use Node.js 26 on your computer, with PostgreSQL and RabbitMQ from `docker-compose.local.yml`. This file contains only the two services; Dittoly itself runs directly on your machine.

```bash
npm ci
npm run setup:local
npm run services:up
npm run build
npm start
```

`setup:local` creates `.env` from the example when necessary, generates a master key only when one is missing, and configures personal mode with the process sandbox. Existing encryption keys, API keys, and custom connection settings remain. The bundled container hostnames are converted to loopback URLs; the default `postgres` connection to the `dittoly` database on port 5432 is updated to Docker's published port 5433, preserving its credentials.

The default `.env` settings are:

```dotenv
DITTOLY_MODE=local
DITTOLY_SANDBOX=process
DATABASE_URL=postgres://postgres@127.0.0.1:5433/dittoly
DITTOLY_AMQP_URL=amqp://dittoly:dittoly@127.0.0.1:5672
HOST=127.0.0.1
PORT=8080
```

### Reaching it from your phone or another computer

By default Dittoly only listens on this computer (`127.0.0.1`). To open it from a phone (pairing, voice commands) or another device on the same network:

```sh
npm start -- --host=0.0.0.0      # or: HOST=0.0.0.0 in .env
npm start -- --host=0.0.0.0 --port=9000
```

`npm start --host=0.0.0.0` (without `--`) also works, but npm 11 warns that this form will stop working in its next major version, so prefer the one with `--`. A command-line `--host`/`--port` wins over `HOST`/`PORT` in `.env`.

On every address, Dittoly prints the address to open (this computer's network address, e.g. `http://192.168.1.20:8080`) and uses it for links, sign-in links and phone QR codes, even when you open the portal on `localhost`. With `--host` on the command line, a `DITTOLY_PUBLIC_URL` pointing at `localhost` (as older `.env` files have) gives way to it, since other devices cannot open localhost. Any other `DITTOLY_PUBLIC_URL` (a domain, a tunnel) is used as set, and so is a localhost one with `HOST=0.0.0.0` in `.env` (in Docker, localhost reaches the container through its port mapping). With single sign-on, set `DITTOLY_PUBLIC_URL` to the address people use, since the identity provider only accepts the return address you registered. The phone must be on the same network, and the computer's firewall must allow the port. Anyone who can reach the address still needs to sign in; on the local install, the printed sign-in link is the key, so do not share it.

All app commands load `.env` automatically; shell environment variables override file settings. `npm start` migrates the database, creates or reuses your personal admin, and prints the browser sign-in link. Keep the generated `DITTOLY_MASTER_KEY` in `.env` across restarts so saved credentials remain readable. No SSO setup or admin bootstrap is needed.

To start afresh, stop Dittoly and run `npm run reset`: it asks you to type `reset`, then empties the database in `DATABASE_URL` (modules, Flows, runs, plans, your account and every stored credential), creating it when it does not exist yet. Your `.env` (master key, AI settings) is kept; `npm start` then sets everything up again. `--yes` skips the question.

`npm run services:down` stops the Docker services without deleting their volumes. If the app was previously running in the full Compose stack, run `docker compose stop dittoly` before `npm start`; both Compose files use the same service and volume names so existing PostgreSQL data is retained.

For development, use `npm run dev` to restart the backend on source changes and `npm run web:dev` in a second terminal for the frontend. The frontend proxies API and auth to the backend port from `.env`. With nvm installed, run `nvm use` to select Node 26 from `.nvmrc`.

### Local MCP servers

In local mode you can import MCP servers that run as programs (stdio) from an npm package. Each runs in a locked-down Docker container that can only reach the hosts you approve. This needs Docker on the same machine and Dittoly running directly on it (`npm start`), not inside the Compose stack. Dittoly creates the Docker network `dittoly-mcp-egress` for its egress proxies, one internal network per session (`dty-sbx-…`, removed when the session ends), and one volume per imported package (`dty-mcp-…`).

## Node.js

Needs Node.js 26.

```bash
git clone https://github.com/SudoDevStudio/dittoly dittoly && cd dittoly
npm ci && npm run build
node bin/dittoly.mjs          # or, from source: npm run local
```

It prints a sign-in link for `http://127.0.0.1:8484`. You are admin and approver at once.

| Option | Meaning |
|---|---|
| `--home <dir>` | where data and the encryption key live (default `~/.dittoly`, or `DITTOLY_HOME`) |
| `--port <n>` | port (default 8484) |
| `--ai <provider>` | `claude-cli`, `codex-cli`, `anthropic`, `openai` or `ollama` turns on chat creation |

With `claude-cli` or `codex-cli`:

- **Time per answer.** One answer may take up to 15 minutes; a whole module at a high effort can take several. Set
  `DITTOLY_AI_CLI_TIMEOUT_MS` (at least 60000) to change it. An answer that runs out of time is `ai_timeout`, and a
  plan item tries it again later.
- **Web search (Codex).** See *Current docs while drafting* below. Codex's own default (cached search) is never left
  on; Claude Code gets only its WebSearch and WebFetch tools, and only while drafting.

### Current docs while drafting

Whatever AI you use, when it drafts a module, a Flow, a Super Flow or a plan (and when it decides how a module
connects), it may search the live web and read pages, so it builds on the service's current official documentation
instead of what it remembers:

| AI | How |
|---|---|
| `anthropic` | web search and web fetch server tools (`web_search_20260318`, `web_fetch_20260209`; basic versions on older models), at most 8 searches and 8 fetches per answer |
| `openai` | the Responses API `web_search` tool |
| `claude-cli` | Claude Code's WebSearch and WebFetch tools only |
| `codex-cli` | `web_search="live"` |
| `ollama` | no web search |

### A model you run yourself

With `ollama`, Dittoly asks the server for a context window large enough for the prompt it is sending (its skills,
the catalog of approved actions, the request), because Ollama's own default is a few thousand tokens and a prompt
that does not fit is cut silently — which looks like a stupid model, not a setting. Ceiling and sampling:

| Variable | What it does |
|---|---|
| `DITTOLY_OLLAMA_NUM_CTX` | the largest context to ask for (default 65536). Lower it on a laptop: every token of context costs memory |
| `DITTOLY_AI_TEMPERATURE` | sampling temperature (default 0, the steadiest for drafting). Some models ask for their own, e.g. Gemma for 1.0 |
| `DITTOLY_AI_TOP_P`, `DITTOLY_AI_TOP_K` | sent only when set |

### Is a model good enough for this work?

A model you run yourself (Ollama, a fine-tuned one of your own) is free and private, but it has to write what
Dittoly accepts. `npm run bench:ai` says whether it does: it runs the real drafting code — the same system prompts,
skills and response schemas the app uses — over a fixed set of requests, and scores every answer with Dittoly's own
checks (the manifest parser, the TypeScript compiler, the Flow validator). No database and no sandbox are needed,
so it measures the model, not the server.

```bash
DITTOLY_AI_PROVIDER=ollama DITTOLY_AI_MODEL=<a model on your Ollama server> npm run bench:ai
DITTOLY_AI_PROVIDER=anthropic npm run bench:ai   # a baseline to compare against
```

It prints, per request, whether the answer could be read and whether Dittoly accepts it, with the reason when it
does not and what the model answered when its answer could not be read at all.

`npm run bench:tasks` asks the harder question: does what it builds do the job? Each task in
`scripts/bench/tasks.json` is a real request ("merge the ready merge requests, but a person signs off first") with
what the answer must contain and must not, and every draft is judged against the task — the actions it calls, a
sign-off before anything changes, a condition before a write, the table it declares, the revision it writes back
against. It reports first-attempt success, success after the repair rounds the app itself would do, how often a
person would have to correct it, how often the model wrongly refused, and the time and tokens per working
automation. Add your own tasks to that file: the same file is used for every model and every version. `BENCH_TRIES=3` runs each request
three times (how steady is it?), `BENCH_KIND=flow|module` narrows it, `BENCH_CASES=flow-table,...` picks single
ones, and `BENCH_OUT=report.md` writes the table to a file. The exit code is 1 only when nothing the model wrote
was accepted.

AI steps in runs never search: they handle data from other systems. Where an account, model or organization does
not allow web search, the draft is written without it. Web searches are billed by the AI provider (Anthropic: per
1,000 searches) on top of tokens. Set `DITTOLY_AI_WEB_SEARCH=off` to turn web search off for drafting too, for every
AI.

The reviewer sees the pages a draft is based on, under **Sources** on the module and in the Flow's review: pages the
AI's web search read (reported by the Anthropic and OpenAI APIs) and pages the AI names as what it relied on (the only
kind the CLIs can report; Dittoly does not check those).

### Docker or Podman

Everything Dittoly sandboxes — a module's sandbox, a fix step's clone, an app step's install, build and run, the
browser, and a local (stdio) MCP server — is one `run` of a container with the flags Docker and Podman both take.
Dittoly never builds an image or speaks an engine's own API, so a machine with Podman and no Docker daemon runs the
same work, rootless, whatever the project is written in: Node, Java, PHP, Python, Go, Ruby, .NET all run in the
step's own image with their caches in the step's folder.

By default Dittoly asks Docker first and falls back to Podman; `DITTOLY_CONTAINER_ENGINE=podman` (or `docker`)
settles it, and any other value is refused at start-up. One difference is handled for you: Docker 28 and later are
asked for a bridge with no address on the host, so a container cannot reach what the host itself serves (an older
Docker gets a plain internal network and a warning), while Podman's internal networks have no gateway address to
begin with.

Podman notes: the engine must be on `PATH` for the user Dittoly runs as, and rootless Podman maps container users
to your own, so a step's files are written as that mapping, not as root.

### What the AI is asked to fix while it drafts

Dittoly reviews every draft before anybody sees it — a module's security and performance checks (OWASP A01-A10,
Performance P1-P9, whether each setting is explained, whether every write action has a test for bad input), and a
Flow's guards (a sign-off before the first step that changes anything, a condition on it, a data table it reads so a
second run does not repeat the work, model-written text reaching a step that changes something, examples) — and hands
what it finds back to the AI in the same drafting round. A draft that answers fewer findings than the one it would
replace is thrown away, as is one that no longer compiles or breaks a test.

Each draft with findings costs one more AI call. Set `DITTOLY_AI_DRAFT_REVIEW=off` to skip the round; the findings are
then only shown to the approver, under **What this draft is worth** on the module and in the Flow's review.

Every version an AI wrote records the model that answered it, down to the release and the effort
("anthropic:claude-opus-5:medium" — never "default": the same family a release apart writes differently). **Model
comparison**, under Oversight, adds those up per model from this organization's own drafts: how many were approved,
findings each, tests and examples written, tokens, and how many AI calls a draft took — a call over one means it had
to be sent back.

The embedded database (PGlite) has no password, so it listens on a Unix socket in an owner-only folder (`<home>/run`). On Windows it uses a loopback port instead, which other local programs can reach.

## Backup, restore and key rotation (local install)

Stop Dittoly first; these commands refuse to run while it is running.

```bash
node bin/dittoly.mjs backup [file] [--home <dir>]     # asks for a passphrase (12+ characters), twice
node bin/dittoly.mjs restore <file> [--home <dir>]    # into an empty data directory only
node bin/dittoly.mjs rotate-key [--home <dir>]        # new master key, every stored secret re-encrypted
node bin/dittoly.mjs cleanup [--home <dir>] [--yes]   # start afresh: content and history go, access and settings stay
```

- A backup is one file: the database and the master key, encrypted with your passphrase (scrypt, AES-256-GCM). Anyone with the file and the passphrase can read your credentials; without the passphrase nobody can restore it, including you.
- Without a terminal (automation), the passphrase comes from `DITTOLY_BACKUP_PASSPHRASE`.
- `rotate-key` re-encrypts everything in one transaction and only then replaces `master.key`; if it is interrupted, the next start uses whichever key the data is actually encrypted with. Backups made earlier still contain the old key.
- `cleanup` gives you a fresh start without losing your access. It lists what will go and asks you to type `cleanup` (`--yes` skips the question, for scripts). It cannot be undone, so run `backup` first if you may want anything back.
  - **Removed:** modules, Flows and Super Flows, with everything that exists only for them (runs, schedules, triggers, watches, endpoints, approvals, tests, delegations, self-fix records), plus apps, plans, data tables, git sync, the audit log and AI usage history.
  - **Also removed, from this computer:** what the sandboxes left behind: this install's Docker containers, networks and temporary folders, and the Docker images Dittoly pulled. Images you had before, and other installations' containers, are left alone.
  - **Kept:** your account, teams, stored credentials (personal and team), the master key, and settings (organization, AI, budgets and prices, policies, notification channels, themes), devices, MCP tokens and audit stream destinations. The fresh audit log starts with one entry recording the cleanup.

## Docker (personal or shared)

For a team server, follow [server.md](server.md): requirements (CPU, memory, disk, Docker version), step-by-step setup with HTTPS, upgrades and backups. This section is the reference behind it.

Needs Docker with Compose. `docker compose up -d` starts Dittoly, PostgreSQL and RabbitMQ.

For personal use, set `DITTOLY_MODE: local` in the `dittoly.environment` section of `docker-compose.yml`. Set `DITTOLY_MASTER_KEY` and `DITTOLY_PUBLIC_URL` in `.env`; no OIDC configuration or manual admin bootstrap is needed. Startup creates the first admin, or reuses an existing enabled admin, and prints a sign-in link:

```bash
docker compose up -d --build dittoly
docker compose logs dittoly
```

Open the latest `/auth/local?token=...` link in the logs. The link uses `DITTOLY_PUBLIC_URL` (normally `http://localhost:8080`) and changes whenever Dittoly starts. Existing accounts and data remain in PostgreSQL.

For a shared team server, set `DITTOLY_MODE: shared` in Compose and configure OIDC. Shared-mode startup does not create an admin or print a personal sign-in link. Use the following bootstrap procedure:

```bash
git clone https://github.com/SudoDevStudio/dittoly dittoly && cd dittoly
cp .env.example .env
docker compose up -d
docker compose exec dittoly node dist/src/cli/bootstrap.js admin   # first admin; prints a break-glass API token once
docker compose exec dittoly node dist/src/cli/seed.js              # optional: example modules for admin review
```

For an app running inside the full Docker Compose stack, set `HOST=0.0.0.0` and `DITTOLY_SANDBOX=docker` in `.env`. In `.env`, also set at least:

- `DITTOLY_MASTER_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). It encrypts everyone's credentials: back it up and never change it.
- `DITTOLY_PUBLIC_URL`: the URL members use. Use `https://` behind a reverse proxy in production.
- For shared mode: `DITTOLY_OIDC_ISSUER`, `DITTOLY_OIDC_CLIENT_ID`, `DITTOLY_OIDC_CLIENT_SECRET` (optionally `DITTOLY_OIDC_ALLOWED_DOMAINS`). Register `<DITTOLY_PUBLIC_URL>/auth/callback` as the redirect URI.

Things to know:

- **Docker access.** Modules run in locked-down sibling containers (no network, read-only, all capabilities dropped), so the Dittoly container mounts `/var/run/docker.sock`. Whoever controls the Dittoly container controls the host's Docker, which is root-equivalent. Run it on a host dedicated to Dittoly.
- **Sandbox folder.** Module code is written to `/tmp/dittoly-sandbox`, mounted at the same path on the host so the host's Docker can mount it into sandbox containers.
- **Sandbox image.** `node:26-alpine` by default (`DITTOLY_SANDBOX_IMAGE`); the host's Docker pulls it on first use.
- **Database.** The bundled PostgreSQL trusts connections on the Compose network and listens only on `127.0.0.1:5433` on the host. For production, point `DATABASE_URL` at a managed PostgreSQL with a password.
- **Webhooks.** Requests are checked (signature, rate limit, replay), queued on RabbitMQ, and answered with `202 {"accepted": true}` at once; a worker then starts the run.
- **AI.** `anthropic`, `openai` or `ollama`; the Claude and Codex CLIs are refused on a shared server.
- **Notifications.** Each team can set up its own channels on the Teams page: an approved module action (for example Slack "post a message", or an SMTP module's "send email") whose inputs are filled from `{{ message.text }}`, `{{ message.url }}` and `{{ member.email }}`, run with the team's shared credentials. A team's channels replace the server-wide settings below for notifications about its runs. The server-wide settings are a deprecated fallback for teams without channels. Besides the portal: email (`DITTOLY_SMTP_URL`), Slack direct messages (`DITTOLY_SLACK_BOT_TOKEN`: create a Slack app, add the bot scopes `chat:write`, `im:write`, `users:read` and `users:read.email`, install it to your workspace and copy the bot token) and a Teams channel (`DITTOLY_TEAMS_WEBHOOK_URL`: in the channel choose Workflows, then the template "Send webhook alerts to a channel", and copy the link). Slack finds each member by their sign-in email. Teams posts to one channel and names the member, unless a member pastes their own Workflows URL (template "Send webhook alerts to a chat") on their Credentials page; their messages then go to that chat instead. That per-member path needs no server setting. Whether a chat with only yourself can be the target depends on your tenant; try it there. Every message is one sentence and a link to the portal, never run data, and members can turn each channel off on their Credentials page.
- **Health and readiness.** `GET /health` says the process answers (liveness; the image's `HEALTHCHECK` uses it). `GET /ready` says it can do its work: `200` or `503` with `{ready, checks: {database, migrations, worker, webhookQueue}}`, states only. The database must answer within 2 s with every migration applied, and the background worker must run. Without RabbitMQ configured, `webhookQueue` is `not_configured`, which is not a failure; configured but unreachable, it is `down` and the server is not ready. Use `/ready` for load-balancer or Kubernetes readiness probes and `/health` for liveness. Admins see the background queue (waiting, running, scheduled, failed, and the oldest wait) on the Admin page, also as `GET /api/jobs/queue`; each finished job logs `job_done` with how long it waited (`waitMs`) and ran (`durationMs`).
- **Background work.** Runs, AI drafting for plans, and quick work (notifications, git sync, undo) run in separate lanes, so a long fix or browser step never delays a notification and a long draft never holds up a run. `DITTOLY_DRAFT_WORKERS` sets how many plan items are drafted at once (2). `DITTOLY_RUN_WORKERS` sets how many runs one server works on at once: 2 by default (1 on a local install), at most 32. Each takes a database connection while it works, so keep it well below `DITTOLY_DB_POOL_MAX` (default 10). Admins can cap how many runs one team has going at once (Teams page, or `PUT /api/teams/:id/run-limit`): that team's other runs wait their turn while other teams go on; runs waiting for a person take no place. A cancelled run stops at its next checkpoint (between items, or at a long step's keep-alive) and frees its place. When `DITTOLY_MAX_WAITING_RUNS` runs (default 500) already wait for a place, starting another answers `503 server_busy` with `Retry-After: 60`; queued webhooks are retried, and runs already going (Super Flow children, follow-ups) are never refused. See [capacity-baseline.md](capacity-baseline.md) for a measured baseline and `scripts/bench/capacity.ts` to measure your own host.
- **Code sandboxes.** App and fix steps run the project's code in containers of up to 2 GB and 2 CPUs each. `DITTOLY_CODE_SANDBOXES` caps how many build and test at once: 2 by default (1 on a local install), counted across all servers sharing the database. A step that finds them all busy does not hold its run's place: its run waits (`sandbox busy` on the run page) and tries again every 20 seconds, in the order the queue gives. A fix step holds its sandbox until it ends; an app step only during its install and build (the app it starts keeps running for the run's browse steps).
- **Sandbox cleanup.** Containers are removed when they exit, and a step's network, proxy and folders when it ends. Every container, network and folder a server makes is labelled with that server process's id, which it renews in the database every 30 seconds. Every 10 minutes a server removes what servers of this installation that stopped renewing left behind (a crash or a kill in the middle of a step), and frees their sandboxes. Resources of another installation on the same Docker host, and anything without the labels, are never touched. Step images Dittoly pulled itself (not ones already on the host when it first used them, nor its own proxy and browser images) are removed after `DITTOLY_SANDBOX_IMAGE_TTL_HOURS` without use: 24 by default, `0` keeps them. The next step that needs one pulls it again.
- **What a sandbox cannot reach.** A step's containers see only that step's clone and its own cache folder: not Dittoly's files, its configuration, the Docker socket or other steps. They are on an internal network of their own whose only way out is the step's proxy, which refuses private addresses (the database, RabbitMQ, the host, your LAN) unless an admin lists one in `DITTOLY_INTERNAL_HOSTS`. On Docker 28 or later the network's bridge also has no address on the host (`com.docker.network.bridge.gateway_mode_ipv4=isolated`), so a container cannot reach ports the host listens on, Dittoly's own included; an older Docker cannot do this, and the server logs `sandbox_network_not_isolated` (upgrade Docker, or bind the host's services to `127.0.0.1`). `test/egress-docker.test.ts` checks this in real containers.
- **Backups.** Back up PostgreSQL with your usual tools (`pg_dump`) and keep `DITTOLY_MASTER_KEY` somewhere separate and safe: the database alone cannot be decrypted.
- **Key rotation.** Stop Dittoly and let the webhook queue drain, then run `docker compose run --rm -e DITTOLY_NEW_MASTER_KEY=<new key> dittoly node dist/src/cli/rotate-key.js`. It re-encrypts every stored secret in one transaction (nothing changes if it fails). Then put the new key in `.env` as `DITTOLY_MASTER_KEY` and start again. Sign-ins in progress and queued webhooks from before the rotation fail and are retried by their senders.

New members sign in through your identity provider and start as `member`; admins change roles on the Members page.

## From source (shared server)

Needs Node.js 26, PostgreSQL, RabbitMQ and Docker. Start just the services with `docker compose up -d postgres rabbitmq`, or use your own.

```bash
npm ci && npm run build
cp .env.example .env        # set the master key, OIDC, DITTOLY_MODE=shared and DITTOLY_SANDBOX=docker
npm run bootstrap -- admin
npm start                   # portal at DITTOLY_PUBLIC_URL
```

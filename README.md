# Dittoly

**Orchestrate anything.** Super-Modules + Super Flows, approved by people, run with your own access.

Dittoly is self-hosted orchestration. **Super-Modules** connect your apps, **Flows** automate a process, and **Super Flows** connect Flows into bigger ones ([docs/super-flows.md](docs/super-flows.md)). Describe a multi-app process in plain language, the AI drafts a Flow, a person approves it, and the engine runs exactly that version. Every member keeps their own credentials; when you lack access, a teammate runs that one step with theirs.

## Install

### Quick start

Needs Node.js 26 and Docker with Compose, running. From the clone:

```bash
npx dittoly run
```

It does only what is still missing, in order: installs the npm packages, creates `.env` from `.env.example` with a
new encryption key, asks which AI should draft modules and Flows (the Claude, Codex and Ollama CLIs found on your
machine are offered first; an API key you type is hidden and saved only in `.env`), pulls and starts PostgreSQL and
RabbitMQ in Docker, builds, and starts Dittoly with your sign-in link. Running it again is safe and quick.

```bash
npx dittoly run --ai claude-cli   # choose the AI without being asked (claude-cli, codex-cli, anthropic, openai, ollama, none)
npx dittoly run --setup-only      # everything except starting
npx dittoly run --stop            # stop PostgreSQL and RabbitMQ; your data is kept
npx dittoly run --reset           # start over: delete modules, Flows, runs, apps, plans, data tables and history;
                                  # keep your account, teams, stored credentials, encryption key and settings
```

`npm run up -- <options>` is the same command, and `./run.sh <options>` also switches to Node.js 26 with nvm first.

> Run it **inside the clone**. The name `dittoly` on the npm registry belongs to an unrelated package, so `npx dittoly`
> outside this folder would download and run that instead.

The steps below are the same thing by hand.

### Local app with PostgreSQL and RabbitMQ

Needs Node.js 26 and Docker with Compose. Dittoly runs on your machine; the two supporting services run in Docker.

If you use nvm, select the project's Node.js version before installing or starting:

```bash
nvm install
nvm use
```

Node.js 22 cannot enforce the process sandbox's network restrictions. Passing `--allow-net` to `npm start` does not fix an older runtime.

```bash
npm ci
npm run setup:local
npm run services:up
npm run build
npm start
```

Open the sign-in link printed in your terminal (normally at `http://localhost:8080`). Startup creates or reuses your personal admin. App commands load `.env` automatically, and shell environment variables take precedence. `setup:local` preserves your existing encryption key and custom settings.

`docker-compose.local.yml` contains only PostgreSQL and RabbitMQ. Stop them with `npm run services:down`; their data volumes remain. If you previously ran the app in Docker, stop that app container with `docker compose stop dittoly` before starting it locally. The service and volume names are shared so your existing database is reused.

For live development, use `npm run dev` for the backend and `npm run web:dev` in another terminal for the frontend. If you use nvm, `nvm use` selects the version from `.nvmrc`.

### Node.js (on your own computer)

Needs [Node.js 26](https://nodejs.org).

```bash
git clone https://github.com/SudoDevStudio/dittoly dittoly && cd dittoly
npm ci && npm run build
node bin/dittoly.mjs
```

Open the sign-in link it prints. Data is kept in `~/.dittoly`.

### Docker (shared server for a team)

The published image with HTTPS and single sign-on, nothing to build: on a host with Docker Engine 28+, a DNS name and
ports 80 and 443 open,

```bash
mkdir dittoly && cd dittoly
curl -fsSLO https://raw.githubusercontent.com/SudoDevStudio/dittoly/v0.1.0/compose.server.yml
curl -fsSL -o .env https://raw.githubusercontent.com/SudoDevStudio/dittoly/v0.1.0/.env.example
# in .env: DITTOLY_DOMAIN, DITTOLY_MASTER_KEY (openssl rand -base64 32), the DITTOLY_OIDC_* lines, the AI
docker compose -f compose.server.yml up -d
docker compose -f compose.server.yml exec dittoly node dist/src/cli/bootstrap.js admin   # first admin
```

Caddy gets the certificate for your domain by itself; PostgreSQL and RabbitMQ get no ports on the host. Requirements,
identity providers, upgrades and backups: [docs/server.md](docs/server.md), which also builds the same from source.

For personal Docker use, set `DITTOLY_MODE: local` in `docker-compose.yml`. Startup automatically creates or reuses your admin and prints a sign-in link in `docker compose logs dittoly`; OIDC and manual bootstrap are unnecessary. After updating the source, rebuild with `docker compose up -d --build dittoly`.

## Documentation

New here? Start with [docs/getting-started.md](docs/getting-started.md).

[docs/](docs/README.md): how it works, configuration, API, development, and the known gaps.

## License

[Apache License 2.0](LICENSE)

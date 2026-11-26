# Dittoly

**Orchestrate anything.** Super-Modules + Super Flows, approved by people, run with your own access.

Dittoly is self-hosted orchestration. **Super-Modules** connect your apps, **Flows** automate a process, and **Super Flows** connect Flows into bigger ones ([docs/super-flows.md](docs/super-flows.md)). Describe a multi-app process in plain language, the AI drafts a Flow, a person approves it, and the engine runs exactly that version. Every member keeps their own credentials; when you lack access, a teammate runs that one step with theirs.

## Install

### Quick start (macOS and Linux)

Needs Node.js 26 (switched for you if you use nvm) and Docker with Compose, running.

```bash
./run.sh
```

It does only what is still missing, in order: installs the npm packages, creates `.env` from `.env.example` with a
new encryption key, asks which AI should draft modules and Flows (the Claude and Codex CLIs you are signed in to are
offered first; an API key you type is hidden and saved only in `.env`), pulls and starts PostgreSQL and RabbitMQ in
Docker, builds, and starts Dittoly with your sign-in link. Running it again is safe and takes about a second when
nothing changed.

```bash
./run.sh --ai claude-cli   # choose the AI without being asked (claude-cli, codex-cli, anthropic, openai, ollama, none)
./run.sh --setup-only      # everything except starting
./run.sh --stop            # stop PostgreSQL and RabbitMQ; your data is kept
```

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

Step-by-step guide with system requirements, HTTPS, upgrades and backups: [docs/server.md](docs/server.md). In short, it needs Docker Engine 28+ with Compose.

```bash
git clone https://github.com/SudoDevStudio/dittoly dittoly && cd dittoly
cp .env.example .env        # set the master key, OIDC, DITTOLY_SANDBOX=docker and HOST=0.0.0.0
docker compose up -d
docker compose exec dittoly node dist/src/cli/bootstrap.js admin   # first admin
```

The portal is at `DITTOLY_PUBLIC_URL` (port 8080).

For personal Docker use, set `DITTOLY_MODE: local` in `docker-compose.yml`. Startup automatically creates or reuses your admin and prints a sign-in link in `docker compose logs dittoly`; OIDC and manual bootstrap are unnecessary. After updating the source, rebuild with `docker compose up -d --build dittoly`.

## Documentation

New here? Start with [docs/getting-started.md](docs/getting-started.md).

[docs/](docs/README.md): how it works, configuration, API, development, and the known gaps.

## License

[Apache License 2.0](LICENSE)

# Running Dittoly on a server (Docker)

This guide sets up a shared Dittoly server for a team with Docker Compose: Dittoly, PostgreSQL and RabbitMQ in
containers, members signing in through your identity provider, and HTTPS in front. For a personal install on your
own computer, see [install.md](install.md).

## What runs where

| Container | Image | Role |
| --- | --- | --- |
| `dittoly` | built from this repository's `Dockerfile` | The portal, the API and the background worker (port 8080) |
| `postgres` | `postgres:16` | All data. Secrets in it are encrypted with `DITTOLY_MASTER_KEY` |
| `rabbitmq` | `rabbitmq:4.2-alpine` | The queue for incoming webhooks |

Dittoly also starts short-lived **sandbox containers** through the host's Docker (it mounts
`/var/run/docker.sock`). These run module code, browser steps, egress proxies, and the project code of app and fix
steps. Each one is locked down: no Linux capabilities, a memory and CPU limit, an internal network whose only way out
is a proxy. See [install.md](install.md) ("Code sandboxes", "What a sandbox cannot reach").

There is no prebuilt Dittoly image in a registry yet: you build it from the repository (step 4 below).

## Requirements

### Software

- **Linux, 64-bit** (x86_64 or arm64). The images used are published for both; CI tests on x86_64.
- **Docker Engine 28 or later**, with the **Compose v2** plugin (`docker compose`). From Docker 28, sandbox networks get
  no address on the host, so a sandbox cannot reach ports the host listens on. An older Docker works, but the server
  logs `sandbox_network_not_isolated`, and you must bind every host service to `127.0.0.1` yourself.
- **git**, to get the code.
- **Outbound HTTPS** to Docker Hub and `mcr.microsoft.com` (images), to your AI provider, and to the apps your Flows
  use. App and fix steps also reach the package registries listed in `PACKAGE_REGISTRIES` (`src/engine/apps.ts`).
- **An OpenID Connect identity provider** (Google Workspace, Microsoft Entra ID, Okta, Keycloak, ...) for sign-in.
- **A DNS name and a TLS certificate** for the portal, served by a reverse proxy (step 7).

### Hardware

Pick the size by what your Flows do. Steps that only call apps through modules are light. Browser steps, and app and
fix steps that build and test code, need much more.

| Use | vCPU | RAM | Disk (SSD) |
| --- | --- | --- | --- |
| **Minimum**: modules and Flows that call apps, AI steps; no browser, app or fix steps | 2 | 4 GB | 20 GB |
| **Recommended**: browser steps, and app or fix steps with the default 2 code sandboxes | 4 | 8 GB | 60 GB |
| **Larger** | 2 + 2 per code sandbox | 2 GB + 2 GB per code sandbox + 1 GB per browser step at once | 60 GB + 2 GB per extra language image |

How these figures were reached:

- **The stack itself is small.** Measured idle on a test host: Dittoly about 65 MB, PostgreSQL about 68 MB, RabbitMQ
  about 109 MB. Dittoly stayed near 210 MB during a burst of 44 runs ([capacity report](capacity-baseline.md)).
  Leave 1 to 2 GB for the stack, the database's cache and the operating system.
- **Sandboxes have fixed limits** (set in the code). A module action is 256 MB and 1 CPU, for a second or so. A local
  MCP server is 512 MB. An egress proxy is 128 MB. A browser step is 1 GB and 1 CPU. An app or fix step is **2 GB and
  2 CPUs**, and `DITTOLY_CODE_SANDBOXES` of them may run at once (2 by default). These are ceilings, not
  reservations; plan RAM for them, or lower the setting.
- **Disk is mostly images.** Dittoly's image is about 0.5 GB, PostgreSQL's 0.65 GB, RabbitMQ's 0.27 GB, and the
  module sandbox image (`node:26-alpine`) 0.25 GB. The browser image is about 1 GB to download and larger unpacked.
  Each language an app or fix step uses adds its image: from 0.2 GB (`python:3.14-slim`) to 1.65 GB (`ruby:4.0`). Dittoly removes step images unused for 24 hours
  (`DITTOLY_SANDBOX_IMAGE_TTL_HOURS`). Add room for the database, which grows with runs and their kept outputs.

These are planning figures, from the limits above and one measured host. They are not a load test of your Flows:
watch the Admin page's "Background work" card, and `docker stats`, in the first weeks, and resize.

## Quick setup with the published image

Each release is published as `ghcr.io/sudodevstudio/dittoly:<version>` (linux/amd64 and linux/arm64, with an SBOM
and signed build provenance). `compose.server.yml` runs it with HTTPS and single sign-on already set: nothing to
build, and nothing in the Compose file to edit. You need a host with Docker Engine 28 or later (step 1 below), a DNS
name pointing at it, ports 80 and 443 open, and an identity provider (step 3 below lists what it needs).

```bash
mkdir dittoly && cd dittoly
curl -fsSLO https://raw.githubusercontent.com/SudoDevStudio/dittoly/v0.1.0/compose.server.yml
curl -fsSL -o .env https://raw.githubusercontent.com/SudoDevStudio/dittoly/v0.1.0/.env.example
```

In `.env`, set:

| Setting | Value |
| --- | --- |
| `DITTOLY_DOMAIN` | The address people open, e.g. `dittoly.example.com` (no `https://`). Caddy gets its certificate for it |
| `DITTOLY_VERSION` | The release to run, e.g. `0.1.0` |
| `DITTOLY_MASTER_KEY` | `openssl rand -base64 32` — **back it up apart from the server; it cannot be recovered** |
| `DITTOLY_OIDC_ISSUER`, `DITTOLY_OIDC_CLIENT_ID`, `DITTOLY_OIDC_CLIENT_SECRET` | From your identity provider; register `https://<DITTOLY_DOMAIN>/auth/callback` as the redirect URI |
| `DITTOLY_AI_PROVIDER` and its key | `anthropic`, `openai`, `ollama`, or `none` (as in step 3 below) |

Then start it and create the first admin:

```bash
docker compose -f compose.server.yml up -d
docker compose -f compose.server.yml ps                                    # all healthy
docker compose -f compose.server.yml exec dittoly node dist/src/cli/bootstrap.js admin
```

`https://<DITTOLY_DOMAIN>` is live once Caddy has its certificate (usually within a minute). PostgreSQL and RabbitMQ
have no ports on the host at all, Dittoly listens only on `127.0.0.1:8080`, and only Caddy is reachable from outside.

**Upgrade:** set `DITTOLY_VERSION` in `.env` to the new release, then `docker compose -f compose.server.yml up -d`.
Back up first ([Backups](#backups)); migrations run when the new version starts.

The steps below build the same thing from source, and explain each part.

## Setting it up

### 1. Prepare the host

Install Docker Engine and the Compose plugin from Docker's instructions for your distribution
(https://docs.docker.com/engine/install/), then check the versions:

```bash
docker version --format '{{.Server.Version}}'   # 28 or later
docker compose version
```

Use a host (or VM) dedicated to Dittoly. The Dittoly container controls the host's Docker, which is
root-equivalent on that host.

### 2. Get the code

```bash
git clone https://github.com/SudoDevStudio/dittoly.git dittoly
cd dittoly
cp .env.example .env
```

### 3. Configure

In `.env`, set at least:

| Setting | Value |
| --- | --- |
| `DITTOLY_MASTER_KEY` | `openssl rand -base64 32`. It encrypts every stored credential: **back it up apart from the database and never change it** (rotation: [install.md](install.md), "Key rotation") |
| `DITTOLY_PUBLIC_URL` | The address members open, e.g. `https://dittoly.example.com` |
| `DITTOLY_OIDC_ISSUER`, `DITTOLY_OIDC_CLIENT_ID`, `DITTOLY_OIDC_CLIENT_SECRET` | From your identity provider. Register `<DITTOLY_PUBLIC_URL>/auth/callback` as the redirect URI |
| `DITTOLY_OIDC_ALLOWED_DOMAINS` | Optional: only these email domains may sign in |
| `DITTOLY_AI_PROVIDER` and its key | `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`) or `ollama` (`DITTOLY_OLLAMA_URL`, `DITTOLY_AI_MODEL`, and optionally `DITTOLY_OLLAMA_NUM_CTX`, `DITTOLY_AI_TEMPERATURE`, `DITTOLY_AI_TOP_P`, `DITTOLY_AI_TOP_K`); `none` turns AI features off |

Compose sets the database, RabbitMQ, port and sandbox settings itself, so leave the `DATABASE_URL`, `HOST` and
`DITTOLY_SANDBOX` lines of `.env` as they are. The other settings are described in `.env.example`.

In `docker-compose.yml`, change two lines of the `dittoly` service:

```yaml
    environment:
      DITTOLY_MODE: shared          # was: local
    ports:
      - "127.0.0.1:8080:8080"       # was: "8080:8080"; the reverse proxy is the only way in
```

In `shared` mode members sign in only through your identity provider (there is no personal sign-in link), the
Claude and Codex command-line AI providers are refused, and module code runs only in Docker (startup fails with
`DITTOLY_SANDBOX=process`).

The bundled PostgreSQL trusts every connection on the Compose network. For production you can point `DATABASE_URL`
(in the `dittoly` service's `environment`) at a managed PostgreSQL with a password instead.

### 4. Build and start

```bash
docker compose up -d --build
docker compose ps                      # all three healthy
curl -s http://127.0.0.1:8080/ready    # {"ready":true,...}
```

The first build takes a few minutes. Database migrations run automatically when Dittoly starts.

### 5. Create the first admin

```bash
docker compose exec dittoly node dist/src/cli/bootstrap.js admin
```

It prints a break-glass API token once: store it in your password manager. Everyone else signs in through your
identity provider, starts as `member`, and gets roles on the Members page.

Optionally, load the example modules for an admin to review:

```bash
docker compose exec dittoly node dist/src/cli/seed.js
```

### 6. Check the sandbox

Sign in as the admin and open the Admin page. "Background work" should show the queue and "Code sandboxes 0 / 2".
Then check the server log for a warning about the sandbox networks:

```bash
docker compose logs dittoly | grep -E 'sandbox_network_not_isolated|error' || echo ok
```

### 7. Put HTTPS in front

Run a reverse proxy on the host that ends TLS and forwards to `127.0.0.1:8080`. With Caddy, which gets and renews the
certificate itself, the whole configuration (`/etc/caddy/Caddyfile`) is:

```
dittoly.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx, Traefik or your load balancer work the same way. Use `GET /health` for liveness and `GET /ready` for readiness
checks.

### 8. Firewall

Open only 443 (and 80, if your proxy redirects or gets certificates over HTTP). PostgreSQL (5433) and RabbitMQ (5672)
are bound to `127.0.0.1` in `docker-compose.yml`. Keep them that way.

## Running it

### Upgrades

With the published image (`compose.server.yml`): set `DITTOLY_VERSION` in `.env`, then
`docker compose -f compose.server.yml up -d`. Built from source:

```bash
git pull
docker compose up -d --build
```

Migrations run when the new version starts. Runs in progress are picked up again by the new process. Sandboxes the old
process left are removed within about 10 minutes.

### Backups

Back up the database, and keep the master key **separately**: the database alone cannot be decrypted.

```bash
docker compose exec -T postgres pg_dump -U postgres dittoly | gzip > dittoly-$(date +%F).sql.gz
```

Restore into an empty database with `psql`, with the same `DITTOLY_MASTER_KEY` in `.env`.

### Logs and health

- `docker compose logs -f dittoly`: one JSON line per event, without secrets or run data.
- `GET /ready`: `{ready, checks: {database, migrations, worker, webhookQueue}}`, `503` when the server cannot work.
- Admin page, "Background work": waiting and failed jobs, the oldest wait, and code sandboxes in use and waited for.

### Settings to tune

| Setting | Default (shared) | What it does |
| --- | --- | --- |
| `DITTOLY_RUN_WORKERS` | 2 | Runs one server works on at once. Keep it well below `DITTOLY_DB_POOL_MAX` (10) |
| `DITTOLY_DRAFT_WORKERS` | 2 | Plan items the AI drafts at once, in their own lane (runs never wait for drafting, nor drafting for runs) |
| `DITTOLY_CODE_SANDBOXES` | 2 | App and fix steps that build and test at once (2 GB and 2 CPUs each); more wait their turn |
| `DITTOLY_MAX_WAITING_RUNS` | 500 | Above this many waiting runs, new ones get `503 server_busy` |
| `DITTOLY_SANDBOX_IMAGE_TTL_HOURS` | 24 | Step images Dittoly pulled are removed after this long unused; `0` keeps them |
| `DITTOLY_INTERNAL_HOSTS` | (none) | Hosts on your private network that modules and steps may reach (e.g. a self-hosted GitLab) |
| `DITTOLY_CODE_RUNNER` | `local` | `remote`: app and fix steps build, test and run on a separate code runner machine ([code-runner.md](code-runner.md)) |

### Without Compose

To use your own PostgreSQL and RabbitMQ, build the image and run it with the same settings Compose passes:

```bash
docker build -t dittoly:latest .
docker run -d --name dittoly --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file .env \
  -e DITTOLY_MODE=shared -e DITTOLY_SANDBOX=docker -e HOST=0.0.0.0 -e PORT=8080 \
  -e DATABASE_URL='postgres://dittoly:<password>@db.internal:5432/dittoly' \
  -e DITTOLY_AMQP_URL='amqp://dittoly:<password>@mq.internal:5672' \
  -e TMPDIR=/tmp/dittoly-sandbox \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /tmp/dittoly-sandbox:/tmp/dittoly-sandbox \
  dittoly:latest
```

The sandbox folder must have the **same path** inside the container and on the host: Dittoly writes code there, and
the host's Docker mounts it into the sandbox containers.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Log line `sandbox_network_not_isolated` | Docker older than 28: sandboxes can reach ports the host listens on. Upgrade Docker, or bind host services to `127.0.0.1` |
| `/ready` says `migrations: pending` or `database: down` | The database is unreachable or still starting: `docker compose logs postgres` |
| `/ready` says `webhookQueue: down` | RabbitMQ is unreachable: `docker compose logs rabbitmq` |
| App or fix steps fail with `app_needs_docker` | Dittoly cannot use Docker: check the `docker.sock` mount |
| Runs wait with "sandbox busy" for long | All code sandboxes are in use: raise `DITTOLY_CODE_SANDBOXES` if the host has the memory, or wait |
| Sign-in fails after the identity provider | The redirect URI must be exactly `<DITTOLY_PUBLIC_URL>/auth/callback`, and `DITTOLY_PUBLIC_URL` must be the address members use |

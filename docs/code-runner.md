# Code runner: app and fix steps on a separate machine

App steps (build and start your app for a browser check) and fix steps (error-to-fix: reproduce, fix and verify) run
your project's code. By default they run in Docker sandboxes on the Dittoly machine. With a **code runner** they
run on another machine instead, so project code never runs where Dittoly, its files and its database are.

One setting chooses, when Dittoly starts:

| `DITTOLY_CODE_RUNNER` | App and fix steps run |
| --- | --- |
| `local` (the default) | On the Dittoly machine, as before |
| `remote` | On the code runner at `DITTOLY_RUNNER_URL` |

Nothing else changes: the same Flows, the same per-phase destinations, secrets, limits and evidence. The step's
output says `mode: docker` either way.

## What runs where

| Dittoly machine | Code runner machine |
| --- | --- |
| The portal, the database, credentials, the AI, approvals, the audit log | Docker, and the runner process (`npm run runner`) |
| Decides each step and sends the runner what that step needs | Clones, installs, builds, tests and runs the app in its sandboxes |
| The browser of browse steps | The running app, published on the runner's own loopback address only |

The runner has **no database and none of Dittoly's files**. Each step brings what it needs: the repository and the
token that clones it (for that one step), each phase's destinations, and each phase's secret env vars (only with the
commands of that phase). When the step ends, its clone, containers, networks, token and secrets are gone.

The sandboxes are the same as on a Dittoly server: one container per phase, no privileges, 2 GB and 2 CPUs, an
internal network whose only way out is that phase's egress proxy, and the install phase without secrets or the
step's destinations. See [ai-steps.md, "Fix and verify"](ai-steps.md#fix-and-verify).

## Set up the runner machine

You need Linux with Docker 28 or later, Node.js 26 and git.

```bash
git clone https://github.com/SudoDevStudio/dittoly.git dittoly && cd dittoly
npm ci
openssl rand -base64 32        # the shared token: the same value goes into Dittoly's settings
```

Put the settings in `.env.runner` (read by `npm run runner`):

```bash
DITTOLY_RUNNER_TOKEN=<the token>
DITTOLY_RUNNER_TLS_CERT=/etc/dittoly-runner/cert.pem
DITTOLY_RUNNER_TLS_KEY=/etc/dittoly-runner/key.pem
# DITTOLY_RUNNER_PORT=8443
# DITTOLY_RUNNER_SLOTS=2
# DITTOLY_INTERNAL_HOSTS=gitlab.corp.example.com:443
```

```bash
npm run runner
```

The runner refuses to start without Docker, without a token of at least 32 characters, or listening on other
addresses without TLS. To use a TLS proxy you already run (Caddy, nginx) on the same machine instead, set
`DITTOLY_RUNNER_HOST=127.0.0.1` and leave out the certificate.

| Setting | Default | What it does |
| --- | --- | --- |
| `DITTOLY_RUNNER_TOKEN` | (required) | The shared secret; every call from Dittoly carries it |
| `DITTOLY_RUNNER_HOST` | `0.0.0.0` | Address to listen on |
| `DITTOLY_RUNNER_PORT` | `8443` | Port to listen on |
| `DITTOLY_RUNNER_TLS_CERT`, `DITTOLY_RUNNER_TLS_KEY` | (none) | PEM files: the runner serves HTTPS itself |
| `DITTOLY_RUNNER_SLOTS` | `2` | Steps that build and test at once (2 GB and 2 CPUs each); more wait their turn |
| `DITTOLY_INTERNAL_HOSTS` | (none) | Git hosts on your private network the runner may clone from |
| `DITTOLY_SANDBOX_IMAGE_TTL_HOURS` | `24` | Step images the runner pulled are removed after this long unused; `0` keeps them |
| `DITTOLY_RUNNER_STATE_DIR` | `~/.dittoly-runner` | Where it remembers its earlier processes and the images it pulled |

Keep it running with your service manager, for example systemd:

```ini
[Unit]
Description=Dittoly code runner
After=docker.service
Requires=docker.service

[Service]
WorkingDirectory=/opt/dittoly
ExecStart=/usr/bin/npm run runner
Restart=always

[Install]
WantedBy=multi-user.target
```

## Point Dittoly at it

In Dittoly's `.env`, then restart Dittoly:

```bash
DITTOLY_CODE_RUNNER=remote
DITTOLY_RUNNER_URL=https://runner.internal.example.com:8443
DITTOLY_RUNNER_TOKEN=<the same token>
# Only when the runner's certificate is not publicly trusted (your own CA, or a self-signed certificate):
# DITTOLY_RUNNER_CA=/etc/dittoly/runner-ca.pem
```

Dittoly refuses to start with `remote` and no address or token, or with a plain `http://` address to another
machine. The Admin page shows the runner's mode (`docker`), or `off` while it cannot reach it.

To go back, set `DITTOLY_CODE_RUNNER=local` (or remove it) and restart.

## How app steps work remotely

The app keeps running on the runner. A small forward container, on a network of its own, publishes it on the
runner's **loopback address only**: nothing on the network, and no other container, reaches it directly. When the app starts, the runner gives Dittoly a token for that
one app. Dittoly starts a relay, which carries each of the browser's connections to the runner over HTTPS, and the
runner joins them to the app:

- With the browser in Docker (`DITTOLY_SANDBOX=docker`), the relay is a container that has the app's name on a
  network only this run's browser joins, the same as for an app on the Dittoly machine.
- With the browser on the machine (`DITTOLY_SANDBOX=process`), the relay listens on `127.0.0.1`.

The app's token opens only that app's tunnel. The shared token does not open it, and the app's token does nothing
else. The app stops when its run ends, or after two hours.

Dittoly must be able to reach the runner's port. The runner never connects to Dittoly.

## Waiting, failures and clean-up

- **Busy:** when all `DITTOLY_RUNNER_SLOTS` are building or testing, a step gets `sandbox_busy` and its run waits
  its turn, the same as with Dittoly's own `DITTOLY_CODE_SANDBOXES`. Dittoly's own slots still apply, so set
  `DITTOLY_CODE_SANDBOXES` no higher than the runner's slots. A running app does not hold a slot.
- **Runner unreachable:** the step fails with `runner_unreachable`, retryable, and Dittoly's usual retries apply.
  A wrong token fails with `runner_unauthorized`.
- **Steps left behind:** a fix step's workspace that nobody used for 45 minutes is closed, the same as one open for
  six hours. A step whose Dittoly server stopped mid-way therefore never keeps its clone or secrets.
- **Runner restarts:** at start, the runner removes the containers, networks and folders its earlier processes left
  (for example after a crash). Resources of anything else on that Docker host, including a Dittoly server, are
  never touched.

## Security notes

- The runner and its Docker host are where untrusted project code runs. Run nothing else there that matters, and
  give the machine no access it does not need: its network only needs your git host and the package registries
  (`PACKAGE_REGISTRIES` in `src/engine/apps.ts`), plus each step's declared destinations.
- The shared token can start steps, so treat it like a password: keep it only in the two settings files, and rotate it
  by changing both and restarting both.
- Only Dittoly talks to the runner. Allow its port only from the Dittoly machine, for example with the firewall.

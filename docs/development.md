# Development

```bash
npm ci
npm run setup:local                        # .env with personal mode and a persistent master key
npm run services:up                        # only Postgres :5433 and RabbitMQ :5672 in Docker
npm run build
npm start                                 # app runs on this machine; prints your sign-in link
```

For live development, use `npm run dev` for the backend and `npm run web:dev` in a second terminal. All application commands load `.env`; shell variables take precedence. Node.js 26 is required (`nvm use` if you use nvm).

For tests:

```bash
npm run web:build                          # the browser test drives the built portal
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/dittoly_test npm test
DITTOLY_TEST_DOCKER_IMAGE=node:26-alpine npm test          # also run sandbox tests in containers
```

`TEST_AMQP_URL` defaults to `amqp://dittoly:dittoly@127.0.0.1:5672`. In the cloud development container, `scripts/dev/services.sh` starts Postgres, Docker and RabbitMQ instead.

The suite covers the Step 5 list (approval integrity, manifest enforcement, webhook rejection and replay, credential isolation and delegation, the shared-mode CLI block, retries and restart recovery, PII absence) plus SSO sign-in against a real OIDC provider, MCP against a real MCP server, webhooks through a real RabbitMQ, the local install on PGlite, the security-review regressions, and a Chromium run through the portal. It also passes with `DITTOLY_DB_POOL_MAX=1` and against PGlite (`scripts/dev/pglite-server.ts`).

**Portal test failures.** Each portal test signs in for itself, so one can run alone: `npx vitest run test/ui.e2e.test.ts -t 'Super Flow'`. A failed portal test leaves `test-artifacts/<test>/` with a full-page screenshot, the URL and browser errors (`page.json`) and a Playwright trace (`npx playwright show-trace trace.zip`); the Vitest error is printed with the test. `DITTOLY_TEST_ARTIFACTS` moves the folder. CI uploads it as the `portal-test-failures` artifact (kept 7 days) when a run fails. Library traces do not include assertions: read them next to the Vitest error.

Other useful commands: `npm run typecheck`, `npm run web:dev` (portal with hot reload), `npm run local` (local install from source).

CI (`.github/workflows/ci.yml`) runs the typecheck, the build and the full suite (with Postgres, RabbitMQ, Chromium and the Docker sandbox) on every pull request that changes more than documentation or the website (`site/`). It tests the PR merged into `main`, so it does not run again on `main` after the merge (run it there by hand from the Actions tab when needed). The exported-app frontend builds run only when `src/export/` or the lockfile changes, and the per-language toolchain tests (`.github/workflows/toolchains.yml`) only when the sandbox or a toolchain changes, and monthly.

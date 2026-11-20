# Export as an app

Dittoly can package approved Flows as an app that runs on its own. The export is a TypeScript
project, all of it source code:
- the Flows are written out as code;
- the modules are their exact approved code;
- its runtime is TypeScript in the app's own `src/runtime/`, with only the parts its Flows and modules use;
- it is configured entirely by environment variables;
- it has no database of its own, no compiled Dittoly files and no connection back to Dittoly.

Admins and approvers export from **Export an app** (under **Share** in the menu).

An app built under **Apps** ([apps.md](apps.md)) exports with its own layout and look: **Export** on its page fills this in.

## What you can export

| Kind | What it is |
| --- | --- |
| **Runner** | The Flows run on their schedules and webhooks. No API beyond `/health` and `/hooks`. |
| **Headless API** | Start runs, read results, approve and answer forms over HTTP. `openapi.json` describes it, with each Flow's own input schema. |
| **API + simple UI** | The API plus a branded web app: a form per Flow, results, the approvals inbox and the runs list. |
| **Your framework** | The API plus a frontend project in **React (Vite)**, **Next.js**, **Angular**, **Astro** or **Vue**, laid out from your Flows. |

For each Flow you choose who may start it:
- **holders of the app's API token**; or
- **anyone**: public, rate limited, for things like a shop's product list or an order form.

A Flow that another exported Flow runs (a Super Flow's Flows) comes along automatically, is called by its name in the code, and is only run by that Flow.

## What is in the export

The download is a `.tar.gz` of about 100 KB:

```
release-desk/
  src/flows/release-desk.ts   each Flow as code, written out from its approved version
  src/app.ts                  the app: its modules' manifests, schedules, webhooks, theme, page plan
  src/main.ts                 starts it, with the parts of the runtime it uses
  src/runtime/*.ts            the runtime, as source: engine, server, sandbox workers, broker, and only
                              the parts these Flows and modules need
  sandbox/modules/*.mjs       the modules' code, exactly as approved (checked by sha256 at start)
  sandbox/runner.mjs          what runs a module inside its sandbox
  public/                     the built-in UI, or an info page (a generated frontend is built into it)
  frontend/                   the generated frontend project (Your framework only)
  package.json  tsconfig.json  Dockerfile  docker-compose.yml  .env.example  openapi.json  README.md
```

A Flow file is plain TypeScript. Each step's inputs are expressions of the run form and earlier steps' results:

```ts
{
  id: 'issues',
  type: 'action',
  title: 'Find issues',
  module: 'jira@1.1.0',
  action: 'search_issues',
  input: (s) => ({
    jql: ref(s, 'inputs.jql'),
  }),
},
```

- **Only what the app uses.**
  - `src/runtime/` always has the engine, the HTTP server, the sandbox workers and the broker (about 14 files).
    Every other part is its own file, and `src/main.ts` imports it only when the app needs it:

    | Part | Files | When |
    | --- | --- | --- |
    | Keeping runs across restarts | `state.ts`, `store-redis.ts`, `store-postgres.ts` | a Flow waits for a person, waits a while or uses a table |
    | Notices with approve links | `notify.ts` | a Flow waits for a person |
    | Schedules | `schedules.ts` | a Flow runs on a schedule |
    | Webhooks | `hooks.ts`, `verify.ts` | a Flow has a webhook |
    | Report steps | `report.ts` | a Flow has a report step |
    | Form steps | `input-steps.ts`, `form.ts` | a Flow asks a person to fill in a form |
    | Table steps | `table-steps.ts`, `values.ts` | a Flow uses a table |
    | AI steps | `ai-steps.ts`, `ai-step.ts`, `ai-*.ts` | a Flow has an AI step |
    | Email, messages, WebSocket, SSE | `endpoint-calls.ts`, `transport-<protocol>.ts` | a module has such an endpoint |
    | Databases | `endpoint-calls.ts`, `databases.ts`, `db-<database>.ts` | a module has a database endpoint |
    | Google service accounts | `google-auth.ts` | a module uses one |

  - `package.json` lists only the packages those files import, at exact versions. A Flow that calls HTTPS APIs
    needs `ajv`, `re2js` and `undici`.
  - There are no migrations, no database engine and no web framework. The server is Node's own `http`.
- **Only approved content.** The Flows are written out from approved versions, and the modules are exactly as
  approved. The app refuses to start if a module's code was changed. Changing a Flow file makes the app do
  something other than what was approved.
- **No secrets.** What the Flows tell the modules, credentials, the AI key and webhook secrets become environment variables
  that whoever runs the app sets.
- **What cannot be exported, and why the export says so:**
  - steps that build and run an app from git, and steps that fix and verify code (both need Dittoly's
    build sandbox);
  - steps handed to a named teammate;
  - modules imported from MCP servers;
  - browser modules and AI-guided browse steps (they need a browser and its own sandbox).

  The export names each reason once per Flow, with the steps it applies to. `{{ fingerprint(...) }}` is
  exported: the app computes the same value Dittoly does.

## Exporting again

Each export remembers what it was made from. When a Flow in it gets a newer approved version, **Earlier
exports** marks it **New versions available**; while a change to one of its Flows waits for approval it says
**Flow change awaiting approval**. **Review** shows what an export made now would change:
- each Flow's version (1 → 2) and its steps added, removed or changed;
- modules added or removed;
- settings to update where the app runs: new variables, ones now required, ones no longer used;
- whether the app now needs a state store (`STATE_URL`), or no longer does.

**Download new export** makes it again from the same choices (Flows, access, kind, theme, layout) with the
current approved versions. It is a new export with its own bundle hash; the earlier one stays in the list.
Exports made before this existed are listed but cannot be exported again in one step.

## Run it

```sh
tar -xzf release-desk.tar.gz && cd release-desk
cp .env.example .env      # fill in the required values
docker compose up -d --build
```

Without Docker: `npm install && npm run build && node dist/main.js` (Node.js 26).

Every variable can also be given as `<NAME>_FILE`, the path of a file holding the value, so Docker and Kubernetes
secrets work as they are.

### Where runs are kept

- **Flows that never wait:** runs live in memory. Nothing is written to disk or to a database, and the app
  has no state store code (setting `STATE_URL` is refused).
- **Flows that wait** (for a sign-off, a form or a delay) **or keep table rows:** that state must outlive a
  restart. It goes to the store `STATE_URL` names:
  - **Redis** (`redis://`);
  - **Postgres** (`postgres://`). The app creates its three tables itself.
- The generated `docker-compose.yml` starts a Redis for it. Point `STATE_URL` at your own Redis or Postgres instead
  if you have one.
- Run data sent to the store (inputs and step outputs) is encrypted with a key derived from `APP_SECRET`.
- A run that was waiting carries on after a restart. A step that was in the middle of changing something when the
  app stopped is not repeated blindly: the run pauses with `uncertain_outcome` (unless the action is marked `idempotent`).

### Performance

- **Steps run in the app's process.** The engine runs the Flow's steps directly; nothing goes through a queue or a
  database between steps.
- **Modules run in warm sandboxed workers.** Each is started once and reused, so a call does not start a process.
- **Measured** with stand-in apps, a two-step Flow (two module calls) started over HTTP:
  - about 5 ms per run, start to finish;
  - 100 runs at once in about 0.2 s.
- **Small.** The Docker image of a simple app is about 290 MB, most of it the `node:26-alpine` base. It uses
  about 90 MB of memory with one warm worker.

### Environment variables

| Variable | |
| --- | --- |
| `APP_SECRET` | Required. At least 32 random characters. Signs links and encrypts what goes to `STATE_URL`; keep it the same across restarts. |
| `APP_API_TOKEN` | Bearer token to start non-public Flows and read runs. |
| `APP_ADMIN_TOKEN` | Bearer token for approvals, forms the Flows wait on, the inbox and the runs list. Required when a Flow waits for a person. |
| `STATE_URL` | `redis://…` or `postgres://…`. Required when a Flow waits or uses a table; such apps only. |
| `SETTING_<MODULE>_<SETTING>` | A module setting, e.g. `SETTING_JIRA_SITE=acme.atlassian.net`. Host settings are required. |
| `CRED_<SERVICE>` | A credential, e.g. `CRED_JIRA=me@acme.com:token`. Every run uses these: the app has one identity. |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `OLLAMA_URL` | Your own AI key, when a Flow has AI steps that use the organization's AI. |
| `HOOK_SECRET_<FLOW>` | The signing secret of a Flow's webhook (`POST /hooks/<flow>`). |
| `PUBLIC_URL` | Where people open the app; used in approval links. |
| `NOTIFY_WEBHOOK_URL`, `NOTIFY_EMAIL`, `SMTP_URL`, `EMAIL_FROM` | Tell someone when a run waits for a person. |
| `SANDBOX_WORKERS` | Warm sandbox workers per module (default 2): how many calls of one module run at the same time. |
| `RUN_RETENTION_DAYS`, `INTERNAL_HOSTS`, `CORS_ORIGINS`, `DISABLE_SCHEDULES`, `PORT` | Optional. |

## The API

- `POST /api/flows/<flow>/runs?wait=20` with `{ "inputs": { ... } }` starts a run and waits up to 20 seconds
  for it to finish or stop for a person. The answer has two parts:
  - the run: each step's result, what it waits for, and `result` (the last step's output);
  - a `runToken`.
- `GET /api/runs/<id>` reads a run, with a token or the run's own `X-Run-Token`.
- `POST /api/runs/<id>/steps/<step>/decision` with `{ "decision": "approved" | "rejected" }` (admin token). For a step text an AI wrote could steer, the inbox item carries `signOff` (the step's exact values and their `sha256`); send `"valuesSha256"` with the decision and it is refused if the values changed meanwhile.
- `POST /api/runs/<id>/steps/<step>/input` with `{ "values": { ... } }` (admin token or run token).
- `GET /api/inbox` (admin token), `GET /api/runs` (any token), `GET /api/app`, `GET /openapi.json`, `GET /health`.

The run token lets whoever started a public run read it and answer its forms, and nothing else.

## People in the loop

Approval and form steps work as in Dittoly: the run waits, and someone with the admin token decides in the
app's inbox or through the API.

With `NOTIFY_WEBHOOK_URL` (a JSON POST) or `NOTIFY_EMAIL`, each waiting step is announced once, with **signed
approve and reject links** valid for 7 days. A link opens a confirmation page, and the decision is made only when
the button is pressed, so link scanners cannot approve anything.

## Branding

A theme is:
- a name;
- a logo (PNG, JPEG, WebP or SVG, up to 200 KB);
- a main and an accent colour;
- a font style and a corner style.

Dittoly derives light and dark colours from it and **adjusts text colours until they meet WCAG contrast**
(4.5:1 for text, 3:1 for focus rings), whatever colours were picked. The organization's AI can propose a palette
from a short description. Themes are saved for reuse. Fonts are system font stacks, so an exported app loads
nothing from a font host.

## Frontends in your framework

The frontend is described by a **page plan**:
- the pages: home, a form for a Flow, a table or cards listing what a Flow returns, the inbox, the runs list;
- which Flow each page runs, and where in the results its data is;
- the card fields (title, image, price…);
- buttons that open another page with fields filled in from an item. A product's **Buy** opens checkout with its id.

How the plan is made and built:
- Without a brief, the plan is a page per Flow, made without AI.
- With a brief ("a shop: product cards with a Buy button, then checkout; sidebar on the left") and/or a layout
  image, the organization's AI drafts the plan from the Flows and their modules' output shapes.
  - The plan is checked against the Flows: every Flow, input, step and page must exist.
  - The AI gets one chance to fix what is wrong.
  - The AI only ever writes this plan, never code.
- Each framework has one tested template that renders any plan: React (Vite), Next.js (static export), Angular
  (standalone components), Astro (static pages) and Vue (single-file components). They share:
  - `dittoly/core.js`, the API client and helpers, with types in `core.d.ts`;
  - `theme.css` and `app.css`.
- Versions are pinned exactly (React 19.3, Vite 8.3, Next.js 16.3, Angular 22.2, Astro 7.3, Vue 3.5, TypeScript
  6.0), so a rebuild later installs the same thing. CI installs and builds every template on each change.
- Change the look by editing `theme.css`, `app.css` or the components; change the pages by editing
  `app.config.json`. The Docker build compiles it and the app serves it, with `/api` on the same origin.

## Security

- **Same checks as Dittoly.** Module code runs in warm sandboxed workers: Node processes with:
  - no network;
  - no child processes;
  - an empty environment;
  - files readable only in `sandbox/`.

  Every request a module makes goes through the same broker as in Dittoly. Modules reach only their declared
  hosts, credentials are attached outside module code, and database queries are the fixed, reviewed ones.
- **Workers are reused.** A worker runs one call at a time. It is replaced when a call times out, when it exits,
  and after 1000 calls.
- **Strict built-in UI.** It is served with a strict content security policy (no inline scripts) and renders data
  as text only.
- **One identity.** Every run uses the credentials in the environment. Give them only the access these Flows
  need, and prefer private Flows (`APP_API_TOKEN`) unless a Flow is meant for the public.
- **No self-fixing.** Nothing in an exported app asks an AI on its own.

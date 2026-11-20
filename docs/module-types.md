# Module types and the Dittoly base

Every module Dittoly's AI builds is the same shape: the **Dittoly base** at the top of `module.ts`, the module's own
TypeScript under it, and a **config** that says what each action is and does. This page lists what each kind of
module can do. It is the same for every module of that kind. The AI reads the same list in its module skill
(`skills/module-authoring`).

- **The base** is tested TypeScript, the same in every module, between `// <dittoly-base>` markers. It handles what
  every module of a kind needs: building requests, credentials, paging, errors, queries, email, publishing and
  streams. It adds no power: every call still goes through the sandbox's broker, within the hosts, endpoints, queries
  and credentials the manifest declares.
- **The module's own code** calls the base (`base.http.client(...)`, `base.db.first(...)`, ...). Where an action needs
  something else, the code does that part itself, for example its own error mapping, parsing an XML answer, or
  several calls in one action. The base is plain functions, so any part of it can be replaced.
- **The config** describes each action: its kind, the call it makes, the endpoint and query it uses, and where it
  does more than the base usually does. Dittoly checks the config against the manifest and the code. It shows the
  config on the review page and in MODULE.md, and gives it to the AI that revises the module or builds a Flow with
  it. The config does not run anything. If the AI's config still doesn't match the module after one fix, the module
  is kept without it.

A new version of a module gets the current base again and keeps its own code, so a module is reviewed and approved
with the exact base it runs.

## http

`base.http.client({ baseUrl, headers?, credential? })`, then `.get`, `.post`, `.put`, `.patch`, `.delete` or `.list`.

- Any HTTPS JSON API: GET, POST, PUT, PATCH, DELETE.
- `{name}` path placeholders filled from `vars` (URL-encoded).
- Query parameters (empty ones left out).
- A JSON body, or multipart with files as data URLs.
- The manifest's credential, attached by the runtime (or none).
- A host per organization: `{{settings.site}}` in `baseUrl`.
- Errors inside a 200 answer (`okWhen`).
- Status codes mapped to error codes: 401/403 become `not_allowed`, 404 `not_found`, 429 `rate_limited`. 429 and 5xx can be retried.
- Listings across pages (Link header, page number or cursor), at most 10 pages.
- The raw answer (`raw: true`) for XML, HTML, CSV or the code's own checks.

## db (PostgreSQL, MySQL/MariaDB, SQL Server, MongoDB)

`base.db.rows`, `base.db.first`, `base.db.count`.

- Runs a query (SQL) or operation (MongoDB) that the manifest's endpoint declares, by id, with bound parameters.
- Returns all rows, the first row (or `not_found` when there is none), or the row count.

## smtp

`base.mail.send`.

- Sends one email: to, cc, bcc, reply-to, subject, and text or html.
- The sender is fixed by the manifest.

## amqp and mqtt

`base.amqp.publish`, `base.mqtt.publish`.

- Publishes one message: to an exchange the endpoint declares (AMQP), or to a topic within the endpoint's topics (MQTT, QoS 0 or 1, retained or not).
- A `{name}` in a routing key or topic fills one level. A value with `/`, `#`, `+` or spaces is refused.

## ws and sse

`base.ws.exchange`, `base.sse.read`.

- A bounded WebSocket exchange: send messages, collect a limited number of replies.
- Reads a limited number of Server-Sent Events.
- JSON messages and event data come back parsed.

## browser and code

- A **browser** module (a manifest with a `browser` section) uses `ctx.page` for sites without a usable API. See the browser-scripts skill.
- A **code** action makes no call (exact logic such as matching or de-duplicating).
- Both are described in the config like any other action.

# Protocols

What a module can connect to, and how a request is classified before anything is built.

## Classify, then ask

When someone asks for a module or a Flow, the AI first says what kind of integration it is: a category and the protocols it needs. It then asks only what it cannot decide and what changes what gets built. For example, for an email request it asks whether to use a provider API (Mailchimp, SendGrid, Resend, Postmark) or the organization's own SMTP server. Nothing is built until the person answers every question. When there are no questions but something is missing (an unsupported protocol, or a module no one has built yet), they can choose **Build anyway**.

When a Flow needs something no approved module can do (say, reading a pull request's existing comments), drafting never ends in an error. The person sees what is missing and chooses:

- **Add it to `<module>`**, when an approved module for the same app only lacks that action: a new version of that module is drafted with the action added, keeping every existing action as it is. It is reviewed and approved like any version; then draft the Flow again.
- **Build a new module** for an app no module covers yet.
- **Draft without it**: the Flow is drafted without that part, and its description starts with "Leaves out: …" so reviewers see what it does not do. A later version can add it.
- **Change the request.**

The same choices appear when the AI tries to build all of it anyway and cannot.

- **Support status.** Whether a protocol is supported comes from the catalog (`src/ai/protocols.ts`), never from the AI. Unknown protocol names are dropped.
- **Unsupported protocols.** A protocol Dittoly cannot use (SFTP, SSH, IMAP, gRPC, databases…) is shown before building, along with the usual alternative.
- **Missing modules in Flows.** A Flow that needs something no approved module can do names the missing capability, with a ready-made request to build that module. A Flow built anyway keeps the list, and its review says what was missing.
- **What reviewers see.** The classification and the person's answers are stored with the draft and shown on the review page under "What the AI was given". They guide the draft only. What a module may do is still its manifest, enforced at run time.
- **Empty answers are not answers.** Answers are matched by the question or its id; blank ones count as unanswered. Sending answers asks again only the questions they leave open; with none open, it builds. Plans work the same way.
- **When classification fails.** An answer that says too much is still read: an over-long summary, question or option is shortened, extra entries are dropped, and JSON in a code fence is accepted. Only an answer that is not a JSON object at all is unreadable. An unreadable classification is asked once more. If it fails again, nothing is built: the request answers `503 classification_unavailable` and the person tries again. Their answers stay on the page.
- **API.** `POST /api/modules/generate` and `POST /api/flows/generate` take an optional `answers` object (question or question id → answer). They may answer `200 {needsAnswers: true, classification}` (with only the open questions) instead of `201` with a draft. With no questions open, sending `answers` (even `{}`) builds anyway.

## What modules can use

| Category | Protocols | In Dittoly |
| --- | --- | --- |
| Web API (HTTPS) | REST, GraphQL, SOAP, JSON-RPC, XML-RPC, OData, outgoing webhooks, A2A | `ctx.http.request` to hosts in `hosts` |
| | WebDAV | GET, PUT, DELETE only |
| | S3-compatible storage | Pre-signed URLs or a gateway (request signing needs the secret, which modules never see) |
| Streaming | WebSocket / WSS | `ctx.ws.exchange`: connect, send, collect a bounded number of replies, close |
| | Server-Sent Events | `ctx.sse.read`: a bounded number of events |
| Email | SMTP | `ctx.smtp.send`, send only, with the sender fixed in the manifest |
| | Provider APIs (Mailchimp, SendGrid, Resend, Postmark, SES) | `ctx.http.request` |
| Messaging | AMQP (RabbitMQ) | `ctx.amqp.publish` to declared exchanges, with publisher confirms |
| | MQTT | `ctx.mqtt.publish` to topics matching declared filters, QoS 0 or 1 |
| Databases | PostgreSQL (and Supabase), MySQL/MariaDB, Microsoft SQL Server | `ctx.db.query`: fixed queries from the manifest with bound parameters (see [SQL databases](#sql-databases)) |
| | MongoDB (and Atlas) | `ctx.db.query`: fixed operations from the manifest with typed parameters (see [MongoDB](#mongodb)) |
| | Firebase: Cloud Firestore, Realtime Database | `ctx.http.request` with a Google service account credential (see [Google service accounts and Firebase](#google-service-accounts-and-firebase)) |
| AI agents | MCP | Imported on the Modules page (remote, or a local package in local mode) |
| Not supported | IMAP, POP3, FTP, FTPS, SFTP, SCP, SMB, NFS, SSH, Telnet, gRPC, Thrift, Kafka, NATS, STOMP, Redis, LDAP, WebRTC, WebTransport, RTSP, RTP, SIP | The catalog names the usual alternative, such as the service's HTTPS API |
| Underneath, not a choice | TCP, UDP, QUIC, IP, IPv4, IPv6, DNS, DHCP, ICMP, TLS, SSL, HTTP/2, HTTP/3 | Handled by the runtime. TLS is always required and certificates are verified. Requests use HTTP/1.1. |

## Endpoints

Every connection other than an HTTPS request is declared in the manifest's `endpoints` and reviewed by an admin. Module code names the endpoint id, never an address or a secret:

```json
"endpoints": [
  { "id": "mail", "protocol": "smtp", "host": "{{settings.smtp_host}}", "tls": "starttls", "credential": "smtp_login", "from": "{{settings.sender}}" },
  { "id": "bus",  "protocol": "amqp", "host": "rabbit.acme.com", "tls": true, "vhost": "/", "exchanges": ["orders"], "credential": "amqp_login" },
  { "id": "iot",  "protocol": "mqtt", "host": "mqtt.acme.com", "tls": true, "topics": ["devices/+/commands"], "credential": "mqtt_login" },
  { "id": "feed", "protocol": "websocket", "host": "stream.example.com", "credential": "api_token" },
  { "id": "events", "protocol": "sse", "host": "api.example.com" }
]
```

The broker enforces, on every call:

- **Endpoint.** It must be declared and match the call's protocol.
- **Default ports.** SMTP 587 (465 for implicit TLS), AMQP 5671, MQTT 8883, WebSocket/SSE 443, PostgreSQL 5432, MySQL 3306, SQL Server 1433, MongoDB 27017.
- **Encryption.** TLS is required. Plain text is allowed only for hosts an admin lists in `DITTOLY_INSECURE_HTTP_HOSTS`, which is meant for local development.
- **Addresses.** The same rules as HTTPS: loopback, link-local and metadata addresses are refused, and private ranges are refused unless the host is in `DITTOLY_INTERNAL_HOSTS`. IP literals are checked too.
- **Credentials.** The running member's own credential is attached by the broker. SMTP, AMQP, MQTT and database logins use `basic` placement (`username:password`). WebSocket and SSE use HTTP-style placements on the handshake.
- **Public data needs no key.** A credential marked `"optional": true` is attached only when the member has stored it (higher rate limits, private data); otherwise the request or connection goes out without it, and runs never stop for it. The AI uses no credential for public data, an optional one when a key only adds limits or private data, and a required one only when the service refuses every request without one.
- **Any public site, read-only.** A module with `"publicWeb": "read"` may also GET or HEAD any public `https` URL (and its browser may load any public page) besides its declared hosts: no credentials, no request body, no form submissions, only `accept`, `accept-language`, `user-agent` and `range` headers, addresses up to 2,048 characters, and private or internal addresses refused even when an admin allows them for declared hosts. Sending data and credentials still works only on the declared hosts. The reviewer's summary says so, including that a web address itself can carry a little data. Use it for modules that take links from anywhere, such as "analyse this article".
- **Writes.** Sending email and publishing are allowed only in `write` actions, and are never retried when the outcome is uncertain. A WebSocket session that sends messages counts as a possible write.
- **Limits.**
  - Email: 50 recipients, a single-line subject, 1 MB of body.
  - AMQP: 1 MB per message.
  - MQTT: 256 KB per message, and no wildcard characters in the topic being published to.
  - WebSocket: 20 messages sent (64 KB each), at most 100 received, 30 seconds, 2 MB in total.
  - SSE: at most 100 events, 30 seconds, 2 MB.

Not supported: consuming from AMQP or MQTT (use a webhook or a schedule), reading mailboxes, and long-lived streams beyond one step.

Sandbox tests can give canned answers for these calls with `"calls": [{ "protocol": "smtp", "rejected": [...] }]`, `{ "protocol": "websocket", "messages": [...] }` or `{ "protocol": "sse", "events": [...] }`. Without them, sends succeed and streams return nothing.

## SQL databases

A database endpoint connects to PostgreSQL (`"protocol": "postgres"`, also Supabase), MySQL or MariaDB (`"mysql"`) or SQL Server (`"mssql"`). The module can only run the queries written in the manifest. The admin reviews each one word for word, and the review summary shows the exact SQL with its parameters.

```json
{ "id": "shop", "protocol": "postgres", "host": "{{settings.db_host}}", "database": "{{settings.db_name}}",
  "tls": true, "ca": "{{settings.db_ca}}", "credential": "db_login",
  "queries": [
    { "id": "find_order", "effect": "read", "sql": "SELECT id, status, total FROM orders WHERE id = :order_id",
      "params": { "order_id": { "type": "integer" } }, "maxRows": 1 },
    { "id": "mark_shipped", "effect": "write", "sql": "UPDATE orders SET status = 'shipped' WHERE id = :order_id",
      "params": { "order_id": { "type": "integer" } } }
  ] }
```

```js
const r = await ctx.db.query({ endpoint: 'shop', query: 'find_order', params: { order_id: input.id } });
// r = { rows: [{ id: 7, status: 'new', total: '19.90' }], rowCount: 1, truncated: false }
```

How SQL injection is ruled out:

- **No SQL from code.** The code names a declared query and passes values. It cannot send SQL text.
- **Bound parameters only.** `:name` placeholders become the driver's own parameters (`$1`, `?`, `@p1`), so values are never pasted into the SQL. Each parameter is declared with a type (`string`, `integer`, `number`, `boolean`, `timestamp`, optionally `nullable`). Values must be single values of that type, never objects or lists, and unknown or missing parameters are refused.
- **Checked when the manifest is saved.** A query must be exactly one statement: no comments, no `;` except at the end, no other placeholder styles, and no Postgres `E'...'` or `$$` strings. Strings cannot contain backslashes, and MySQL queries cannot use double-quoted strings: what both mean depends on server settings. Read queries start with `SELECT` or `WITH` and cannot use `INSERT`, `UPDATE`, `DELETE`, `INTO` or locking reads. Write queries make exactly one `INSERT`, `UPDATE` or `DELETE`, and `UPDATE` and `DELETE` need a `WHERE`. Schema changes, permissions, transactions, procedures, dynamic SQL, `COPY`/`LOAD`, `MERGE` and functions that sleep, read files or run other SQL (`pg_sleep`, `pg_read_file`, `dblink`, `query_to_xml`, `sleep`, `benchmark`, `load_file`, `xp_*`, `sp_*`, and others) are refused. SQL Server allows statements without a `;` between them, so statement keywords such as `EXEC`, `BEGIN` and `IF` are refused there as well.
- **Reads cannot write.** Read queries run in a transaction that is always rolled back. On PostgreSQL and MySQL that transaction is also `READ ONLY`, so the database itself refuses changes. A `read` action can run only read queries.
- **Limits.** `maxRows` defaults to 100 and can be at most 1,000. Postgres stops at the limit with a cursor; MySQL and SQL Server stop reading. Results are capped at 2 MB, and each query gets the step's time limit (15 seconds by default) as a statement timeout. The result's `truncated` flag shows when more rows matched.
- **Errors are codes.** `db_timeout`, `db_login_failed`, `db_tls_failed`, `db_read_only`, `db_duplicate`, `db_constraint`, `db_permission_denied`, `db_conflict`, `db_unreachable`. The database's own message, which can quote data, is never passed to the module.

**Connections.** Each call opens one connection to an address the egress rules allow and closes it afterwards. TLS is required, the certificate is verified against the endpoint's host name, and plain text is allowed only for hosts in `DITTOLY_INSECURE_HTTP_HOSTS`. Give the module a database user that can only do what its queries need. That way the database's own permissions hold even if a query is wrong.

**Supabase.** Supabase is `postgres`. Use host `db.<project-ref>.supabase.co:5432` or the pooler host from the project's Connect panel, and database `postgres`. Supabase signs its database certificates with its own CA. Download it under **Database Settings → SSL Configuration** and paste it into the module's `certificate` setting, which the endpoint's `ca` names. Full verification (`verify-full`) then works ([Supabase: Postgres SSL Enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)).

Sandbox tests answer queries with made-up rows: `"calls": [{ "protocol": "postgres", "query": "find_order", "rows": [{ "id": 7, "status": "new" }] }]`, `{ "protocol": "postgres", "query": "mark_shipped", "rowCount": 1 }`, or `{ "protocol": "mysql", "error": "db_duplicate" }`. Without one, a query returns no rows. The test report lists each query run, such as `SQL postgres db.example.com/shop find_order (1 bound value)`.

## MongoDB

A `mongodb` endpoint runs only the operations written in the manifest, and the review summary shows each one in full. Each operation's filter, update, document or pipeline is a JSON template, and values from the code go only where the template has a `{ "$param": "name" }` placeholder:

```json
{ "id": "orders", "protocol": "mongodb", "host": "{{settings.cluster}}", "srv": true, "database": "shop",
  "tls": true, "credential": "db_login", "authSource": "admin",
  "operations": [
    { "id": "by_status", "effect": "read", "collection": "orders", "op": "find",
      "filter": { "status": { "$param": "status" } }, "projection": { "_id": 0, "number": 1, "status": 1 },
      "sort": { "number": -1 }, "params": { "status": { "type": "string" } }, "maxRows": 20 },
    { "id": "ship", "effect": "write", "collection": "orders", "op": "updateOne",
      "filter": { "number": { "$param": "number" } }, "update": { "$set": { "status": "shipped" } },
      "params": { "number": { "type": "integer" } } }
  ] }
```

How NoSQL injection is ruled out:

- **Single values only.** A parameter is a string, integer, number, boolean, timestamp or `objectId` (24 hex characters), optionally `nullable`. A value can never be an object or a list, so input cannot turn into an operator such as `{ "$ne": null }` or `{ "$where": ... }`. In a pipeline, a string cannot start with `$`, where it would be read as a field path.
- **Checked when the manifest is saved.**
  - Operations that run JavaScript (`$where`, `$function`, `$accumulator`), write elsewhere (`$out`, `$merge`) or inspect the server (`$currentOp`, `$collStats` and others) are refused.
  - `$lookup` and `$unionWith` must name their collection literally.
  - A parameter cannot be a key or a regular expression.
  - Reads are `find`, `findOne`, `countDocuments` and `aggregate`. Writes are `insertOne`, `updateOne`, `updateMany`, `deleteOne` and `deleteMany`.
  - Updates use update operators only, and `updateMany` and `deleteMany` need a filter.
  - `system.*` collections are refused.
- **A read action runs only read operations.**
- **Limits.** `maxRows` defaults to 100 and can be at most 1,000. Results are capped at 2 MB, and every operation gets the step's time limit (`maxTimeMS`). Writes are not retried automatically.
- **Errors are codes**, as for SQL. The server's own message is never passed to the module.

**Connections.** MongoDB drivers connect to every server of a replica set that the deployment lists, including ones given as IP addresses. So all of the driver's connections go through a relay inside Dittoly that opens only connections to:

- the endpoint's host;
- servers in the same parent domain (`cluster0-shard-00-01.abcde.mongodb.net` for `cluster0.abcde.mongodb.net`);
- addresses the egress rules allow.

The relay accepts only its own one-time password. TLS runs end to end and is verified against each server's name.

**Atlas.** Use `"srv": true` with the cluster host from the Atlas connection string and no port. A host setting with pattern `**.mongodb.net` takes the cluster host, which has more than one label in front of the domain. Give the module a database user with only the roles its operations need.

Sandbox tests answer operations with made-up documents: `"calls": [{ "protocol": "mongodb", "query": "by_status", "rows": [{ "number": 1, "status": "new" }] }]`, or `{ "protocol": "mongodb", "query": "ship", "rowCount": 1 }`.

## Google service accounts and Firebase

Firebase and other Google APIs (Sheets, BigQuery, Cloud Storage) are reached over HTTPS with a credential whose placement is `google_service_account`:

```json
"credentials": [{ "id": "sa", "service": "firebase", "label": "Firebase service account", "hosts": ["firestore.googleapis.com"],
  "placement": { "type": "google_service_account", "scopes": ["https://www.googleapis.com/auth/datastore"] } }]
```

- The member stores the service account's **JSON key** (Google Cloud console: IAM & Admin → Service accounts → Keys) in their vault. The key is encrypted like every other secret.
- For each request, the broker signs a JWT with the key and exchanges it at Google's token endpoint (`https://oauth2.googleapis.com/token`, the OAuth 2.0 JWT bearer grant). It receives an access token that lasts about an hour and carries only the declared scopes, and sends it as a bearer token to the credential's hosts.
- The token endpoint is fixed, whatever the key file says. Tokens are cached in memory only, until a minute before they expire.
- The module code never sees the key or the tokens, and cannot call the token endpoint itself.
- Errors: `credential_invalid` (the stored secret is not a service account key), `credential_rejected` (Google refused it: deleted or disabled key, or a scope the account may not use), `google_token_unavailable` (Google's token endpoint is not answering).
- Sandbox tests use a dummy token. Nothing reaches Google.

| Firebase product | Host | Scopes |
| --- | --- | --- |
| Cloud Firestore | `firestore.googleapis.com` | `https://www.googleapis.com/auth/datastore` |
| Realtime Database | `<db>.firebaseio.com` or `<db>.<region>.firebasedatabase.app`, as a host setting with pattern `*.firebaseio.com` or `**.firebasedatabase.app` | `https://www.googleapis.com/auth/firebase.database`, `https://www.googleapis.com/auth/userinfo.email` |

These are the scopes Google's own libraries request: the Firestore client uses `datastore`, and the Firebase Admin SDK uses `firebase.database` with `userinfo.email` for the Realtime Database.

**Injection.** Firestore queries are JSON (`structuredQuery`), and input values go into it as typed values (`{ "stringValue": ... }`), never as query text. Ids put into a path are checked by the input schema and encoded with `encodeURIComponent`. The OWASP checks flag unencoded input in URLs.

**Security rules do not apply.** Firebase security rules do not apply to a service account. Give the account only the IAM roles its actions need, for example *Cloud Datastore Viewer* for a module that only reads.

---
name: module-protocols
description: The connections a Dittoly module may use besides HTTPS (SMTP, AMQP, MQTT, WebSocket, SSE, SQL databases, MongoDB) and what is not supported. Loaded when the AI builds or revises a module.
---
# Other protocols

OTHER PROTOCOLS: plain HTTPS (REST, GraphQL, SOAP, JSON-RPC) uses "hosts" and ctx.http.request. These other
connections must each be declared in "endpoints", and the code names the endpoint id, never an address:
- Email (SMTP, send only):
  { "id": "mail", "protocol": "smtp", "host": "{{settings.smtp_host}}", "tls": "starttls" | "implicit", "credential": "smtp_login", "from": "{{settings.sender}}" }
  await ctx.smtp.send({ endpoint: 'mail', to: [..] | 'a@b.c', cc?, bcc?, replyTo?, subject, text?, html? }) -> { accepted, rejected }
  The sender is fixed by the manifest ("from"), never by code. The credential uses placement basic.
- AMQP (e.g. RabbitMQ, publish only):
  { "id": "bus", "protocol": "amqp", "host": "...", "tls": true, "vhost": "/", "exchanges": ["orders"], "credential": "amqp_login" }
  await ctx.amqp.publish({ endpoint: 'bus', exchange: 'orders', routingKey: 'created', message: {..} | 'text', headers?, persistent? })
- MQTT (publish only, QoS 0 or 1):
  { "id": "iot", "protocol": "mqtt", "host": "...", "tls": true, "topics": ["devices/+/commands"], "credential": "mqtt_login" }
  await ctx.mqtt.publish({ endpoint: 'iot', topic: 'devices/pump-1/commands', message: {..}, qos?: 0 | 1, retain? })
- WebSocket (a bounded session: connect, send, collect replies, close):
  { "id": "feed", "protocol": "websocket", "host": "stream.example.com", "tls": true, "credential": "api_token" }
  await ctx.ws.exchange({ endpoint: 'feed', path: '/v1/stream?x=1', send: [{..}], maxMessages: 10, maxMs: 5000 }) -> { messages: [string], closed }
- Server-Sent Events (read a bounded number of events):
  { "id": "events", "protocol": "sse", "host": "api.example.com", "tls": true, "credential": "api_token" }
  await ctx.sse.read({ endpoint: 'events', path: '/events', maxEvents: 10, maxMs: 5000 }) -> { status, events: [{ event, data, id? }] }
- SQL databases: PostgreSQL (also Supabase), MySQL/MariaDB and Microsoft SQL Server, with FIXED queries only:
  { "id": "shop", "protocol": "postgres", "host": "{{settings.db_host}}", "database": "{{settings.db_name}}",
    "tls": true, "ca"?: "{{settings.db_ca}}", "credential": "db_login",
    "queries": [
      { "id": "find_order", "effect": "read", "sql": "SELECT id, status, total FROM orders WHERE id = :order_id",
        "params": { "order_id": { "type": "integer" } }, "maxRows": 1 },
      { "id": "mark_shipped", "effect": "write", "sql": "UPDATE orders SET status = 'shipped' WHERE id = :order_id",
        "params": { "order_id": { "type": "integer" } } } ] }
  MySQL/MariaDB is "protocol": "mysql", SQL Server is "protocol": "mssql"; the rest is the same.
  await ctx.db.query({ endpoint: 'shop', query: 'find_order', params: { order_id: input.order_id } }) -> { rows: [{..}], rowCount, truncated }
  The code never writes SQL: it picks a declared query and passes values, which are ALWAYS sent as bound parameters. Never
  build SQL from input; if the request needs a different filter or sort, declare another query. Write SQL as one plain
  statement with :name parameters (lower_snake_case, each declared in "params" with type string, integer, number, boolean
  or timestamp, "nullable": true when null is allowed). Parameters are values only: never table names, column names,
  ORDER BY directions or lists (write one query per sort order; for a list, one call per value). Rules the manifest
  check enforces: no comments, no ";" except at the end, no $1 / ? / @var placeholders, no Postgres E'...' or $$ strings,
  no backslashes or double-quoted strings in MySQL, no hex literals; "read" queries start with SELECT or WITH and run in
  a read-only transaction that is rolled back; "write" queries are one INSERT, UPDATE or DELETE, and UPDATE and DELETE
  need a WHERE; never CREATE, DROP, ALTER, TRUNCATE, GRANT, EXEC, CALL, COPY, LOAD, MERGE, SELECT INTO, locking reads, or
  functions that sleep, read files or run SQL text (pg_sleep, pg_read_file, dblink, sleep, benchmark, load_file,
  xp_cmdshell, sp_executesql...). List only the columns the actions need (no SELECT *), and keep maxRows (1-1000,
  default 100) as small as the action allows. The credential is placement "basic" ("username:password"); suggest a
  database user that may only do what the queries need. Use a host setting for the server, a text setting for the
  database name, and for a server whose certificate is signed by its own CA (Supabase: download it from the project's
  Database Settings, SSL Configuration) a "certificate" setting: { "id": "db_ca", "type": "certificate", "label": "Database CA certificate" }.
  Supabase is "postgres" (host db.<project-ref>.supabase.co:5432 or the pooler host, database "postgres").
- MongoDB (also Atlas), with FIXED operations only:
  { "id": "orders", "protocol": "mongodb", "host": "{{settings.cluster}}", "srv": true, "database": "shop", "tls": true,
    "credential": "db_login", "authSource"?: "admin",
    "operations": [
      { "id": "by_status", "effect": "read", "collection": "orders", "op": "find", "filter": { "status": { "$param": "status" } },
        "projection": { "_id": 0, "number": 1, "status": 1 }, "sort": { "number": -1 }, "params": { "status": { "type": "string" } }, "maxRows": 20 },
      { "id": "ship", "effect": "write", "collection": "orders", "op": "updateOne", "filter": { "number": { "$param": "number" } },
        "update": { "$set": { "status": "shipped" } }, "params": { "number": { "type": "integer" } } } ] }
  await ctx.db.query({ endpoint: 'orders', query: 'by_status', params: { status: input.status } }) -> { rows: [{..}], rowCount, truncated }
  Values go only where the template has { "$param": "name" }, and only as single values of the declared type (string,
  integer, number, boolean, timestamp, objectId for a 24-hex id; "nullable": true allows null), so input can never become an
  operator. Read ops: find, findOne, countDocuments, aggregate (pipeline of stages). Write ops: insertOne (document),
  updateOne / updateMany (update with operators such as $set, $inc, $push, $currentDate; optional "upsert"), deleteOne,
  deleteMany; updateMany and deleteMany need a filter. Never $where, $function, $accumulator, $out, $merge or server
  introspection stages; $lookup / $unionWith name their collection literally; a parameter cannot be a $regex or a key.
  In a pipeline a string value cannot start with "$". sort values are 1 or -1. Results: ids as 24-hex text, dates as ISO
  text. Atlas: "srv": true with the cluster host (cluster0.abcde.mongodb.net) and a host setting with pattern
  "**.mongodb.net"; the module may reach only servers in that cluster's domain. Use a database user with only the roles
  the operations need.
Endpoint hosts are host[:port] (default ports: SMTP 587/465, AMQP 5671, MQTT 8883, WebSocket/SSE 443, PostgreSQL 5432,
MySQL 3306, SQL Server 1433, MongoDB 27017; an "srv" host has no port) or a host setting.
A credential used by an endpoint lists that endpoint's host in its "hosts". Sending email or publishing only works in "write" actions.
Use a host setting for servers that differ per organization (an SMTP server almost always does), and a text setting for the sender.
Nothing else is supported: no IMAP/POP3, FTP/SFTP, SSH, raw TCP/UDP, gRPC, or other databases (Redis, Cassandra...)
over their own protocols. If the request needs one, use the
service's HTTPS API instead, or build what is possible and say what is missing in the action descriptions.
Sandbox tests may add "calls": [{ "protocol": "smtp"|"amqp"|"mqtt"|"websocket"|"sse"|"postgres"|"mysql"|"mssql"|"mongodb", "messages"?: [..], "events"?: [..],
"rejected"?: [..], "query"?: "find_order" (a query or operation id), "rows"?: [{..}], "rowCount"?: 1, "error"?: "code" }] (canned answers with made-up
values, used in order; a database answer may name the query it answers); without them sends succeed, streams return
nothing and queries return no rows. Database errors arrive as codes: db_timeout, db_login_failed, db_tls_failed,
db_duplicate, db_constraint, db_permission_denied, db_conflict, db_unreachable.

Limits:
- SMTP: 1-50 recipients, a subject on one line (up to 998 characters), text or html, 1 MB at most. SMTP, AMQP and MQTT
  credentials use placement "basic".
- AMQP: only the declared exchanges (up to 20), routing key up to 255 characters, 1 MB, up to 20 headers.
- MQTT: declared topic filters (up to 20); publish to a concrete topic (no + or #) that matches one, 256 KB at most.
- WebSocket and SSE: path starts with "/"; maxMs 100-30000; maxMessages and maxEvents 1-100; up to 20 sent
  messages of 64 KB each.
- Databases: up to 30 queries per endpoint, 10,000 characters of SQL each; string values up to 10,000 characters;
  results up to maxRows rows and 2 MB; each query has the step's time limit (15 s by default).
- Unencrypted connections are refused unless an admin allowed that host.

# Streaming audit events to a SIEM

Dittoly can send every audit event, as it happens, to your SIEM or log platform. Five kinds of destination are supported: Splunk, Datadog, any HTTPS collector, syslog over TLS and OpenTelemetry. Your security team then sees who changed, approved and ran what next to the rest of your logs, and can alert on it there.

Set it up on **Members & Access → Stream audit events to a SIEM** (org admins only). Adding, pausing, resuming and removing a stream are themselves audit events.

## What is sent

Each audit event, about a minute after it happens. Events are sent only after they are sealed into the [audit chain](governance.md#audit-log-and-audit-report):

```json
{
  "schema": "dittoly.audit/1",
  "id": "4182",
  "at": "2026-10-16T09:12:44.120Z",
  "atUs": "1792141964120412",
  "server": "https://dittoly.example.com",
  "action": "run.started",
  "outcome": "ok",
  "errorType": null,
  "actor": { "id": "…", "name": "maya@example.com" },
  "subject": { "type": "run", "id": "…", "name": "Release notes run" },
  "related": null,
  "summary": "maya@example.com run.started run Release notes run",
  "chain": { "hash": "9c1e…", "prevHash": "41aa…" }
}
```

- **Who, what, outcome:** the action (for example `flow.approved`, `run.started`, `breakglass.started`) and whether it was `ok`, `denied` or `failed`, with the error type when it failed.
- **Names next to the IDs:** the member's handle, and the name of the Flow, Flow version, run, team or module. Analysts can search for people and Flows without looking IDs up in Dittoly. This means members' handles (often their email addresses) are stored in your SIEM too.
- **Never** run inputs, outputs, app data, credentials or AI prompts. These are not in the audit log either.
- **Severity:** `ok` is info, `denied` is a warning and `failed` is an error. Each destination uses its own field for it.

## Destinations

| Destination | What you give | How it is sent |
|---|---|---|
| **Splunk** (HTTP Event Collector) | HEC address (for example `https://splunk.example.com:8088`, or your Splunk Cloud `http-inputs-…` address), HEC token, optional index and source type | `POST /services/collector/event` with `Authorization: Splunk <token>`. Events are sent in batches, each with `time`, `host`, `source=dittoly`, `sourcetype` (default `dittoly:audit`) and `index` if set. |
| **Datadog** (Logs API v2) | Your Datadog site (`datadoghq.com`, `datadoghq.eu`, `us3`, `us5`, `ap1`, `ap2`, `uk1`, `ddog-gov.com`, `us2.ddog-gov.com`), an API key, optional service and tags | `POST https://http-intake.logs.<site>/api/v2/logs` with `DD-API-KEY`, compressed. Each log has `ddsource=dittoly`, `service`, `status`, `ddtags` (your tags plus `action:` and `outcome:`), `message` (the summary) and the whole event under `dittoly`. |
| **HTTPS** (JSON lines) | Any https URL, optional auth header (name and value) | One JSON event per line (`application/x-ndjson`), signed with `X-Dittoly-Signature: sha256=<HMAC-SHA256 of the body>`, using a key shown once when the stream is added. `X-Dittoly-First-Event` and `X-Dittoly-Last-Event` give the batch's event IDs. Use it with Logstash, Fluent Bit, Vector, Cribl, Sumo Logic, Elastic Agent's HTTP input, or your own receiver. |
| **Syslog over TLS** | Host, port (default 6514), framing | RFC 5424 messages with facility 13 ("log audit"). APP-NAME is `dittoly`, MSGID is the action and the message is the JSON event. They go over TLS (RFC 5425) with octet counting, or one message per line if your receiver needs that. Use it for QRadar, ArcSight, Graylog, rsyslog/syslog-ng, or Microsoft Sentinel through its agent. |
| **OpenTelemetry** (OTLP/HTTP) | The collector address (`/v1/logs` is added when the address has no path), optional auth header | OTLP/HTTP with JSON encoding, compressed. Each log record has the summary as its body, a severity, `eventName=dittoly.audit` and the event as `dittoly.*` attributes. The resource has `service.name=dittoly`. Works with the OpenTelemetry Collector, Grafana, Elastic, New Relic, Honeycomb, and Datadog's and Splunk's OTLP intakes. |

Addresses must be https; syslog always uses TLS, and the server's certificate is checked. For a private certificate authority, start Dittoly with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. SIEMs on your internal network (private addresses) must be listed in `DITTOLY_INTERNAL_HOSTS`, like other internal hosts ([install.md](install.md)).

**Start with:** *new events from now on* (the default), or *the whole audit history, then new events*. Datadog accepts timestamps at most 18 hours old. Older events sent to Datadog are therefore dated when Datadog receives them, and their real time is kept in `dittoly.at`.

## Nothing missed, nothing changed

- **In order, from a saved position.** Each stream remembers the last event it delivered and continues after it, so a restart or an outage never skips events.
- **When the SIEM is down,** Dittoly keeps the position and tries again after 30 seconds, then waits longer each time, up to 15 minutes. Admins are told once when a stream starts failing, both in the portal and by email if it is set up. Each failure and recovery is recorded in the audit log, and everything missed is sent once the SIEM is back. The card shows each stream's state: up to date, how many events are waiting, or failing since when and why.
- **At least once.** After a crash in the middle of a send, the same batch can arrive twice. Each event has its `id`, so you can drop repeats.
- **Checkable in the SIEM.** Each event carries its audit-chain hash and the hash before it. Export the events from your SIEM, as JSON lines or a JSON array (Splunk's and Datadog's export shapes are understood), and run:

  ```
  npm run audit:verify-export -- export.ndjson
  ```

  It checks that each event matches its hash and follows from the one before. A changed, removed or inserted event is reported, and the command exits with 1. It needs nothing from the Dittoly server. Names (handles, Flow names) are not covered by the hash; IDs, times, actions and outcomes are.

**Send a test event** on the card sends one event, `audit.stream_test`, with the ID `0`. It checks the address and the credentials without moving the stream's position.

## Evidence

The stream is evidence of monitoring for SOC 2 CC7.2 and ISO/IEC 27001:2022 A.8.15 (Logging) and A.8.16 (Monitoring activities): the audit log is kept outside Dittoly, and changes to the stream are themselves recorded. As with the rest of the evidence mapping, whether a control is met depends on your whole organization.

## API

`GET /api/admin/audit-streams`, `POST /api/admin/audit-streams` (`{kind: 'splunk' | 'datadog' | 'https' | 'syslog' | 'otlp', name, startFrom?: 'now' | 'all', …}`: Splunk `url, token, index?, sourcetype?`; Datadog `site, apiKey, service?, tags?`; HTTPS and OTLP `url, headerName?, headerValue?`; syslog `host, port?, framing?: 'octet' | 'newline'`), `PATCH /api/admin/audit-streams/:id` (`{enabled}`), `DELETE /api/admin/audit-streams/:id`, `POST /api/admin/audit-streams/:id/test`. Tokens, keys and header values are stored encrypted and never returned.

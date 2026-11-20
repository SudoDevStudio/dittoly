# Flow URLs

A Flow URL lets another system start a Flow: a CI pipeline, a script, a scheduler or another app. Each URL is unique and has its own token. The caller sends the token in the `x-sflow-token` header.

To create one, open an approved Flow and use **Flow URLs** → **Create URL**. You can make several per Flow, for example one per calling system, so you can revoke one without breaking the others.

## Calling it

```sh
curl -X POST 'https://dittoly.example.com/sflow/<id>' \
  -H 'x-sflow-token: sflow_…' \
  -H 'content-type: application/json' \
  -d '{"release": "2.4"}'
```

- The body is the Flow's inputs as a JSON object. Leave out the body, or send `{}`, when the Flow takes no inputs.
- The answer is `202` with `{ runId, status, statusUrl }`. The call does not wait for the run: runs can take a long time, for example an approval gate or a browser check.
- To follow the run, GET `statusUrl` with the same header. The answer contains:
  - the run's `status`, plus `waitReason` while it waits;
  - each step's `status`, `errorType` and `output`.
- A URL can only read the runs it started.

| Answer | Meaning |
|---|---|
| `401 invalid_token` | The token is missing or wrong, or the URL does not exist. These cases look the same to the caller on purpose. |
| `400 invalid_inputs` | The inputs do not match the Flow's input schema; `detail` says which. |
| `403 endpoint_disabled` | The URL was turned off. Status checks still work. |
| `410 endpoint_expired` | The URL has passed its expiry date. |
| `409 flow_version_not_approved` | The pinned version was replaced or lost its approval. |
| `409 no_approved_version` | A URL that follows the latest version, while no version is approved. |
| `403 not_in_team` | The URL's creator is no longer in the Flow's team. |
| `429 rate_limited` | Too many calls. The limit is 60 per minute per URL by default. |

## Any JSON, with no mapping

Without a body mapping, a Flow URL accepts any JSON. When the body is not exactly the Flow's inputs:

- a Flow with **one input** gets the whole body there: as is for an input with no `type` or of type object (a Flow
  that takes any JSON, e.g. `"inputs": {"type": "object", "properties": {"payload": {}}}`), as JSON text for a text
  input, as a one-item list for a list input;
- a Flow with **several inputs**: each takes the field of the same name, wherever it is in the body (`stack` from
  `error.stack`; the exact name first, then any casing). Other fields are ignored. A required input found nowhere
  still gives `400 invalid_inputs`;
- a Flow with **no inputs** runs with none.

The error-to-fix template for Node.js takes one `payload` input, so a sender posts whatever it has. A body mapping, when
set, decides instead.

## Mapping a sender's own JSON

Some systems send their own JSON and cannot be told to send the Flow's inputs: an error reporter, a monitoring tool, a
form service. Without a mapping their call fails with `400 invalid_inputs` (for example `eventId: is not an input of
this Flow`).

Open the URL and choose **Map the request body**. For each input of the Flow, write the field of the posted JSON it
comes from:

| Write | Takes |
|---|---|
| `summary` | the body's `summary` field |
| `errors/0/message` | the `message` of the first item of `errors` |
| `*` | the whole body (for an input of type object) |

- An input left empty gets nothing.
- Fields of the body that are not mapped are ignored.
- The token and the URL stay the same, and the Flow's input checks still apply: a mapped field missing from the body
  leaves its input missing.
- **Remove mapping** makes the body the Flow's inputs again.

Through the API, `inputMap` is a JSON Pointer per input (`{"text": "/summary"}`, `""` for the whole body), as for
webhook triggers. Set it with `POST /api/flows/:id/endpoints` or `PATCH /api/endpoints/:id`; `null` removes it. Only
inputs the Flow version has are accepted (`400 unknown_flow_input` lists them).

## Whose run it is

Every run started through a URL belongs to the member who made the URL and uses their own access, exactly like their schedules and webhooks. The audit log records which URL started each run.

So anyone holding the token can start that Flow as you. A URL can never do more than you could yourself:
- the version must be approved;
- you must still be in the Flow's team;
- the inputs are checked against the Flow's schema.

## Version: pinned or latest

- **Only version N:** the URL runs that exact approved version. When the Flow changes, the URL stops starting runs until you make a new one.
- **Always the latest approved version:** calls run whichever version is approved at the time. Each new version still needs an approver first. While a new version waits for approval, no version is approved, so calls answer `409 no_approved_version`.

## Tokens

- A token looks like `sflow_` followed by 43 characters (256 random bits).
- It is shown once, when you create or rotate it. Only its SHA-256 hash is stored.
- **Rotate token** issues a new one. By default the old one stops working at once. Tick *keep the old token working for 24 hours* to give callers time to switch.
- **Disable** turns the URL off without deleting it.
- **Delete** removes it; callers get `401`.
- **Expires** (optional) stops the URL at a set time.
- Only the URL's creator and admins can see, rotate, disable or delete it.

## Management API (signed in)

| | |
|---|---|
| `GET /api/flows/:flowId/endpoints` | Your URLs for a Flow (admins see everyone's). |
| `POST /api/flows/:flowId/endpoints` | `{name, followLatest: true}` or `{name, versionId}`, plus optional `expiresAt` (ISO 8601) and `rateLimitPerMinute` (1–600). Answers `201` with the URL and its `token`. |
| `POST /api/endpoints/:id/rotate` | `{overlapSeconds?}` (0 to 7 days). Answers with the new `token`. |
| `PATCH /api/endpoints/:id` | `{enabled?, expiresAt?, inputMap?}`. Use `expiresAt: null` to remove the expiry, `inputMap: null` to remove the body mapping. |
| `DELETE /api/endpoints/:id` | Delete the URL. |

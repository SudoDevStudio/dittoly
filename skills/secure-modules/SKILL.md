---
name: secure-modules
description: OWASP Top 10 (2025) rules every generated module follows, and the automatic checks that look for them. Loaded when the AI builds or revises a module.
---
# Security rules (OWASP Top 10, 2025)

Every module you write follows these rules. The sandbox and broker enforce the hard limits; the module review also runs
automatic checks named "OWASP A01" to "OWASP A10" and shows them to the admin. A hard-coded secret fails the review; the
other checks are warnings, but they are not ignored: whatever they find is sent straight back to you with the draft to
fix before anybody reviews it, and the finding count per model is kept and compared. Write the module so they find
nothing the first time.

- A01 Broken Access Control (includes server-side request forgery): call only declared hosts and endpoints. Never take a
  host, full URL or endpoint from the input; take ids and build the path yourself. Never put "../" in a path. A read
  action never changes data.
- A02 Security Misconfiguration: always https and encrypted endpoints ("tls": true). Never turn certificate checks off;
  for a server signed by its own CA, declare a "certificate" setting.
- A03 Software Supply Chain Failures: modules are self-contained: no import, require or code loaded from elsewhere.
- A04 Cryptographic Failures: never put a secret, password, API key, token or private key in the code, the manifest, a
  URL or a test. Declare a credential; the runtime attaches the member's own. Tests use made-up values only. Do not use
  Math.random() for anything others must not guess.
- A05 Injection: validate every input with a tight JSON Schema (pattern, enum, maxLength, minimum/maximum,
  additionalProperties false). Encode values put into a URL with encodeURIComponent. Send data as JSON bodies, not
  hand-built strings. Databases use fixed queries with bound :name parameters only, never SQL built from input. Do not
  put input into email HTML without escaping &, <, >, " and '.
- A06 Insecure Design: keep each action to one task and the smallest permissions (fewest credentials, read when it only
  reads, small maxRows). Every write action has a test that expects bad input to be refused (expectOk false).
- A07 Authentication Failures: never set an Authorization header or put keys in a URL; use a credential placement.
  Ask for the narrowest token scopes and list them in "scopes".
- A08 Software or Data Integrity Failures: never eval, new Function or run code from text. Check the shape of what an
  app returns before using it, and fail with an ActionError when it is not what you expected.
- A09 Security Logging and Alerting Failures: do not use console.*; personal data and secrets must not reach logs. Fail
  with ctx.ActionError and a short code (e.g. "jira_404"), never with the app's raw message or the input.
- A10 Mishandling of Exceptional Conditions: check res.ok or res.status after every request; never swallow errors with an
  empty catch or .catch(() => {}); a write that may have failed half-way fails, it does not report success. Mark only
  temporary failures (429, 5xx, timeouts) as retryable.

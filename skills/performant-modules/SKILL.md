---
name: performant-modules
description: Performance rules every generated module follows (fewest calls, batching, pagination caps, small outputs, efficient queries), and the automatic checks that look for them. Loaded when the AI builds or revises a module.
---
# Performance rules

Correctness and security come first. Keep actions small and bounded; verify cost with sandbox tests.
Automatic Performance P1-P9 checks flag these patterns, and what they find comes back to you with the draft to fix
before anybody reviews it (the count per model is kept and compared), so write it so they find nothing:

- The easiest correct action is usually the fastest: one documented endpoint that returns exactly what is needed.
- Look up by exact key (id, name, branch, filter parameters on a list endpoint) rather than a full-text search API,
  which has tight limits (query length, operators, a lower rate limit) and fails on names the token cannot see. Use
  search only when no exact lookup exists, and keep the query short.
- Minimize calls: prefer filtered list and bulk endpoints. Avoid sequential independent requests in loops (P1); preserve order for dependent operations.
- Batch independent calls at most 5 at a time; no unbounded fan-out (P2). Respect service rate limits.
- Bound input arrays with maxItems (P8) and long strings with maxLength. Stay within 50 calls and 60 seconds per action.
- Filter, select fields, sort and limit at the service. Cap pagination by pages or caller limit; return truncated=true when more results remain (P3).
- Return only needed fields and bounded text/lists, not whole responses (P5).
- No sleeps or retry loops (P4). Throw retryable ctx.ActionError for 429/5xx; Dittoly schedules retries.
- Parse responses once; no JSON stringify/parse deep copies (P6). Use Map/Set for repeated lookups. Module load only defines constants/functions.
- Query explicit columns, indexed filters, ORDER BY and LIMIT/TOP/FETCH FIRST; never SELECT * (P7). Keep maxRows small, including MongoDB. Batch supported operations instead of querying per row.
- Tests use the expected minimum calls; cover a second page for paginated actions. More than 10 calls triggers P9. Claim improvements only with observed call counts or measurements.

---
name: api-design
description: MANDATORY when designing a new endpoint, API surface, request/response contract, error shape, webhook, or versioning scheme — REST or gRPC. Contains resource/method semantics, the single error envelope rule, cursor-vs-offset pagination, idempotency for POST, backward-compatibility laws, and contract-first artifacts.
---

# API Design

An API is a promise other people build on for years. Design it once, deliberately; consistency with the repo's existing surface beats your personal taste (recon the existing endpoints first — mirror their conventions unless the task is to change them).

## Resources & methods
- Nouns for resources (`/orders/{id}/items`), not verbs; actions that don't fit CRUD → sub-resource verbs used sparingly and consistently (`POST /orders/{id}/cancel`).
- Method semantics are contracts: GET safe+idempotent (NEVER state-changing), PUT full-replace idempotent, PATCH partial, DELETE idempotent (second delete → 404 or 204, pick one repo-wide), POST the only non-idempotent one — see idempotency below.
- Status codes honest: 400 malformed, 401 unauthenticated, 403 unauthorized, 404 absent-or-hidden (use for cross-tenant to avoid existence leaks), 409 conflict, 422 valid-shape-invalid-content, 429 with Retry-After. A 500 on bad input is a bug.

## ONE error envelope, repo-wide
```json
{"error": {"code": "order_not_cancellable", "message": "human sentence",
           "details": [{"field": "items[2].qty", "code": "min", "message": "..."}]}}
```
- `code` machine-readable, stable, documented — clients branch on it, never on `message`.
- Validation failures list ALL field errors at once (422), not first-error-only.
- Never leak internals: stack traces, SQL, provider payloads stay in logs (skill://observability-instrumentation).

## Pagination — cursor over offset
Offset breaks under concurrent writes (rows shift → duplicates/gaps) and is O(n) deep. Default to cursor:
```json
{"data": [...], "next_cursor": "opaque-string-or-null", "has_more": true}
```
Cursor is OPAQUE (encode sort key + id; sign/encode it) — clients never parse it. Document the sort; `limit` capped server-side.

## Idempotency
- Naturally idempotent methods stay that way.
- Effectful POST (payments, sends, orders): accept `Idempotency-Key` header; same key → replay the stored original response; same key + different body → 422. Implementation per skill://concurrency-correctness.

## Compatibility laws (breaking = a new consumer contract)
SAFE: adding optional request fields, adding response fields, adding endpoints/enum values (only if consumers were told to tolerate unknowns — say so in the contract).
BREAKING: removing/renaming fields, type changes, semantic changes to an existing field (the worst — never repurpose), tightening validation, changing error codes clients branch on, changing defaults.
Process for breaking: additive replacement → deprecation window (header/docs + telemetry on old-field usage) → removal only at zero observed usage or the announced date. Version (URL `/v2` or header) only when additive evolution truly can't work — a version is a fork you maintain.

## Conventions that prevent whole bug classes
- Datetimes: RFC3339 UTC strings, always. Money: integer minor units + currency code, never floats (skill://database-craft).
- IDs: opaque strings from day one (never expose auto-increment ints — enumeration + coupling).
- Field naming: match the repo (choose camelCase or snake_case once); booleans as `is_*`/`has_*`.
- Every input validated at the edge against a schema (zod/joi/protovalidate/pydantic) → the 422 envelope; limits documented (payload size, array lengths, rate limits, timeout).

## Contract-first artifacts
The OpenAPI/proto file is the source of truth: written/updated in the SAME change as the code, types generated from it where the repo supports it (drift = the contract lying). Review the contract diff like code — it IS the public API.

## Webhooks you emit
Signed payloads (HMAC + timestamp, documented verification), event `id` for consumer dedup, at-least-once delivery declared, retry schedule documented, versioned event types.

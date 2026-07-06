---
name: observability-instrumentation
description: Use when adding logging, metrics, tracing, or any instrumentation; when asked to "add logs"; and for every risk-lane change that needs a how-will-we-know-it-broke answer before shipping. Contains log-level semantics, structured-logging rules, the never-log list (PII/secrets), log-once-at-handling, RED metrics with the cardinality trap, and the one-metric-to-watch rule for risky deploys.
---

# Observability & Instrumentation

Instrument for the 3am debugger (possibly you) who has ONLY these signals and no debugger. Every log line answers: what happened, to which entity, in which request.

## Log levels — semantics, not vibes
- ERROR — broken AND needs action; a page-worthy event. If nobody should wake up, it's not ERROR.
- WARN — degraded but self-handled: retry succeeded, fallback used, deprecated path hit.
- INFO — state changes and lifecycle: request completed (status, duration), order created, migration ran, config loaded.
- DEBUG — flow detail for diagnosis; off in prod by default; safe to enable (no secrets even here).
Symptom of misuse: ERROR logs nobody reacts to → alarm fatigue → the real one gets ignored.

## Structured, correlated
- JSON logs with STABLE snake_case keys: `{"level":"info","msg":"order_created","order_id":"o_9","tenant_id":"t_1","duration_ms":42,"request_id":"r_abc"}` — `msg` is a stable event name (greppable), details live in fields, never interpolated into prose.
- request_id/trace_id generated (or accepted) at the edge and propagated through EVERY log line and downstream call — one id reconstructs the whole request. Use the repo's context mechanism (AsyncLocalStorage, context.Context, contextvars); don't hand-thread it.

## The never-log list
Passwords, tokens, API keys, session/cookies, full Authorization headers, card/bank data, national ids, full request/response bodies of sensitive endpoints, precise geolocation. Emails/names per the repo's privacy stance — when in doubt, log the id, not the value. Redact structurally (serializer-level denylist), not by remembering at each call site. Error objects can smuggle secrets via config in their context — sanitize before logging.

## Log ONCE, at the handling site
An error is logged where it is HANDLED, with full context — not at every layer it bubbles through (5 stack traces for 1 failure buries the signal). Layers that can't handle it: enrich and rethrow (wrap with context), don't log-and-rethrow. And never log-and-swallow: a caught exception is either handled (logged once, flow continues by design) or propagated.

## Metrics — RED per endpoint/operation
- Rate (requests/s), Errors (count by code class), Duration (histogram — p50/p95/p99, never just mean).
- Naming: `http_request_duration_seconds{route="/orders/:id",method="GET",status="2xx"}` — the ROUTE PATTERN, never the raw path.
- CARDINALITY TRAP: labels multiply series — user ids, order ids, emails, raw URLs NEVER go in labels. High-cardinality detail belongs in logs/traces, not metrics.
- Business counters for the flows that matter: `orders_created_total`, `payments_failed_total{reason}` — these catch what HTTP metrics can't (200s that did the wrong thing).
- Queues/jobs: depth, processing duration, failure count, DLQ size, oldest-message age.

## Traces
Span per inbound request and per external call (DB, HTTP, queue) with the ids as attributes; propagate context (W3C traceparent) to downstream services — a trace that dies at your service boundary is half a trace.

## For risky changes — define detection BEFORE shipping
Answer in the plan/claim: "How will we know within minutes if this broke in prod?" → name the ONE metric or log query + the threshold ("`payments_failed_total{reason="gateway"}` > 5/min", "`msg:order_created` rate drops >50%"). If the change has no observable signal, ADD the instrumentation as part of the change — an unobservable risky change is not shippable. Pair with the rollback note: signal fires → the documented rollback path (skill://migration-upgrade, skill://incident-response).

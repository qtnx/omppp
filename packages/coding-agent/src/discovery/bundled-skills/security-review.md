---
name: security-review
description: MANDATORY when the diff or task touches authentication, authorization, permissions, login, sessions, tokens, user input handling, file uploads, query building, crypto, secrets, or when asked for a security review. Contains the per-object IDOR check, injection hunting by sink type, the blessed-crypto table per language, upload rules, and the uniform-error/enumeration rules.
---

# Security Review

Work the entry points: enumerate every input the change accepts (path/query params, body fields, headers, cookies, file uploads, webhook payloads) — each one is attacker-controlled until proven otherwise.

## Authorization — the #1 real-world hole
- AuthN ≠ AuthZ. "User is logged in" says nothing about whether THIS user may touch THIS object.
- IDOR check: every id-like parameter (`/orders/:id`, `?userId=`, body ids) MUST be verified against the caller's ownership/tenancy — in the query itself where possible: `WHERE id = $1 AND tenant_id = $2`, not fetch-then-compare (and never fetch-then-forget).
- Deny by default: new routes require an explicit permission declaration; a route that "forgot" middleware must fail closed, not open — verify the framework's default.
- Privilege escalation: can a request body set `role`, `isAdmin`, `tenantId`? Allowlist writable fields (never spread the raw body into an update).
- State-changing GETs are CSRF food; mutations go through POST/PUT/DELETE with the repo's CSRF protection where sessions are cookie-based.

## Injection — hunt by sink
- SQL: parameterized queries ONLY; string-built SQL is banned even inside ORMs (`raw()`, `$queryRawUnsafe`, string `WHERE`). Identifier interpolation (table/column names) → allowlist map, never user input.
- Shell: no string interpolation into commands — exec with argument ARRAYS (`execFile`, `subprocess.run([...])`); if a shell is truly required, the input doesn't go in it.
- Path: user-influenced paths → resolve to absolute, then verify the result still has the intended base directory as prefix; reject `..` before AND after normalization.
- HTML/XSS: framework auto-escaping stays on; every `dangerouslySetInnerHTML`/`v-html`/`innerHTML` needs sanitization (DOMPurify-class) and a justification; user content never into inline event handlers or `javascript:` URLs.
- SSRF: user-supplied URLs your server fetches → allowlist schemes+hosts; block private ranges (127.0.0.0/8, 169.254.169.254, 10/8, 172.16/12, 192.168/16) AFTER DNS resolution; no redirects-follow into internal space.
- Deserialization: never deserialize untrusted data with formats that execute (pickle, unrestricted YAML load, Java native) — JSON + schema validation.

## Secrets
- Env only; never in code, logs, error messages, or URLs. Grep the diff: `grep -rnE "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][A-Za-z0-9]"`.
- Committed secret → ROTATE it (history rewrite is cleanup, not remediation).
- Tokens: generated with CSPRNG (`crypto.randomBytes`, `secrets`), compared timing-safe (`crypto.timingSafeEqual`, `hmac.compare_digest`).

## Crypto — never roll your own; the blessed table
- Passwords: argon2id (preferred) or bcrypt — Node `argon2`/`bcrypt`, Go `golang.org/x/crypto/argon2|bcrypt`, Rust `argon2`, Python `argon2-cffi`/`bcrypt`. NEVER a bare hash (md5/sha*) even salted.
- Symmetric: AES-256-GCM / XChaCha20-Poly1305 via the stdlib/libsodium — with random nonce per message, never reused.
- JWTs: pin the algorithm server-side (reject `alg` from the token), short expiry, verify on EVERY request; `none` is an attack, not an option.
- Randomness for anything security-relevant: CSPRNG only — `Math.random()`/`rand()` are banned in that context.

## Uploads
Validate by content (magic bytes), not extension/Content-Type; enforce size limits at the edge; store outside the webroot with server-generated random names; images: re-encode; never execute/include from the upload directory.

## Auth flows — enumeration & abuse
- Uniform errors: login/reset responses identical for "no such user" vs "wrong password" (message AND timing where feasible).
- Rate limit login, reset, signup, and OTP endpoints; lockout/backoff on failures.
- Session fixation: rotate session id on login; invalidate on logout and password change.

## Output — findings format
Same as skill://code-review-lens: `[BLOCKER|SHOULD] file:line — problem; Scenario: concrete attack sequence; Fix: specific`. A security finding without an attack scenario is a question, not a finding. Verify exploitability where cheap (curl the IDOR with another user's token — per skill://verify-before-done) rather than speculating.

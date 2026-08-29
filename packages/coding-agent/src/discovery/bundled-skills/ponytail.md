---
name: ponytail
description: Use when designing an implementation plan, writing code, assigning code-writing work to the main agent or a subagent, choosing an implementation approach, or reviewing a proposed diff for over-engineering, unnecessary dependencies, boilerplate, or speculative scope; also use when the user asks for a minimal, simplest, shortest, YAGNI, or "do less" solution. Read-only investigation and architecture research alone do not trigger it.
license: MIT
---

# Ponytail

Ponytail is minimality guidance for planning and coding. Be lazy about the
solution, never lazy about understanding, correctness, safety, or the user's
explicit scope. The smallest correct diff wins; code golf, partial delivery,
and symptom fixes do not.

**Attribution:** Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT licensed.

## Activation

Use this skill **before implementation-plan design** and **before writing code**
by the main agent or any subagent. Every code-writing assignment MUST tell its
owner to read Ponytail and apply its planning and coding checkpoints. Read-only
investigation and architecture research are exempt; the moment the owner will
write code, the requirement applies.

## The seven-rung ladder

After reading the task and tracing the real flow, stop at the first rung that
solves the requested problem:

1. **Need at all?** Skip speculative or unrequested work; preserve every explicit requirement.
2. **Existing code?** Reuse the established helper, type, pattern, or path; do not reimplement nearby behavior.
3. **Standard library?** Prefer the language/runtime standard library.
4. **Native platform?** Prefer a built-in platform, browser, database, or runtime capability.
5. **Installed dependency?** Use an existing dependency before adding one.
6. **One line?** Use a one-line solution when it remains clear and correct.
7. **Minimum working code.** Only then add the smallest implementation that fully works.

The ladder shortens implementation, never comprehension. Read the code the
change touches, identify callers and boundaries, and understand the end-to-end
flow before choosing a rung. If two options are equally small, choose the one
with stronger edge-case correctness.

## Planning checkpoint

Before locking an implementation plan, challenge every proposed:

- file and production-code change: is it necessary for the requested behavior?
- abstraction, helper, interface, or layer: is there a second real use now?
- configuration value or surface: does a real consumer need it now?
- dependency: does an existing or native option fail a demonstrated requirement?
- shim, compatibility path, fallback, or copied implementation: can callers use the canonical path instead?
- phase or task: does it land executable requested capability, or is it speculative scaffolding?

Delete what cannot defend its necessity. Do not use minimality to remove
validation, data-loss handling, security, accessibility, explicit requirements,
understanding, or runnable checks.

## Coding checkpoint

While implementing:

- Reuse existing code, then standard-library, native-platform, and installed-dependency capabilities in that order.
- Fix shared root causes at the canonical path; do not patch only the reported caller.
- Prefer deletion and a clean cutover over parallel legacy paths, aliases, shims, or dead branches.
- Keep the full requested scope, including error handling, data integrity, tests, harnesses, and required edge cases.
- Do not add abstractions, configuration, dependencies, scaffolding, or polish "for later."
- If a deliberate simplification has a real known ceiling, mark it with a `ponytail:` comment naming the ceiling and upgrade path; never hide a correctness limitation.

Minimality is not permission to ship an MVP, defer an explicit requirement, or
replace a runnable check with confidence. A non-trivial branch, loop, parser,
data path, security path, or other behavior change keeps the smallest check
that would catch its failure.

## Non-negotiable boundaries

Never simplify away:

- trust-boundary validation or authorization;
- error handling that prevents data loss or corruption;
- security controls, privacy boundaries, or auditability;
- accessibility basics and required user-visible states;
- explicit user requirements, public contracts, or compatibility obligations;
- tests and runnable verification required to prove the changed behavior.

When the user requests the full version, build the full version without
re-arguing for a smaller scope. Question only speculative additions outside the
request.

## Red flags

Stop and reconsider if the proposed diff includes:

- a new dependency where native, standard-library, or existing code works;
- a wrapper, factory, interface, config knob, or phase with one consumer;
- copied logic beside a helper that already owns the behavior;
- a compatibility shim after all internal callers can migrate;
- a guard at a symptom site instead of the shared root cause;
- omitted validation, error paths, security, accessibility, data handling, tests, or a requested requirement in the name of "minimality."

The goal is not the fewest tokens. It is the fewest necessary moving parts in a
correct, complete, maintainable solution.

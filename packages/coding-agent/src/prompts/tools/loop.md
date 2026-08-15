Schedule a self-contained prompt to re-run as follow-up turns every `interval`, `count` times. Iteration 1 is queued immediately; later iterations arrive as ordinary follow-up messages so you can apply judgment each cycle.

## When to use

Recurring checks, monitoring, or iterative refinement that needs agent judgment on every pass (re-read CI, re-probe a flaky service, tighten a design every N minutes). For one-shot background shell/subagent work use `job` instead — loops are conversational turns, not background processes.

## Parameters

- `prompt`: self-contained instruction delivered verbatim each iteration. Must not start with `/`.
- `interval`: cadence after the first fire — `"10s"`, `"5m"`, `"1h"`, or bare seconds (e.g. `"30"`). Minimum 10s.
- `count`: total iterations including the immediate first one (1–100).

Example:

```json
{"prompt":"Re-check CI status and report only if anything failed or is still running.","interval":"10m","count":5}
```

## Semantics

- Iteration 1 fires immediately (no full-interval wait); iterations 2..N fire every `interval`.
- Each iteration is a fresh follow-up turn with header `[loop <id> · <i>/<count>] <prompt>`.
- Stops after `count` iterations or when the session ends/resets (all loops cancelled).
- Use `/loop list` to inspect active agent loops; `/loop stop <id>` cancels one (`/loop cancel <id>` is an alias), and `/loop stop all` cancels every active agent loop (`/loop cancel all` is an alias).

## Anti-patterns

WRONG: `{"interval":"1s","count":100}` — hot loop burns turns; use a realistic cadence (≥10s).
RIGHT: `{"interval":"5m","count":12}` — check every five minutes for an hour.

WRONG: prompt that assumes prior-turn memory ("continue from where you left off").
RIGHT: self-contained prompt that restates the goal and success criteria each iteration.

WRONG: using `loop` for a long shell build — that is `job` / `bash`.
RIGHT: use `loop` only when each tick needs model judgment on fresh state.

<critical>
- Iteration 1 is immediate; do not "warm up" with a separate call.
- Prompt must be self-contained — each tick is a new follow-up turn.
- Use `/loop list` to inspect active agent loops; `/loop stop <id>` cancels one, and `/loop stop all` cancels every active agent loop. `/loop cancel` is an alias for `/loop stop`.
- Never use intervals under 10s or prompts that start with `/`.
- Prefer `job` for fire-and-forget background work without per-tick judgment.
</critical>

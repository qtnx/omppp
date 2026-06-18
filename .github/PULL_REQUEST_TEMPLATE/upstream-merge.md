## Summary
Merged upstream/main into OMPx fork (2026-06-18).

Conflicts resolved preferring OMPx features.

## Upstream additions accepted
- ArkType migration (schemas for all tools)
- `model.loopGuard.enabled` / `checkAssistantContent`
- `omp ttsr` (Time-Traveling Stream Rules CLI + builtins)
- PDF image reads via `read <pdf>:<image>.png`
- `startup.showSplash`, `app.retry` (Alt+R)
- Perplexity Responses streaming + OpenRouter fallback
- LaTeX math, Mermaid, advisory, Emacs Lisp tree-sitter

## OMPx features kept (via --ours where conflicted)
- Task delegation contract: `# Target`, `# Change`, `# Acceptance`, `# Done` (prohibited to omit)
- `delegation.reminder.enabled` + `threshold`
- `task.eager` (boolean, default `true`)
- `display.syntaxHighlighting`
- Codex guards, prewarm, snapcompact
- Browser `annotate` (focus/queue/toolbar)
- `snapcompact.*`, IRC, sandbox
- Subagent batch/hub, robomp, session-stats, worktree support

## How resolved
- `--ours` on OMPx core paths
- `--theirs` on upstream-only
- Manual on shared (settings, prompts, packages)
- Clean merge (0 unmerged files/markers)

## Verification
- `task.eager` + reminder present as OMPx
- Delegation contract language in `task.md` + system prompt
- OMPx dirs (python/robomp, scripts/session-stats) intact
- Browser annotate impl
- Upstream features (loopGuard, ttsr, ArkType) integrated

See commit e7ee8abfc.

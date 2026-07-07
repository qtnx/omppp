---
name: git-craft
description: Use for commits, PRs, rebases, merge conflicts, history archaeology, recovering from git mistakes, splitting mixed changes, and isolating parallel subagents with worktrees. Contains atomic-commit discipline, rescue recipes (reflog, bad rebase, lost work), conflict-resolution protocol, worktree-per-agent setup, and the hard safety rules for destructive operations.
---

# Git Craft

## Atomic commits
- One logical change per commit; it builds and passes tests on its own. Mixed work staged? Split it: `git add -p` (stage hunks interactively), `git restore --staged <file>` to pull pieces back out.
- Message: imperative subject ≤72 chars ("Add rate limit to login"), blank line, body = WHY and what alternatives were rejected — the diff already shows WHAT.
- Refactor and behavior change never share a commit (skill://refactoring-safely). Generated files (lockfiles, codegen) in their own commit or clearly separated.

## PR description = evidence, not vibes
```
WHAT: <one paragraph>
WHY: <problem/ticket>
VERIFIED: <command → output; entry-point probe + state, per skill://verify-before-done>
RISKS: <what could break, blast radius, rollback note>
OUT OF SCOPE: <explicitly not done + why>
```

## Rescue recipes
- "I lost work" → `git reflog` shows every HEAD position for ~90 days: find the sha, `git branch rescue <sha>` or `git reset --hard <sha>` (see safety rules). Uncommitted-but-staged content: `git fsck --lost-found`.
- Bad rebase/merge → `git reflog`, reset the branch to the pre-rebase entry (`branch@{1}` right after), redo calmly.
- Deleted branch → `git reflog | grep <name>` → `git branch <name> <sha>`.
- Committed to wrong branch → `git branch correct-branch` (bookmark it), then reset the wrong branch back: `git reset --hard HEAD~N`.
- Amend ONLY unpushed commits; after pushing, fix-forward with a new commit, or if the branch is exclusively yours: `git push --force-with-lease` (never bare `--force`; lease aborts if someone else pushed meanwhile).
- Undo a pushed commit on shared history → `git revert <sha>`, never rewrite.

## Merge conflicts — protocol, not panic
1. Understand BOTH sides before touching markers: `git log --merge -p <file>` (the competing commits), `git blame` for intent.
2. Resolve by reconstructing the intended combined behavior — never by picking a side because it makes markers go away, and never keep both blocks blindly.
3. Watch for semantic conflicts git can't see: both sides compile after resolution but a renamed function from side A is still called by side B's new code — build + run affected tests after EVERY conflict resolution, before continuing the rebase.
4. Lockfile conflicts: don't hand-merge JSON — take either side, re-run the package manager to regenerate.

## Worktrees — physical isolation for parallel subagents
Ownership rules on paper still break on shared working trees (lockfiles, generated files, formatters). One worktree per work package:
```bash
git worktree add ../wt-pkg1 -b agent/pkg1     # per package; dispatch agent with cwd=../wt-pkg1
git worktree list                              # inventory
# integrate SERIALLY: merge each agent/pkgN, run gates between merges
git worktree remove ../wt-pkg1 && git branch -d agent/pkg1   # teardown, always
```

## Archaeology
- Regression hunting: `git bisect run <repro-cmd>` (skill://bug-hunting).
- Who/why for a line: `git log -L 42,60:src/f.ts` (history of a range), `git blame -w -C` (ignore whitespace, follow copies).
- When did this string appear/vanish: `git log -S "someSymbol" --oneline`.

## Hard safety rules
- `push --force-with-lease` only, only on branches exclusively yours; NEVER rewrite shared history.
- `reset --hard`, `clean -fd`, branch deletion, history rewrites = irreversible tier: confirm intent (or ask the user) before running; check `git status` for unsaved work first — this is one of the sanctioned uses of status.
- Never `git add .` blindly — review what's staged; scratch files, VERIFY-TEMP leftovers, and secrets ride in on lazy adds. `git diff --cached` before every commit of consequence.
- Secrets committed → rotating the secret is the fix; history rewriting is cleanup, not remediation.

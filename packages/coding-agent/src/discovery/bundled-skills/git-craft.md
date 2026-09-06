---
name: git-craft
description: Git flows (feature/hotfix/release/sync), commits, PRs/MRs, merge conflicts incl. parallel resolution, rescues, worktrees. Contains the repo-flow discovery step (base branch, PR/MR host, gates, merge style, tag pattern), flow formulas, atomic-commit discipline, rescue recipes (reflog, bad rebase, lost work), the conflict-resolution protocol with a quick_task fanout contract, worktree-per-agent setup, and the hard safety rules for destructive operations.
---

# Git Craft

## Step 0 — discover the repo's flow before branching
Every repo has its own flow; the generic `gitFlow` only says WHICH steps exist. Fill in the repo-specific values FIRST and treat a user-named value as LOCKED:

`repoGitFlow := base=<branch> · naming=<pattern> · publish=<PR|MR|none> · gates=<CI job names> · merge=<squash|merge|rebase> · release=<tag pattern + changelog> · protected=<branches>`

Read the signals with tools, in this order; stop as soon as the value is known:
```bash
git status --porcelain && git branch --show-current && git remote -v      # where am I, what is dirty (peers' work stays)
git symbolic-ref refs/remotes/origin/HEAD                                # default branch
git branch -r                                                            # inspect remote branches with repository tools
git log --oneline -15 --first-parent origin/<base>                        # merge style: "Merge pull request" vs squash vs rebase
git log -n 20 --format=%s                                       # commit convention (conventional commits? ticket prefix?)
git for-each-ref --sort=-v:refname --count=5 refs/tags          # tag pattern (v1.2.3, 2026.09.02, service/v3)
# Inspect `.github/workflows`, `.gitlab-ci.yml`, `.github/pull_request_template.md`, `CONTRIBUTING.md`, and `CHANGELOG*` with repository read tools.
```
- `AGENTS.md`/`CONTRIBUTING.md`/PR template outrank inference. A repo `repoGitFlow` line (e.g. root `AGENTS.md`) is the answer; do not re-derive it.
- Host decides the verbs: `github.com` remote → `gh pr …`; `gitlab` remote → `glab mr …`; neither → push and report the branch.
- User said "checkout from origin production" / "branch off origin/main" → that exact ref, fetched fresh (`git fetch origin production && git switch -c <name> origin/production`), never a local stale branch and never a substitute you consider better.
- Unknown base AND the choice is hard to reverse (hotfix target, release branch) → ask ONE question with the candidates you found. Unknown base for ordinary feature work → the default branch, stated in the report.

## Flow formulas
`gitFlow := preflight → isolate → sync → change → verify → commit → publish → CI/review → merge → post-merge verify`

- `preflight`: the Step 0 commands; record dirty paths that are not yours (peers' work: never touched).
- `isolate`: new branch per `naming` from a FRESH remote ref (`git fetch origin <base>`; branch from `origin/<base>`). Needs a clean tree? Own worktree: `git worktree add ../wt-<name> origin/<base>`.
- `sync`: `git fetch --prune`; integrate only the authorized base with the repo's `merge` style (rebase your unpushed branch; merge into shared ones); never rewrite shared history.
- `change → verify`: one logical diff; the repo's own focused gates for touched paths (skill://verify-before-done for the evidence shape).
- `commit`: only when requested or authorized; stage explicit paths; message in the repo's convention.
- `publish`: `git push -u origin <branch>`; open ONE PR/MR to the LOCKED target with the evidence template below; update that PR, never open a second.
- `CI/review`: wait for checks on the CURRENT head (`gh pr checks <n> --watch` / `glab mr ci view`); a red job is yours to read (`gh run view <id> --log-failed`) and fix-forward, then re-wait. A stale green on an older sha is not green.
- `merge`: only when authorized; use the repo's `merge` style (`gh pr merge --squash|--merge|--rebase`). Never merge past a required review or a red required check.
- `post-merge verify`: `git fetch origin <target> && git log -1 origin/<target>` shows the merge commit (`gh pr view <n> --json mergeCommit`); CI on the target head is green; deploy/release state matches what the repo promises for that branch.

Concrete flows (each is `gitFlow` with values filled in):

| Flow | base | publish target | extra steps |
|---|---|---|---|
| `feature` | `origin/<default>` | `<default>` | none |
| `hotfix` | `origin/<production\|release-x.y>` (LOCKED by repo or user) | same branch | smallest possible diff; after merge: `tag` per pattern if the repo tags hotfixes; **forward-port** to `<default>`/`develop` (cherry-pick or merge, per repo) and verify BOTH heads; report both PR links |
| `release` | `origin/<develop\|default>` → `release/x.y` or direct | `<production\|main>` | bump version + changelog in the repo's own files; annotated tag `git tag -a vX.Y.Z -m "…" <merged sha>` and `git push origin vX.Y.Z` only after the merge commit exists; verify the tag points at the merged head and any release workflow ran |
| `sync-upstream` | fork `<default>` in its OWN worktree | `origin` PR | `git fetch upstream`; merge (never rebase a shared branch) `upstream/<default>`; conflict protocol below; push to `origin` only |
| `backport` | `origin/<release-x.y>` | that branch | `git cherry-pick -x <sha>`; conflicts via protocol; never re-implement by hand when a cherry-pick applies |

`done(git) := unmerged=0 ∧ markers=0 ∧ every dropped hunk named ∧ diffstat audited against both parents ∧ focused gates pass ∧ exact merged head verified ∧ current-head CI/review green ∧ release/deploy state observed`

## Atomic commits
- One logical change per commit; it builds and passes tests on its own. Mixed work staged? Split it: `git add -p` (stage hunks interactively), `git restore --staged <file>` to pull pieces back out.
- Message: imperative subject ≤72 chars ("Add rate limit to login"), blank line, body = WHY and what alternatives were rejected — the diff already shows WHAT. Follow the repo's convention from Step 0 (conventional commits, ticket prefix).
- Refactor and behavior change never share a commit (skill://refactoring-safely). Generated files (lockfiles, codegen) in their own commit or clearly separated.

## PR/MR description = evidence, not vibes
```
WHAT: <one paragraph>
WHY: <problem/ticket>
VERIFIED: <command → output; entry-point probe + state, per skill://verify-before-done>
RISKS: <what could break, blast radius, rollback note>
OUT OF SCOPE: <explicitly not done + why>
```
Use the repo's PR template when one exists; fold the block above into its sections.

## Rescue recipes
- "I lost work" → `git reflog` shows every HEAD position for ~90 days: find the sha, `git branch rescue <sha>` (safe) before any reset. Uncommitted-but-staged content: `git fsck --lost-found`.
- Bad rebase/merge → `git reflog`, reset the branch to the pre-rebase entry (`branch@{1}` right after), redo calmly — in a tree that is exclusively yours (safety rules).
- Deleted branch → inspect `git reflog` with repository tools, then `git branch <name> <sha>`.
- Committed to wrong branch → `git branch correct-branch` (bookmark it), then reset the wrong branch back: `git reset --hard HEAD~N` (own tree only).
- Amend ONLY unpushed commits; after pushing, fix-forward with a new commit, or if the branch is exclusively yours: `git push --force-with-lease` (never bare `--force`; lease aborts if someone else pushed meanwhile).
- Undo a pushed commit on shared history → `git revert <sha>`, never rewrite.

## Merge conflicts — protocol, not panic
1. Freeze evidence before touching anything:
   ```bash
   git status --porcelain                              # peers' dirty paths → untouchable
   git diff --name-only --diff-filter=U                # CF := conflicted paths
   git merge-base HEAD MERGE_HEAD   # or REBASE_HEAD / CHERRY_PICK_HEAD
   git diff --diff-filter=U --stat                     # size per file → triage
   ```
2. Understand BOTH sides per file: `git log --merge --oneline -- <f>` (competing commits), `git diff <base>..HEAD -- <f>` (ours intent), `git diff <base>..MERGE_HEAD -- <f>` (theirs intent), `git show :1:<f>` / `:2:<f>` / `:3:<f>` (base / ours / theirs full content). `git checkout --conflict=diff3 <f>` rewrites the markers with the base block when it helps.
3. Resolve by reconstructing the intended combined behavior — never by picking a side because it makes markers go away, and never keep both blocks blindly. `resolve(f) := semantic merge(O,T)` preserving both intents.
4. Ledger every dropped hunk: `f:hunk → O intent | T intent | resolution | dropped? reason (duplicate/obsolete only)`. No row, no drop.
5. Semantic conflicts git can't see: both sides compile after resolution but a renamed function from side A is still called by side B's new code — build/typecheck + the affected tests after the WHOLE pass, before `--continue`.
6. Lockfile/generated conflicts: don't hand-merge — take either side, re-run the package manager / generator, and commit the regenerated file.
7. Rebase with many commits stops once per commit; for a heavy sync prefer ONE merge (one conflict pass) over N rebase stops unless the repo mandates rebase.

## Parallel conflict resolution — quick_task fanout, safe and fast
`heavyConflict := freeze → triage → cluster → ONE batch of quick_task resolvers → parent integrate → gates → continue`

Trigger: more than ~5 conflicted files or more than ~150 conflict lines after lockfiles/generated files are removed from the count. Below that, resolve serially yourself: dispatch overhead exceeds the work.

**Triage (parent, 1–2 minutes):**
- `generated/lockfile` → parent regenerates; never a child.
- `trivial` (whitespace, adjacent independent additions, one side only touched imports) → parent resolves inline while children run.
- `semantic` → child work. Group by shared symbol/contract, not by directory: two files that conflict over the same renamed function or changed signature form ONE cluster, because the resolver must decide the contract once. Cluster caps for `quick_task`: ≤3 files and ≤150 conflict lines; larger clusters go to `task`.
- Decide shared contracts BEFORE dispatch and write them as LOCKED in the batch `context` (e.g. `LOCKED: parseConfig(path, {strict}) is the final signature (theirs); ours callers adapt`). A child never decides a contract two clusters depend on.

**Why parallel children in the same worktree are safe:** the conflict state lives in the index; each child edits ONLY its owned conflicted files and stages ONLY those paths. Disjoint paths + per-file edit lock + no child ever running a state-changing git command = no interference. The parent is the only process that runs `--continue`, `commit`, or anything that touches the index beyond `git add <owned file>`.

**Child contract (assignment-fmt, one per cluster; dispatch ALL clusters in ONE `tasks[]` batch, `max_runtime_seconds: 300`):**
```
# Target
Resolve merge conflicts in: <f1>, <f2> (Owns: exactly these). Forbidden: any other file, any git command except `git show :N:<f>`, `git diff`, `git log`, `git add <owned file>`. NEVER `checkout --ours/--theirs`, `reset`, `stash`, `commit`, `merge/rebase --continue`.
# Pointers (no rediscovery)
base/ours/theirs: `git show :1:<f>` / `:2:<f>` / `:3:<f>`. Ours intent: <commit subjects from git log --merge -- f>. Theirs intent: <same>. Decisive hunk pasted: <the conflicting block with diff3 markers>.
# Change
Produce the merged file preserving BOTH intents. LOCKED contract: <signature/schema final form>. Keep every hunk unless duplicate/obsolete; do not reformat untouched lines.
# Acceptance
1. Use the repository `grep` tool to search `^(<{7}|={7}|>{7})` in `<f>` → no output.
2. `<repo typecheck command>` → no errors in owned files. Use the command documented by the repository; never substitute a different compiler or runner.
3. `git add <f1> <f2>` → `git diff --name-only --diff-filter=U` no longer lists them.
# Done
Yield immediately after Acceptance. Report per hunk: `f:hunk → O intent | T intent | resolution | dropped? reason`. BLOCKED (do not guess) when: on-disk contract differs from LOCKED; a correct merge needs a file you do not own; both sides deleted/renamed the same symbol differently.
```

**Parent integrate (after the batch settles):**
1. `git diff --name-only --diff-filter=U` → empty; use the repository `grep` tool to search `^(<{7}|={7}|>{7})` across the tree → empty.
2. Regenerate lockfiles/generated files; stage them.
3. Read every child ledger; any dropped hunk without a duplicate/obsolete reason goes back to that child (one round) or is restored by you.
4. ONE build/typecheck for the whole tree, then focused tests for every module a cluster touched; a semantic conflict found here is a targeted fix, not a re-fanout.
5. `git diff --stat <base>..HEAD` and `git diff --stat <base>..MERGE_HEAD` vs the resolved diff: every file changed on either side still appears; a missing file is data loss.
6. `git merge --continue` / `git rebase --continue` / `git cherry-pick --continue`, then the normal `verify → publish → CI` steps.

Report shape: `CF=<n> files · parent=<k> trivial + generated · children=<m> clusters (quick_task) · dropped hunks=<list or none> · gates: <cmd → result>`.

## Worktrees — physical isolation for parallel subagents
Ownership rules on paper still break on shared working trees (lockfiles, generated files, formatters). One worktree per work package:
```bash
git worktree add ../wt-pkg1 -b agent/pkg1 origin/<base>   # per package; dispatch agent with cwd=../wt-pkg1
git worktree list                                          # inventory
# integrate SERIALLY: merge each agent/pkgN, run gates between merges
git worktree remove ../wt-pkg1 && git branch -d agent/pkg1 # teardown, always
```
Conflict resolvers are the exception: they share the parent's worktree on purpose (the conflict state is in its index) and are safe because they own disjoint paths and run no state-changing git commands.

## Archaeology
- Regression hunting: `git bisect run <repro-cmd>` (skill://bug-hunting).
- Who/why for a line: `git log -L 42,60:src/f.ts` (history of a range), `git blame -w -C` (ignore whitespace, follow copies).
- When did this string appear/vanish: `git log -S "someSymbol" --oneline`.

## Hard safety rules
- `push --force-with-lease` only, only on branches exclusively yours; NEVER rewrite shared history.
- ALWAYS assume other agents are editing the same working tree. `reset` (any mode), `checkout -- .`, `restore`, `stash`, `clean`, branch deletion, history rewrites = irreversible tier: run `git status --porcelain` FIRST (a sanctioned use of status); any entry you did not write is a peer's uncommitted work and the command is forbidden. A merge, rebase, or cherry-pick that needs a clean tree runs in its own `git worktree add ../wt-<name> <base>`, never by cleaning the shared tree.
- Never `git add .` / `-A` blindly — review what's staged; scratch files, VERIFY-TEMP leftovers, and secrets ride in on lazy adds. `git diff --cached` before every commit of consequence.
- Merge, tag, and release only with explicit authorization; a green CI is a precondition, not permission.
- Secrets committed → rotating the secret is the fix; history rewriting is cleanup, not remediation.

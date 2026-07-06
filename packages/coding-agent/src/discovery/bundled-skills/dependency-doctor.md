---
name: dependency-doctor
description: MANDATORY when adding, installing, upgrading, or debugging dependencies — package installs, version conflicts, lockfile changes, peer-dependency errors, CVE patches, or ANY time you are about to use a library API from memory. Contains rule zero (read the INSTALLED version's API, never trust training memory), the adoption checklist, npm/pnpm/yarn differences, Python env rules, and conflict-surgery commands.
---

# Dependency Doctor

## Rule zero — read the INSTALLED version, never memory
Your memory of a library may describe a different major. Before using any non-trivial API:
- Confirm the installed version: `cat node_modules/<pkg>/package.json | jq .version` · `go list -m <mod>` · `cargo tree | grep <crate>` · `pip show <pkg>`.
- Read THAT version's surface: `node_modules/<pkg>/` README + `.d.ts` files (the types are the truth) · `go doc <pkg>.<Symbol>` · docs.rs/<crate>/<exact-version> · `python -c "import x; help(x.f)"`.
- Version-sensitive details (config shape, breaking renames): the installed changelog `node_modules/<pkg>/CHANGELOG.md` beats web docs describing latest.
Hallucinated APIs from the wrong major are the single most common agent-introduced bug. When a call errors with "not a function"/"unexpected keyword": suspect version mismatch FIRST.

## Adding a dependency = adopting its maintenance
Checklist before `install`:
1. Does the stdlib or an EXISTING dep already do this? (`jq .dependencies package.json` — search it.)
2. Health: recent releases, open-issue triage, weekly downloads — a dead lib is future you's problem.
3. Cost: bundle/binary size (`npx bundlephobia-cli <pkg>` mentality), transitive tree size (`npm ls <pkg> --all | wc -l`).
4. License compatible with the project.
5. Pin per the repo's convention; lockfile committed in the same change.

## Package-manager specifics (JS)
- Identify the manager by lockfile: `package-lock.json`=npm, `pnpm-lock.yaml`=pnpm, `yarn.lock`=yarn. NEVER mix — use the repo's, via `corepack enable` if pinned in `packageManager`.
- `npm ci` (not `install`) for reproducing the lockfile exactly.
- pnpm is strict (no phantom deps): code importing an undeclared transitive dep breaks — the fix is declaring it, not switching managers.
- Force a transitive version (CVE patch): npm `"overrides"`, yarn `"resolutions"`, pnpm `pnpm.overrides` — always with a comment WHY and the removal condition.
- Peer-dep error decoding: the message names WHO wants WHAT range — satisfy it by aligning the host package's version; `--legacy-peer-deps`/`--force` is deferring the explosion, not fixing it.

## Python
- Always a project env: `uv venv`/`python -m venv .venv`; NEVER global pip. Respect the repo's tool (uv/poetry/pip-tools) and its lockfile.
- `pip install package` without freezing = unreproducible; changes go through the repo's manifest + lock.

## Go / Rust
- Go: `go mod tidy` after changes; `go mod why <mod>` and `go mod graph | grep <mod>` for "why is this here"; toolchain line pins the compiler.
- Rust: `cargo tree -i <crate>` (inverse: who pulls it in); feature flags are half of every "missing method" mystery — check which features the repo enables.

## Conflict surgery — understand the tree before overriding
1. Why does it resolve this way: `npm ls <pkg>` / `pnpm why <pkg>` / `yarn why` / `cargo tree -i` / `go mod graph | grep`.
2. Prefer aligning the requesters (upgrade the host that demands the old range).
3. Override/resolution only as last resort, commented, and VERIFIED at runtime — a forced version that installs cleanly can still explode at the call site. Run the affected flow per skill://verify-before-done.

## CVE patching
`npm audit` / `pnpm audit` / `cargo audit` / `pip-audit` → identify the vulnerable path → bump the direct dep if a fixed release exists, else override the transitive → re-run audit to confirm clean → run the gates; a security bump is still an upgrade (majors → skill://migration-upgrade).

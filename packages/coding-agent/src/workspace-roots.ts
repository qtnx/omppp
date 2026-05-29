/**
 * Multi-root workspace resolution.
 *
 * Turns CLI flags (`--be`, `--fe`, `--worktree`, `--add-dir`) into a set of
 * tagged {@link WorkspaceRoot}s plus the primary cwd the session should adopt:
 *
 *   - `--be <repo>` / `--fe <repo>` resolve a git repo and (unless
 *     `--no-worktree`) create an isolated worktree on a fresh `omp/<name>`
 *     branch checked out from the repo's origin default branch. The user's main
 *     checkout is never touched, so a dirty tree is safe. Worktrees live under
 *     `~/.omp/wt/` and are cleanable via `omp worktree clear`.
 *   - `--add-dir <path>` tags an existing directory by its basename. No
 *     worktree is created.
 *
 * The first repo root (`--be` before `--fe`) becomes the primary cwd; if only
 * `--add-dir`s are given, the first one is primary. Roots are surfaced to the
 * model in the system prompt so it knows which directory plays which role.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreeDir, hashPath, logger } from "@oh-my-pi/pi-utils";
import type { Args } from "./cli/args";
import { generateTaskName } from "./task/name-generator";
import { expandTilde } from "./tools/path-utils";
import * as git from "./utils/git";
import { buildWorkspaceTree } from "./workspace-tree";

/** A tagged working directory the session is aware of. */
export interface WorkspaceRoot {
	/** Semantic label: "be", "fe", or the directory basename for `--add-dir`. */
	tag: string;
	/** Absolute path (the worktree path when one was created). */
	path: string;
	/** Repository root the worktree was derived from (repo-tagged roots only). */
	sourceRepo?: string;
	/** Branch checked out in this root, when known. */
	branch?: string;
	/** True for the session's primary cwd. */
	primary: boolean;
	/** Pre-rendered bounded directory tree (non-primary roots only). */
	tree?: string;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findWorkspaceRootForPath(
	inputPath: string,
	workspaceRoots: readonly WorkspaceRoot[] | undefined,
): WorkspaceRoot | null {
	if (!workspaceRoots || workspaceRoots.length === 0) return null;
	const resolvedPath = path.resolve(inputPath);
	let bestMatch: WorkspaceRoot | null = null;
	let bestLength = -1;
	for (const root of workspaceRoots) {
		const rootPath = path.resolve(root.path);
		if (!isPathWithinRoot(rootPath, resolvedPath)) continue;
		if (rootPath.length <= bestLength) continue;
		bestMatch = root;
		bestLength = rootPath.length;
	}
	return bestMatch;
}

/**
 * Resolve a user/model-facing workspace-root reference.
 *
 * Supported forms:
 * - `be` / `@be` -> root path
 * - `be/` / `@be/` -> root path
 * - `be/src/file.ts` / `@be/src/file.ts` -> path inside that root
 *
 * Traversal that escapes the tagged root is rejected.
 */
export function resolveWorkspaceRootReference(
	input: string,
	workspaceRoots: readonly WorkspaceRoot[] | undefined,
): string | null {
	if (!workspaceRoots || workspaceRoots.length === 0) return null;
	const normalizedInput = input.startsWith("@") ? input.slice(1) : input;
	const slashIndex = normalizedInput.indexOf("/");
	const tag = slashIndex === -1 ? normalizedInput : normalizedInput.slice(0, slashIndex);
	if (tag.length === 0) return null;
	const root = workspaceRoots.find(candidate => candidate.tag === tag);
	if (!root) return null;
	const rootPath = path.resolve(root.path);
	const suffix = slashIndex === -1 ? "" : normalizedInput.slice(slashIndex + 1);
	if (suffix.length === 0) return rootPath;
	const candidatePath = path.resolve(rootPath, suffix);
	if (!isPathWithinRoot(rootPath, candidatePath)) return null;
	return candidatePath;
}

export interface ResolveWorkspaceRootsResult {
	roots: WorkspaceRoot[];
	/** Directory the session should chdir into, or null to keep the current cwd. */
	primaryCwd: string | null;
	/** Human-readable warnings to surface to the user (non-fatal). */
	notices: string[];
}

/** Bound the per-root workspace scan so startup stays responsive. */
const ROOT_TREE_TIMEOUT_MS = 2000;

/** Convert a worktree name into an fs-/ref-safe slug. */
function slugify(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return slug || "wt";
}

/** Pick a tag that does not collide with an already-registered root. */
function uniqueTag(base: string, roots: WorkspaceRoot[]): string {
	const candidate = base || "dir";
	if (!roots.some(root => root.tag === candidate)) return candidate;
	let n = 2;
	while (roots.some(root => root.tag === `${candidate}-${n}`)) n++;
	return `${candidate}-${n}`;
}

/**
 * Determine the start point for a new worktree branch. Prefers the repo's
 * origin default branch (fetched best-effort), falling back to the local
 * default branch, then HEAD.
 */
async function resolveStartPoint(repoRoot: string, tag: string, notices: string[]): Promise<string> {
	const defaultBranch = await git.branch.default(repoRoot).catch(() => null);
	const remotes = await git.remote.list(repoRoot).catch(() => [] as string[]);
	if (defaultBranch && remotes.includes("origin")) {
		try {
			await git.fetch(repoRoot, "origin", `refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`);
		} catch (err) {
			notices.push(`--${tag}: could not fetch origin/${defaultBranch} (${errText(err)}); using local state.`);
		}
		if (await git.ref.exists(repoRoot, `refs/remotes/origin/${defaultBranch}`).catch(() => false)) {
			return `origin/${defaultBranch}`;
		}
	}
	if (defaultBranch && (await git.ref.exists(repoRoot, `refs/heads/${defaultBranch}`).catch(() => false))) {
		return defaultBranch;
	}
	notices.push(`--${tag}: default branch not found; branching off current HEAD.`);
	return "HEAD";
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Resolve a repo-tagged root, creating an isolated worktree on a fresh branch. */
async function createRepoWorktree(
	input: string,
	tag: string,
	worktreeName: string,
	primary: boolean,
	notices: string[],
): Promise<WorkspaceRoot | null> {
	const resolved = path.resolve(expandTilde(input));
	const repoRoot =
		(await git.repo.primaryRoot(resolved).catch(() => null)) ?? (await git.repo.root(resolved).catch(() => null));
	if (!repoRoot) {
		notices.push(`--${tag}: ${resolved} is not a git repository; skipping.`);
		return null;
	}

	const branch = `omp/${slugify(worktreeName)}`;
	const branchRef = `refs/heads/${branch}`;
	const worktreePath = getWorktreeDir(`${slugify(worktreeName)}-${hashPath(repoRoot)}`);

	return git.withRepoLock(repoRoot, async () => {
		// Reuse an existing worktree for this branch (idempotent across runs).
		const existing = await git.worktree.list(repoRoot).catch(() => []);
		const reused = existing.find(entry => entry.branch === branchRef || entry.path === worktreePath);
		if (reused) {
			return { tag, path: reused.path, sourceRepo: repoRoot, branch, primary };
		}

		const branchExists = await git.ref.exists(repoRoot, branchRef).catch(() => false);
		try {
			await fs.mkdir(path.dirname(worktreePath), { recursive: true });
			if (branchExists) {
				// Branch already present but not checked out anywhere — attach it.
				await git.worktree.add(repoRoot, worktreePath, branch);
			} else {
				const startPoint = await resolveStartPoint(repoRoot, tag, notices);
				await git.worktree.add(repoRoot, worktreePath, branch, { newBranch: true, startPoint });
			}
		} catch (err) {
			notices.push(`--${tag}: failed to create worktree (${errText(err)}); using repo checkout in place.`);
			const current = (await git.branch.current(repoRoot).catch(() => null)) ?? undefined;
			return { tag, path: repoRoot, sourceRepo: repoRoot, branch: current, primary };
		}

		const finalPath = await fs.realpath(worktreePath).catch(() => worktreePath);
		return { tag, path: finalPath, sourceRepo: repoRoot, branch, primary };
	});
}

/** Tag a repo in place (no worktree) — used with `--no-worktree`. */
async function tagRepoInPlace(
	input: string,
	tag: string,
	primary: boolean,
	notices: string[],
): Promise<WorkspaceRoot | null> {
	const resolved = path.resolve(expandTilde(input));
	const repoRoot = await git.repo.root(resolved).catch(() => null);
	if (!repoRoot) {
		notices.push(`--${tag}: ${resolved} is not a git repository; skipping.`);
		return null;
	}
	const branch = (await git.branch.current(repoRoot).catch(() => null)) ?? undefined;
	return { tag, path: repoRoot, sourceRepo: repoRoot, branch, primary };
}

/**
 * Resolve all CLI-supplied working directories into tagged roots. Returns an
 * empty result (no-op) when no relevant flags were passed.
 */
export async function resolveWorkspaceRoots(parsed: Args): Promise<ResolveWorkspaceRootsResult> {
	const notices: string[] = [];
	const repoSpecs: Array<{ tag: string; input: string }> = [];
	if (parsed.be) repoSpecs.push({ tag: "be", input: parsed.be });
	if (parsed.fe) repoSpecs.push({ tag: "fe", input: parsed.fe });
	const addDirs = parsed.addDirs ?? [];

	if (repoSpecs.length === 0 && addDirs.length === 0) {
		return { roots: [], primaryCwd: null, notices };
	}

	const worktreeName =
		typeof parsed.worktree === "string" && parsed.worktree.trim().length > 0
			? parsed.worktree.trim()
			: generateTaskName();

	const roots: WorkspaceRoot[] = [];
	const seenPaths = new Set<string>();

	const pushRoot = (root: WorkspaceRoot | null): void => {
		if (!root) return;
		const key = path.resolve(root.path);
		if (seenPaths.has(key)) return;
		seenPaths.add(key);
		roots.push(root);
	};

	for (const spec of repoSpecs) {
		const primary = roots.length === 0;
		const root = parsed.noWorktree
			? await tagRepoInPlace(spec.input, spec.tag, primary, notices)
			: await createRepoWorktree(spec.input, spec.tag, worktreeName, primary, notices);
		pushRoot(root);
	}

	for (const dir of addDirs) {
		const resolved = path.resolve(expandTilde(dir));
		const stat = await fs.stat(resolved).catch(() => null);
		if (!stat?.isDirectory()) {
			notices.push(`--add-dir: ${resolved} is not a directory; skipping.`);
			continue;
		}
		pushRoot({ tag: uniqueTag(path.basename(resolved), roots), path: resolved, primary: roots.length === 0 });
	}

	// Build bounded trees for non-primary roots so the model sees their layout.
	// The primary root's tree is already rendered as the main <workspace-tree>.
	await Promise.all(
		roots
			.filter(root => !root.primary)
			.map(async root => {
				try {
					const tree = await buildWorkspaceTree(root.path, { timeoutMs: ROOT_TREE_TIMEOUT_MS });
					root.tree = tree.rendered || undefined;
				} catch (err) {
					logger.debug("Failed to build workspace tree for root", { path: root.path, error: errText(err) });
				}
			}),
	);

	const primary = roots.find(root => root.primary) ?? null;
	return { roots, primaryCwd: primary?.path ?? null, notices };
}

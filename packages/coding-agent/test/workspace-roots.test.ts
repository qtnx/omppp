import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { parseArgs } from "../src/cli/args";
import { buildSystemPrompt } from "../src/system-prompt";
import * as git from "../src/utils/git";
import type { WorkspaceRoot } from "../src/workspace-roots";
import { resolveWorkspaceRoots } from "../src/workspace-roots";

afterEach(() => {
	vi.restoreAllMocks();
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wsr-"));
	try {
		return await run(await fs.realpath(dir));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/** Initialize a git repo at `dir` with one commit on `main`. Returns the repo path. */
async function initRepo(dir: string, file = "README.md"): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	await $`git init -q -b main`.cwd(dir).quiet();
	await $`git config user.email test@example.com`.cwd(dir).quiet();
	await $`git config user.name Test`.cwd(dir).quiet();
	await Bun.write(path.join(dir, file), "seed\n");
	await $`git add -A`.cwd(dir).quiet();
	await $`git commit -q -m init`.cwd(dir).quiet();
	return dir;
}

/** Clone `origin` (bare) into `dest` so origin/HEAD is recorded. */
async function cloneRepo(origin: string, dest: string): Promise<string> {
	await $`git clone -q ${origin} ${dest}`.quiet();
	await $`git config user.email test@example.com`.cwd(dest).quiet();
	await $`git config user.name Test`.cwd(dest).quiet();
	return dest;
}

/** Redirect agent worktree dirs into `wtRoot` so tests never touch real ~/.omp. */
function redirectWorktrees(wtRoot: string): void {
	vi.spyOn(piUtils, "getWorktreeDir").mockImplementation((segment: string) => path.join(wtRoot, segment));
}

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

describe("parseArgs — workspace flags", () => {
	test("parses --be/--fe/--worktree as a named worktree", () => {
		const args = parseArgs(["--be", "/srv/api", "--fe", "/srv/web", "--worktree", "feature-x"]);
		expect(args.be).toBe("/srv/api");
		expect(args.fe).toBe("/srv/web");
		expect(args.worktree).toBe("feature-x");
	});

	test("--worktree without a value resolves to auto (true)", () => {
		expect(parseArgs(["--be", "/srv/api", "--worktree"]).worktree).toBe(true);
	});

	test("--worktree followed by a flag does not consume the flag", () => {
		const args = parseArgs(["--worktree", "--model", "opus"]);
		expect(args.worktree).toBe(true);
		expect(args.model).toBe("opus");
	});

	test("-w is an alias for --worktree", () => {
		expect(parseArgs(["-w", "quick"]).worktree).toBe("quick");
	});

	test("--add-dir is repeatable and order-preserving", () => {
		expect(parseArgs(["--add-dir", "/a", "--add-dir", "/b"]).addDirs).toEqual(["/a", "/b"]);
	});

	test("--no-worktree is captured", () => {
		expect(parseArgs(["--no-worktree", "--be", "/srv/api"]).noWorktree).toBe(true);
	});
});

describe("git.worktree.add — newBranch", () => {
	test("creates a new branch at the start point in a fresh worktree", async () => {
		await withTempDir(async dir => {
			const repo = await initRepo(path.join(dir, "repo"));
			const wt = path.join(dir, "wt");

			await git.worktree.add(repo, wt, "feature", { newBranch: true, startPoint: "HEAD" });

			expect(await git.branch.list(repo)).toContain("feature");
			expect(await git.branch.current(wt)).toBe("feature");
			expect(await Bun.file(path.join(wt, "README.md")).text()).toBe("seed\n");
		});
	});
});

describe("resolveWorkspaceRoots — no-op", () => {
	test("returns empty result when no workspace flags are set", async () => {
		const result = await resolveWorkspaceRoots(parseArgs(["just", "a", "message"]));
		expect(result).toEqual({ roots: [], primaryCwd: null, notices: [] });
	});
});

describe("resolveWorkspaceRoots — --add-dir tagging", () => {
	test("tags existing dirs by basename, marks the first primary, dedupes name collisions", async () => {
		await withTempDir(async dir => {
			const api = path.join(dir, "api");
			const web = path.join(dir, "web");
			const nestedApi = path.join(dir, "nested", "api");
			await fs.mkdir(api, { recursive: true });
			await fs.mkdir(web, { recursive: true });
			await fs.mkdir(nestedApi, { recursive: true });

			const result = await resolveWorkspaceRoots(
				parseArgs(["--add-dir", api, "--add-dir", web, "--add-dir", nestedApi]),
			);

			expect(result.roots.map(r => r.tag)).toEqual(["api", "web", "api-2"]);
			expect(result.roots.map(r => r.primary)).toEqual([true, false, false]);
			expect(result.primaryCwd).toBe(api);
			expect(result.roots.every(r => r.branch === undefined)).toBe(true);
		});
	});

	test("skips missing dirs with a notice instead of failing", async () => {
		await withTempDir(async dir => {
			const real = path.join(dir, "real");
			await fs.mkdir(real, { recursive: true });
			const result = await resolveWorkspaceRoots(
				parseArgs(["--add-dir", path.join(dir, "ghost"), "--add-dir", real]),
			);
			expect(result.roots.map(r => r.path)).toEqual([real]);
			expect(result.notices.some(n => n.includes("ghost") && n.includes("not a directory"))).toBe(true);
		});
	});
});

describe("resolveWorkspaceRoots — --be/--fe worktrees", () => {
	test("creates worktrees off origin default branch; --be is primary; branch is namespaced", async () => {
		await withTempDir(async dir => {
			const wtRoot = path.join(dir, "wt");
			redirectWorktrees(wtRoot);

			const originBe = path.join(dir, "be.git");
			const originFe = path.join(dir, "fe.git");
			await $`git init -q --bare -b main ${originBe}`.quiet();
			await $`git init -q --bare -b main ${originFe}`.quiet();
			// Seed each origin with one commit on main via a throwaway working clone.
			for (const origin of [originBe, originFe]) {
				const seed = path.join(dir, `seed-${path.basename(origin)}`);
				await initRepo(seed);
				await $`git remote add origin ${origin}`.cwd(seed).quiet();
				await $`git push -q -u origin main`.cwd(seed).quiet();
			}
			const be = await cloneRepo(originBe, path.join(dir, "be"));
			const fe = await cloneRepo(originFe, path.join(dir, "fe"));

			const result = await resolveWorkspaceRoots(parseArgs(["--be", be, "--fe", fe, "--worktree", "feat-x"]));

			const beRoot = result.roots.find(r => r.tag === "be");
			const feRoot = result.roots.find(r => r.tag === "fe");
			expect(beRoot?.primary).toBe(true);
			expect(feRoot?.primary).toBe(false);
			expect(beRoot?.branch).toBe("omp/feat-x");
			expect(feRoot?.branch).toBe("omp/feat-x");
			expect(result.primaryCwd).toBe(beRoot!.path);
			// Branched off the origin default branch (no HEAD fallback notice).
			expect(result.notices.some(n => n.includes("default branch not found"))).toBe(false);

			// Worktrees are real checkouts of the seeded commit, on the new branch.
			expect(await Bun.file(path.join(beRoot!.path, "README.md")).text()).toBe("seed\n");
			expect(await git.branch.current(beRoot!.path)).toBe("omp/feat-x");
			// fe is non-primary, so its bounded tree was rendered for the prompt.
			expect(typeof feRoot?.tree).toBe("string");
		});
	});

	test("auto-generates a worktree name when --worktree is omitted", async () => {
		await withTempDir(async dir => {
			redirectWorktrees(path.join(dir, "wt"));
			const origin = path.join(dir, "be.git");
			await $`git init -q --bare -b main ${origin}`.quiet();
			const seed = await initRepo(path.join(dir, "seed"));
			await $`git remote add origin ${origin}`.cwd(seed).quiet();
			await $`git push -q -u origin main`.cwd(seed).quiet();
			const be = await cloneRepo(origin, path.join(dir, "be"));

			const result = await resolveWorkspaceRoots(parseArgs(["--be", be]));
			expect(result.roots[0]?.branch).toMatch(/^omp\/.+/);
		});
	});

	test("reusing the same worktree name is idempotent (no duplicate worktree)", async () => {
		await withTempDir(async dir => {
			redirectWorktrees(path.join(dir, "wt"));
			const origin = path.join(dir, "be.git");
			await $`git init -q --bare -b main ${origin}`.quiet();
			const seed = await initRepo(path.join(dir, "seed"));
			await $`git remote add origin ${origin}`.cwd(seed).quiet();
			await $`git push -q -u origin main`.cwd(seed).quiet();
			const be = await cloneRepo(origin, path.join(dir, "be"));

			const first = await resolveWorkspaceRoots(parseArgs(["--be", be, "--worktree", "dup"]));
			const second = await resolveWorkspaceRoots(parseArgs(["--be", be, "--worktree", "dup"]));
			expect(second.roots[0]?.path).toBe(first.roots[0]?.path);

			const repoRoot = first.roots[0]!.sourceRepo!;
			const worktrees = await git.worktree.list(repoRoot);
			expect(worktrees.filter(w => w.branch === "refs/heads/omp/dup")).toHaveLength(1);
		});
	});

	test("tags a non-git --be path with a notice instead of throwing", async () => {
		await withTempDir(async dir => {
			redirectWorktrees(path.join(dir, "wt"));
			const notRepo = path.join(dir, "plain");
			await fs.mkdir(notRepo, { recursive: true });
			const result = await resolveWorkspaceRoots(parseArgs(["--be", notRepo, "--worktree", "x"]));
			expect(result.roots).toHaveLength(0);
			expect(result.notices.some(n => n.includes("not a git repository"))).toBe(true);
		});
	});

	test("--no-worktree tags repos in place on their current branch", async () => {
		await withTempDir(async dir => {
			const be = await initRepo(path.join(dir, "be"));
			const result = await resolveWorkspaceRoots(parseArgs(["--be", be, "--no-worktree"]));
			const beRoot = result.roots.find(r => r.tag === "be");
			expect(beRoot?.path).toBe(be);
			expect(beRoot?.branch).toBe("main");
		});
	});
});

describe("buildSystemPrompt — <workspace-roots> block", () => {
	test("lists tagged roots with primary annotation and branch", async () => {
		const roots: WorkspaceRoot[] = [
			{ tag: "be", path: "/srv/api-wt", branch: "omp/feat-x", primary: true },
			{ tag: "fe", path: "/srv/web-wt", branch: "omp/feat-x", primary: false, tree: "  - index.ts" },
		];
		const { systemPrompt } = await buildSystemPrompt({
			cwd: "/tmp",
			skills: [],
			contextFiles: [],
			workspaceTree: EMPTY_TREE,
			workspaceRoots: roots,
		});
		const text = systemPrompt.join("\n");
		expect(text).toContain("<workspace-roots>");
		expect(text).toContain("[be] (primary cwd) /srv/api-wt — branch `omp/feat-x`");
		expect(text).toContain("[fe] /srv/web-wt — branch `omp/feat-x`");
		expect(text).toContain("- index.ts");
		expect(text).toContain("Use tagged roots intentionally: `be` means `/srv/api-wt`, `fe` means `/srv/web-wt`.");
		expect(text).toContain(
			"When running shell/build/test commands for a non-current root, pass that root tag or path as the tool `cwd`",
		);
	});

	test("omits the block entirely when there are no roots", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: "/tmp",
			skills: [],
			contextFiles: [],
			workspaceTree: EMPTY_TREE,
		});
		expect(systemPrompt.join("\n")).not.toContain("<workspace-roots>");
	});
});

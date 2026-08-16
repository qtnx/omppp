import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeGraphManager } from "@oh-my-pi/pi-coding-agent/codegraph/manager";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PATH = process.env.PATH;

function writeFakeCodeGraph(binDir: string): void {
	const executable = path.join(binDir, "codegraph");
	fs.writeFileSync(
		executable,
		`#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CG_LOG_FILE"
command="$1"
shift
case "$command" in
  status)
    if [ -f "$CG_STATE_FILE" ]; then
      printf '{"initialized":true}\\n'
    else
      printf '{"initialized":false}\\n'
    fi
    ;;
  init)
    mkdir -p "$(dirname "$CG_STATE_FILE")/.codegraph"
    printf '*\\n!.gitignore\\n' > "$(dirname "$CG_STATE_FILE")/.codegraph/.gitignore"
    touch "$CG_STATE_FILE"
    if [ "\${CG_INIT_MODE:-success}" = "loser" ]; then
      printf 'another process initialized the index\\n' >&2
      exit 1
    fi
    ;;
  sync) ;;
  index) ;;
  explore)
    if [ "\${CG_EXPLORE_DELAY:-0}" != "0" ]; then exec sleep "$CG_EXPLORE_DELAY"; fi
    printf 'explored:%s\\n' "$*"
    ;;
esac
`,
	);
	fs.chmodSync(executable, 0o755);
}

describe("CodeGraphManager", () => {
	let workDir: string;
	let binDir: string;
	let logFile: string;
	let stateFile: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-codegraph-manager-"));
		binDir = path.join(workDir, "bin");
		logFile = path.join(workDir, "commands.log");
		stateFile = path.join(workDir, ".state");
		fs.mkdirSync(binDir);
		writeFakeCodeGraph(binDir);
		process.env.HOME = workDir;
		process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
		process.env.CG_LOG_FILE = logFile;
		process.env.CG_STATE_FILE = stateFile;
		delete process.env.CG_INIT_MODE;
		delete process.env.CG_EXPLORE_DELAY;
		expect(Bun.spawnSync(["git", "init", "-q", workDir]).exitCode).toBe(0);
		CodeGraphManager.disposeAll();
	});

	afterEach(() => {
		CodeGraphManager.disposeAll();
		process.env.HOME = ORIGINAL_HOME;
		process.env.PATH = ORIGINAL_PATH;
		delete process.env.CG_LOG_FILE;
		delete process.env.CG_STATE_FILE;
		delete process.env.CG_INIT_MODE;
		delete process.env.CG_EXPLORE_DELAY;
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("does not create a manager outside a git repository", async () => {
		const loose = fs.mkdtempSync(path.join(os.tmpdir(), "omp-codegraph-nongit-"));
		try {
			expect(await CodeGraphManager.forProject(loose)).toBeNull();
		} finally {
			fs.rmSync(loose, { recursive: true, force: true });
		}
	});

	it("canonicalizes a nested directory to its Git worktree root", async () => {
		const nested = path.join(workDir, "nested");
		fs.mkdirSync(nested);

		const manager = await CodeGraphManager.forProject(nested);

		expect(manager?.projectRoot).toBe(workDir);
	});

	it("shares concurrent readiness and leaves a fresh index ignored", async () => {
		const manager = await CodeGraphManager.forProject(workDir);
		if (!manager) throw new Error("expected CodeGraph manager in a git repository");

		const [first, second] = await Promise.all([manager.ensureReady(), manager.ensureReady()]);

		expect(first.status).toBe("ready");
		expect(second.status).toBe("ready");
		expect(fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)).toEqual([
			`status --json ${workDir}`,
			`init ${workDir}`,
		]);
		expect(fs.readFileSync(path.join(workDir, ".codegraph", ".gitignore"), "utf8")).toBe("*\n");
	});

	it("syncs an existing initialized index", async () => {
		fs.writeFileSync(stateFile, "ready");
		fs.mkdirSync(path.join(workDir, ".codegraph"));
		fs.writeFileSync(path.join(workDir, ".codegraph", ".gitignore"), "*\n!.gitignore\n");
		const manager = await CodeGraphManager.forProject(workDir);
		if (!manager) throw new Error("expected CodeGraph manager in a git repository");

		expect((await manager.ensureReady()).status).toBe("ready");
		expect(fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)).toEqual([
			`status --json ${workDir}`,
			`sync --quiet ${workDir}`,
		]);
		expect(fs.readFileSync(path.join(workDir, ".codegraph", ".gitignore"), "utf8")).toBe("*\n");
	});

	it("accepts an init race loser after its status recheck", async () => {
		process.env.CG_INIT_MODE = "loser";
		const manager = await CodeGraphManager.forProject(workDir);
		if (!manager) throw new Error("expected CodeGraph manager in a git repository");

		expect((await manager.ensureReady()).status).toBe("ready");
		expect(fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)).toEqual([
			`status --json ${workDir}`,
			`init ${workDir}`,
			`status --json ${workDir}`,
		]);
	});

	it("uses the managed local install when PATH has not refreshed", async () => {
		const localBin = path.join(workDir, ".local", "bin");
		fs.mkdirSync(localBin, { recursive: true });
		fs.renameSync(path.join(binDir, "codegraph"), path.join(localBin, "codegraph"));
		process.env.PATH = ["/usr/bin", "/bin"].join(path.delimiter);
		CodeGraphManager.disposeAll();
		const manager = await CodeGraphManager.forProject(workDir);
		if (!manager) throw new Error("expected CodeGraph manager in a git repository");

		expect((await manager.ensureReady()).status).toBe("ready");
	});

	it("reports a missing executable without throwing from start", async () => {
		process.env.PATH = path.join(workDir, "empty-bin");
		CodeGraphManager.disposeAll();
		const manager = await CodeGraphManager.forProject(workDir);
		if (!manager) throw new Error("expected CodeGraph manager in a git repository");

		expect(() => manager.start()).not.toThrow();
		expect((await manager.ensureReady()).status).toBe("unavailable");
		expect(manager.getState().error).toContain("codegraph");
	});

	it("runs explore with locked argv and passes its output through", async () => {
		fs.writeFileSync(stateFile, "ready");
		const manager = await CodeGraphManager.forProject(workDir);
		if (!manager) throw new Error("expected CodeGraph manager in a git repository");

		const result = await manager.explore("find manager", { projectPath: "/tmp/target", maxFiles: 3 });

		expect(result.command).toEqual([
			"codegraph",
			"explore",
			"--path",
			"/tmp/target",
			"--max-files",
			"3",
			"find manager",
		]);
		expect(result.stdout).toBe("explored:--path /tmp/target --max-files 3 find manager\n");
		expect(fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)).toEqual([
			`status --json ${workDir}`,
			`sync --quiet ${workDir}`,
			"explore --path /tmp/target --max-files 3 find manager",
		]);
	});

	it("honors an aborted explore signal", async () => {
		fs.writeFileSync(stateFile, "ready");
		process.env.CG_EXPLORE_DELAY = "5";
		const manager = await CodeGraphManager.forProject(workDir);
		if (!manager) throw new Error("expected CodeGraph manager in a git repository");
		const controller = new AbortController();
		const pending = manager.explore("slow", { signal: controller.signal });
		await Bun.sleep(20);
		controller.abort();

		const result = await pending;
		expect(result.exitCode).not.toBe(0);
	});
});

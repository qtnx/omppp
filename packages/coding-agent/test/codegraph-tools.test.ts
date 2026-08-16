import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CODEGRAPH_REQUIRES_GIT, CodeGraphManager } from "@oh-my-pi/pi-coding-agent/codegraph/manager";
import { CodeGraphExploreTool } from "@oh-my-pi/pi-coding-agent/codegraph/tools";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	type ToolSession,
} from "@oh-my-pi/pi-coding-agent/tools";

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;

function writeFakeCodeGraph(binDir: string): void {
	const executable = path.join(binDir, "codegraph");
	fs.writeFileSync(
		executable,
		`#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CG_LOG_FILE"
case "$1" in
  status) printf '{"initialized":true}\\n' ;;
  sync|init|index) ;;
  explore) printf '1:export class CodeGraphManager {}\\n' ;;
esac
`,
	);
	fs.chmodSync(executable, 0o755);
}

function makeSession(cwd: string, settings = Settings.isolated()): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as ToolSession;
}

describe("CodeGraph built-in tools", () => {
	let workDir: string;
	let binDir: string;
	let logFile: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-codegraph-tools-"));
		binDir = path.join(workDir, "bin");
		logFile = path.join(workDir, "commands.log");
		fs.mkdirSync(binDir);
		writeFakeCodeGraph(binDir);
		process.env.HOME = workDir;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.CG_LOG_FILE = logFile;
		CodeGraphManager.disposeAll();
	});

	afterEach(() => {
		CodeGraphManager.disposeAll();
		process.env.HOME = originalHome;
		process.env.PATH = originalPath;
		delete process.env.CG_LOG_FILE;
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("registers explore as default-active and gates all CodeGraph tools", async () => {
		expect(Bun.spawnSync(["git", "init", "-q", workDir]).exitCode).toBe(0);
		expect(computeEssentialBuiltinNames(Settings.isolated())).toContain("codegraph_explore");
		const explore = await BUILTIN_TOOLS.codegraph_explore(makeSession(workDir));
		const init = await BUILTIN_TOOLS.codegraph_init(makeSession(workDir));
		const index = await BUILTIN_TOOLS.codegraph_index(makeSession(workDir));
		if (!explore || !init || !index) throw new Error("CodeGraph built-ins must be constructible");
		expect(explore.loadMode).toBe("essential");
		expect(init.loadMode).toBe("discoverable");
		expect(index.approval).toBe("write");

		const defaultTools = await createTools(makeSession(workDir));
		expect(defaultTools.map(tool => tool.name)).toContain("codegraph_explore");

		const disabled = Settings.isolated({ "codegraph.enabled": false });
		const tools = await createTools(makeSession(workDir, disabled), [
			"codegraph_init",
			"codegraph_index",
			"codegraph_explore",
		]);
		expect(tools.map(tool => tool.name)).not.toContain("codegraph_init");
		expect(tools.map(tool => tool.name)).not.toContain("codegraph_index");
		expect(tools.map(tool => tool.name)).not.toContain("codegraph_explore");
	});

	it("hides CodeGraph tools and refuses execute outside a git repository", async () => {
		const tools = await createTools(makeSession(workDir), ["codegraph_init", "codegraph_index", "codegraph_explore"]);
		expect(tools.map(tool => tool.name)).not.toContain("codegraph_init");
		expect(tools.map(tool => tool.name)).not.toContain("codegraph_index");
		expect(tools.map(tool => tool.name)).not.toContain("codegraph_explore");

		await expect(
			new CodeGraphExploreTool(makeSession(workDir)).execute("codegraph-nongit", { query: "CodeGraphManager" }),
		).rejects.toThrow(CODEGRAPH_REQUIRES_GIT);
	});

	it("runs the locked explore command and preserves line-numbered source", async () => {
		expect(Bun.spawnSync(["git", "init", "-q", workDir]).exitCode).toBe(0);
		const result = await new CodeGraphExploreTool(makeSession(workDir)).execute("codegraph-test", {
			query: "CodeGraphManager",
			maxFiles: 2,
		});

		expect(result.content).toEqual([{ type: "text", text: "1:export class CodeGraphManager {}\n" }]);
		if (!result.details) throw new Error("CodeGraph explore result must include command details");
		expect(result.details.command).toEqual(["codegraph", "explore", "--max-files", "2", "CodeGraphManager"]);
		expect(fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)).toEqual([
			`status --json ${workDir}`,
			`sync --quiet ${workDir}`,
			"explore --max-files 2 CodeGraphManager",
		]);
	});

	it("reports an unavailable CodeGraph executable as an actionable tool failure", async () => {
		expect(Bun.spawnSync(["git", "init", "-q", workDir]).exitCode).toBe(0);
		process.env.PATH = path.join(workDir, "empty-bin");

		await expect(
			new CodeGraphExploreTool(makeSession(workDir)).execute("codegraph-missing", { query: "CodeGraphManager" }),
		).rejects.toThrow("CodeGraph executable was not found");
	});
});

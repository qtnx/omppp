import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { MacOSSandboxRelaunchResult } from "@oh-my-pi/pi-coding-agent/task/omp-command";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MacOSSandboxTool } from "@oh-my-pi/pi-coding-agent/tools/macos-sandbox";

function makeSession(
	request: (dirs: string[]) => MacOSSandboxRelaunchResult,
	sessionFile: string | null = "/Users/alice/.omp/session.jsonl",
	workspaceRoots?: ToolSession["workspaceRoots"],
): ToolSession {
	return {
		cwd: "/Users/alice/project",
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getSessionId: () => "session-1",
		requestMacOSSandboxRelaunch: request,
		workspaceRoots,
	} as unknown as ToolSession;
}

function firstText(result: AgentToolResult): string {
	const firstContent = result.content[0];
	expect(firstContent?.type).toBe("text");
	if (firstContent?.type !== "text") throw new Error("expected text tool content");
	return firstContent.text;
}

describe("MacOSSandboxTool", () => {
	it("requests relaunch with the current session directory as the primary workspace root", async () => {
		const requested: string[][] = [];
		const tool = new MacOSSandboxTool(
			makeSession(
				dirs => {
					requested.push(dirs);
					return { requested: true };
				},
				"/Users/alice/.omp/session.jsonl",
				[{ tag: "api", path: "/Users/alice/api", primary: false }],
			),
		);

		const result = await tool.execute("call-1", { paths: ["../other", "/Users/alice/third"] });

		expect(requested).toEqual([
			[
				"/Users/alice/project",
				"/Users/alice/api",
				path.resolve("/Users/alice/project", "../other"),
				"/Users/alice/third",
			],
		]);
		expect(result.isError).toBeUndefined();
		expect(result.details?.relaunchRequested).toBe(true);
		const text = firstText(result);
		expect(text).toContain("/Users/alice/other");
		expect(text).toContain("/Users/alice/third");
		expect(text).not.toContain("/Users/alice/project");
		expect(text).not.toContain("/Users/alice/api");
	});

	it("returns a manual restart command when no supervisor is available", async () => {
		const tool = new MacOSSandboxTool(
			makeSession(() => ({ requested: false, reason: "missing-supervisor" }), "/Users/alice/.omp/session.jsonl", [
				{ tag: "api", path: "/Users/alice/api", primary: false },
			]),
		);

		const result = await tool.execute("call-2", { paths: ["/Users/alice/other;echo-owned"] });

		expect(result.isError).toBe(true);
		expect(result.details?.relaunchRequested).toBe(false);
		expect(result.details?.restartArgs).toEqual([
			"--session-dir",
			"/Users/alice/.omp",
			"--resume",
			"session-1",
			"--sandbox-add-dir",
			"/Users/alice/project",
			"--sandbox-add-dir",
			"/Users/alice/api",
			"--sandbox-add-dir",
			"/Users/alice/other;echo-owned",
		]);
		expect(firstText(result)).toContain("'--session-dir' '/Users/alice/.omp'");
		expect(firstText(result)).toContain(
			"'--sandbox-add-dir' '/Users/alice/project' '--sandbox-add-dir' '/Users/alice/api' '--sandbox-add-dir' '/Users/alice/other;echo-owned'",
		);
		expect(firstText(result)).toContain("restart OMPx from your shell");
	});

	it("rejects broad home and credential directories", async () => {
		const tool = new MacOSSandboxTool(makeSession(() => ({ requested: true })));

		const homeResult = await tool.execute("call-3", { paths: ["/Users/alice"] });
		const dataAliasResult = await tool.execute("call-4", {
			paths: ["/System/Volumes/Data/Users/alice/.ssh"],
		});

		expect(homeResult.isError).toBe(true);
		expect(firstText(homeResult)).toContain("Refusing to whitelist unsafe sandbox directory");
		expect(dataAliasResult.isError).toBe(true);
		expect(firstText(dataAliasResult)).toContain("Refusing to whitelist unsafe sandbox directory");
	});

	it("does not request relaunch for non-persisted sessions", async () => {
		const requested: string[][] = [];
		const tool = new MacOSSandboxTool(
			makeSession(dirs => {
				requested.push(dirs);
				return { requested: true };
			}, null),
		);

		const result = await tool.execute("call-5", { paths: ["/Users/alice/other"] });

		expect(requested).toEqual([]);
		expect(result.isError).toBe(true);
		expect(result.details?.reason).toBe("missing-session");
		expect(result.details?.restartArgs).toBeUndefined();
	});
});

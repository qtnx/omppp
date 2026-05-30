import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { closeDb, initDb, insertMessageStats } from "../src/db";
import { getSessionTrace, listSessions } from "../src/sessions";
import type { MessageStats } from "../src/types";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-sessions-");
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

function usage() {
	return {
		input: 100,
		output: 50,
		cacheRead: 25,
		cacheWrite: 0,
		totalTokens: 175,
		cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
	};
}

function makeMessage(sessionFile: string, entryId: string, timestamp: number): MessageStats {
	return {
		sessionFile,
		entryId,
		folder: "/repo",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1200,
		ttft: 200,
		stopReason: "stop",
		errorMessage: null,
		usage: usage(),
	};
}

async function writeJsonl(filePath: string, entries: unknown[]): Promise<void> {
	await Bun.write(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("session traces", () => {
	it("lists root sessions and nests task subagent session files under the spawning tool result", async () => {
		if (!tempDir) throw new Error("Temp dir not initialized");
		const now = Date.now();
		const projectDir = path.join(getAgentDir(), "sessions", "--repo");
		const rootFile = path.join(projectDir, "root.jsonl");
		const childFile = path.join(projectDir, "root", "0-Research.jsonl");

		await writeJsonl(rootFile, [
			{ type: "session", version: 3, id: "root-session", timestamp: new Date(now).toISOString(), cwd: "/repo" },
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(now).toISOString(),
				message: { role: "user", content: [{ type: "text", text: "Build a trace dashboard" }], timestamp: now },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: new Date(now + 1).toISOString(),
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tool-call-1", name: "task", arguments: { tasks: [{ id: "0-Research" }] } },
					],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.4",
					usage: usage(),
					stopReason: "toolUse",
					timestamp: now + 1,
					duration: 1200,
					ttft: 200,
				},
			},
			{
				type: "message",
				id: "tool-result-1",
				parentId: "assistant-1",
				timestamp: new Date(now + 2).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "tool-call-1",
					toolName: "task",
					content: [{ type: "text", text: "Subagent complete" }],
					details: { results: [{ id: "0-Research", sessionFile: childFile }] },
					isError: false,
					timestamp: now + 2,
				},
			},
		]);

		await writeJsonl(childFile, [
			{ type: "session", version: 3, id: "child-session", timestamp: new Date(now + 3).toISOString(), cwd: "/repo" },
			{
				type: "session_init",
				id: "child-init",
				parentId: null,
				timestamp: new Date(now + 3).toISOString(),
				systemPrompt: "You are Research",
				task: "Research dashboard precedents",
				tools: ["read"],
			},
			{
				type: "message",
				id: "child-user-1",
				parentId: "child-init",
				timestamp: new Date(now + 4).toISOString(),
				message: { role: "user", content: [{ type: "text", text: "Study Langfuse layout" }], timestamp: now + 4 },
			},
		]);

		await initDb();
		insertMessageStats([
			makeMessage(rootFile, "assistant-1", now + 1),
			makeMessage(childFile, "child-assistant-1", now + 5),
		]);

		const list = await listSessions();
		expect(list.total).toBe(1);
		expect(list.sessions[0]).toMatchObject({ id: "root-session", subagentCount: 1 });
		expect(list.sessions[0]?.stats?.totalRequests).toBe(1);

		const trace = await getSessionTrace(rootFile);
		expect(trace?.summary.subagentCount).toBe(1);
		const toolResult = trace?.nodes[0]?.children[0]?.children[0];
		expect(toolResult?.id).toBe("tool-result-1");
		expect(toolResult?.subtraces[0]?.summary).toMatchObject({ id: "child-session", parentTaskId: "0-Research" });
		expect(toolResult?.subtraces[0]?.summary.task).toBe("Research dashboard precedents");
	});
});

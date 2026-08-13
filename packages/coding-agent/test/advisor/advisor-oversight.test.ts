import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, SessionEntry } from "@oh-my-pi/pi-agent-core";
import type { AdvisorAgent, AdvisorRuntimeHost } from "../../src/advisor";
import {
	AdvisorRuntime,
	ReadAdvisorStateTool,
	SetTodosTool,
	UpdateAdvisorStateTool,
	UpdateBriefTool,
} from "../../src/advisor";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import type { ToolSession } from "../../src/tools";
import { getLatestTodoPhasesFromEntries, type TodoPhase, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import { ToolError } from "../../src/tools/tool-errors";

function promptText(input: string | AgentMessage[]): string {
	if (typeof input === "string") return input;
	return input
		.map(message => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content.map(block => (block as { text?: string }).text ?? "").join("\n");
			}
			return String(message);
		})
		.join("\n");
}

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function createTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createAdvisorAgent(promptInputs: string[]): AdvisorAgent {
	const state: { messages: AgentMessage[]; error?: string } = { messages: [] };
	return {
		prompt: async input => {
			promptInputs.push(promptText(input));
		},
		abort: () => {},
		reset: () => {},
		state,
	};
}

function createRuntime(promptInputs: string[]): AdvisorRuntime {
	const host: AdvisorRuntimeHost = {
		snapshotMessages: () => [],
		enqueueAdvice: () => {},
	};
	const runtime = new AdvisorRuntime(createAdvisorAgent(promptInputs), host);
	runtime.seedTo(0);
	return runtime;
}

function textFromResult(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map(part => part.text ?? "").join("\n");
}

describe("advisor oversight contracts", () => {
	it("reviews a non-blank user prompt once on a started unpaused runtime and drops blank or paused prompts", async () => {
		const promptInputs: string[] = [];
		const runtime = createRuntime(promptInputs);

		runtime.onUserPrompt("Build the migration planner before editing code.");
		await Promise.resolve();

		expect(promptInputs).toHaveLength(1);
		expect(promptInputs[0]).toContain("### User prompt review");
		expect(promptInputs[0]).toContain("Build the migration planner before editing code.");
		expect(promptInputs[0]).toContain("request_takeover");
		expect(promptInputs[0]).toContain('purpose: "plan"');

		runtime.onUserPrompt("   \n\t ");
		runtime.pause();
		runtime.onUserPrompt("This prompt must not enqueue while paused.");
		await Promise.resolve();
		expect(promptInputs).toHaveLength(1);
	});

	it("update_brief writes advisor-brief.md, accepts the byte cap, and rejects content over the cap", async () => {
		const artifactsDir = await createTempDir("advisor-brief-");
		const session = {
			cwd: artifactsDir,
			localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "brief-test" },
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "brief-test",
		} as unknown as ToolSession;
		const tool = new UpdateBriefTool(session);
		const targetPath = resolveLocalUrlToPath("local://advisor-brief.md", session.localProtocolOptions ?? {});

		const content = "## Goal\nShip the advisor brief contract.\n";
		const result = await tool.execute("brief", { content });
		expect(path.basename(targetPath)).toBe("advisor-brief.md");
		expect(await fs.readFile(targetPath, "utf8")).toBe(content);
		expect(textFromResult(result)).toContain(
			`Brief updated (${new TextEncoder().encode(content).byteLength} bytes).`,
		);

		const capped = "x".repeat(8192);
		expect(textFromResult(await tool.execute("brief-cap", { content: capped }))).toContain("8192 bytes");
		await expect(tool.execute("brief-over-cap", { content: `${capped}x` })).rejects.toThrow(ToolError);
		await expect(tool.execute("brief-over-cap-message", { content: `${capped}x` })).rejects.toThrow("8192 byte cap");
	});

	it("read_advisor_state reports missing state and reads exact content after update_advisor_state writes it", async () => {
		const artifactsDir = await createTempDir("advisor-state-");
		const session = {
			cwd: artifactsDir,
			localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "state-test" },
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "state-test",
		} as unknown as ToolSession;
		const readTool = new ReadAdvisorStateTool(session);
		const updateTool = new UpdateAdvisorStateTool(session);
		const targetPath = resolveLocalUrlToPath("local://advisor-state.md", session.localProtocolOptions ?? {});

		expect(path.basename(targetPath)).toBe("advisor-state.md");
		expect(textFromResult(await readTool.execute("read-missing", {}))).toContain(
			"No advisor state has been written yet.",
		);

		const content = "## Goal\nKeep a durable ledger.\n";
		const byteLength = new TextEncoder().encode(content).byteLength;
		const updateResult = await updateTool.execute("state", { content });
		expect(textFromResult(updateResult)).toContain(`Advisor state updated (${byteLength} bytes).`);
		expect(await fs.readFile(targetPath, "utf8")).toBe(content);

		const readResult = textFromResult(await readTool.execute("read", {}));
		expect(readResult).toBe(`Advisor state at local://advisor-state.md:\n\n${content}`);

		const capped = "x".repeat(16_384);
		expect(textFromResult(await updateTool.execute("state-cap", { content: capped }))).toContain("16384 bytes");
		await expect(updateTool.execute("state-over-cap", { content: `${capped}x` })).rejects.toThrow(ToolError);
		await expect(updateTool.execute("state-over-cap-message", { content: `${capped}x` })).rejects.toThrow(
			"16384 byte cap",
		);
	});

	it("set_todos full-replaces live phases and appends durable user_todo_edit data preserving reorder", async () => {
		const liveUpdates: TodoPhase[][] = [];
		const entries: SessionEntry[] = [];
		const session = {
			cwd: "/tmp",
			setTodoPhases: (phases: TodoPhase[]) => {
				liveUpdates.push(structuredClone(phases));
			},
			appendCustomEntry: (customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					id: `entry-${entries.length + 1}`,
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType,
					data,
				} as unknown as SessionEntry);
				return `entry-${entries.length}`;
			},
		} as unknown as ToolSession;
		const tool = new SetTodosTool(session);

		const result = await tool.execute("todos", {
			phases: [
				{
					phase: "QA",
					items: [
						{ content: "Run focused browser scenario", status: "pending" },
						{ content: "Record evidence", status: "in_progress" },
					],
				},
				{
					phase: "Implementation",
					items: [{ content: "Patch the seam", status: "completed" }],
				},
			],
		});

		const expected: TodoPhase[] = [
			{
				name: "QA",
				tasks: [
					{ content: "Run focused browser scenario", status: "pending" },
					{ content: "Record evidence", status: "in_progress" },
				],
			},
			{
				name: "Implementation",
				tasks: [{ content: "Patch the seam", status: "completed" }],
			},
		];
		expect(textFromResult(result)).toContain("Todos updated: 2 phases, 2 open.");
		expect(liveUpdates).toEqual([expected]);
		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe("custom");
		if (entries[0].type === "custom") {
			expect(entries[0].customType).toBe(USER_TODO_EDIT_CUSTOM_TYPE);
		}
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(expected);
	});

	it("set_todos rejects empty replacements and invalid statuses", async () => {
		const session = {
			cwd: "/tmp",
			setTodoPhases: () => {},
			appendCustomEntry: () => "entry-1",
		} as unknown as ToolSession;
		const tool = new SetTodosTool(session);

		await expect(tool.execute("empty", { phases: [] })).rejects.toThrow(ToolError);
		await expect(
			tool.execute("bad-status", {
				phases: [
					{
						phase: "QA",
						items: [{ content: "Run verification", status: "bogus" as "pending" }],
					},
				],
			}),
		).rejects.toThrow(ToolError);
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { TaskTool } from "../../src/task";
import * as discovery from "../../src/task/discovery";
import * as routing from "../../src/task/jev-brief";
import type { TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("does not classify bundled agents as read-only when they expose command-capable tools", () => {
		const agents = loadBundledAgents();
		const explore = agentByName(agents, "explore");

		expect(explore.tools).toContain("bash");
		expect(isReadOnlyAgent(explore)).toBe(false);
		expect(explore.systemPrompt).toContain("You MUST operate as read-only");
		expect(explore.systemPrompt).toContain("You NEVER use `bash` to write, edit, delete, install");
		expect(isReadOnlyAgent(agentByName(agents, "scout"))).toBe(true);
		for (const name of ["task", "quick_task", "plan", "reviewer", "tester", "designer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("does not classify an agent declaring `hub` as read-only", () => {
		// `hub` resolves to exec approval for start/stop/restart, process-stdin
		// `send`, unrecognized ops and malformed params, so declaring it must
		// disqualify an agent from the read-only label surfaced to the model.
		const scout = agentByName(loadBundledAgents(), "scout");

		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "hub", "yield"] })).toBe(false);
		expect(isReadOnlyAgent({ ...scout, tools: ["hub"] })).toBe(false);

		// Guard against over-correcting: the positive case must still hold.
		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "yield"] })).toBe(true);
	});

	it("keeps a scout declaring `jev_scout` read-only: the tool is read-approval and never edits", () => {
		const scout = agentByName(loadBundledAgents(), "scout");
		expect(scout.tools).toContain("jev_scout");
		expect(isReadOnlyAgent(scout)).toBe(true);
		expect(isReadOnlyAgent({ ...scout, tools: ["jev_scout", "edit"] })).toBe(false);
	});

	it("disables read summarization for scout, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "explore").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		expect(agentByName(agents, "scout").readSummarize).toBe(false);
		for (const name of ["task", "quick_task", "plan", "reviewer", "tester", "designer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
	it("ships every bundled agent without prewalk; hand-off is opt-in via task.agentPrewalk", () => {
		const agents = loadBundledAgents();

		for (const name of ["task", "scout", "quick_task", "reviewer", "security-reviewer", "designer", "librarian"]) {
			expect(agentByName(agents, name).prewalk).toBeUndefined();
		}
	});
});

describe("explicit task agent precedence", () => {
	afterEach(() => vi.restoreAllMocks());
	it.each([
		{ batch: "task", item: undefined, expected: "task", calls: 0 },
		{ batch: "task", item: "quick_task", expected: "quick_task", calls: 0 },
		{ batch: undefined, item: undefined, expected: "quick_task", calls: 1 },
	])("preserves batch=$batch item=$item and only routes absent choices", async ({ batch, item, expected, calls }) => {
		vi.spyOn(discovery, "discoverAgents")
			.mockResolvedValueOnce({
				agents: ["task", "quick_task"].map(name => ({
					name,
					description: name,
					systemPrompt: "Test",
					source: "bundled" as const,
				})),
				projectAgentsDir: null,
			})
			.mockResolvedValue({ agents: [], projectAgentsDir: null });
		const route = vi.spyOn(routing, "routeAgent").mockResolvedValue("quick_task");
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": true, "task.jevAssist": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
		const result = await tool.execute("precedence", {
			agent: batch,
			context: "Read-only fixture: preserve the caller's chosen agent and return its observed outcome.",
			tasks: [{ name: "Probe", agent: item, task: "Read one fact." }],
		} as TaskParams);
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(text).toContain(`Unknown agent "${expected}"`);
		expect(route).toHaveBeenCalledTimes(calls);
	});
});

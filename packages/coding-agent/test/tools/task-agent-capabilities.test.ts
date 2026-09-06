import { describe, expect, it } from "bun:test";
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
		for (const name of ["task", "quick_task", "heavy_task", "plan", "reviewer", "tester", "designer"]) {
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

	it("disables read summarization for scout, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "explore").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		expect(agentByName(agents, "scout").readSummarize).toBe(false);
		for (const name of ["task", "quick_task", "heavy_task", "plan", "reviewer", "tester", "designer"]) {
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

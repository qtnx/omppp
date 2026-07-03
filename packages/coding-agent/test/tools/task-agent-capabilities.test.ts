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
		expect(explore.systemPrompt).toContain("You MUST NOT use `bash` to write");
		for (const name of ["task", "quick_task", "heavy_task", "plan", "reviewer", "tester", "designer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("disables read summarization for explore and librarian, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "explore").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		for (const name of ["task", "quick_task", "heavy_task", "plan", "reviewer", "tester", "designer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
});

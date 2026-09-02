import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Contract: caveman mode is a system-prompt overlay, not a chat message. When
// `caveman.enabled` is on the bundled skill body is present in the effective
// system prompt before the first turn; `/caveman off` (setCavemanEnabled(false))
// removes it from the prompt the model receives, and `on` restores it.

const CAVEMAN_HEADER = "# Caveman Mode (active)";
const CAVEMAN_BODY = "Respond terse like smart caveman.";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock-model",
		name: "Mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	});
}

const readTool: AgentTool = {
	name: "read",
	label: "Read",
	description: "Read tool",
	parameters: { type: "object", properties: {} } as never,
	execute: async () => ({ content: [{ type: "text", text: "" }], details: undefined }),
};

describe("caveman system-prompt overlay", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function newSession(settings: Settings): { session: AgentSession; agent: Agent } {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: createModel(), systemPrompt: ["base"], tools: [readTool], messages: [] },
			convertToLlm,
		});
		const toolRegistry = new Map<string, AgentTool>([[readTool.name, readTool]]);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry,
			builtInToolNames: ["read"],
			ensureWriteRegistered: async () => false,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["base"] }),
		});
		sessions.push(session);
		return { session, agent };
	}

	function cavemanBlocks(agent: Agent): string[] {
		return agent.state.systemPrompt.filter(block => block.includes(CAVEMAN_HEADER));
	}

	it("loads the skill into the prompt by default and drops it on /caveman off", () => {
		const { session, agent } = newSession(Settings.isolated({ "compaction.enabled": false }));

		const initial = cavemanBlocks(agent);
		expect(initial).toHaveLength(1);
		expect(initial[0]).toContain(CAVEMAN_BODY);
		// Frontmatter is stripped; only the skill body is injected.
		expect(initial[0]).not.toContain("license: MIT");
		expect(agent.state.systemPrompt[0]).toBe("base");

		session.setCavemanEnabled(false);
		expect(cavemanBlocks(agent)).toHaveLength(0);
		expect(agent.state.systemPrompt).toEqual(["base"]);

		session.setCavemanEnabled(true);
		expect(cavemanBlocks(agent)).toHaveLength(1);
	});

	it("keeps the prompt clean when caveman is disabled in settings", () => {
		const { agent } = newSession(Settings.isolated({ "compaction.enabled": false, "caveman.enabled": false }));
		expect(cavemanBlocks(agent)).toHaveLength(0);
	});
});

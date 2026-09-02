import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "../src/system-prompt";

// Contract: caveman mode is part of the base system prompt, not a chat
// message. With `cavemanEnabled` the bundled skill body is present before the
// first turn; without it the prompt carries no caveman block. `/caveman on|off`
// (setCavemanEnabled) rebuilds the base prompt with the new setting so the next
// turn already runs with the block injected or removed.

const CAVEMAN_HEADER = "# Caveman Mode (active)";
const CAVEMAN_BODY = "Respond terse like smart caveman.";

async function renderPrompt(cavemanEnabled: boolean): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: import.meta.dir,
		toolNames: ["read", "bash", "edit"],
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: { rootPath: import.meta.dir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		activeRepoContext: null,
		personality: "none",
		cavemanEnabled,
	});
	return systemPrompt[0] ?? "";
}

describe("caveman mode in the system prompt", () => {
	it("injects the skill body (frontmatter stripped) only when enabled", async () => {
		const on = await renderPrompt(true);
		expect(on).toContain(CAVEMAN_HEADER);
		expect(on).toContain(CAVEMAN_BODY);
		expect(on).not.toContain("license: MIT");

		const off = await renderPrompt(false);
		expect(off).not.toContain(CAVEMAN_HEADER);
		expect(off).not.toContain(CAVEMAN_BODY);
	});
});

describe("AgentSession.setCavemanEnabled", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("rebuilds the base prompt with the new setting and skips no-op toggles", async () => {
		const model: Model<"openai-responses"> = buildModel({
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
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read tool",
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({ content: [{ type: "text", text: "" }], details: undefined }),
		};
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["base"], tools: [readTool], messages: [] },
			convertToLlm,
		});
		const rebuilds: boolean[] = [];
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry: new Map<string, AgentTool>([[readTool.name, readTool]]),
			builtInToolNames: ["read"],
			ensureWriteRegistered: async () => false,
			rebuildSystemPrompt: async () => {
				const enabled = settings.get("caveman.enabled");
				rebuilds.push(enabled);
				return { systemPrompt: [enabled ? `base\n${CAVEMAN_HEADER}` : "base"] };
			},
		});
		sessions.push(session);

		await session.setCavemanEnabled(true); // default already on: no rebuild
		expect(rebuilds).toEqual([]);

		await session.setCavemanEnabled(false);
		expect(rebuilds).toEqual([false]);
		expect(agent.state.systemPrompt).toEqual(["base"]);

		await session.setCavemanEnabled(true);
		expect(rebuilds).toEqual([false, true]);
		expect(agent.state.systemPrompt[0]).toContain(CAVEMAN_HEADER);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Coverage for the orchestrator QA completion gate (`#checkQaCompletion`): when the
 * agent stops with no tool calls while QA verification jobs are still running, it must
 * append a persisted developer `<system-reminder>` and schedule a continuation so it
 * does not prematurely claim completion. The gate is one-shot per running QA cohort and
 * only fires in orchestrator mode for running `task`-type jobs whose id starts with "QA".
 */
describe("AgentSession QA completion gate", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let asyncJobManager: AsyncJobManager;
	let neverResolve: () => void;

	function textOnlyStop(): void {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "all done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function qaReminderCount(): number {
		return sessionManager.getBranch().filter(entry => {
			if (entry.type !== "message" || entry.message.role !== "developer") return false;
			const { content } = entry.message;
			if (!Array.isArray(content)) return false;
			return content.some(
				(item): item is TextContent => item.type === "text" && item.text.includes("QA verification jobs"),
			);
		}).length;
	}

	function registerRunningJob(id: string, type: "bash" | "task" | "workflow"): void {
		asyncJobManager.register(
			type,
			id,
			() =>
				new Promise<string>(resolve => {
					neverResolve = () => resolve("");
				}),
			{ id },
		);
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-qa-gate-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		asyncJobManager = new AsyncJobManager({ onJobComplete: () => {} });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			asyncJobManager,
		});
		// Prevent the scheduled continuation from driving a real streaming turn.
		vi.spyOn(session.agent, "continue").mockResolvedValue();
	});

	afterEach(async () => {
		neverResolve?.();
		await session.dispose();
		asyncJobManager.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("appends a QA reminder and schedules continuation when a running QA task job exists", async () => {
		await session.setOrchestratorModeState({ enabled: true });
		registerRunningJob("QAFoo", "task");
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		textOnlyStop();
		await session.waitForIdle();

		expect(qaReminderCount()).toBe(1);
		const reminderEntry = sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "developer") return false;
			const { content } = entry.message;
			if (!Array.isArray(content)) return false;
			return content.some((item): item is TextContent => item.type === "text" && item.text.includes("QAFoo"));
		});
		expect(reminderEntry?.type).toBe("message");
		expect(continueSpy).toHaveBeenCalled();
	});

	it("does not remind when orchestrator mode is disabled", async () => {
		registerRunningJob("QAFoo", "task");

		textOnlyStop();
		await session.waitForIdle();

		expect(qaReminderCount()).toBe(0);
	});

	it("does not remind for a running job without the QA id prefix", async () => {
		await session.setOrchestratorModeState({ enabled: true });
		registerRunningJob("BuildFoo", "task");

		textOnlyStop();
		await session.waitForIdle();

		expect(qaReminderCount()).toBe(0);
	});

	it("is one-shot: a second stop with the same running job does not re-remind", async () => {
		await session.setOrchestratorModeState({ enabled: true });
		registerRunningJob("QAFoo", "task");

		textOnlyStop();
		await session.waitForIdle();
		expect(qaReminderCount()).toBe(1);

		textOnlyStop();
		await session.waitForIdle();
		expect(qaReminderCount()).toBe(1);
	});
});

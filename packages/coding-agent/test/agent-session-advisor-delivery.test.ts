import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Message, TextContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AdviseTool } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

const ADVISOR_NOTE = "Both tools must settle before this concern is considered.";
const SKIPPED_TOOL_RESULT = "Skipped due to queued user message";
const TAIL_ADVISOR_NOTE = "Re-check the final answer before declaring the run complete.";
type MessageBlock = Exclude<Message["content"], string>[number];

function messageText(message: Message): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return Array.from(message.content)
		.filter((part): part is Extract<MessageBlock, { type: "text" }> => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

function toolResultText(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): string {
	return event.result.content
		.filter((part: AgentToolResult["content"][number]): part is TextContent => part.type === "text")
		.map((part: TextContent) => part.text)
		.join("\n");
}

describe("AgentSession advisor delivery during a tool batch", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-delivery-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	it("delivers a streaming advisor concern after every tool in the current batch settles", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");

		const firstToolStarted = Promise.withResolvers<void>();
		const releaseFirstTool = Promise.withResolvers<void>();
		const executions: string[] = [];
		const noArgs = type({});
		const firstTool: AgentTool<typeof noArgs> = {
			name: "first_gate",
			label: "First gate",
			description: "Waits at a deterministic gate",
			parameters: noArgs,
			intent: "omit",
			concurrency: "exclusive",
			async execute() {
				executions.push("first_gate");
				firstToolStarted.resolve();
				await releaseFirstTool.promise;
				return { content: [{ type: "text", text: "first complete" }] };
			},
		};
		const secondTool: AgentTool<typeof noArgs> = {
			name: "second_probe",
			label: "Second probe",
			description: "Records that the remainder of the batch ran",
			parameters: noArgs,
			intent: "omit",
			concurrency: "exclusive",
			async execute() {
				executions.push("second_probe");
				return { content: [{ type: "text", text: "second complete" }] };
			},
		};
		const mainMock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "call-first", name: firstTool.name, arguments: {} },
						{ type: "toolCall", id: "call-second", name: secondTool.name, arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "call-advise",
							name: "advise",
							arguments: { note: ADVISOR_NOTE, severity: "concern" },
						},
					],
				},
				{ content: ["advice recorded"] },
			],
			handler: { content: ["no additional concerns"] },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [firstTool, secondTool],
				messages: [],
			},
			streamFn: mainMock.stream,
			convertToLlm,
		});
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"advisor.syncBacklog": "off",
			"compaction.enabled": false,
			interruptMode: "immediate",
			"retry.enabled": false,
		});
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
			convertToLlm,
		});
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		const adviceRecorded = Promise.withResolvers<void>();
		const unsubscribeAdvisor = advisor.subscribe(event => {
			if (event.type === "tool_execution_end" && event.toolName === "advise") adviceRecorded.resolve();
		});

		const toolEnds: Array<Extract<AgentSessionEvent, { type: "tool_execution_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "tool_execution_end") toolEnds.push(event);
		});

		const running = session.prompt("Run the two-tool batch");
		await firstToolStarted.promise;
		expect(session.agent.state.isStreaming).toBe(true);

		const advisorRunning = advisor.prompt("Review the in-flight primary turn");
		try {
			await adviceRecorded.promise;
			expect(session.agent.state.isStreaming).toBe(true);
			expect(session.hasPendingDeliverableAsides()).toBe(false);
		} finally {
			releaseFirstTool.resolve();
		}
		await Promise.all([advisorRunning, running]);
		unsubscribeAdvisor();
		expect(advisorMock.calls).toHaveLength(2);

		expect(executions).toEqual(["first_gate", "second_probe"]);
		expect(toolEnds.map(event => event.toolCallId)).toEqual(["call-first", "call-second"]);
		for (const event of toolEnds) {
			expect(event.isError).toBe(false);
			expect(toolResultText(event)).not.toContain(SKIPPED_TOOL_RESULT);
		}

		expect(mainMock.calls).toHaveLength(2);
		const nextContext = mainMock.calls[1]?.context.messages;
		if (!nextContext) throw new Error("Expected a model call after the tool batch");
		const firstResultIndex = nextContext.findIndex(
			message => message.role === "toolResult" && message.toolCallId === "call-first",
		);
		const secondResultIndex = nextContext.findIndex(
			message => message.role === "toolResult" && message.toolCallId === "call-second",
		);
		const advisorIndex = nextContext.findIndex(message => messageText(message).includes(ADVISOR_NOTE));
		expect(firstResultIndex).toBeGreaterThanOrEqual(0);
		expect(secondResultIndex).toBeGreaterThan(firstResultIndex);
		expect(advisorIndex).toBeGreaterThan(secondResultIndex);
		expect(
			session.agent.state.messages.some(
				message =>
					message.role === "custom" &&
					message.customType === "advisor" &&
					typeof message.content === "string" &&
					message.content.includes(ADVISOR_NOTE),
			),
		).toBe(true);
	});

	it("treats a default user steer as a pending deliverable aside", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		});

		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "Pause the blocking wait" }],
			steering: true,
			attribution: "user",
			timestamp: Date.now(),
		});

		expect(session.hasPendingDeliverableAsides()).toBe(true);
	});

	it("automatically processes a concern emitted after the final aside snapshot", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");

		const mainMock = createMockModel({
			responses: [{ content: ["initial answer"] }, { content: ["advisor concern handled"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
			convertToLlm,
		});
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"advisor.syncBacklog": "off",
			"compaction.enabled": false,
			interruptMode: "immediate",
			"retry.enabled": false,
		});
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			convertToLlm,
		});
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		const adviseTool = advisor.state.tools.find((tool): tool is AdviseTool => tool instanceof AdviseTool);
		if (!adviseTool) throw new Error("Expected the live advisor to own AdviseTool");

		let injected = false;
		let streamingAtInjection: boolean | undefined;
		let finalSnapshotSize: number | undefined;
		let queuedImmediatelyAfterAdvice: boolean | undefined;
		let adviseExecution: Promise<AgentToolResult> | undefined;
		const drainLazy = session.yieldQueue.drainLazy.bind(session.yieldQueue);
		const drainSpy = vi.spyOn(session.yieldQueue, "drainLazy").mockImplementation(() => {
			const snapshot = drainLazy();
			if (!injected && snapshot.length === 0 && session?.agent.state.isStreaming) {
				injected = true;
				streamingAtInjection = session.agent.state.isStreaming;
				finalSnapshotSize = snapshot.length;
				// AdviseTool invokes the real session callback synchronously, placing this note
				// immediately after the loop's empty snapshot without a timer or source hook.
				adviseExecution = adviseTool.execute("tail-advise", {
					note: TAIL_ADVISOR_NOTE,
					severity: "concern",
				});
				queuedImmediatelyAfterAdvice = session.yieldQueue.has("advisor");
			}
			return snapshot;
		});

		try {
			await session.prompt("Finish with one response");
			if (!adviseExecution) throw new Error("Expected advice injection at the final aside snapshot");
			const result = await adviseExecution;
			expect(result.details).toEqual({ note: TAIL_ADVISOR_NOTE, severity: "concern" });
			await session.waitForIdle();
		} finally {
			drainSpy.mockRestore();
		}

		const liveAdvisorMessages = session.agent.state.messages.filter(
			message =>
				message.role === "custom" &&
				message.customType === "advisor" &&
				typeof message.content === "string" &&
				message.content.includes(TAIL_ADVISOR_NOTE),
		);
		const persistedAdvisorEntries = sessionManager
			.getEntries()
			.filter(
				entry =>
					entry.type === "custom_message" &&
					entry.customType === "advisor" &&
					typeof entry.content === "string" &&
					entry.content.includes(TAIL_ADVISOR_NOTE),
			);
		const deliveredContextCount =
			mainMock.calls[1]?.context.messages.filter(message => messageText(message).includes(TAIL_ADVISOR_NOTE))
				.length ?? 0;

		expect({
			streamingAtInjection,
			finalSnapshotSize,
			queuedImmediatelyAfterAdvice,
			modelCalls: mainMock.calls.length,
			deliveredContextCount,
			liveAdvisorMessages: liveAdvisorMessages.length,
			persistedAdvisorEntries: persistedAdvisorEntries.length,
			advisorQueueRemaining: session.yieldQueue.has("advisor"),
		}).toEqual({
			streamingAtInjection: true,
			finalSnapshotSize: 0,
			queuedImmediatelyAfterAdvice: false,
			modelCalls: 2,
			deliveredContextCount: 1,
			liveAdvisorMessages: 1,
			persistedAdvisorEntries: 1,
			advisorQueueRemaining: false,
		});
	});
});

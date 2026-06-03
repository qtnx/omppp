import { describe, expect, it } from "bun:test";
import type { BeforeAgentStartEvent, ExtensionAPI, TurnEndEvent } from "@oh-my-pi/pi-coding-agent";
import systemContextReminderExtension, {
	appendSystemContextReminderPrompt,
	createSystemContextReminderExtension,
	SYSTEM_CONTEXT_REMINDER_CUSTOM_TYPE,
	SYSTEM_CONTEXT_REMINDER_LABEL,
} from "../src/extension";

type AssistantMessage = Extract<TurnEndEvent["message"], { role: "assistant" }>;

interface SentMessage {
	message: {
		customType: string;
		content: unknown;
		display?: boolean;
		attribution?: string;
		details?: unknown;
	};
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

interface FakePi {
	labels: string[];
	handlers: Map<string, unknown[]>;
	sentMessages: SentMessage[];
	setLabel(label: string): void;
	on(event: string, handler: unknown): void;
	sendMessage(message: SentMessage["message"], options?: SentMessage["options"]): void;
}

type BeforeAgentStartHandler = (event: BeforeAgentStartEvent) => { systemPrompt?: string[] } | undefined;
type TurnEndHandler = (event: TurnEndEvent) => void;

function createFakePi(): FakePi {
	return {
		labels: [],
		handlers: new Map(),
		sentMessages: [],
		setLabel(label: string): void {
			this.labels.push(label);
		},
		on(event: string, handler: unknown): void {
			const handlers = this.handlers.get(event) ?? [];
			handlers.push(handler);
			this.handlers.set(event, handlers);
		},
		sendMessage(message: SentMessage["message"], options?: SentMessage["options"]): void {
			this.sentMessages.push({ message, options });
		},
	};
}

function getHandler<T>(fakePi: FakePi, event: string): T {
	const handler = fakePi.handlers.get(event)?.[0];
	if (!handler) throw new Error(`Expected handler for ${event}`);
	return handler as T;
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "synthetic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content,
		stopReason,
		timestamp: 1,
	};
}

function emitTurnEnd(fakePi: FakePi, message: AssistantMessage): void {
	const handler = getHandler<TurnEndHandler>(fakePi, "turn_end");
	handler({ type: "turn_end", turnIndex: 0, message, toolResults: [] });
}

describe("systemContextReminderExtension", () => {
	it("registers the default reminder hooks", () => {
		const fakePi = createFakePi();

		systemContextReminderExtension(fakePi as unknown as ExtensionAPI);

		expect(fakePi.labels).toEqual([SYSTEM_CONTEXT_REMINDER_LABEL]);
		expect(fakePi.handlers.has("before_agent_start")).toBe(true);
		expect(fakePi.handlers.has("turn_end")).toBe(true);
	});

	it("can disable per-turn prompt injection for native SDK prompt ownership", () => {
		const fakePi = createFakePi();

		createSystemContextReminderExtension({ injectPromptOnBeforeAgentStart: false })(
			fakePi as unknown as ExtensionAPI,
		);

		expect(fakePi.labels).toEqual([SYSTEM_CONTEXT_REMINDER_LABEL]);
		expect(fakePi.handlers.has("before_agent_start")).toBe(false);
		expect(fakePi.handlers.has("turn_end")).toBe(true);
	});

	it("appends system-context guidance once", () => {
		const fakePi = createFakePi();
		systemContextReminderExtension(fakePi as unknown as ExtensionAPI);
		const beforeHandler = getHandler<BeforeAgentStartHandler>(fakePi, "before_agent_start");

		const first = beforeHandler({ type: "before_agent_start", prompt: "continue", systemPrompt: ["base"] });
		expect(first?.systemPrompt).toEqual(["base", expect.stringContaining("## System Context Reminder")]);
		expect(first?.systemPrompt?.join("\n\n")).toContain("forgot the system prompt");
		expect(first?.systemPrompt?.join("\n\n")).toContain("follow the full system prompt");

		const second = beforeHandler({
			type: "before_agent_start",
			prompt: "continue",
			systemPrompt: first?.systemPrompt ?? [],
		});
		expect(second).toBeUndefined();
	});

	it("queues a hidden next-turn reminder when final prose omits required persona terms", () => {
		const fakePi = createFakePi();
		systemContextReminderExtension(fakePi as unknown as ExtensionAPI);

		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Finished." }]));

		expect(fakePi.sentMessages).toHaveLength(1);
		expect(fakePi.sentMessages[0]).toMatchObject({
			message: {
				customType: SYSTEM_CONTEXT_REMINDER_CUSTOM_TYPE,
				display: false,
				attribution: "agent",
				details: { kind: "system-context-reminder" },
			},
			options: { deliverAs: "nextTurn" },
		});
		expect(String(fakePi.sentMessages[0]?.message.content)).toContain("forgot the system prompt");
		expect(String(fakePi.sentMessages[0]?.message.content)).toContain("full system prompt");
	});

	it("queues when final prose uses forbidden persona terms even with required terms present", () => {
		const fakePi = createFakePi();
		systemContextReminderExtension(fakePi as unknown as ExtensionAPI);

		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Dạ bố, con đã kiểm tra cho bạn." }]));
		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Dạ bố, tôi đã kiểm tra xong cho con." }]));
		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Dạ bố, mình đã xong rồi con nhé." }]));

		expect(fakePi.sentMessages).toHaveLength(3);
	});

	it("does not queue when final prose contains both required persona terms", () => {
		const fakePi = createFakePi();
		systemContextReminderExtension(fakePi as unknown as ExtensionAPI);

		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Dạ bố, con đã làm xong." }]));

		expect(fakePi.sentMessages).toEqual([]);
	});

	it("does not queue for non-final or non-prose turns", () => {
		const fakePi = createFakePi();
		systemContextReminderExtension(fakePi as unknown as ExtensionAPI);
		const turnEndHandler = getHandler<TurnEndHandler>(fakePi, "turn_end");

		turnEndHandler({
			type: "turn_end",
			turnIndex: 0,
			message: { role: "user", content: "hello", timestamp: 1 } as TurnEndEvent["message"],
			toolResults: [],
		});
		emitTurnEnd(fakePi, assistantMessage([]));
		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "   " }]));
		emitTurnEnd(
			fakePi,
			assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } }]),
		);
		emitTurnEnd(
			fakePi,
			assistantMessage([
				{ type: "text", text: "I will inspect that." },
				{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "file.ts" } },
			]),
		);
		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Partial." }], "aborted"));
		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Failed." }], "error"));

		expect(fakePi.sentMessages).toEqual([]);
	});

	it("requires standalone persona terms rather than substrings", () => {
		const fakePi = createFakePi();
		systemContextReminderExtension(fakePi as unknown as ExtensionAPI);

		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Dạ bố, context is ready." }]));
		emitTurnEnd(fakePi, assistantMessage([{ type: "text", text: "Dạ bố, con is ready." }]));

		expect(fakePi.sentMessages).toHaveLength(1);
	});
});

describe("appendSystemContextReminderPrompt", () => {
	it("returns undefined when the prompt already contains exact guidance", () => {
		const first = appendSystemContextReminderPrompt([]);
		expect(first).toHaveLength(1);
		expect(appendSystemContextReminderPrompt(first ?? [])).toBeUndefined();
	});
});

import { describe, expect, it } from "bun:test";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
} from "@oh-my-pi/pi-coding-agent";
import delegationReminderExtension, {
	createDelegationReminderExtension,
	DELEGATION_REMINDER_CUSTOM_TYPE,
} from "../src/extension";

type AssistantMessage = Extract<TurnEndEvent["message"], { role: "assistant" }>;
type ToolResultContent = NonNullable<ToolResultEventResult["content"]>[number];
type TextContent = Extract<ToolResultContent, { type: "text" }>;
type ToolResultHandler = (event: ToolResultEvent) => ToolResultEventResult | undefined;
type ToolCallHandler = (event: ToolCallEvent) => void;
type TurnStartHandler = () => void;
type TurnEndHandler = (event: TurnEndEvent) => void;

interface AppendedEntry {
	customType: string;
	data: unknown;
}

interface FakePi {
	labels: string[];
	handlers: Map<string, unknown[]>;
	appendedEntries: AppendedEntry[];
	setLabel(label: string): void;
	on(event: string, handler: unknown): void;
	appendEntry(customType: string, data?: unknown): void;
}

function createFakePi(): FakePi {
	return {
		labels: [],
		handlers: new Map(),
		appendedEntries: [],
		setLabel(label: string): void {
			this.labels.push(label);
		},
		on(event: string, handler: unknown): void {
			const handlers = this.handlers.get(event) ?? [];
			handlers.push(handler);
			this.handlers.set(event, handlers);
		},
		appendEntry(customType: string, data?: unknown): void {
			this.appendedEntries.push({ customType, data });
		},
	};
}

function getHandler<T>(fakePi: FakePi, event: string): T {
	const handler = fakePi.handlers.get(event)?.[0];
	if (!handler) throw new Error(`Expected handler for ${event}`);
	return handler as T;
}

function startTurn(fakePi: FakePi): void {
	getHandler<TurnStartHandler>(fakePi, "turn_start")();
}

function callTool(fakePi: FakePi, toolName: string): void {
	getHandler<ToolCallHandler>(
		fakePi,
		"tool_call",
	)({
		type: "tool_call",
		toolCallId: `call-${toolName}`,
		toolName,
		input: {},
	} as ToolCallEvent);
}

function resultFor(
	fakePi: FakePi,
	toolName: string,
	content: ToolResultContent[] = [],
): ToolResultEventResult | undefined {
	return getHandler<ToolResultHandler>(
		fakePi,
		"tool_result",
	)({
		type: "tool_result",
		toolCallId: `call-${toolName}`,
		toolName,
		input: {},
		content,
		isError: false,
	} as ToolResultEvent);
}

function assistantMessage(): AssistantMessage {
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
		content: [{ type: "text", text: "Done." }],
		stopReason: "stop",
		timestamp: 1,
	};
}

function endTurn(fakePi: FakePi): void {
	getHandler<TurnEndHandler>(
		fakePi,
		"turn_end",
	)({
		type: "turn_end",
		turnIndex: 0,
		message: assistantMessage(),
		toolResults: [],
	});
}

/** Drive `count` hands-on calls; returns the tool_result outcome of the final one. */
function runHandsOn(fakePi: FakePi, count: number, toolName = "edit"): ToolResultEventResult | undefined {
	let last: ToolResultEventResult | undefined;
	for (let i = 0; i < count; i++) {
		callTool(fakePi, toolName);
		last = resultFor(fakePi, toolName);
	}
	return last;
}

describe("delegationReminderExtension", () => {
	it("default extension appends the notice at the default threshold", () => {
		const fakePi = createFakePi();

		delegationReminderExtension(fakePi as unknown as ExtensionAPI);
		startTurn(fakePi);

		expect(runHandsOn(fakePi, 5)).toBeUndefined();
		callTool(fakePi, "edit");
		expect(resultFor(fakePi, "edit")?.content).toBeDefined();
	});

	it("appends the notice exactly once when the hands-on threshold is crossed", () => {
		const fakePi = createFakePi();
		createDelegationReminderExtension({ threshold: 3 })(fakePi as unknown as ExtensionAPI);
		startTurn(fakePi);

		// Below threshold: no nudge on the first two results.
		callTool(fakePi, "edit");
		expect(resultFor(fakePi, "edit")).toBeUndefined();
		callTool(fakePi, "bash");
		expect(resultFor(fakePi, "bash")).toBeUndefined();

		// Third hands-on call crosses the threshold (3 >= 3) → notice on this result.
		callTool(fakePi, "write");
		const crossed = resultFor(fakePi, "write");
		expect(crossed?.content).toBeDefined();
		const blocks = crossed?.content ?? [];
		expect(blocks).toHaveLength(1);
		expect((blocks[0] as TextContent).text).toContain("<system-notice>");
		expect((blocks[0] as TextContent).text).toContain("Orchestrator Mode");
		expect((blocks[0] as TextContent).text).toContain("3 hands-on");

		// Subsequent hands-on calls in the same turn must not nudge again.
		callTool(fakePi, "edit");
		expect(resultFor(fakePi, "edit")).toBeUndefined();
	});

	it("does not append when a task call delegated before the threshold was crossed", () => {
		const fakePi = createFakePi();
		createDelegationReminderExtension({ threshold: 3 })(fakePi as unknown as ExtensionAPI);
		startTurn(fakePi);

		// Delegate first, then do plenty of hands-on work.
		callTool(fakePi, "task");
		resultFor(fakePi, "task");
		for (let i = 0; i < 6; i++) {
			callTool(fakePi, "edit");
			expect(resultFor(fakePi, "edit")).toBeUndefined();
		}

		endTurn(fakePi);
		expect(fakePi.appendedEntries).toEqual([]);
	});

	it("preserves existing tool-result content verbatim before the appended notice", () => {
		const fakePi = createFakePi();
		createDelegationReminderExtension({ threshold: 1 })(fakePi as unknown as ExtensionAPI);
		startTurn(fakePi);

		const existing: TextContent[] = [
			{ type: "text", text: "first existing block" },
			{ type: "text", text: "second existing block" },
		];
		const inputContent = [...existing];
		callTool(fakePi, "edit");
		const outcome = resultFor(fakePi, "edit", inputContent);
		const blocks = outcome?.content ?? [];

		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toEqual(existing[0]);
		expect(blocks[1]).toEqual(existing[1]);
		expect((blocks[2] as TextContent).type).toBe("text");
		expect((blocks[2] as TextContent).text).toContain("<system-notice>");
		expect(inputContent).toHaveLength(2);
		expect(inputContent[0]).toBe(existing[0]);
		expect(inputContent[1]).toBe(existing[1]);
		expect(outcome?.content).not.toBe(inputContent);
	});

	it("resets per-turn counters so each turn re-evaluates independently", () => {
		const fakePi = createFakePi();
		createDelegationReminderExtension({ threshold: 2 })(fakePi as unknown as ExtensionAPI);

		// Turn 1: crosses threshold → nudge + record.
		startTurn(fakePi);
		expect(runHandsOn(fakePi, 2)?.content).toBeDefined();
		endTurn(fakePi);
		expect(fakePi.appendedEntries).toHaveLength(1);

		// Turn 2: counter and nudged state reset, so crossing threshold nudges again.
		startTurn(fakePi);
		expect(runHandsOn(fakePi, 2)?.content).toBeDefined();
		endTurn(fakePi);
		expect(fakePi.appendedEntries).toHaveLength(2);
	});

	it("records the contract-shaped stats entry once per nudged turn", () => {
		const fakePi = createFakePi();
		createDelegationReminderExtension({ threshold: 2 })(fakePi as unknown as ExtensionAPI);
		startTurn(fakePi);

		runHandsOn(fakePi, 3); // 3 hands-on edits, threshold 2
		callTool(fakePi, "task"); // a late delegation still records taskCount
		expect(resultFor(fakePi, "task")).toBeUndefined();
		endTurn(fakePi);

		expect(fakePi.appendedEntries).toHaveLength(1);
		const entry = fakePi.appendedEntries[0];
		expect(entry.customType).toBe(DELEGATION_REMINDER_CUSTOM_TYPE);
		expect(entry.data).toEqual({
			model: "test-model",
			provider: "synthetic",
			api: "openai-responses",
			handsOnCount: 3,
			taskCount: 1,
			threshold: 2,
		});
	});

	it("suppresses nudging and recording when disabled", () => {
		const fakePi = createFakePi();
		createDelegationReminderExtension({ threshold: 1, enabled: false })(fakePi as unknown as ExtensionAPI);
		startTurn(fakePi);

		callTool(fakePi, "edit");
		expect(resultFor(fakePi, "edit")).toBeUndefined();
		endTurn(fakePi);
		expect(fakePi.appendedEntries).toEqual([]);
	});

	it("clamps a sub-1 threshold up to 1 and defaults an omitted threshold", () => {
		const clamped = createFakePi();
		createDelegationReminderExtension({ threshold: 0 })(clamped as unknown as ExtensionAPI);
		startTurn(clamped);
		callTool(clamped, "edit");
		// threshold clamped to 1 → first hands-on call nudges.
		expect(resultFor(clamped, "edit")?.content).toBeDefined();

		const defaulted = createFakePi();
		createDelegationReminderExtension()(defaulted as unknown as ExtensionAPI);
		startTurn(defaulted);
		expect(runHandsOn(defaulted, 5)).toBeUndefined();
		callTool(defaulted, "edit");
		expect(resultFor(defaulted, "edit")?.content).toBeDefined();
	});

	it("ignores non-hands-on tools when counting delegation pressure", () => {
		const fakePi = createFakePi();
		createDelegationReminderExtension({ threshold: 2 })(fakePi as unknown as ExtensionAPI);
		startTurn(fakePi);

		// `read`/`search` are not hands-on and must not advance the counter.
		for (const toolName of ["read", "search", "find", "read", "search"]) {
			callTool(fakePi, toolName);
			expect(resultFor(fakePi, toolName)).toBeUndefined();
		}
		endTurn(fakePi);
		expect(fakePi.appendedEntries).toEqual([]);

		for (const toolName of ["edit", "write", "ast_edit", "bash"]) {
			const handsOn = createFakePi();
			createDelegationReminderExtension({ threshold: 1 })(handsOn as unknown as ExtensionAPI);
			startTurn(handsOn);
			callTool(handsOn, toolName);
			expect(resultFor(handsOn, toolName)?.content).toBeDefined();
		}
	});
});

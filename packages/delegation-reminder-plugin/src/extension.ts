/// <reference path="./bun-imports.d.ts" />
import type {
	ExtensionAPI,
	ExtensionFactory,
	MessageEndEvent,
	ToolCallEvent,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent";
import delegationReminderNotice from "./delegation-reminder-notice.md" with { type: "text" };

export const DELEGATION_REMINDER_LABEL = "Delegation Reminder";
export const DELEGATION_REMINDER_CUSTOM_TYPE = "delegation-reminder";
export const DELEGATION_REMINDER_NOTICE_TEMPLATE = delegationReminderNotice.trim();

/**
 * Tool names that count as the model doing the work itself instead of delegating.
 * Exported so tests assert against the same source of truth the runtime uses.
 */
export const HANDS_ON_TOOL_NAMES: readonly string[] = ["edit", "write", "ast_edit", "bash"];

/** Tool name that marks the turn as having delegated work. */
export const TASK_TOOL_NAME = "task";

/** Default hands-on count that triggers the mid-turn delegation nudge. */
export const DEFAULT_DELEGATION_REMINDER_THRESHOLD = 6;

type AssistantMessage = Extract<TurnEndEvent["message"], { role: "assistant" }>;

/** Shape of the stats payload recorded once per nudged turn. Mirrors the StatsPipeline contract. */
export interface DelegationReminderRecord {
	model: string;
	provider: string;
	api: string;
	handsOnCount: number;
	taskCount: number;
	threshold: number;
}

export interface DelegationReminderExtensionOptions {
	/** Hands-on tool count that triggers the nudge. Clamped to a minimum of 1. Default {@link DEFAULT_DELEGATION_REMINDER_THRESHOLD}. */
	threshold?: number;
	/** When false the extension registers its hooks but never nudges or records. Default true. */
	enabled?: boolean;
}

function normalizeThreshold(threshold: number | undefined): number {
	if (threshold === undefined || !Number.isFinite(threshold)) return DEFAULT_DELEGATION_REMINDER_THRESHOLD;
	return Math.max(1, Math.trunc(threshold));
}

export function createDelegationReminderExtension(options: DelegationReminderExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		registerDelegationReminderExtension(pi, options);
	};
}

export default function delegationReminderExtension(pi: ExtensionAPI): void {
	registerDelegationReminderExtension(pi);
}

function registerDelegationReminderExtension(pi: ExtensionAPI, options: DelegationReminderExtensionOptions = {}): void {
	pi.setLabel(DELEGATION_REMINDER_LABEL);

	const enabled = options.enabled !== false;
	const threshold = normalizeThreshold(options.threshold);

	// Per-turn counters, reset on every `turn_start`. One extension instance per
	// session, so the closure is the turn-scoped state shared by all four hooks.
	let handsOnCount = 0;
	let taskCount = 0;
	let delegated = false;
	let nudged = false;

	const resetTurn = (): void => {
		handsOnCount = 0;
		taskCount = 0;
		delegated = false;
		nudged = false;
	};

	pi.on("turn_start", (_event: TurnStartEvent) => {
		resetTurn();
	});

	// Suppress the nudge when the assistant message that is currently executing
	// already contains a `task` call. Two layers cover the same-batch case:
	// 1. `message_end` (below) is pushed onto the session event stream *before*
	//    tool execution begins and is consumed FIFO, so it normally lands first.
	// 2. The task tool's own `tool_call` hook (further down) fires inline right
	//    before the task executes.
	// Neither layer is a hard ordering guarantee against a hands-on tool result
	// emitted from the inline wrapper path during the same microtask window, but
	// hands-on tools are exclusive-serial with real I/O, so in practice one of
	// the two layers always wins. The nudge is an advisory heuristic — a residual
	// false positive is harmless and intentionally accepted over more machinery.
	pi.on("message_end", (event: MessageEndEvent) => {
		if (isAssistantMessage(event.message) && hasTaskToolCall(event.message)) {
			delegated = true;
		}
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName === TASK_TOOL_NAME) {
			taskCount += 1;
			delegated = true;
			return;
		}
		if (HANDS_ON_TOOL_NAMES.includes(event.toolName)) {
			handsOnCount += 1;
		}
	});

	pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
		if (!enabled || event.isError || delegated || nudged || handsOnCount < threshold) return undefined;
		nudged = true;
		// Full replacement array: keep every existing content item verbatim and
		// append the notice last. NEVER mutate or drop the original content.
		const text = DELEGATION_REMINDER_NOTICE_TEMPLATE.replaceAll("{{count}}", String(handsOnCount)).replaceAll(
			"{{threshold}}",
			String(threshold),
		);
		return { content: [...event.content, { type: "text", text }] };
	});

	pi.on("turn_end", (event: TurnEndEvent) => {
		if (!enabled || !nudged) return;
		if (!isAssistantMessage(event.message)) return;
		// Session-log-only entry (`type:"custom"`): never converted into an LLM
		// message at rebuild, so the stats record does not bloat the conversation.
		const record: DelegationReminderRecord = {
			model: event.message.model,
			provider: event.message.provider,
			api: event.message.api,
			handsOnCount,
			taskCount,
			threshold,
		};
		pi.appendEntry(DELEGATION_REMINDER_CUSTOM_TYPE, record);
	});
}

function isAssistantMessage(message: TurnEndEvent["message"]): message is AssistantMessage {
	return message.role === "assistant";
}

function hasTaskToolCall(message: AssistantMessage): boolean {
	return message.content.some(content => content.type === "toolCall" && content.name === TASK_TOOL_NAME);
}

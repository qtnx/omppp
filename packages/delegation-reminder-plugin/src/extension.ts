/// <reference path="./bun-imports.d.ts" />
import type {
	AgentStartEvent,
	ExtensionAPI,
	ExtensionFactory,
	MessageEndEvent,
	ToolCallEvent,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent";
import { TURN_SIGNALS_CHANNEL, type TurnSignals } from "@oh-my-pi/pi-coding-agent/signals/index";
import delegationReminderNotice from "./delegation-reminder-notice.md" with { type: "text" };
import discoveryReminderNotice from "./discovery-reminder-notice.md" with { type: "text" };

export const DELEGATION_REMINDER_LABEL = "Delegation Reminder";
export const DELEGATION_REMINDER_CUSTOM_TYPE = "delegation-reminder";
export const DELEGATION_REMINDER_NOTICE_TEMPLATE = delegationReminderNotice.trim();
export const DISCOVERY_REMINDER_NOTICE_TEMPLATE = discoveryReminderNotice.trim();

/**
 * Tool names that count as the model doing the work itself instead of delegating.
 * Exported so tests assert against the same source of truth the runtime uses.
 */
export const HANDS_ON_TOOL_NAMES: readonly string[] = ["edit", "write", "ast_edit", "bash"];

/** Tool name that marks the turn as having delegated work. */
export const TASK_TOOL_NAME = "task";

/** Default hands-on count that triggers the mid-turn delegation nudge. */
export const DEFAULT_DELEGATION_REMINDER_THRESHOLD = 6;

/**
 * Tool names that count as the model scouting the codebase itself. Only calls
 * made before the first hands-on tool count: once editing starts, a read is a
 * re-read before an edit, not discovery.
 */
export const DISCOVERY_TOOL_NAMES: readonly string[] = ["read", "grep", "glob", "codegraph_explore"];

/** Default discovery-call count that triggers the run-scoped scouting nudge. */
export const DEFAULT_DISCOVERY_REMINDER_THRESHOLD = 8;

/**
 * `TurnSignals.parallelSlices` below this value means TypeSafe judged the turn
 * to hold one work slice, so there is nothing left to parallelize and the
 * nudge would only be noise.
 */
export const SINGLE_SLICE_PARALLEL_MAX = 0.5;

/**
 * `TurnSignals.openEndedDiscovery` below this value means TypeSafe judged the
 * latest slice to be targeted lookups rather than open-ended discovery, so
 * dispatching scouts would only add overhead.
 */
export const OPEN_ENDED_DISCOVERY_MIN = 0.6;

type AssistantMessage = Extract<TurnEndEvent["message"], { role: "assistant" }>;

/** Shape of the stats payload recorded once per nudge. Mirrors the StatsPipeline contract. */
export interface DelegationReminderRecord {
	model: string;
	provider: string;
	api: string;
	handsOnCount: number;
	taskCount: number;
	threshold: number;
	/** Which nudge produced this record. Absent on entries written before the discovery nudge existed. */
	kind?: "hands-on" | "discovery";
	/** Discovery calls counted for the run, present on `kind: "discovery"` records. */
	discoveryCount?: number;
}

export interface DelegationReminderExtensionOptions {
	/** Hands-on tool count that triggers the nudge. Clamped to a minimum of 1. Default {@link DEFAULT_DELEGATION_REMINDER_THRESHOLD}. */
	threshold?: number;
	/** Discovery tool count that triggers the run-scoped scouting nudge. Clamped to a minimum of 1. Default {@link DEFAULT_DISCOVERY_REMINDER_THRESHOLD}. */
	discoveryThreshold?: number;
	/** When false the extension registers its hooks but never nudges or records. Default true. */
	enabled?: boolean;
}

function normalizeThreshold(
	threshold: number | undefined,
	fallback: number = DEFAULT_DELEGATION_REMINDER_THRESHOLD,
): number {
	if (threshold === undefined || !Number.isFinite(threshold)) return fallback;
	return Math.max(1, Math.trunc(threshold));
}

function renderNotice(template: string, count: number, threshold: number): string {
	return template.replaceAll("{{count}}", String(count)).replaceAll("{{threshold}}", String(threshold));
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
	const discoveryThreshold = normalizeThreshold(options.discoveryThreshold, DEFAULT_DISCOVERY_REMINDER_THRESHOLD);

	// Per-turn counters, reset on every `turn_start`. One extension instance per
	// session, so the closure is the turn-scoped state shared by all four hooks.
	let handsOnCount = 0;
	let taskCount = 0;
	let delegated = false;
	let nudged = false;
	// Run-scoped discovery state. `turn_start`/`turn_end` fire per LLM step, so
	// hand-scouting spread over many steps only accumulates when this state
	// survives the whole agent run and resets on `agent_start`.
	let discoveryCount = 0;
	let runDelegated = false;
	let runHandsOn = false;
	let discoveryNudged = false;
	// TypeSafe classifies a turn once it settles; an extension only ever sees the
	// published values, never the classifier. Cache the latest classification so
	// the nudge can skip a turn already judged single-slice. Never cleared on
	// `turn_start`: the newest value describes the most recent classification,
	// and dropping it would blind the nudge for a whole turn.
	let latestParallelSlices: number | undefined;
	let latestOpenEndedDiscovery: number | undefined;

	pi.events.on(TURN_SIGNALS_CHANNEL, payload => {
		// Untrusted payload: a malformed frame counts as "no classification" so a
		// producer bug can never read as a confident single-slice judgment.
		const signals: Partial<TurnSignals> = typeof payload === "object" && payload !== null ? payload : {};
		if (typeof signals.parallelSlices === "number" && Number.isFinite(signals.parallelSlices)) {
			latestParallelSlices = signals.parallelSlices;
		}
		if (typeof signals.openEndedDiscovery === "number" && Number.isFinite(signals.openEndedDiscovery)) {
			latestOpenEndedDiscovery = signals.openEndedDiscovery;
		}
	});

	const resetTurn = (): void => {
		handsOnCount = 0;
		taskCount = 0;
		delegated = false;
		nudged = false;
	};

	pi.on("turn_start", (_event: TurnStartEvent) => {
		resetTurn();
	});

	pi.on("agent_start", (_event: AgentStartEvent) => {
		discoveryCount = 0;
		runDelegated = false;
		runHandsOn = false;
		discoveryNudged = false;
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
			runDelegated = true;
		}
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName === TASK_TOOL_NAME) {
			taskCount += 1;
			delegated = true;
			runDelegated = true;
			return;
		}
		if (HANDS_ON_TOOL_NAMES.includes(event.toolName)) {
			handsOnCount += 1;
			runHandsOn = true;
			return;
		}
		// Only reads before the first hands-on call are scouting; afterwards a
		// read is a re-read right before an edit.
		if (!runHandsOn && DISCOVERY_TOOL_NAMES.includes(event.toolName)) {
			discoveryCount += 1;
		}
	});

	pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
		if (!enabled || event.isError) return undefined;

		// Run-scoped scouting nudge: many reads, no edit, no subagent dispatched.
		// A classification below the minimum means targeted lookups, not
		// open-ended discovery; no classification keeps the count-only behavior.
		if (
			!runDelegated &&
			!discoveryNudged &&
			discoveryCount >= discoveryThreshold &&
			(latestOpenEndedDiscovery === undefined || latestOpenEndedDiscovery >= OPEN_ENDED_DISCOVERY_MIN)
		) {
			discoveryNudged = true;
			// Recorded here, not at `turn_end`: the discovery run spans turns, and
			// `ToolResultEvent` carries no model identity, so those fields stay empty.
			const record: DelegationReminderRecord = {
				model: "",
				provider: "",
				api: "",
				handsOnCount,
				taskCount,
				threshold: discoveryThreshold,
				kind: "discovery",
				discoveryCount,
			};
			pi.appendEntry(DELEGATION_REMINDER_CUSTOM_TYPE, record);
			return {
				content: [
					...event.content,
					{
						type: "text",
						text: renderNotice(DISCOVERY_REMINDER_NOTICE_TEMPLATE, discoveryCount, discoveryThreshold),
					},
				],
			};
		}

		if (delegated || nudged || handsOnCount < threshold) return undefined;
		// TypeSafe judged this turn single-slice: delegating cannot split work that
		// is not there. No classification (disabled, no key, request failed) keeps
		// the nudge exactly as it behaved before signals existed.
		if (latestParallelSlices !== undefined && latestParallelSlices < SINGLE_SLICE_PARALLEL_MAX) return undefined;
		nudged = true;
		// Full replacement array: keep every existing content item verbatim and
		// append the notice last. NEVER mutate or drop the original content.
		return {
			content: [
				...event.content,
				{
					type: "text",
					text: renderNotice(DELEGATION_REMINDER_NOTICE_TEMPLATE, handsOnCount, threshold),
				},
			],
		};
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
			kind: "hands-on",
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

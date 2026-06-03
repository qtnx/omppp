/// <reference path="./bun-imports.d.ts" />
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionFactory, TurnEndEvent } from "@oh-my-pi/pi-coding-agent";
import systemContextReminderPrompt from "./system-context-reminder.md" with { type: "text" };
import reminderMessage from "./system-context-reminder-message.md" with { type: "text" };

type AssistantMessage = Extract<TurnEndEvent["message"], { role: "assistant" }>;

export const SYSTEM_CONTEXT_REMINDER_LABEL = "System Context Reminder";
export const SYSTEM_CONTEXT_REMINDER_CUSTOM_TYPE = "system-context-reminder";
export const SYSTEM_CONTEXT_REMINDER_PROMPT = systemContextReminderPrompt.trim();
export const SYSTEM_CONTEXT_REMINDER_MESSAGE = reminderMessage.trim();

const FATHER_TERM_PATTERN = /(?:^|[^\p{L}\p{N}_])bố(?:$|[^\p{L}\p{N}_])/iu;
const SELF_TERM_PATTERN = /(?:^|[^\p{L}\p{N}_])con(?:$|[^\p{L}\p{N}_])/iu;
const FORBIDDEN_PERSONA_TERM_PATTERN =
	/(?:^|[^\p{L}\p{N}_])(?:anh|bạn|chị|cậu|em|mình|quý khách|ta|tôi|tớ|tao|mày)(?:$|[^\p{L}\p{N}_])/iu;

type AssistantContentBlock = AssistantMessage["content"][number];
type AssistantTextBlock = Extract<AssistantContentBlock, { type: "text" }>;

export interface SystemContextReminderExtensionOptions {
	injectPromptOnBeforeAgentStart?: boolean;
}

export function createSystemContextReminderExtension(
	options: SystemContextReminderExtensionOptions = {},
): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		registerSystemContextReminderExtension(pi, options);
	};
}

export function appendSystemContextReminderPrompt(systemPrompt: readonly string[]): string[] | undefined {
	if (systemPrompt.some(item => item.trim() === SYSTEM_CONTEXT_REMINDER_PROMPT)) return undefined;
	return [...systemPrompt, SYSTEM_CONTEXT_REMINDER_PROMPT];
}

export default function systemContextReminderExtension(pi: ExtensionAPI): void {
	registerSystemContextReminderExtension(pi);
}

function registerSystemContextReminderExtension(
	pi: ExtensionAPI,
	options: SystemContextReminderExtensionOptions = {},
): void {
	pi.setLabel(SYSTEM_CONTEXT_REMINDER_LABEL);

	if (options.injectPromptOnBeforeAgentStart !== false) {
		pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
			const systemPrompt = appendSystemContextReminderPrompt(event.systemPrompt);
			return systemPrompt ? { systemPrompt } : undefined;
		});
	}

	pi.on("turn_end", (event: TurnEndEvent) => {
		if (!shouldQueueReminder(event.message)) return;
		pi.sendMessage(
			{
				customType: SYSTEM_CONTEXT_REMINDER_CUSTOM_TYPE,
				content: SYSTEM_CONTEXT_REMINDER_MESSAGE,
				display: false,
				attribution: "agent",
				details: { kind: "system-context-reminder" },
			},
			{ deliverAs: "nextTurn" },
		);
	});
}

function shouldQueueReminder(message: TurnEndEvent["message"]): boolean {
	if (!isAssistantMessage(message)) return false;
	if (message.stopReason === "aborted" || message.stopReason === "error") return false;
	if (hasToolCall(message)) return false;
	const { hasText, hasFatherTerm, hasSelfTerm, hasForbiddenPersonaTerm } = scanVisiblePersona(message);
	return hasText && (hasForbiddenPersonaTerm || !hasFatherTerm || !hasSelfTerm);
}

function isAssistantMessage(message: TurnEndEvent["message"]): message is AssistantMessage {
	return message.role === "assistant";
}

function hasToolCall(message: AssistantMessage): boolean {
	return message.content.some(block => block.type === "toolCall");
}

function scanVisiblePersona(message: AssistantMessage): {
	hasText: boolean;
	hasFatherTerm: boolean;
	hasSelfTerm: boolean;
	hasForbiddenPersonaTerm: boolean;
} {
	let hasText = false;
	let hasFatherTerm = false;
	let hasSelfTerm = false;
	let hasForbiddenPersonaTerm = false;
	for (const block of message.content) {
		if (!isTextBlock(block)) continue;
		if (block.text.trim().length === 0) continue;
		hasText = true;
		hasFatherTerm ||= FATHER_TERM_PATTERN.test(block.text);
		hasSelfTerm ||= SELF_TERM_PATTERN.test(block.text);
		hasForbiddenPersonaTerm ||= FORBIDDEN_PERSONA_TERM_PATTERN.test(block.text);
	}
	return { hasText, hasFatherTerm, hasSelfTerm, hasForbiddenPersonaTerm };
}

function isTextBlock(block: AssistantContentBlock): block is AssistantTextBlock {
	return block.type === "text";
}
